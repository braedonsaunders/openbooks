import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/test-fixtures.ts'
import type { Authz } from './authz'

const state: { gate: Authz | null; pause: (() => Promise<void>) | null } = { gate: null, pause: null }
Object.assign(globalThis, { __orderScopeRead: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
const orderLib = new URL('../app/api/_order/lib.ts', import.meta.url).href
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return virtual('export {}')
  if (specifier === './authz' && context.parentURL?.endsWith('/lib/feature-gates.ts')) {
    return virtual('export async function guardPermission(){ return globalThis.__orderScopeRead.gate }')
  }
  if (specifier === './lib' && context.parentURL?.endsWith('/api/_order/handlers.ts')) {
    return virtual(`export * from ${JSON.stringify(orderLib)};
      import {loadOrder as nativeLoad} from ${JSON.stringify(orderLib)};
      export async function loadOrder(...args) {
        const pause = globalThis.__orderScopeRead.pause;
        globalThis.__orderScopeRead.pause = null;
        if (pause) await pause();
        return nativeLoad(...args);
      }`)
  }
  return next(specifier, context)
} })
const { makeGET } = await import('../app/api/_order/handlers')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

for (const kind of ['quote', 'sales_order', 'purchase_order'] as const) {
  test(`${kind} read never discloses another subsidiary after a concurrent draft rehome`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg()
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId
      const other = randomUUID()
      const orderId = randomUUID()
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"orders":true,"multiSubsidiary":true}'::jsonb) where id=${org.orgId}`)
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${other},${org.orgId},${org.subsidiaryId},'Private subsidiary','CAD','CA')`)
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,party_id,subsidiary_id,currency,status,subtotal,tax_total,total,memo,created_by)
        values(${orderId},${org.orgId},${kind},'SCOPE-READ',${org.date},${kind === 'purchase_order' ? org.vendorId : org.customerId},${org.subsidiaryId},'CAD','draft',10,0,10,'Visible original',${actorId})`)
      await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,description,quantity,unit_price,amount)
        values(${org.orgId},${orderId},1,${org.accounts.revenue},'Visible original line',1,10,10)`)
      state.gate = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(['ar.read']),
        allowedSubsidiaryIds: new Set([org.subsidiaryId]) } as Authz
      const get = makeGET({ kind, readPerm: kind === 'purchase_order' ? 'ap.read' : 'ar.read', createPerm: kind === 'purchase_order' ? 'ap.create' : 'ar.create' })
      const request = () => get(new Request('http://audit.local/orders/' + orderId), { params: Promise.resolve({ id: orderId }) })
      assert.equal((await request()).status, 200, 'the original order is visible before the race')
      const paused = deferred<void>()
      const resume = deferred<void>()
      state.pause = async () => { paused.resolve(); await resume.promise }
      const reading = request()
      const readOutcome = reading.then(value => ({ value }), error => ({ error }))
      let writing: Promise<void> | undefined
      let writerOutcome: Promise<unknown> | undefined
      let writerDone = false
      try {
        await paused.promise
        const writerPid = deferred<number>()
        writing = withOrgTransaction(org.orgId, async () => {
          const pid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid
          writerPid.resolve(pid)
          await db.execute(sql`update documents set subsidiary_id=${other},memo='Private B-only terms',updated_at=now()
            where id=${orderId} and org_id=${org.orgId}`)
          await db.execute(sql`update document_lines set description='Private B-only line'
            where document_id=${orderId} and org_id=${org.orgId}`)
        }).finally(() => { writerDone = true })
        writerOutcome = writing.then(() => null, error => { writerPid.resolve(-1); return error })
        const pid = await writerPid.promise
        assert.notEqual(pid, -1, 'writer must acquire a connection')
        // Both serialization outcomes are valid: a protected read holds up the
        // writer; an unprotected read lets it commit before loading its payload.
        let observed = false
        for (let i = 0; i < 100; i++) {
          const blockers = (await db.execute<{ n: number }>(sql`select cardinality(pg_blocking_pids(${pid})) as n`)).rows[0]!.n
          if (writerDone || blockers > 0) { observed = true; break }
          await delay(20)
        }
        assert.ok(observed, 'writer must either commit or visibly wait behind the read')
      } finally {
        resume.resolve()
        await Promise.all([readOutcome, writerOutcome])
      }
      assert.equal(await writerOutcome, null)
      const outcome = await readOutcome
      assert.ok('value' in outcome, 'native GET should return a response')
      if (outcome.value.status === 200) {
        const payload = await outcome.value.json()
        assert.equal(payload.doc.subsidiary_id, org.subsidiaryId, 'a scoped reader must never receive the rehomed private header')
        assert.equal(payload.doc.memo, 'Visible original')
        assert.equal(payload.lines[0].description, 'Visible original line')
      } else assert.equal(outcome.value.status, 404)
      assert.equal((await request()).status, 404, 'the moved record is unavailable on subsequent reads')
    } finally {
      state.gate = null
      state.pause = null
      await dropScratchOrg(org.orgId)
    }
  })
}

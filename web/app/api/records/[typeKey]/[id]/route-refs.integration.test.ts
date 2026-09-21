import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.custom-record-route-refs-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  import { NextResponse } from 'next/server';
  const state = globalThis[Symbol.for('openbooks.custom-record-route-refs-test')]
  export async function guardPermission() {
    if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    return state.authz;
  }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '../../../../../lib/authz' && context.parentURL?.includes('/api/records/')) {
      return { url: 'mock:custom-record-route-refs-authz', shortCircuit: true }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf('/web/') + 5)
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context)
    }
    if (context.parentURL?.startsWith('mock:') && (specifier.startsWith('@openbooks/') || specifier === 'next/server')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url })
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:custom-record-route-refs-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?custom-record-route-refs-test'
const { GET, PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

test(
  'interactive custom-record PATCH refuses party and GL-account UUIDs owned by another organization',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `refs-${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const recordId = randomUUID()
    const orgA = await withBypass(() => createScratchOrg())
    const orgB = await withBypass(() => createScratchOrg())
    const actorId = (await withBypass(() => seedFlowActors(orgA.orgId))).adminId
    const fields = [
      {
        id: 'main',
        title: 'Details',
        fields: [
          { id: 'vendor', type: 'party', label: 'Vendor' },
          { id: 'acct', type: 'gl_account', label: 'Account' },
        ],
      },
      {
        id: 'lines',
        title: 'Lines',
        repeating: true,
        fields: [{ id: 'billto', type: 'party', label: 'Bill to' }],
      },
    ]
    await withBypass(async () => {
      const typeId = randomUUID()
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${orgA.orgId}, ${typeKey}, 'Ref Record', 'Ref Records',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actorId}, ${actorId})
      `)
      await db.execute(sql`
        insert into custom_records
          (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
        values
          (${recordId}, ${orgA.orgId}, ${typeId}, ${typeKey}, 'REF-000001',
           ${JSON.stringify({ vendor: orgA.vendorId, acct: orgA.accounts.bank, lines: [{ billto: orgA.vendorId }] })}::jsonb,
           'ref-000001', 'draft', ${actorId}, ${actorId})
      `)
    })

    state.authz = {
      user: {
        id: actorId,
        orgId: orgA.orgId,
        name: 'Refs actor',
        roles: [{ key: 'admin', name: 'Admin' }],
      },
      permissions: new Set(['records.create', 'records.read']),
      allowedSubsidiaryIds: null,
    }
    try {
      await withOrgContext(orgA.orgId, async () => {
        const params = { params: Promise.resolve({ typeKey, id: recordId }) }
        const opened = await GET(
          new Request(`http://localhost/api/records/${typeKey}/${recordId}`),
          params,
        )
        assert.equal(opened.status, 200, await opened.clone().text())
        const revision = ((await opened.json()) as { record: { updated_at: string } }).record.updated_at

        const save = (data: Record<string, unknown>, expectedUpdatedAt: string) =>
          PATCH(
            new Request(`http://localhost/api/records/${typeKey}/${recordId}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ data, expectedUpdatedAt }),
            }),
            { params: Promise.resolve({ typeKey, id: recordId }) },
          )

        const foreignParty = await save({ vendor: orgB.vendorId }, revision)
        assert.equal(foreignParty.status, 404, await foreignParty.clone().text())
        const partyBody = (await foreignParty.json()) as { error?: string }
        assert.match(partyBody.error ?? '', /not found in this organization/)

        const foreignAccount = await save({ acct: orgB.accounts.bank }, revision)
        assert.equal(foreignAccount.status, 404, await foreignAccount.clone().text())

        const dangling = await save({ vendor: randomUUID() }, revision)
        assert.equal(dangling.status, 404, await dangling.clone().text())

        const foreignRow = await save({ lines: [{ billto: orgB.vendorId }] }, revision)
        assert.equal(foreignRow.status, 404, await foreignRow.clone().text())

        const stored = (await db.execute<{ data: { vendor: string; acct: string } }>(sql`
          select data from custom_records where id = ${recordId} and org_id = ${orgA.orgId}
        `)).rows[0]
        assert.equal(stored?.data.vendor, orgA.vendorId)
        assert.equal(stored?.data.acct, orgA.accounts.bank)

        const own = await save(
          { vendor: orgA.vendorId, acct: orgA.accounts.bank, lines: [{ billto: orgA.vendorId }] },
          revision,
        )
        assert.equal(own.status, 200, await own.clone().text())
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(orgA.orgId))
      await withBypass(() => dropScratchOrg(orgB.orgId))
    }
  },
)

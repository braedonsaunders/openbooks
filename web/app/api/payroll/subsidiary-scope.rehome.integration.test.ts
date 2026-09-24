import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { sql } from 'drizzle-orm'
import { db, pool, withOrg } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    return next(specifier, context)
  },
})

const { guardPayrollEmployees } = await import('./subsidiary-scope.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function waitForRehomeWaiter(): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and query ilike 'update parties set subsidiary_id%'
    `)
    if (Number(rows.rows[0]?.n ?? 0) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

test('payroll filing employee authorization holds the party scope against concurrent rehome', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  let releaseGuard: (() => void) | undefined
  let writer: PoolClient | undefined
  let announceGuard!: () => void
  const guardEntered = new Promise<void>((resolve) => { announceGuard = resolve })
  const guardHeld = new Promise<void>((resolve) => { releaseGuard = resolve })
  let authorization: Promise<void> | undefined
  try {
    const assigned = await db.execute(sql`
      update parties set subsidiary_id = ${org.subsidiaryId}
       where org_id = ${org.orgId} and id = ${org.customerId}
    `)
    assert.equal(assigned.rowCount, 1)

    authorization = withOrg(org.orgId, async () => {
      const gate = {
        user: { id: 'scope-race-user', orgId: org.orgId },
        allowedSubsidiaryIds: new Set([org.subsidiaryId]),
      } as unknown as Parameters<typeof guardPayrollEmployees>[0]
      assert.equal(await guardPayrollEmployees(gate, [org.customerId]), null)
      announceGuard()
      await guardHeld
    })
    await Promise.race([
      guardEntered,
      authorization.then(() => { throw new Error('authorization transaction ended before the race barrier') }),
    ])
    writer = await pool.connect()
    await writer.query('begin')
    await writer.query(
      "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)",
      [org.orgId],
    )
    const update = writer.query(
      'update parties set subsidiary_id = null where org_id = $1 and id = $2',
      [org.orgId, org.customerId],
    )
    const blocked = await waitForRehomeWaiter()

    releaseGuard?.()
    await authorization
    await update
    await writer.query('commit')
    writer.release()
    writer = undefined

    assert.ok(blocked, 'party rehome must wait until the filing authorization transaction finishes')
  } finally {
    releaseGuard?.()
    if (writer) {
      await writer.query('rollback').catch(() => undefined)
      writer.release()
    }
    await dropScratchOrg(org.orgId)
  }
})

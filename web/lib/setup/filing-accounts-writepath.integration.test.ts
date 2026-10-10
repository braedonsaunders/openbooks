import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const { sql } = await import('drizzle-orm')
const { db, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createSetupRecord, updateSetupRecord } = await import('./write.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

/**
 * Filing-account numbers share one namespace per organization — every filing
 * program, every legal entity, archived rows included — so creating a
 * Washington SUI account under the EIN's number is refused. The refusal used
 * to read "This record already exists." while the list showed only the EIN
 * row: the conflicting row (another program, another entity, or archived)
 * was one the operator could not see. The 409 now names it and says how to
 * edit or reactivate it.
 */
async function seedOrg(): Promise<{ orgId: string; actorId: string }> {
  const org = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(org.orgId, 'Payroll Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`
    update orgs set settings = settings || '{"features":{"payroll":true}}'::jsonb
     where id = ${org.orgId}`))
  return { orgId: org.orgId, actorId }
}

function actor(orgId: string, actorId: string) {
  return { orgId, id: actorId, permissions: ['admin.setup.manage'] }
}

async function accountCount(orgId: string): Promise<number> {
  const r = await withBypass(() => db.execute<{ n: number }>(sql`
    select count(*)::int as n from payroll_filing_accounts where org_id = ${orgId}`))
  return r.rows[0]!.n
}

test('a SUI account reusing the EIN number is refused naming the EIN row and its edit', { skip: !DB }, async () => {
  const { orgId, actorId } = await seedOrg()
  try {
    const number = `11-${randomUUID().slice(0, 6).replaceAll('-', '0')}89`
    const ein = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'payroll-filing-accounts', {
      accountNumber: number, name: 'Federal EIN', country: 'US', programType: 'us_ein', isActive: true,
    }))
    assert.equal(ein.status, 200, `EIN setup refused: ${JSON.stringify(ein.body)}`)
    const sui = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'payroll-filing-accounts', {
      accountNumber: number, name: 'WA SUI', country: 'US', programType: 'us_state_sui', stateCode: 'WA', isActive: true,
    }))
    assert.equal(sui.status, 409)
    const body = sui.body as { error?: unknown; code?: unknown }
    assert.equal(body.code, 'duplicate')
    const message = String(body.error ?? '')
    assert.ok(message.includes(number), 'names the conflicting number')
    assert.match(message, /Federal EIN/, 'names the conflicting row')
    assert.match(message, /Federal employer identification number/, 'names the other program, not just the row')
    assert.match(message, /Edit "Federal EIN" in Payroll Setup/, 'says how to fix it')
    assert.equal(await accountCount(orgId), 1, 'the refused write stores no second row')
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('reusing an archived number names the archived row and its reactivation', { skip: !DB }, async () => {
  const { orgId, actorId } = await seedOrg()
  try {
    const number = `WA-${randomUUID().slice(0, 8)}`
    const first = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'payroll-filing-accounts', {
      accountNumber: number, name: 'WA SUI legacy', country: 'US', programType: 'us_state_sui', stateCode: 'WA', isActive: true,
    }))
    assert.equal(first.status, 200, `SUI setup refused: ${JSON.stringify(first.body)}`)
    const archived = await withBypass(() => updateSetupRecord(actor(orgId, actorId), 'payroll-filing-accounts', {
      id: (first.body as { id: string }).id, isActive: false,
    }))
    assert.equal(archived.status, 200, `archive refused: ${JSON.stringify(archived.body)}`)
    const second = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'payroll-filing-accounts', {
      accountNumber: number, name: 'WA SUI', country: 'US', programType: 'us_state_sui', stateCode: 'WA', isActive: true,
    }))
    assert.equal(second.status, 409)
    const body = second.body as { error?: unknown; code?: unknown }
    assert.equal(body.code, 'duplicate')
    const message = String(body.error ?? '')
    assert.match(message, /WA SUI legacy/, 'names the archived row the list hides by default')
    assert.match(message, /reactivate/i, 'says to reactivate rather than recreate')
    assert.equal(await accountCount(orgId), 1, 'the refused write stores no second row')
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

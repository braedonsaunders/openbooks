import assert from 'node:assert/strict'
import test from 'node:test'

const { sql } = await import('drizzle-orm')
const { db, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { payrollSetupState } = await import('@openbooks/engine/src/payroll/readiness.ts')
const { createSetupRecord, updateSetupRecord } = await import('./write.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

/**
 * A vendor payment and a pay run once shared PAY- with independent counters,
 * so PAY-00001 named two documents. New series collisions are refused at
 * configuration time (naming both kinds and the remedy); existing ones warn
 * in payroll setup without renumbering posted history.
 */
async function seedOrg(): Promise<{ orgId: string; actorId: string }> {
  const org = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  return { orgId: org.orgId, actorId }
}

function actor(orgId: string, actorId: string) {
  return { orgId, id: actorId, permissions: ['admin.setup.manage'] }
}

async function createSeries(
  orgId: string, actorId: string, documentKind: string, prefix: string, padding = 5,
) {
  return withBypass(() => createSetupRecord(actor(orgId, actorId), 'number-sequences', {
    documentKind, prefix, padding, nextNumber: 1,
  }))
}

test('a second kind on one series is refused naming both kinds and the remedy', { skip: !DB }, async () => {
  const { orgId, actorId } = await seedOrg()
  try {
    const first = await createSeries(orgId, actorId, 'vendor_payment', 'PAY-')
    assert.equal(first.status, 200, `vendor series refused: ${JSON.stringify(first.body)}`)
    const second = await createSeries(orgId, actorId, 'pay_run', 'PAY-')
    assert.equal(second.status, 400)
    const message = String((second.body as { error?: unknown }).error ?? '')
    assert.match(message, /"pay_run" and "vendor_payment"/, 'names both colliding kinds')
    assert.match(message, /PAY-0+/, 'shows the ambiguous shape')
    assert.match(message, /Setup → Number sequences/, 'names the remedy')
    // A different width issues distinct strings and stays configurable.
    const narrow = await createSeries(orgId, actorId, 'pay_run', 'PAY-', 4)
    assert.equal(narrow.status, 200, `distinct width refused: ${JSON.stringify(narrow.body)}`)
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('the fix stays writable: a colliding row can move series or keep counting', { skip: !DB }, async () => {
  const { orgId, actorId } = await seedOrg()
  try {
    const first = await createSeries(orgId, actorId, 'vendor_payment', 'PAY-')
    assert.equal(first.status, 200)
    // Seed the legacy collision the way history holds it (setup validation
    // would refuse it today, storage never did).
    await withBypass(() => db.execute(sql`
      insert into number_sequences (org_id, document_kind, prefix, next_number, padding, allocated_through)
      values (${orgId}, 'pay_run', 'PAY-', 1, 5, 0)`))
    const rowId = (await withBypass(() => db.execute<{ id: string }>(sql`
      select id from number_sequences where org_id = ${orgId} and document_kind = 'pay_run'`))).rows[0]!.id
    // Moving the pay run onto its own prefix resolves the collision.
    const moved = await withBypass(() => updateSetupRecord(actor(orgId, actorId), 'number-sequences', {
      id: rowId, prefix: 'PR-',
    }))
    assert.equal(moved.status, 200, `the remedy edit refused: ${JSON.stringify(moved.body)}`)
    // A counter-only edit to a (now uncollided) row stays writable.
    const counted = await withBypass(() => updateSetupRecord(actor(orgId, actorId), 'number-sequences', {
      id: rowId, nextNumber: 2,
    }))
    assert.equal(counted.status, 200, `counter edit refused: ${JSON.stringify(counted.body)}`)
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('an existing pay_run collision warns in payroll setup without renumbering', { skip: !DB }, async () => {
  const { orgId, actorId } = await seedOrg()
  try {
    await withBypass(() => db.execute(sql`
      update orgs set settings = settings || '{"features":{"payroll":true},"payroll":{"countries":["US"]}}'::jsonb
       where id = ${orgId}`))
    await withBypass(() => db.execute(sql`
      insert into number_sequences (org_id, document_kind, prefix, next_number, padding, allocated_through)
      values (${orgId}, 'vendor_payment', 'PAY-', 7, 5, 7),
             (${orgId}, 'pay_run', 'PAY-', 3, 5, 3)`))
    const state = await withBypass(() => payrollSetupState(orgId))
    const warnings = state.checks.filter(
      (check) => check.code === 'setup.documentNumberSeries' && check.severity === 'warning' && !check.ok,
    )
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!.detail ?? '', /pay_run.*vendor_payment|vendor_payment.*pay_run/)
    assert.match(warnings[0]!.detail ?? '', /posted history keeps its numbers/)
    const counters = (await withBypass(() => db.execute<{ document_kind: string; next_number: number }>(sql`
      select document_kind, next_number from number_sequences where org_id = ${orgId}`))).rows
    assert.deepEqual(
      Object.fromEntries(counters.map((row) => [row.document_kind, row.next_number])),
      { vendor_payment: 7, pay_run: 3 },
      'the warning moves no counter',
    )
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

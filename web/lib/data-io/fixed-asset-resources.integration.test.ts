import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { fixedAssetsResource, FIXED_ASSETS_DESCRIPTOR } = (await import(
  './fixed-asset-resources.ts'
)) as typeof import('./fixed-asset-resources.ts')
hooks.deregister()

const { db, withOrgTransaction } = await import('@openbooks/engine/src/platform/db.ts')
const { runDepreciation } = await import('@openbooks/engine/src/assets/depreciation.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

/**
 * Fixed-asset import: a mid-life register row loads through the generic
 * machinery, continues its schedule from the opening figure, exports back
 * verbatim, and re-imports as a no-op — while bad rows and post-history
 * opening edits fail with field messages.
 */
async function fixture() {
  const org = await createScratchOrg()
  const cal = (await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where org_id = ${org.orgId} limit 1`)).rows[0]!.id
  const months = [
    { n: 1, from: '2026-01-01', to: '2026-01-31' },
    { n: 2, from: '2026-02-01', to: '2026-02-28' },
    { n: 3, from: '2026-03-01', to: '2026-03-31' },
  ]
  for (const m of months) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${org.orgId}, 2026, ${m.n}, ${`2026-0${m.n}`}, ${m.from}, ${m.to}, false, ${cal})`)
  }
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, default_method, default_life_months,
       default_convention, tax_attributes, is_active)
    values (${randomUUID()}, ${org.orgId}, 'Import Equipment', ${org.accounts.invAsset},
            ${org.accounts.clearing}, ${org.accounts.adjustment}, 'straight_line', 120,
            'full_month', '{}'::jsonb, true)`)
  return org
}

const MID_LIFE_ROW = {
  assetNumber: 'FA-9001',
  name: 'Imported press',
  category: 'Import Equipment',
  acquisitionCost: '120000',
  salvageValue: '0',
  inServiceOn: '2021-06-15',
  status: 'in_service',
  method: 'straight_line',
  lifeMonths: 120,
  convention: 'full_month',
  assetAccount: '1300',
  accumAccount: '2150',
  expenseAccount: '5100',
  openingAccumulated: '55000',
  openingAsOf: '2025-12-31',
}

test('descriptor exposes the asset register as an importable resource', async () => {
  assert.equal(FIXED_ASSETS_DESCRIPTOR.key, 'fixed-assets')
  assert.equal(FIXED_ASSETS_DESCRIPTOR.supportsImport, true)
  assert.equal(FIXED_ASSETS_DESCRIPTOR.naturalKey, 'assetNumber')
})

test('a mid-life row imports, continues its schedule, and round-trips verbatim', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const actorId = await createScratchUser(org.orgId, 'Asset importer', 'admin')
    const resource = fixedAssetsResource(org.orgId)
    const first = await resource.write([{ ...MID_LIFE_ROW }], 'insert', {
      orgId: org.orgId,
      actorId,
      dryRun: false,
    })
    assert.deepEqual(
      { created: first.created, failed: first.failed, errors: first.errors },
      { created: 1, failed: 0, errors: [] },
    )
    const asset = (await db.execute<{ id: string }>(sql`
      select id from fixed_assets where org_id = ${org.orgId} and asset_number = 'FA-9001'`)).rows[0]!
    const createAudit = (await db.execute<{ actor_id: string; action: string; changes: unknown }>(sql`
      select actor_id, action, changes from audit_log
       where org_id = ${org.orgId} and table_name = 'fixed_assets' and row_id = ${asset.id}
         and changes->>'source' = 'import'`)).rows[0]!
    assert.equal(createAudit.actor_id, actorId)
    assert.equal(createAudit.action, 'insert')
    assert.deepEqual(createAudit.changes, {
      source: 'import',
      before: null,
      after: {
        assetNumber: 'FA-9001', name: 'Imported press', description: null,
        subsidiaryId: org.subsidiaryId, categoryId: (await db.execute<{ id: string }>(sql`
          select id from asset_categories where org_id = ${org.orgId} and name = 'Import Equipment'`)).rows[0]!.id,
        status: 'in_service', acquisitionCost: '120000.0000', salvageValue: '0.0000',
        acquiredOn: null, inServiceOn: '2021-06-15', depreciationMethod: 'straight_line',
        usefulLifeMonths: 120, depreciationRatePercent: null, depreciationConvention: 'full_month',
        depreciationUnitsTotal: null, assetAccountId: org.accounts.invAsset,
        accumulatedDepreciationAccountId: org.accounts.clearing,
        depreciationExpenseAccountId: org.accounts.adjustment,
        openingAccumulatedDepreciation: '55000.0000', openingAccumulatedAsOf: '2025-12-31',
        serialNumber: null,
      },
    })

    // The continuation is real on import: the first scheduled month is one
    // month, and the opening figure sits on the row.
    const lines = (await db.execute<{ month: string; planned: string }>(sql`
      select p.starts_on::text as month, l.planned_amount::text as planned
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
        join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
        join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
       where s.org_id = ${org.orgId} and a.asset_number = 'FA-9001'
       order by p.starts_on`)).rows
    assert.deepEqual(
      lines.map((l) => l.month),
      ['2026-01-01', '2026-02-01', '2026-03-01', '2026-07-01'],
    )
    assert.equal(lines[0]!.planned, '1000.0000')

    // Export → re-import (upsert) is a no-op: the matrix's round-trip half
    // for this resource, pinned to exact row equality.
    const exported = await resource.read()
    const row = exported.rows.find((r) => (r as Record<string, unknown>).assetNumber === 'FA-9001')
    assert.ok(row, 'exported register contains the imported asset')
    assert.equal((row as Record<string, unknown>).openingAccumulated, '55000.0000')
    assert.equal((row as Record<string, unknown>).openingAsOf, '2025-12-31')
    const second = await resource.write([row as Record<string, unknown>], 'upsert', {
      orgId: org.orgId,
      actorId,
      dryRun: false,
    })
    assert.deepEqual(
      { created: second.created, updated: second.updated, failed: second.failed, errors: second.errors },
      { created: 0, updated: 1, failed: 0, errors: [] },
    )
    const reread = (await resource.read()).rows.find(
      (r) => (r as Record<string, unknown>).assetNumber === 'FA-9001',
    )
    assert.deepEqual(reread, row)
    const importAudits = (await db.execute<{ action: string; changes: unknown }>(sql`
      select action, changes from audit_log
       where org_id = ${org.orgId} and table_name = 'fixed_assets' and row_id = ${asset.id}
         and changes->>'source' = 'import' order by at, id`)).rows
    assert.equal(importAudits.length, 2)
    assert.equal(importAudits[1]!.action, 'update')
    assert.equal((importAudits[1]!.changes as { before: { name: string } }).before.name, 'Imported press')
    assert.equal((importAudits[1]!.changes as { after: { name: string } }).after.name, 'Imported press')
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('insert twice fails the duplicate; post-history opening edits lock', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const actorId = await createScratchUser(org.orgId, 'Asset importer', 'admin')
    const resource = fixedAssetsResource(org.orgId)
    const first = await resource.write([{ ...MID_LIFE_ROW }], 'insert', {
      orgId: org.orgId,
      actorId,
      dryRun: false,
    })
    assert.equal(first.created, 1)

    const duplicate = await resource.write([{ ...MID_LIFE_ROW }], 'insert', {
      orgId: org.orgId,
      actorId,
      dryRun: false,
    })
    assert.deepEqual(
      { created: duplicate.created, failed: duplicate.failed },
      { created: 0, failed: 1 },
    )
    assert.match(duplicate.errors[0]!.message, /already exists/)

    const run = await runDepreciation(org.orgId, '2026-01-31', actorId)
    assert.equal(run.posted, 1)
    const locked = await resource.write(
      [{ ...MID_LIFE_ROW, openingAccumulated: '56000' }],
      'upsert',
      { orgId: org.orgId, actorId, dryRun: false },
    )
    assert.equal(locked.failed, 1)
    assert.match(locked.errors[0]!.message, /posted depreciation or lifecycle events/)

    // Non-basis edits still flow after posting.
    const renamed = await resource.write(
      [{ ...MID_LIFE_ROW, name: 'Imported press (renamed)' }],
      'upsert',
      { orgId: org.orgId, actorId, dryRun: false },
    )
    assert.deepEqual(
      { updated: renamed.updated, failed: renamed.failed, errors: renamed.errors },
      { updated: 1, failed: 0, errors: [] },
    )
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('dry-run previews without writing; bad rows fail with field messages', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const actorId = await createScratchUser(org.orgId, 'Asset importer', 'admin')
    const resource = fixedAssetsResource(org.orgId)
    const preview = await resource.write([{ ...MID_LIFE_ROW }], 'insert', {
      orgId: org.orgId,
      actorId,
      dryRun: true,
    })
    assert.deepEqual(
      { created: preview.created, failed: preview.failed },
      { created: 1, failed: 0 },
    )
    const count = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from fixed_assets where org_id = ${org.orgId} and asset_number = 'FA-9001'`)).rows[0]!.n
    assert.equal(count, '0', 'dry-run writes nothing')

    const bad = await resource.write(
      [
        { ...MID_LIFE_ROW, assetNumber: 'FA-9002', category: 'No Such Category' },
        { ...MID_LIFE_ROW, assetNumber: 'FA-9003', openingAccumulated: '1000', openingAsOf: '' },
        { ...MID_LIFE_ROW, assetNumber: 'FA-9004', salvageValue: '999999' },
        { ...MID_LIFE_ROW, assetNumber: 'FA-9005', acquisitionCost: '12,34' },
      ],
      'insert',
      { orgId: org.orgId, actorId, dryRun: false },
    )
    assert.deepEqual(
      { created: bad.created, failed: bad.failed },
      { created: 0, failed: 4 },
    )
    assert.match(bad.errors[0]!.message, /unknown asset category/)
    assert.match(bad.errors[1]!.message, /set together/)
    assert.match(bad.errors[2]!.message, /Salvage value cannot exceed/)
    assert.match(bad.errors[3]!.message, /must use "\." as the decimal point/)
    assert.match(bad.errors[3]!.message, /12\.34/)
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('restricted imports lock only in-scope natural-key matches across a rehome', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const actorId = await createScratchUser(org.orgId, 'Scoped asset importer', 'admin')
    const otherSubsidiaryId = randomUUID()
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, is_active)
      values (${otherSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Asset importer B', 'USD', 'US', true)`)
    const resource = fixedAssetsResource(org.orgId)
    const hidden = await resource.write([
      { ...MID_LIFE_ROW, assetNumber: 'FA-SCOPE-RACE', status: 'draft' },
    ], 'insert', { orgId: org.orgId, actorId, dryRun: false, allowedSubsidiaryIds: null })
    assert.equal(hidden.created, 1)

    let unlock!: () => void
    let locked!: () => void
    const lockReady = new Promise<void>((resolve) => { locked = resolve })
    const moveReady = new Promise<void>((resolve) => { unlock = resolve })
    const holder = withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`select id from fixed_assets where org_id = ${org.orgId} and asset_number = 'FA-SCOPE-RACE' for update`)
      locked()
      await moveReady
      await db.execute(sql`select set_config('openbooks.amend', 'on', true)`)
      await db.execute(sql`update fixed_assets set subsidiary_id = ${otherSubsidiaryId}
        where org_id = ${org.orgId} and asset_number = 'FA-SCOPE-RACE'`)
    })
    await lockReady

    let settled = false
    const importer = resource.write([
      { ...MID_LIFE_ROW, assetNumber: 'FA-SCOPE-RACE', name: 'Must not move B asset', status: 'draft' },
    ], 'upsert', {
      orgId: org.orgId,
      actorId,
      dryRun: false,
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    }).finally(() => { settled = true })
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(settled, false, 'the importer must wait on the selected asset row lock')
    } finally {
      unlock()
      await holder
    }
    const outcome = await importer
    assert.equal(outcome.updated, 0)
    assert.equal(outcome.failed, 1, 'the moved row is rechecked against the scope predicate after the lock wait')
    const stillHidden = (await db.execute<{ subsidiary_id: string; name: string }>(sql`
      select subsidiary_id, name from fixed_assets where org_id = ${org.orgId} and asset_number = 'FA-SCOPE-RACE'`)).rows[0]!
    assert.equal(stillHidden.subsidiary_id, otherSubsidiaryId)
    assert.equal(stillHidden.name, 'Imported press')

    const preview = await resource.write([
      { ...MID_LIFE_ROW, assetNumber: 'FA-SCOPE-RACE', status: 'draft' },
    ], 'upsert', {
      orgId: org.orgId,
      actorId,
      dryRun: true,
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    })
    assert.equal(preview.created, 1, 'an out-of-scope natural-key match is not exposed in preview')
    assert.equal(preview.updated, 0)
  } finally {
    await dropScratchOrgReporting(org.orgId)
  }
})

test('a caught schedule refusal rolls back each asset import row to its savepoint', { skip: !DB }, async () => {
  const org = await fixture()
  const triggerName = `asset_import_fail_${randomUUID().replaceAll('-', '')}`
  const functionName = `${triggerName}_fn`
  let triggerInstalled = false
  try {
    const actorId = await createScratchUser(org.orgId, 'Asset importer', 'admin')
    const resource = fixedAssetsResource(org.orgId)
    const draft = await resource.write([
      { ...MID_LIFE_ROW, assetNumber: 'FA-IMPORT-UPDATE-ROLLBACK', status: 'draft', inServiceOn: '' },
    ], 'insert', { orgId: org.orgId, actorId, dryRun: false })
    assert.equal(draft.created, 1)

    await db.execute(sql.raw(`create function public."${functionName}"() returns trigger language plpgsql as $$
      begin raise exception 'injected depreciation schedule refusal' using errcode = '23514'; end
      $$`))
    await db.execute(sql.raw(`create trigger "${triggerName}" before insert on public.depreciation_schedules
      for each row execute function public."${functionName}"()`))
    triggerInstalled = true

    const outcome = await resource.write([
      { ...MID_LIFE_ROW, assetNumber: 'FA-IMPORT-INSERT-ROLLBACK' },
      { ...MID_LIFE_ROW, assetNumber: 'FA-IMPORT-UPDATE-ROLLBACK', status: 'in_service', acquisitionCost: '130000' },
      { ...MID_LIFE_ROW, assetNumber: 'FA-IMPORT-SURVIVOR', status: 'draft', inServiceOn: '' },
    ], 'upsert', { orgId: org.orgId, actorId, dryRun: false })
    assert.equal(outcome.created, 1, 'a later row can commit after the failed rows roll back to their savepoints')
    assert.equal(outcome.updated, 0)
    assert.equal(outcome.failed, 2)
    assert.ok(outcome.errors.every((error) => /schedule build failed/.test(error.message)))

    const persisted = await db.execute<{ asset_number: string; status: string; acquisition_cost: string }>(sql`
      select asset_number, status, acquisition_cost::text from fixed_assets
       where org_id = ${org.orgId} and asset_number in (
         'FA-IMPORT-INSERT-ROLLBACK', 'FA-IMPORT-UPDATE-ROLLBACK', 'FA-IMPORT-SURVIVOR')
       order by asset_number`)
    assert.deepEqual(persisted.rows, [
      { asset_number: 'FA-IMPORT-SURVIVOR', status: 'draft', acquisition_cost: '120000.0000' },
      { asset_number: 'FA-IMPORT-UPDATE-ROLLBACK', status: 'draft', acquisition_cost: '120000.0000' },
    ], 'failed schedule creation must roll back its new asset and prior draft update without aborting later rows')
  } finally {
    if (triggerInstalled) {
      await db.execute(sql.raw(`drop trigger "${triggerName}" on public.depreciation_schedules`))
      await db.execute(sql.raw(`drop function public."${functionName}"()`))
    }
    await dropScratchOrgReporting(org.orgId)
  }
})

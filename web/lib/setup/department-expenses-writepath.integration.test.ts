import assert from 'node:assert/strict'
import test from 'node:test'
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createSetupRecord, updateSetupRecord } = await import('./write.ts')

/**
 * Department expense mappings are maintained through the shared setup
 * write path: creates audit, overlapping windows refuse with the remedy,
 * and the range exclusion behind the hook surfaces as a typed conflict.
 */
test('department expense mappings create, audit, and refuse overlaps', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`))
  await withBypass(() => db.execute(sql`update orgs set settings = settings || '{"features":{"payroll":true}}'::jsonb where id = ${org.orgId}`))
  try {
    const account = async (number: string) => (await withBypass(() => db.execute<{ id: string }>(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                            reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (gen_random_uuid(), ${org.orgId}, ${number}, ${number}, 'expense', false, true, false, false,
              '[]'::jsonb, '{}'::jsonb, true) returning id`))).rows[0]!.id
    const wages = await account('5110')
    const overhead = await account('8010')
    const componentId = (await withBypass(() => db.execute<{ id: string }>(sql`
      insert into pay_components (id, org_id, code, name, kind, country, basis, value, taxable,
                                  pensionable, insurable, vacationable, payment_kind, sequence,
                                  created_by, updated_by)
      values (gen_random_uuid(), ${org.orgId}, 'WAGES', 'Wages', 'earning', null, 'fixed_amount', '100',
              true, true, true, false, 'cash', 10, ${actor}, ${actor}) returning id`))).rows[0]!.id
    const departmentId = (await withBypass(() => db.execute<{ id: string }>(sql`
      insert into departments (id, org_id, code, name, is_active)
      values (gen_random_uuid(), ${org.orgId}, 'OVERHEAD', 'Overhead', true) returning id`))).rows[0]!.id
    const act = { orgId: org.orgId, id: actor } as never

    const created = await withBypass(() => createSetupRecord(act, 'pay-component-department-expenses', {
      payComponentId: componentId,
      departmentId,
      expenseAccountId: overhead,
      effectiveFrom: '2026-01-01',
      isActive: true,
    }))
    assert.equal(created.status, 200)
    const createdId = (created.body as { id: string }).id
    assert.ok(createdId)

    const audits = await withBypass(() => db.execute<{ action: string }>(sql`
      select action from audit_log
       where org_id = ${org.orgId} and table_name = 'pay_component_department_expenses' and row_id = ${createdId}`))
    assert.ok(audits.rows.length > 0, 'mapping changes are audited')

    const overlapping = await withBypass(() => createSetupRecord(act, 'pay-component-department-expenses', {
      payComponentId: componentId,
      departmentId,
      expenseAccountId: wages,
      effectiveFrom: '2026-06-01',
      isActive: true,
    }))
    assert.ok(overlapping.status !== 200, 'an overlapping window refuses')
    assert.match(String((overlapping.body as { error?: string }).error ?? ''), /overlap|already have an active/i)

    // The remedy works: close the existing window, then the successor saves.
    const closed = await withBypass(() => updateSetupRecord(act, 'pay-component-department-expenses', {
      id: createdId,
      payComponentId: componentId,
      departmentId,
      expenseAccountId: overhead,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-05-31',
      isActive: true,
    }))
    assert.equal(closed.status, 200)
    const successor = await withBypass(() => createSetupRecord(act, 'pay-component-department-expenses', {
      payComponentId: componentId,
      departmentId,
      expenseAccountId: wages,
      effectiveFrom: '2026-06-01',
      isActive: true,
    }))
    assert.equal(successor.status, 200, `successor refused: ${JSON.stringify(successor.body)}`)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { BENEFITS_REPORT_ENTITIES } from '../../../packages/reports/src/benefits-entities.ts'
import { compileCustomQuery } from '../../../packages/reports/src/custom-query.ts'
import { BUILT_IN_REPORT_DEFINITION_MAP } from '../../../packages/reports/src/built-ins.ts'
import { db, pool, withOrgContext } from '../platform/db.ts'
import { setupHarness, seedEmployment, withHarness } from '../testing/hrm-harness.ts'

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

// Execute the actual native report SQL against migrated tables. A catalog
// registration test alone cannot catch a misspelled column or an invalid join.
test('benefit report definitions execute on the migrated schema with a tenant and entity clamp', enabled, async () => {
  await withHarness(() => setupHarness({}), async ({ org }) => {
    for (const entity of BENEFITS_REPORT_ENTITIES) {
      const compiled = compileCustomQuery(entity, BUILT_IN_REPORT_DEFINITION_MAP[`workforce-${entity.key.replace(/^hrm_/, '').replaceAll('_', '-')}`]!.query, org.orgId, {
        allowedSubsidiaryIds: [org.subsidiaryId],
      })
      const result = await withOrgContext(org.orgId, () => pool.query(compiled.text, compiled.values))
      assert.deepEqual(result.rows, [], entity.key)
    }
  })
})

test('award report retains snapshot identity, exact currency and lifecycle while refusing an empty entity scope', enabled, async () => {
  await withHarness(() => setupHarness({}), async ({ org }) => {
    const employment = await seedEmployment(org.orgId, org.subsidiaryId, { displayName: 'Benefit recipient' })
    const program = (await db.execute<{ id: string }>(sql`
      insert into hrm_benefit_programs
        (org_id, code, name, family, legal_entity_id, currency, effective_from,
         delivery_method, valuation, fixed_amount)
      values (${org.orgId}, 'RECOGNITION', 'Current policy title', 'reward', ${org.subsidiaryId},
              'USD', '2026-01-01', 'external', 'fixed', '25.0000') returning id
    `)).rows[0]!
    await db.execute(sql`
      insert into hrm_benefit_awards
        (org_id, program_id, employment_id, period_from, period_to, value, currency,
         program_snapshot, source_snapshot)
      values (${org.orgId}, ${program.id}, ${employment.employmentId}, '2026-07-01', '2026-07-31',
              '25.0100', 'USD', '{"name":"Recorded recognition policy","family":"reward"}'::jsonb, '{}'::jsonb)
    `)
    const entity = BENEFITS_REPORT_ENTITIES.find((item) => item.key === 'hrm_benefit_awards')!
    const read = async (allowedSubsidiaryIds: string[]) => {
      const compiled = compileCustomQuery(entity, BUILT_IN_REPORT_DEFINITION_MAP[`workforce-${entity.key.replace(/^hrm_/, '').replaceAll('_', '-')}`]!.query, org.orgId, { allowedSubsidiaryIds })
      return withOrgContext(org.orgId, () => pool.query(compiled.text, compiled.values))
    }
    const visible = await read([org.subsidiaryId])
    assert.equal(visible.rows.length, 1)
    assert.equal(visible.rows[0].program, 'Recorded recognition policy')
    assert.equal(visible.rows[0].value, '25.0100')
    assert.equal(visible.rows[0].currency, 'USD')
    assert.equal(visible.rows[0].status, 'draft')
    assert.deepEqual((await read([])).rows, [])
  })
})

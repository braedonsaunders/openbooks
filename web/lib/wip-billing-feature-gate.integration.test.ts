import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createPrebill, WipBillingError } = await import('./wip-billing')

test('WIP service refuses direct creation when WIP Billing is disabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId
      const profile = BUILTIN_PROJECT_TYPES.find((type) => type.key === 'time_and_materials')!
      const typeId = randomUUID()
      const projectId = randomUUID()
      const employeeId = randomUUID()
      const timeEntryId = randomUUID()
      await db.execute(sql`
        insert into project_types(id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
        values (${typeId}, ${org.orgId}, 'wip_gate', 'WIP gate', 'time_and_materials',
                ${JSON.stringify(profile.invoicingProfile)}::jsonb, ${JSON.stringify(profile.backupProfile)}::jsonb)
      `)
      await db.execute(sql`
        insert into project_financial_profile_versions(org_id, project_type_id, effective_from, financial_profile, reason)
        values (${org.orgId}, ${typeId}, '2000-01-01', ${JSON.stringify(profile.financialProfile)}::jsonb, 'WIP gate test')
      `)
      await db.execute(sql`
        insert into projects(id, org_id, subsidiary_id, code, name, customer_id, project_type_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'WIP-GATE', 'WIP gate project', ${org.customerId}, ${typeId}, 'active', true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into parties(id, org_id, kind, display_name, subsidiary_id)
        values (${employeeId}, ${org.orgId}, 'employee', 'WIP gate worker', ${org.subsidiaryId})
      `)
      await db.execute(sql`
        insert into time_entries(id, org_id, employee_party_id, worked_on, hours, project_id, item_id,
                                 is_billable, status, bill_rate, bill_rate_currency)
        values (${timeEntryId}, ${org.orgId}, ${employeeId}, ${org.date}, '2.0000', ${projectId}, ${org.items.service},
                true, 'approved', '100.0000', 'CAD')
      `)

      await assert.rejects(
        createPrebill(org.orgId, actor, { projectId, periodEnd: org.date }),
        (error: unknown) => error instanceof WipBillingError && error.status === 404 && /wip billing feature is disabled/i.test(error.message),
      )
      assert.equal(
        (await db.execute<{ n: number }>(sql`select count(*)::int as n from wip_prebills where org_id=${org.orgId}`)).rows[0]!.n,
        0,
      )
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

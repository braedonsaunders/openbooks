import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import { withAuthzContext } from '../../../lib/authz-context.ts'
import { resolveItemRate, snapshotTimeBillRates } from '../../../lib/item-rates.ts'
import { POST } from './route.ts'

test('native bill-only books retain unknown cost, explicit pins and earlier versions', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features,projects}','true'::jsonb,true)
       where id=${org.orgId}`))
    const post = (body: Record<string, unknown>) => withAuthzContext({
      user: { id: actorId, orgId: org.orgId, email: 'pricing@example.test', name: 'Pricing administrator',
        roles: [], envKind: 'production', productionOrgId: org.orgId, homeUserId: actorId,
        homeOrgId: org.orgId, isSuperAdmin: false },
      permissions: new Set(['admin.setup.manage']), allowedSubsidiaryIds: null,
    }, () => POST(new Request('http://openbooks.test/api/item-rate-books', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })))
    const line = { itemId: org.items.service, unitCode: 'hour', unitName: 'Hour', baseQuantity: '1',
      costRate: null, billRate: '80', baseUnit: 'hour', pricingPolicy: 'explicit', invoicePresentation: 'rate_components' }
    const saved = await post({ code: 'BILL-ONLY', name: 'Bill-only book', isDefault: false,
      replaceRates: true, effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', lines: [line] })
    assert.equal(saved.status, 200)
    const { id: bookId, versionId } = await saved.json() as { id: string; versionId: string }
    const read = () => withOrgContext(org.orgId, () => db.execute(sql`
      select to_jsonb(l) as line,to_jsonb(p) as profile from item_rate_lines l
      join item_rate_version_profiles p on p.org_id=l.org_id and p.version_id=l.version_id and p.item_id=l.item_id
      where l.org_id=${org.orgId} and l.version_id=${versionId}`))
    const before = (await read()).rows as { line: { cost_rate: null; bill_rate: string }; profile: { pricing_policy: string } }[]
    assert.equal(before[0]!.line.cost_rate, null)
    assert.equal(String(before[0]!.line.bill_rate), '80.0000')
    assert.equal(before[0]!.profile.pricing_policy, 'explicit')
    const project = randomUUID(), worker = randomUUID(), entry = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
        values(${project},${org.orgId},${org.subsidiaryId},'BILL-ONLY','Bill-only project',${org.customerId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
        values(${worker},${org.orgId},'employee','Bill-only worker',${org.subsidiaryId},true,'{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_book_assignments(org_id,rate_book_id,rate_version_id,project_id,date_basis,is_active)
        values(${org.orgId},${bookId},${versionId},${project},'usage_date',true)`)
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,item_id,project_id,
        status,is_billable,billing_status,custom,created_by,updated_by)
        values(${entry},${org.orgId},${worker},'2025-06-01',2,${org.items.service},${project},'draft',true,'unbilled','{}'::jsonb,${actorId},${actorId})`)
    })
    const billing = await withOrgContext(org.orgId, () => snapshotTimeBillRates(org.orgId, [entry], { dryRun: true }))
    assert.equal(billing.get(entry), '80.0000', 'billing uses the authored rate without inventing cost')
    await assert.rejects(resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service,
      onDate: '2025-06-01', baseQuantity: '2' }), /No cost rates are configured/)
    const invalid = await post({ id: bookId, code: 'BILL-ONLY', name: 'Changed name', replaceRates: true,
      effectiveFrom: '2026-01-01', lines: [{ ...line, costRate: '-1' }] })
    assert.equal(invalid.status, 422)
    const next = await post({ id: bookId, code: 'BILL-ONLY', name: 'Bill-only book', replaceRates: true,
      effectiveFrom: '2026-01-01', lines: [{ ...line, costRate: '0', pricingPolicy: 'lowest_cost' }] })
    assert.equal(next.status, 200)
    assert.deepEqual((await read()).rows, before, 'a new known cost or policy cannot reinterpret the prior version')
    assert.equal((await withOrgContext(org.orgId, () => snapshotTimeBillRates(org.orgId, [entry], { dryRun: true }))).get(entry), '80.0000')
    await assert.rejects(resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service,
      onDate: '2025-06-01', baseQuantity: '2' }), /No cost rates are configured/)
    const audits = (await withOrgContext(org.orgId, () => db.execute<{ actor_id: string }>(sql`
      select actor_id from audit_log where org_id=${org.orgId} and table_name='item_rate_versions'`))).rows
    assert.equal(audits.length, 2)
    assert.ok(audits.every((row) => row.actor_id === actorId))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { cmp } from '@openbooks/engine/src/money/money.ts'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import { withAuthzContext } from '../../../lib/authz-context.ts'
import { resolveItemRate, snapshotTimeBillRates } from '../../../lib/item-rates.ts'
import { POST } from './route.ts'
import { POST as assignRateBook } from '../rate-book-assignments/route.ts'

test('native bill-only books retain unknown cost, explicit pins and earlier versions', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features,projects}','true'::jsonb,true)
       where id=${org.orgId}`))
    const asPrincipal = <T>(work: () => T) => withAuthzContext({
      user: { id: actorId, orgId: org.orgId, email: 'pricing@example.test', name: 'Pricing administrator',
        roles: [], envKind: 'production', productionOrgId: org.orgId, homeUserId: actorId,
        homeOrgId: org.orgId, isSuperAdmin: false },
      permissions: new Set(['admin.setup.manage', 'projects.manage']), allowedSubsidiaryIds: null,
    }, work)
    const post = (body: Record<string, unknown>) => asPrincipal(() => POST(new Request('http://openbooks.test/api/item-rate-books', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })))
    const line = { itemId: org.items.service, unitCode: 'hour', unitName: 'Hour', baseQuantity: '1',
      costRate: null, billRate: '80', baseUnit: 'hour', pricingPolicy: 'explicit', invoicePresentation: 'rate_components' }
    const saved = await post({ code: 'BILL-ONLY', name: 'Bill-only book', isDefault: false,
      replaceRates: true, effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31',
      laborDerivationPolicy: 'time_type_multipliers', lines: [line] })
    assert.equal(saved.status, 200)
    const { id: bookId, versionId } = await saved.json() as { id: string; versionId: string }
    const read = () => withOrgContext(org.orgId, () => db.execute(sql`
      select to_jsonb(l) as line,to_jsonb(p) as profile from item_rate_lines l
      join item_rate_version_profiles p on p.org_id=l.org_id and p.version_id=l.version_id and p.item_id=l.item_id
      where l.org_id=${org.orgId} and l.version_id=${versionId}`))
    const before = (await read()).rows as { line: { cost_rate: null; bill_rate: string }; profile: { pricing_policy: string } }[]
    assert.equal(before[0]!.line.cost_rate, null)
    assert.equal(cmp(String(before[0]!.line.bill_rate), '80'), 0)
    assert.equal(before[0]!.profile.pricing_policy, 'explicit')
    const readPolicy = (id: string) => withOrgContext(org.orgId, async () =>
      (await db.execute(sql`select * from labor_rate_version_policies where org_id=${org.orgId} and version_id=${id}`)).rows)
    const originalPolicy = await readPolicy(versionId)
    assert.equal(originalPolicy.length, 1)
    assert.equal(originalPolicy[0]!.derivation_policy, 'time_type_multipliers', 'version policy is independent of the item profile')
    const project = randomUUID(), worker = randomUUID(), entry = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
        values(${project},${org.orgId},${org.subsidiaryId},'BILL-ONLY','Bill-only project',${org.customerId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
        values(${worker},${org.orgId},'employee','Bill-only worker',${org.subsidiaryId},true,'{}'::jsonb)`)
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,item_id,project_id,
        status,is_billable,billing_status,custom,created_by,updated_by)
        values(${entry},${org.orgId},${worker},'2025-06-01',2,${org.items.service},${project},'draft',true,'unbilled','{}'::jsonb,${actorId},${actorId})`)
    })
    const assign = (rateBookId: string, rateVersionId: string) => asPrincipal(() => assignRateBook(
      new Request('http://openbooks.test/api/rate-book-assignments', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rateBookId, rateVersionId,
          projectId: project, effectiveFrom: null, effectiveTo: null, dateBasis: 'usage_date', isActive: true }) })))
    const assigned = await assign(bookId, versionId)
    assert.equal(assigned.status, 200, 'the native assignment writer resolves the authored labor policy and exact version pin')
    const assignmentBefore = await withOrgContext(org.orgId, async () =>
      (await db.execute(sql`select * from item_rate_book_assignments where org_id=${org.orgId} and project_id=${project}`)).rows)
    assert.equal(assignmentBefore[0]!.rate_version_id, versionId)
    assert.equal(assignmentBefore[0]!.date_basis, 'usage_date')
    const generic = await post({ code: 'ITEM-ONLY', name: 'Item pricing only', isDefault: false,
      replaceRates: true, effectiveFrom: '2025-01-01', lines: [line] })
    assert.equal(generic.status, 200)
    const genericBook = await generic.json() as { id: string; versionId: string }
    assert.deepEqual(await readPolicy(genericBook.versionId), [], 'generic item pricing is not silently registered as a labor card')
    const refusedAssignment = await assign(genericBook.id, genericBook.versionId)
    assert.equal(refusedAssignment.status, 400)
    assert.deepEqual(await refusedAssignment.json(), { errorCode: 'references' })
    const billing = await withOrgContext(org.orgId, () => snapshotTimeBillRates(org.orgId, [entry], { dryRun: true }))
    assert.ok(billing.has(entry))
    assert.equal(cmp(billing.get(entry)!, '80'), 0, 'billing uses the authored rate without inventing cost')
    await assert.rejects(resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service,
      onDate: '2025-06-01', baseQuantity: '2' }), /No cost rates are configured/)
    const invalid = await post({ id: bookId, code: 'BILL-ONLY', name: 'Changed name', replaceRates: true,
      effectiveFrom: '2026-01-01', lines: [{ ...line, costRate: '-1' }] })
    assert.equal(invalid.status, 422)
    const next = await post({ id: bookId, code: 'BILL-ONLY', name: 'Bill-only book', replaceRates: true,
      effectiveFrom: '2026-01-01', lines: [{ ...line, costRate: '0', pricingPolicy: 'lowest_cost' }] })
    assert.equal(next.status, 200)
    const nextVersion = await next.json() as { versionId: string }
    assert.equal((await readPolicy(nextVersion.versionId))[0]!.derivation_policy, 'time_type_multipliers',
      'ordinary price replacement carries forward the registered policy')
    assert.deepEqual(await readPolicy(versionId), originalPolicy)
    const headerOnlyPolicy = await post({ id: bookId, code: 'BILL-ONLY', name: 'Bill-only book',
      laborDerivationPolicy: 'explicit', replaceRates: false })
    assert.equal(headerOnlyPolicy.status, 422, 'a policy cannot change outside an effective-dated version')
    const explicit = await post({ id: bookId, code: 'BILL-ONLY', name: 'Bill-only book', replaceRates: true,
      effectiveFrom: '2027-01-01', laborDerivationPolicy: 'explicit', lines: [{ ...line, costRate: '0' }] })
    assert.equal(explicit.status, 200)
    assert.equal((await readPolicy((await explicit.json() as { versionId: string }).versionId))[0]!.derivation_policy, 'explicit')
    assert.deepEqual(await readPolicy(versionId), originalPolicy, 'a later explicit policy preserves the earlier whole policy row')
    assert.deepEqual(await withOrgContext(org.orgId, async () =>
      (await db.execute(sql`select * from item_rate_book_assignments where org_id=${org.orgId} and project_id=${project}`)).rows), assignmentBefore)
    assert.deepEqual((await read()).rows, before, 'a new known cost or policy cannot reinterpret the prior version')
    const preservedBilling = await withOrgContext(org.orgId, () => snapshotTimeBillRates(org.orgId, [entry], { dryRun: true }))
    assert.ok(preservedBilling.has(entry))
    assert.equal(cmp(preservedBilling.get(entry)!, '80'), 0)
    await assert.rejects(resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service,
      onDate: '2025-06-01', baseQuantity: '2' }), /No cost rates are configured/)
    const audits = (await withOrgContext(org.orgId, () => db.execute<{ actor_id: string; changes: { laborPolicy: { before: null; after: Record<string, unknown> } } }>(sql`
      select actor_id, changes from audit_log where org_id=${org.orgId} and table_name='item_rate_versions'
       and row_id in (select id from item_rate_versions where org_id=${org.orgId} and rate_book_id=${bookId})`))).rows
    assert.equal(audits.length, 3)
    assert.ok(audits.every((row) => row.actor_id === actorId))
    assert.ok(audits.every(row => row.changes.laborPolicy.before === null && row.changes.laborPolicy.after.org_id === org.orgId))
    assert.deepEqual(audits.find(row => row.changes.laborPolicy.after.version_id === versionId)!.changes.laborPolicy.after,
      JSON.parse(JSON.stringify(originalPolicy[0])), 'the version audit retains the exact actor-authored policy image')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

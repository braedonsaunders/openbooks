import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

type Pricing = { priced: string; entries: string }
const capture = { result: null as Pricing | null }
const captureKey = Symbol.for('openbooks.true-cost-card-pricing-test')
;(globalThis as typeof globalThis & Record<symbol, unknown>)[captureKey] = capture
const queryModule = new URL('./query.ts', import.meta.url).href
const dialectModule = import.meta.resolve('drizzle-orm/pg-core')
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './query' && context.parentURL?.endsWith('/analytics/true-cost-data.ts')) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
      import { analyticsQuery as read } from ${JSON.stringify(queryModule)};
      import { PgDialect } from ${JSON.stringify(dialectModule)};
      const dialect = new PgDialect();
      export async function analyticsQuery(query) {
        const result = await read(query);
        if (dialect.sqlToQuery(query).sql.includes('sum(t.hours * card.rate)')) {
          globalThis[Symbol.for('openbooks.true-cost-card-pricing-test')].result = result.rows[0];
        }
        return result;
      }
    `)}` }
  }
  if (specifier === 'next/headers') return { shortCircuit: true, url: 'data:text/javascript,export function cookies(){return {get(){return undefined}}}' }
  return next(specifier, context)
} })
test.after(() => hooks.deregister())

const { sql } = await import('drizzle-orm')
const { db, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { assertDedicatedFixtureDatabase } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { JULY, withTrueCostOrg } = await import('@openbooks/engine/src/testing/true-cost-fixtures.ts')
const { overheadRateAppliesToDriver, OVERHEAD_ZERO_APPLIED_MARKER } = await import('@openbooks/engine/allocations/overhead-application')
const { compareDecimal } = await import('@openbooks/engine/money/decimal')
const { trueCostData } = await import('./true-cost-data')

/** Per-entry pricing is the reference for aggregation: no intermediate
 * rounding, and the same native eligibility and effective-date kernel. */
async function perEntryPricing(orgId: string, scope: ReadonlySet<string> | null): Promise<Pricing> {
  const ids = scope === null ? null : [...scope]
  const allowed = ids?.length ? sql.join(ids.map(id => sql`${id}::uuid`), sql`, `) : sql`null`
  const result = await db.execute<Pricing>(sql`
    select coalesce(sum(t.hours * card.rate), 0) as priced, count(*) as entries
      from time_entries t
      join lateral (
        select coalesce(sum(r.rate_percent), 0) as rate from overhead_rates r
         where r.rate_kind = 'per_hour'
           and ${overheadRateAppliesToDriver('r', { orgId: sql`t.org_id`, workedOn: sql`t.worked_on`, departmentId: sql`t.department_id` }, { method: 'standard' })}
      ) card on true
     where t.org_id = ${orgId} and t.worked_on >= ${JULY.from} and t.worked_on <= ${JULY.to}
       and t.status = 'approved' and t.project_id is not null and t.costing_basis = 'actual'
       and (t.custom ->> ${OVERHEAD_ZERO_APPLIED_MARKER}) is distinct from 'true'
       ${ids === null ? sql`` : sql`and exists (
         select 1 from parties scope_employee
         left join projects scope_project on scope_project.id = t.project_id and scope_project.org_id = t.org_id
         where scope_employee.id = t.employee_party_id and scope_employee.org_id = t.org_id
           and coalesce(scope_project.subsidiary_id, scope_employee.subsidiary_id) in (${allowed})
       )`}
       and not exists (
         select 1 from projects p join project_types pt on pt.id = p.project_type_id and pt.org_id = t.org_id
          where p.id = t.project_id and p.org_id = t.org_id
            and (select v.financial_profile->'overhead'->>'method'
                   from project_financial_profile_versions v
                  where v.org_id = t.org_id and v.project_type_id = pt.id
                    and v.effective_from <= t.worked_on and (v.effective_to is null or v.effective_to >= t.worked_on)
                  order by v.effective_from desc limit 1) = 'none'
       )
  `)
  assert.ok(result.rows[0])
  return result.rows[0]
}

test('grouped standard-card pricing preserves exact entries, dated specificity, legal-entity scope and fresh cards', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await assertDedicatedFixtureDatabase()
  await withTrueCostOrg({
    depts: ['Field', 'Shop'], projects: ['CARD-1', 'SCOPE-2'],
    employees: [
      { name: 'Field A', dept: 0, project: 0, hours: '0.1000' },
      { name: 'Field B', dept: 0, project: 0, hours: '0.2000' },
      { name: 'Field next day', dept: 0, project: 0, hours: '1.2500', date: '2026-07-15' },
      { name: 'Shop worker', dept: 1, project: 0, hours: '2.5000' },
    ],
    burdenAccounts: [{ number: '7850', name: 'Rent' }],
    journals: [{ entry: 'CARD-BURDEN', lines: [{ account: 0, amount: '100' }, { account: 'bank', amount: '-100' }] }],
  }, async seed => {
    const orgId = seed.org.orgId
    const otherSub = randomUUID(), otherEmployee = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into overhead_rates(org_id,department_id,category,method,rate_kind,rate_percent,effective_from,effective_to)
        values(${orgId},null,'Fallback','standard','per_hour','0.1234','2026-01-01',null),
              (${orgId},${seed.deptIds[0]},'Facilities','standard','per_hour','0.1100','2026-07-01','2026-07-14'),
              (${orgId},${seed.deptIds[0]},'Admin','standard','per_hour','0.2200','2026-07-01','2026-07-14'),
              (${orgId},${seed.deptIds[0]},'Facilities','standard','per_hour','0.4568','2026-07-15',null),
              (${orgId},${seed.deptIds[1]},'Budget','budget','per_hour','99','2026-01-01',null),
              (${orgId},${seed.deptIds[0]},'Percentage','standard','percent','50','2026-01-01',null)`)
      await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,status,department_id,project_id)
        select ${orgId},${seed.empIds[0]},'2026-07-14'::date,'0.0001'::numeric,'approved',${seed.deptIds[0]},${seed.projectIds[0]}
          from generate_series(1,100)`)
      await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,status,department_id,project_id,costing_basis,custom)
        values(${orgId},${seed.empIds[0]},'2026-07-14','0.5000','approved',null,${seed.projectIds[0]},'actual','{}'),
              (${orgId},${seed.empIds[0]},'2026-07-14','100','draft',${seed.deptIds[0]},${seed.projectIds[0]},'actual','{}'),
              (${orgId},${seed.empIds[0]},'2026-07-14','100','approved',${seed.deptIds[0]},${seed.projectIds[0]},'estimated','{}'),
              (${orgId},${seed.empIds[0]},'2026-07-14','100','approved',${seed.deptIds[0]},null,'actual','{}'),
              (${orgId},${seed.empIds[0]},'2026-07-14','100','approved',${seed.deptIds[0]},${seed.projectIds[0]},'actual',${JSON.stringify({ [OVERHEAD_ZERO_APPLIED_MARKER]: true })}::jsonb)`)
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${otherSub},${orgId},${seed.org.subsidiaryId},'Second entity','CAD','CA')`)
      await db.execute(sql`update projects set subsidiary_id=${otherSub} where id=${seed.projectIds[1]} and org_id=${orgId}`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
        values(${otherEmployee},${orgId},'person','Second entity worker',${otherSub})`)
      await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,status,department_id,project_id)
        values(${orgId},${otherEmployee},'2026-07-14','10','approved',${seed.deptIds[0]},${seed.projectIds[1]})`)
    })
    const history = async () => (await db.execute(sql`select * from journal_lines where org_id=${orgId} order by id`)).rows
    const before = await history()
    const compare = async (scope: ReadonlySet<string> | null, amount: string, entries: number) => {
      const reference = await perEntryPricing(orgId, scope)
      capture.result = null
      const model = await trueCostData(orgId, JULY, scope)
      assert.ok(capture.result, 'the native aggregate must execute')
      assert.equal(compareDecimal(String(capture.result.priced), String(reference.priced)), 0)
      assert.equal(compareDecimal(String(capture.result.priced), amount), 0)
      assert.equal(Number(capture.result.entries), Number(reference.entries))
      assert.equal(Number(capture.result.entries), entries)
      assert.equal(model.appliedSource, entries ? 'standard-cards' : null)
    }
    await compare(null, '4.3435', 106)
    await compare(new Set([seed.org.subsidiaryId]), '1.0435', 105)
    await compare(new Set([otherSub]), '3.3', 1)
    await compare(new Set(), '0', 0)
    await compare(new Set([randomUUID()]), '0', 0)
    await withBypass(() => db.execute(sql`insert into overhead_rates(org_id,department_id,category,method,rate_kind,rate_percent,effective_from)
      values(${orgId},${seed.deptIds[1]},'Current shop','standard','per_hour','0.2000','2026-01-01')`))
    await compare(new Set([seed.org.subsidiaryId]), '1.2350', 105)
    await withBypass(() => db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,status,department_id,project_id)
      values(${orgId},${seed.empIds[0]},'2026-07-14','0.0001','approved',${seed.deptIds[0]},${seed.projectIds[0]})`))
    const scope = new Set([seed.org.subsidiaryId])
    const reference = await perEntryPricing(orgId, scope)
    assert.equal(compareDecimal(String(reference.priced), '1.235033'), 0)
    capture.result = null
    await assert.rejects(() => trueCostData(orgId, JULY, scope), /loses precision beyond 4 decimal places/)
    assert.ok(capture.result)
    assert.equal(compareDecimal(String(capture.result.priced), String(reference.priced)), 0)
    assert.equal(Number(capture.result.entries), 106)
    assert.deepEqual(await history(), before, 'pricing reads must preserve posted history')
  })
})

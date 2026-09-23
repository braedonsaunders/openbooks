import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// copy / copy_prior_actuals / apply_source map source lines to destination
// periods with an INNER JOIN and used to delete target lines first: a target
// year missing any source period silently dropped those lines (possibly all)
// while the revision incremented and the API reported success. Every action
// now verifies the FULL mapping before any write and refuses naming the
// unmapped periods.

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null } = {
  orgId: '', actorId: '', allowed: null,
}
Object.assign(globalThis, { __budgetActionsState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__budgetActionsState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: s.allowed };
      }
    `)
    if (specifier === '../../../../../lib/authz') return virtual(`
      export function can() { return true }
      export function subsidiariesInScope(gate, ids) {
        const scope = gate.allowedSubsidiaryIds;
        if (scope === null) return true;
        return ids.every((id) => id !== null && id !== undefined && id !== '' && scope.has(id));
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

interface Org {
  orgId: string
  bookId: string
  subsidiaryId: string
  periodId: string
  calendarId: string
  cogsId: string
  accounts: Record<string, string>
}

async function seedOrg(): Promise<Org> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  state.allowed = null
  const calendarId = (await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
  // The target year carries exactly one period: any source line outside
  // period 1 has no destination and must block the action.
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${randomUUID()}, ${org.orgId}, 2027, 1, '2027-01', '2027-01-01', '2027-01-31', false, ${calendarId})`)
  return {
    orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
    periodId: org.periodId, calendarId, cogsId: org.accounts.cogs,
    accounts: org.accounts,
  }
}

async function seedScenario(org: Org, year: number, name: string): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
    values (${id}, ${org.orgId}, ${org.bookId}, ${year}, ${name}, 'budget', 'draft')`)
  return id
}

async function seedLine(org: Org, scenarioId: string, periodId: string, amount: string): Promise<void> {
  await db.execute(sql`
    insert into budget_lines
      (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
    values (${org.orgId}, ${scenarioId}, ${org.cogsId}, ${periodId}, ${org.subsidiaryId},
            ${amount}, ${state.actorId}, ${state.actorId})`)
}

async function seedPostedActual(
  org: Org & { accounts: Record<string, string> },
  periodId: string,
): Promise<void> {
  const entryId = randomUUID()
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'ACT-1', '2026-07-15',
            ${periodId}, 'draft', 'manual')`)
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
    values (${org.orgId}, ${entryId}, 1, ${org.cogsId}, ${org.subsidiaryId}, 500, 'CAD', 500, 1, ''),
           (${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, -500, 'CAD', -500, 1, '')`)
  await db.execute(sql`
    update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`)
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })
async function post(id: string, body: unknown) {
  return withOrgContext(state.orgId, () => POST(
    new Request(`http://budget.test/api/budgets/${id}/actions`, { method: 'POST', body: JSON.stringify(body) }),
    params(id),
  ))
}
async function scenarioState(id: string, orgId: string) {
  const scenario = (await db.execute<{ revision: number }>(sql`
    select revision from budget_scenarios where id = ${id} and org_id = ${orgId}`)).rows[0]
  const lineCount = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from budget_lines where scenario_id = ${id} and org_id = ${orgId}`)).rows[0]!.n
  return { revision: scenario?.revision ?? null, lines: lineCount }
}

test('copy refuses when the target year misses a source period, writing nothing', { skip: !DB }, async () => {
  const org = await seedOrg()
  try {
    const sourceId = await seedScenario(org, 2026, 'Source 2026')
    await seedLine(org, sourceId, org.periodId, '1200.0000')
    const before = await scenarioState(sourceId, org.orgId)
    const scenarioCount = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from budget_scenarios where org_id = ${org.orgId}`)).rows[0]!.n

    const response = await post(sourceId, { action: 'copy', fiscalYear: 2027, expectedRevision: 1 })
    const body = (await response.json()) as { error?: string }
    assert.match(body.error ?? '', /unmapped_periods/, `copy must refuse naming periods: ${JSON.stringify(body)}`)
    assert.match(body.error ?? '', /2026-07/, 'the refusal names the unmapped source period')

    const after = await scenarioState(sourceId, org.orgId)
    assert.deepEqual(after, before, 'the refused copy changes neither revision nor lines')
    const countAfter = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from budget_scenarios where org_id = ${org.orgId}`)).rows[0]!.n
    assert.equal(countAfter, scenarioCount, 'the refused copy creates no scenario')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('apply_source refuses before its delete, keeping the target lines', { skip: !DB }, async () => {
  const org = await seedOrg()
  try {
    const sourceId = await seedScenario(org, 2026, 'Source 2026')
    await seedLine(org, sourceId, org.periodId, '1200.0000')
    const targetId = await seedScenario(org, 2027, 'Target 2027')
    const targetPeriod = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods where org_id = ${org.orgId} and fiscal_year = 2027`)).rows[0]!.id
    await seedLine(org, targetId, targetPeriod, '100.0000')
    const before = await scenarioState(targetId, org.orgId)
    assert.equal(before.lines, 1)

    const response = await post(targetId, { action: 'apply_source', sourceScenarioId: sourceId, expectedRevision: 1 })
    const body = (await response.json()) as { error?: string }
    assert.match(body.error ?? '', /unmapped_periods/, `apply must refuse naming periods: ${JSON.stringify(body)}`)

    const after = await scenarioState(targetId, org.orgId)
    assert.deepEqual(after, before, 'the refused apply keeps the target lines it would have deleted first')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('copy_prior_actuals refuses before its delete when prior actuals lack a destination period', { skip: !DB }, async () => {
  const org = await seedOrg()
  try {
    const targetId = await seedScenario(org, 2027, 'Target 2027')
    const targetPeriod = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods where org_id = ${org.orgId} and fiscal_year = 2027`)).rows[0]!.id
    await seedLine(org, targetId, targetPeriod, '100.0000')
    // Real posted actuals in 2026-07 (period 7): 2027 carries only period 1.
    await seedPostedActual(org, org.periodId)
    const before = await scenarioState(targetId, org.orgId)

    const response = await post(targetId, { action: 'copy_prior_actuals', expectedRevision: 1 })
    const body = (await response.json()) as { error?: string }
    assert.match(body.error ?? '', /unmapped_periods/, `actuals copy must refuse: ${JSON.stringify(body)}`)
    assert.match(body.error ?? '', /2026-07/)

    const after = await scenarioState(targetId, org.orgId)
    assert.deepEqual(after, before, 'the refused actuals copy keeps the lines it would have deleted first')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

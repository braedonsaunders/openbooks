import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Spreadsheet names can repeat: period names repeat across fiscal calendars,
// dimension codes carry no uniqueness, and account names are not unique. The
// import used to resolve collisions by row order (last writer wins). An
// ambiguous folded name now refuses naming every candidate; periods resolve
// within the budget's pinned (default) calendar only.

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null } = {
  orgId: '', actorId: '', allowed: null,
}
Object.assign(globalThis, { __budgetAmbiguityState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__budgetAmbiguityState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: s.allowed };
      }
    `)
    if (specifier === '../../../../../lib/authz') return virtual(`
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

function csv(rows: string[][]) {
  return rows.map((cells) => cells.map((c) => `"${c.replaceAll('"', '""')}"`).join(',')).join('\n')
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })
async function post(id: string, body: unknown) {
  return withOrgContext(state.orgId, () => POST(
    new Request(`http://budget.test/api/budgets/${id}/import`, { method: 'POST', body: JSON.stringify(body) }),
    params(id),
  ))
}

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  state.allowed = null
  // Two P&L accounts sharing one name: resolving by name must refuse.
  for (const number of ['9001', '9002']) {
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active)
      values (${randomUUID()}, ${org.orgId}, ${number}, 'Dupe Account', 'expense', false, true)`)
  }
  // Two departments sharing one name (codes differ): same refusal.
  for (const code of ['D1', 'D2']) {
    await db.execute(sql`
      insert into departments (id, org_id, code, name, is_active)
      values (${randomUUID()}, ${org.orgId}, ${code}, 'Dupe Dept', true)`)
  }
  // A second calendar reusing the default period's name.
  const otherCalendar = randomUUID()
  await db.execute(sql`
    insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                                  adjustment_period_enabled, is_default, is_active, config)
    values (${otherCalendar}, ${org.orgId}, 'Retail', 'monthly', 1, 1, 'UTC', false, false, true, '{}'::jsonb)`)
  const otherPeriod = randomUUID()
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${otherPeriod}, ${org.orgId}, 2026, 7, '2026-07', '2026-07-01', '2026-07-31', false, ${otherCalendar})`)
  const accountNumber = (await db.execute<{ number: string }>(sql`
    select number from accounts where id = ${org.accounts.cogs}`)).rows[0]!.number
  const scenarioId = randomUUID()
  await db.execute(sql`
    insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
    values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Ambiguity Target', 'budget', 'draft')`)
  return { org, accountNumber, scenarioId, otherPeriod }
}

test('import refuses ambiguous names naming the candidates', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const text = csv([
      ['Account Number', 'Account Name', 'Period', 'Department', 'Amount'],
      ['', '', '2026-07', '', '100'],
      ['', 'Dupe Account', '2026-07', '', '100'],
      [f.accountNumber, '', '2026-07', 'Dupe Dept', '100'],
    ])
    const dry = await post(f.scenarioId, { format: 'csv', text, expectedRevision: 1 })
    assert.equal(dry.status, 200)
    const result = (await dry.json()) as {
      valid: boolean
      errors: { row: number; field: string; message: string }[]
    }
    assert.equal(result.valid, false)
    const byRow = new Map(result.errors.map((e) => [e.row, e.message]))
    // Row 2: blank number + blank name side... 'Account Name' column absent,
    // so the number cell is blank and no name is supplied: unknown.
    assert.equal(byRow.get(2), 'unknown_account')
    const dupAccount = result.errors.find((e) => e.row === 3)
    assert.match(dupAccount?.message ?? '', /ambiguous_account/, 'duplicate account name refuses')
    assert.match(dupAccount?.message ?? '', /9001/, 'the refusal names the first candidate')
    assert.match(dupAccount?.message ?? '', /9002/, 'the refusal names the second candidate')
    const dupDept = result.errors.find((e) => e.row === 4)
    assert.match(dupDept?.message ?? '', /ambiguous_dimension/, 'duplicate department name refuses')
    assert.match(dupDept?.message ?? '', /D1/, 'the refusal names department candidates')
  } finally {
    await dropScratchOrg(f.org.orgId)
  }
})

test('import resolves a repeated period name within the default calendar', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const text = csv([
      ['Account Number', 'Period', 'Amount'],
      [f.accountNumber, '2026-07', '100'],
    ])
    const dry = await post(f.scenarioId, { format: 'csv', text, expectedRevision: 1 })
    assert.equal(dry.status, 200)
    const result = (await dry.json()) as { valid: boolean; errors: unknown[] }
    assert.equal(result.valid, true, `repeated period name must resolve: ${JSON.stringify(result.errors)}`)

    const committed = await post(f.scenarioId, { format: 'csv', text, expectedRevision: 1, commit: true })
    assert.equal(committed.status, 200)
    const line = (await db.execute<{ period_id: string }>(sql`
      select period_id from budget_lines where scenario_id = ${f.scenarioId} and org_id = ${f.org.orgId}`)).rows[0]!
    assert.equal(line.period_id, f.org.periodId, 'the line lands on the default-calendar period, not the same-named one')
  } finally {
    await dropScratchOrg(f.org.orgId)
  }
})

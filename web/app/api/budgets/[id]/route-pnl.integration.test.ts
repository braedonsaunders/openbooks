import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Budgets cover the P&L only — the worksheet, the variances and the
// prior-actuals copy all filter on the six P&L types of the single PNL_TYPES
// definition. Balance-sheet lines were hidden from the worksheet yet counted
// in totals. The import, the save API and the line trigger now refuse them
// by name.

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null } = {
  orgId: '', actorId: '', allowed: null,
}
Object.assign(globalThis, { __budgetPnlState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier.endsWith('/lib/feature-gates')) return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__budgetPnlState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: s.allowed };
      }
    `)
    if (specifier.endsWith('/lib/authz')) return virtual(`
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
const { POST: importPost } = await import('./import/route.ts')
const { PATCH: linesPatch } = await import('./lines/route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

function csv(rows: string[][]) {
  return rows.map((cells) => cells.map((c) => `"${c.replaceAll('"', '""')}"`).join(',')).join('\n')
}

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  state.allowed = null
  const bankNumber = (await db.execute<{ number: string }>(sql`
    select number from accounts where id = ${org.accounts.bank}`)).rows[0]!.number
  const bankName = (await db.execute<{ name: string }>(sql`
    select name from accounts where id = ${org.accounts.bank}`)).rows[0]!.name
  const scenarioId = randomUUID()
  await db.execute(sql`
    insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
    values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'P&L Target', 'budget', 'draft')`)
  return { org, bankNumber, bankName, scenarioId }
}

test('import refuses a balance-sheet account by name', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const text = csv([
      ['Account Number', 'Period', 'Amount'],
      [f.bankNumber, '2026-07', '100'],
    ])
    const dry = await withOrgContext(state.orgId, () => importPost(
      new Request(`http://budget.test/api/budgets/${f.scenarioId}/import`, {
        method: 'POST',
        body: JSON.stringify({ format: 'csv', text, expectedRevision: 1 }),
      }),
      { params: Promise.resolve({ id: f.scenarioId }) },
    ))
    const result = (await dry.json()) as { valid: boolean; errors: { message: string }[] }
    assert.equal(result.valid, false)
    assert.match(result.errors[0]!.message, /non_pnl_account/, 'a balance-sheet account refuses')
    assert.match(result.errors[0]!.message, new RegExp(f.bankName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the refusal names the account')
  } finally {
    await dropScratchOrg(f.org.orgId)
  }
})

test('the worksheet save refuses a balance-sheet account by name', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const response = await withOrgContext(state.orgId, () => linesPatch(
      new Request(`http://budget.test/api/budgets/${f.scenarioId}/lines`, {
        method: 'PATCH',
        body: JSON.stringify({
          expectedRevision: 1,
          cells: [{
            accountId: f.org.accounts.bank,
            periodId: f.org.periodId,
            subsidiaryId: f.org.subsidiaryId,
            amount: '100.0000',
          }],
        }),
      }),
      { params: Promise.resolve({ id: f.scenarioId }) },
    ))
    const body = (await response.json()) as { error?: string }
    assert.match(body.error ?? '', /non_pnl_account/, `the save must refuse: ${JSON.stringify(body)}`)
    const count = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from budget_lines where scenario_id = ${f.scenarioId} and org_id = ${f.org.orgId}`)).rows[0]!.n
    assert.equal(count, 0, 'nothing is written')
  } finally {
    await dropScratchOrg(f.org.orgId)
  }
})

test('the line trigger refuses a balance-sheet account for direct writers', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      db.execute(sql`
        insert into budget_lines
          (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
        values (${f.org.orgId}, ${f.scenarioId}, ${f.org.accounts.bank}, ${f.org.periodId},
                ${f.org.subsidiaryId}, '100.0000', ${state.actorId}, ${state.actorId})`),
      (error: unknown) => {
        let current: unknown = error
        while (current instanceof Error) {
          if (/profit-and-loss/.test(current.message)) return true
          current = (current as Error & { cause?: unknown }).cause
        }
        return false
      },
      'direct balance-sheet inserts are refused by the trigger',
    )
  } finally {
    await dropScratchOrg(f.org.orgId)
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Export wrote a blank Account Number for NULL-number accounts (the import
// then saw the blank column and never consulted Account Name →
// unknown_account), and blank dimension cells for NULL codes (the import
// read blank as "no dimension", silently re-homing the line). The export now
// writes the name fallback the import resolves, so export→import round-trips
// exactly — and anything still unresolvable refuses instead of re-homing.

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null } = {
  orgId: '', actorId: '', allowed: null,
}
Object.assign(globalThis, { __budgetRoundtripState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier.endsWith('/lib/feature-gates')) return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__budgetRoundtripState;
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
const { GET: exportGet } = await import('./export/route.ts')
const { POST: importPost } = await import('./import/route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (char === '\r') {
      // skip
    } else cell += char
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  const [header, ...body] = rows
  return body.filter((r) => r.length > 1 || r[0] !== '').map((r) => Object.fromEntries(header!.map((h, j) => [h, r[j] ?? ''])))
}

test('export then import round-trips null account numbers and null dimension codes exactly', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  state.allowed = null
  try {
    const accountId = randomUUID()
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active)
      values (${accountId}, ${org.orgId}, null, 'No Number Expense', 'expense', false, true)`)
    const deptId = randomUUID()
    await db.execute(sql`
      insert into departments (id, org_id, code, name, is_active)
      values (${deptId}, ${org.orgId}, null, 'No Code Dept', true)`)
    const sourceId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${sourceId}, ${org.orgId}, ${org.bookId}, 2026, 'Roundtrip Source', 'budget', 'draft')`)
    await db.execute(sql`
      insert into budget_lines
        (org_id, scenario_id, account_id, period_id, subsidiary_id, department_id, amount, created_by, updated_by)
      values (${org.orgId}, ${sourceId}, ${accountId}, ${org.periodId}, ${org.subsidiaryId}, ${deptId},
              '250.0000', ${state.actorId}, ${state.actorId})`)

    const exported = await withOrgContext(state.orgId, () => exportGet(
      new Request(`http://budget.test/api/budgets/${sourceId}/export?format=csv`),
      { params: Promise.resolve({ id: sourceId }) },
    ))
    assert.equal(exported.status, 200)
    const rows = parseCsv(await exported.text())
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!['Account Number'], '')
    assert.equal(rows[0]!['Account Name'], 'No Number Expense')
    assert.equal(rows[0]!['Department'], 'No Code Dept')

    const targetId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${targetId}, ${org.orgId}, ${org.bookId}, 2026, 'Roundtrip Target', 'budget', 'draft')`)
    const text = [
      Object.keys(rows[0]!).map((h) => `"${h}"`).join(','),
      Object.values(rows[0]!).map((v) => `"${v.replaceAll('"', '""')}"`).join(','),
    ].join('\n')
    const imported = await withOrgContext(state.orgId, () => importPost(
      new Request(`http://budget.test/api/budgets/${targetId}/import`, {
        method: 'POST',
        body: JSON.stringify({ format: 'csv', text, expectedRevision: 1, commit: true }),
      }),
      { params: Promise.resolve({ id: targetId }) },
    ))
    const result = (await imported.json()) as { revision?: number; imported?: number; valid?: boolean; errors?: unknown[] }
    assert.equal(imported.status, 200, `round-trip import must succeed: ${JSON.stringify(result)}`)

    const lines = (await db.execute<{
      account_id: string; period_id: string; subsidiary_id: string; department_id: string | null; amount: string
    }>(sql`
      select account_id, period_id, subsidiary_id, department_id, amount::text as amount
        from budget_lines where scenario_id = ${targetId} and org_id = ${org.orgId}`)).rows
    assert.equal(lines.length, 1, 'exactly one line lands, on no other cell')
    assert.equal(lines[0]!.account_id, accountId)
    assert.equal(lines[0]!.period_id, org.periodId)
    assert.equal(lines[0]!.subsidiary_id, org.subsidiaryId)
    assert.equal(lines[0]!.department_id, deptId)
    assert.equal(lines[0]!.amount, '250.0000')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

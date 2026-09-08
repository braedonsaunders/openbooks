import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import * as React from 'react'
import ExcelJS from 'exceljs'

const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('./auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __statementBookState: state, React })
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          'export async function getTranslations(){const t=(s)=>s;t.has=()=>false;t.rich=(s)=>s;return t;};export async function getLocale(){return "en"}',
        ),
      }
    }
    if ((s === './auth' || s.endsWith('/lib/auth')) && c.parentURL?.includes('/web/') && !c.parentURL.includes('/web/lib/auth.ts')) {
      // Session identity comes from the test principal; every other auth
      // export (cookie names, token helpers used by locale/report-pdf) is the
      // real module's.
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__statementBookState.user;}`,
        ),
      }
    }
    if (s.startsWith('@/')) {
      const path = root + 'web/' + s.slice(2)
      for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, c)
      return next(path, c)
    }
    return next(s, c)
  },
})

const { db, withOrgTransaction } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/test-fixtures.ts')
const { resolveReport } = await import('./report-run')
const { withReportAuthz } = await import('./report-execution-context')
const { parseReportQuery, buildDrillTarget } = await import('./report-filters')
const { parseReportDrillTarget, encodeReportDrillTarget } = await import('./report-drill')
const { GET: exportStatement } = await import('../app/api/reports/statement/[kind]/export/route')
const { GET: drill } = await import('../app/api/reports/drill/route')
const pages = {
  pnl: (await import('../app/(app)/reports/pnl/page')).default,
  'balance-sheet': (await import('../app/(app)/reports/balance-sheet/page')).default,
}
type Fixture = Awaited<ReturnType<typeof createScratchOrg>>
type MatrixProps = { view: import('./statement-matrix').StatementView; drill: { bookId?: string; dims: import('./statement-matrix').StatementDimFilter; basis: 'accrual' } }
function matrixProps(node: unknown): MatrixProps | null {
  if (!node || typeof node !== 'object') return null
  if (React.isValidElement(node)) return matrixProps(node.props)
  const props = node as Record<string, unknown>
  if (props.view && props.drill) return props as MatrixProps
  for (const value of Object.values(props)) {
    const found = matrixProps(value)
    if (found) return found
  }
  return null
}
async function fixture(action: (org: Fixture, book: string, authz: import('./authz').Authz) => Promise<void>) {
  const org = await createScratchOrg()
  try {
    const uid = await createScratchUser(org.orgId, 'Book reader', 'book_reader')
    await db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb where org_id=${org.orgId} and key='book_reader'`)
    state.user = { id: uid, orgId: org.orgId, isSuperAdmin: false, name: 'Book reader', email: 'reader@example.test',
      roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: uid }
    const book = randomUUID()
    await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
      values(${book},${org.orgId},'TAX','Tax book',false,true,true)`)
    for (const [id, amount, tag] of [[org.bookId, '100', 'PRIMARY'], [book, '700', 'SELECTED']] as const) {
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
        values(${entry},${org.orgId},${id},${org.subsidiaryId},${tag},${org.date},${org.periodId},'draft','manual')`)
      await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
        values(${org.orgId},${entry},1,${org.accounts.bank},${org.subsidiaryId},${amount},'CAD',${amount},1),
        (${org.orgId},${entry},2,${org.accounts.revenue},${org.subsidiaryId},${'-' + amount},'CAD',${'-' + amount},1)`)
      await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`)
    }
    const authz = { user: state.user, permissions: new Set(['reports.read']), allowedSubsidiaryIds: null } as import('./authz').Authz
    await withOrgTransaction(org.orgId, () => withReportAuthz(authz, () => action(org, book, authz)))
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
}
const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
const params = (org: Fixture, book?: string) => ({ period: 'custom', from: org.date, to: org.date, ...(book === undefined ? {} : { book }) })
const request = (url: string) => new Request('http://test.local' + url)

for (const kind of ['pnl', 'balance-sheet'] as const) {
  test(`${kind} screen, shared renderer and exports retain the selected accounting book`, enabled, async () => fixture(async (org, book) => {
    const account = kind === 'pnl' ? org.accounts.revenue : org.accounts.bank
    for (const [selected, expected] of [[undefined, '100.0000'], [book, '700.0000'], [book.toUpperCase(), '700.0000']] as const) {
      const sp = params(org, selected)
      const matrix = matrixProps(await pages[kind]({ searchParams: Promise.resolve(sp) }))
      assert.ok(matrix)
      assert.equal(matrix.view.lines.find(line => line.accountId === account)?.values?.[0], expected, 'screen amount')
      assert.equal(matrix.drill.bookId, selected ? book : org.bookId, 'drill retains the displayed book')
      const p = new URLSearchParams(sp)
      const resolved = await resolveReport(kind, p, { orgId: org.orgId, t: key => key,
        period: { from: org.date, to: org.date, label: 'Book period' }, query: parseReportQuery(p) })
      assert.equal(resolved.render, 'view')
      if (resolved.render !== 'view') assert.fail('statement view required')
      assert.equal(resolved.view.lines.find(line => line.accountId === account)?.values?.[0], expected, 'shared export/schedule renderer')
      const response = await exportStatement(request(`/api/reports/statement/${kind}/export?format=csv&${p}`), { params: Promise.resolve({ kind }) })
      assert.equal(response.status, 200, await response.clone().text())
      const csv = await response.text()
      assert.ok(csv.includes(expected.slice(0, -2)), csv)
      assert.equal(csv.includes(selected ? '100.00' : '700.00'), false)
    }
    const p = new URLSearchParams(params(org, book))
    const response = await exportStatement(request(`/api/reports/statement/${kind}/export?format=xlsx&${p}`), { params: Promise.resolve({ kind }) })
    assert.equal(response.status, 200)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    const rows = JSON.stringify(workbook.worksheets[0]?.getSheetValues())
    assert.ok(rows.includes('700'))
    assert.equal(rows.includes('100.00'), false)
  }))
}

test('statement drill URL and route return the selected book supporting rows', enabled, async () => fixture(async (org, book) => {
  const target = buildDrillTarget({ accountId: org.accounts.revenue, column: { kind: 'amount', from: org.date, to: org.date },
    mode: 'flow', reportDims: {}, basis: 'accrual', label: 'Tax revenue', bookId: book })
  assert.ok(target)
  const parsed = parseReportDrillTarget(encodeReportDrillTarget(target))
  assert.equal(parsed?.kind === 'ledger' ? parsed.bookId : undefined, book)
  const response = await drill(request('/api/reports/drill?target=' + encodeURIComponent(encodeReportDrillTarget(target))))
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.text()
  assert.ok(body.includes('SELECTED'), body)
  assert.equal(body.includes('PRIMARY'), false)
  assert.ok(body.includes('700.00'), body)
}))

test('explicit invalid or unavailable books never fall back to the primary book', enabled, async () => fixture(async (org, book) => {
  const foreign = await createScratchOrg()
  try {
    await db.execute(sql`update accounting_books set is_active=false where id=${book} and org_id=${org.orgId}`)
    for (const selected of ['', 'invalid', randomUUID(), foreign.bookId, book]) {
      const sp = params(org, selected)
      for (const kind of ['pnl', 'balance-sheet'] as const) {
        await assert.rejects(pages[kind]({ searchParams: Promise.resolve(sp) }), /accounting book/i)
        const response = await exportStatement(request(`/api/reports/statement/${kind}/export?format=csv&${new URLSearchParams(sp)}`), { params: Promise.resolve({ kind }) })
        assert.equal(response.status, 422, selected)
      }
      const target = { kind: 'ledger', label: 'Revenue', to: org.date, mode: 'flow', bookId: selected }
      const response = await drill(request('/api/reports/drill?target=' + encodeURIComponent(JSON.stringify(target))))
      assert.equal(response.status, ['', 'invalid'].includes(selected) ? 400 : 422)
    }
  } finally { await dropScratchOrgReporting(foreign.orgId) }
}))

test('budget Actual drills use the scenario book even after that book is retired', enabled, async () => fixture(async (org, book) => {
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"budgets":true}'::jsonb) where id=${org.orgId}`)
  const scenario = randomUUID()
  await db.execute(sql`insert into budget_scenarios(id,org_id,book_id,fiscal_year,name)
    select ${scenario},${org.orgId},${book},fiscal_year,'Selected-book plan' from accounting_periods where id=${org.periodId} and org_id=${org.orgId}`)
  const target = buildDrillTarget({ accountId: org.accounts.revenue, column: { kind: 'amount', from: org.date, to: org.date },
    mode: 'flow', reportDims: {}, basis: 'accrual', label: 'Actual revenue', budgetScenarioId: scenario })
  assert.equal(target?.kind, 'budget', 'the scenario remains the authority for its Actual column')
  if (target?.kind !== 'budget') assert.fail('budget target required')
  assert.equal(target.scope, 'actual')
  for (const active of [true, false]) {
    await db.execute(sql`update accounting_books set is_active=${active} where id=${book} and org_id=${org.orgId}`)
    const response = await drill(request('/api/reports/drill?target=' + encodeURIComponent(encodeReportDrillTarget(target))))
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.text()
    assert.ok(body.includes('SELECTED'), body)
    assert.equal(body.includes('PRIMARY'), false)
    assert.ok(body.includes('700.00'), body)
  }
}))

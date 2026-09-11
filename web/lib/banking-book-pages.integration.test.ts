import { registerHooks } from 'node:module'
import { resolveAppModule } from './test-module-hooks'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import * as React from 'react'
const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('./auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __bankingPagesState: state, React })
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
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__bankingPagesState.user;}`,
        ),
      }
    }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
})

const { db, withOrgContext } = await import(root + 'engine/src/db.ts') as typeof import('../../engine/src/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js') as typeof import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(root + 'engine/src/test-fixtures.ts')
const { startReconciliation, importStatement, createMatch } = await import(root + 'engine/src/banking.ts')
// The page's LOADER, not its rendered tree.
//
// This test asserts which book and which currency the page's queries use, and
// that decision now lives entirely in the loader — the spec only names where
// the resolved rows are drawn. Walking the tree for a workspace component's
// props stopped working when `ModuleView` became the single render path (an
// async server component's children do not exist until it is rendered), and
// reaching for its props was always indirection: the loader's own output is
// the thing under test, and reading it directly is both stronger and stable
// against any later change to how the page is arranged.
const { loadMatch } = await import(root + 'web/app/(app)/banking/match/view.ts')
const { loadReconciliation } = await import(
  root + 'web/app/(app)/banking/[accountId]/reconcile/[reconciliationId]/view.ts'
)

for (const page of ['match', 'reconcile'] as const) {
  test(`bank ${page} page uses primary book and bank-currency amounts`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg()
    try {
      const actor = await createScratchUser(org.orgId, 'Bank operator', 'admin')
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
      state.user = { id: actor, orgId: org.orgId, isSuperAdmin: false, name: 'Bank operator', email: 'bank@scratch.test',
        roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
      const tax = randomUUID()
      await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary) values(${tax},${org.orgId},'TAX','Tax',false)`)
      let primaryLine = ''
      for (const variant of ['primary-usd', 'tax-usd', 'legacy-cad']) {
        const entry = randomUUID(), line = randomUUID()
        const currency = variant === 'legacy-cad' ? 'CAD' : 'USD'
        const amount = currency === 'USD' ? '135' : '100'
        const fx = currency === 'USD' ? '1.35' : '1'
        await db.transaction(async (tx) => {
          await tx.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
            values(${entry},${org.orgId},${variant === 'tax-usd' ? tax : org.bookId},${org.subsidiaryId},${variant},${org.date},${org.periodId},'draft','manual')`)
          await tx.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
            values(${line},${org.orgId},${entry},1,${org.accounts.bank},${org.subsidiaryId},${amount},${currency},100,${fx}),
              (${randomUUID()},${org.orgId},${entry},2,${org.accounts.adjustment},${org.subsidiaryId},${'-' + amount},${currency},-100,${fx})`)
          await tx.execute(sql`update journal_entries set status='posted',posted_by=${actor} where org_id=${org.orgId} and id=${entry}`)
        })
        if (variant === 'primary-usd') primaryLine = line
      }
      // Legacy differently-denominated rows must not be offered after a
      // reconcilable account's explicit statement currency is configured.
      await db.execute(sql`update accounts set currency_restriction='USD',reconcilable=true where org_id=${org.orgId} and id=${org.accounts.bank}`)
      const ctx = { orgId: org.orgId, userId: actor }
      await importStatement({ accountId: org.accounts.bank, source: 'manual', currency: 'USD', statementDate: org.date,
        lines: [{ postedOn: org.date, amount: '100', description: 'Deposit', bankTransactionId: 'usd-deposit' }] }, ctx)
      const recon = await startReconciliation({ accountId: org.accounts.bank, throughDate: org.date, statementBalance: '100' }, ctx)
      await withOrgContext(org.orgId, async () => {
        const loaded = page === 'match'
          ? await loadMatch({ account: org.accounts.bank })
          : await loadReconciliation(org.accounts.bank, recon.id, {})
        assert.ok(loaded)
        const data = (page === 'match' ? loaded.data : loaded) as { glRows: Array<{ id: string; amount: string }>; glTotal: number }
        assert.equal(data.glTotal, 1)
        assert.deepEqual(data.glRows.map(row => ({ id: row.id, amount: row.amount })), [{ id: primaryLine, amount: '100.0000' }])
        assert.equal(((page === 'match' ? loaded.session : loaded.reconciliation) as { currency: string }).currency, 'USD')
        if (page === 'reconcile') {
          const statement = (await db.execute<{ id: string }>(sql`select id from bank_statement_lines where org_id=${org.orgId}`)).rows[0]!
          await createMatch({ reconciliationId: recon.id, statementLineId: statement.id, journalLineIds: [primaryLine] }, ctx)
          const updated = await loadReconciliation(org.accounts.bank, recon.id, {})
          const matched = updated.matchedRows as Array<{ gl_amount: string; stmt_amount: string }>
          assert.equal(matched[0]!.gl_amount, '100.0000')
          assert.equal(matched[0]!.stmt_amount, '100.0000')
        }
      })
    } finally {
      state.user = null
      await dropScratchOrgReporting(org.orgId)
    }
  })
}

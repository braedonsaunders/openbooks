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
Object.assign(globalThis, { __bankingOverviewState: state, React })
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          'export async function getTranslations(){const t=(k,p)=>p===undefined?k:`${k} ${JSON.stringify(p)}`;t.has=()=>false;t.rich=(k)=>k;return t;};export async function getLocale(){return "en"}',
        ),
      }
    }
    if ((s === './auth' || s.endsWith('/lib/auth')) && c.parentURL?.includes('/web/') && !c.parentURL.includes('/web/lib/auth.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__bankingOverviewState.user;}`,
        ),
      }
    }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
})

const { db, withBypass, withOrgContext } = await import(root + 'engine/src/db.ts') as typeof import('../../engine/src/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js') as typeof import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(root + 'engine/src/test-fixtures.ts') as typeof import('../../engine/src/test-fixtures.ts')
// The overview LOADER, not its rendered tree: the roster, the vitals, and
// the rates banner are all loader-resolved data, so the loader output is
// the thing under test (same rationale as banking-book-pages).
const { loadBanking } = await import(root + 'web/app/(app)/banking/view.ts')
const { loadMatch } = await import(root + 'web/app/(app)/banking/match/view.ts')
const { loadBankingAccount } = await import(root + 'web/app/(app)/banking/[accountId]/view.ts')

/**
 * F-t06-001: a multi-subsidiary org whose consolidated rates were never
 * derived for the current period. The overview must still list the same
 * reconcilable accounts as the Match picker with the same cash total —
 * the missing derivation pins a banner, never an empty roster.
 */
test('rates-blocked banking overview agrees with the match picker (F-t06-001)', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, 'Treasurer', 'admin'))
    await withBypass(async () => {
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
      // A foreign-currency child with no consolidated rates derived: the
      // default (root, consolidated) view is rates-blocked, like SIM
      // Ledgerline's CAD sub under its USD root.
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
      const childId = randomUUID()
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${childId}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
      await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where id = ${org.accounts.bank} and org_id = ${org.orgId}`)
      const entryId = randomUUID()
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
        values
          (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'BANK-RATES-BLOCKED', ${org.date}, ${org.periodId},
           'Bank rates blocked', 'draft', 'manual', ${actor}, ${actor})
      `)
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
        values
          (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
           '250.0000', 'CAD', '250.0000', 1, 'Bank rates blocked'),
          (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment}, ${org.subsidiaryId},
           '-250.0000', 'CAD', '-250.0000', 1, 'Bank rates blocked')
      `)
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_by = ${actor}, updated_by = ${actor}
         where id = ${entryId} and org_id = ${org.orgId}
      `)
    })
    state.user = { id: actor, orgId: org.orgId, isSuperAdmin: false, name: 'Treasurer', email: 'treasurer@scratch.test',
      roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    await withOrgContext(org.orgId, async () => {
      const loaded = (await loadBanking({})) as {
        ratesBlocked: unknown
        rosterAccounts: { id: string }[]
        totalCash: number
      }
      assert.ok(loaded.ratesBlocked, 'the missing derivation still pins its banner')
      assert.equal(loaded.rosterAccounts.length, 1, 'the roster lists the reconcilable account even while rates are blocked')
      assert.equal(loaded.rosterAccounts[0]?.id, org.accounts.bank)
      assert.equal(loaded.totalCash, 250, 'the cash total reads the ledger, not the blocked fallback')
      const match = (await loadMatch({})) as { accounts: { id: string }[] }
      assert.deepEqual(
        match.accounts.map((a) => a.id),
        loaded.rosterAccounts.map((a) => a.id),
        'the match picker and the overview roster read the same accounts',
      )
      // The per-account page guards through the same reader: the listed
      // bank renders, a non-bank account 404s instead of rendering a
      // workspace its siblings refuse to list.
      const detail = (await loadBankingAccount(org.accounts.bank, {})) as { headerTitle: string }
      assert.match(detail.headerTitle, /Cash/, 'the rostered account renders its page')
      await assert.rejects(
        loadBankingAccount(org.accounts.adjustment, {}),
        /NEXT_HTTP_ERROR_FALLBACK;404/,
        'a non-bank account has no banking page',
      )
    })
  } finally {
    state.user = null
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

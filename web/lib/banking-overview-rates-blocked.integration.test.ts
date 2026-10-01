import { registerHooks } from 'node:module'
import { resolveAppModule } from './test-module-hooks'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import * as React from 'react'
import { stubModules } from '../testing/stub-modules.ts'
const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('./auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __bankingOverviewState: state, React })
stubModules({ navigation: false, intl: 'export async function getTranslations(){const t=(k,p)=>p===undefined?k:`${k} ${JSON.stringify(p)}`;t.has=()=>false;t.rich=(k)=>k;return t;};export async function getLocale(){return "en"}', authz: false, features: false });

registerHooks({
  resolve(s, c, next) {
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

const { db, withBypass, withOrgContext } = await import(root + 'engine/src/platform/db.ts') as typeof import('../../engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js') as typeof import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(root + 'engine/src/testing/fixtures.ts') as typeof import('../../engine/src/testing/fixtures.ts')
// The overview LOADER, not its rendered tree: the roster, the vitals, and
// the rates banner are all loader-resolved data, so the loader output is
// the thing under test (same rationale as banking-book-pages).
const { loadBanking } = await import(root + 'web/app/(app)/banking/view.ts')
const { loadMatch } = await import(root + 'web/app/(app)/banking/match/view.ts')
const { loadBankingAccount } = await import(root + 'web/app/(app)/banking/[accountId]/view.ts')

/**
 * A multi-subsidiary org whose consolidated rates were never
 * derived for the current period. The overview includes bank/card accounts
 * before reconciliation setup; Match still requires that setup. Missing
 * consolidated rates pin a banner, never an empty or incomplete roster.
 */
test('rates-blocked banking includes accounts awaiting setup and keeps Match eligibility separate', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const reserveId = randomUUID()
  const cardId = randomUUID()
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
      await db.execute(sql`
        insert into accounts(id,org_id,number,name,type,is_active,is_summary,reconcilable)
        values (${reserveId},${org.orgId},'1020','Reserve Savings','asset_bank',true,false,false),
               (${cardId},${org.orgId},'2050','Corporate Credit Card','liability_card',true,false,false),
               (${randomUUID()},${org.orgId},'1030','Inactive bank','asset_bank',false,false,false),
               (${randomUUID()},${org.orgId},'1090','Bank summary','asset_bank',true,true,false)
      `)
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
           '-250.0000', 'CAD', '-250.0000', 1, 'Bank rates blocked'),
          (${randomUUID()}, ${org.orgId}, ${entryId}, 3, ${reserveId}, ${org.subsidiaryId},
           '75.0000', 'CAD', '75.0000', 1, 'Reserve opening'),
          (${randomUUID()}, ${org.orgId}, ${entryId}, 4, ${org.accounts.adjustment}, ${org.subsidiaryId},
           '-75.0000', 'CAD', '-75.0000', 1, 'Reserve offset'),
          (${randomUUID()}, ${org.orgId}, ${entryId}, 5, ${cardId}, ${org.subsidiaryId},
           '-50.0000', 'CAD', '-50.0000', 1, 'Card opening'),
          (${randomUUID()}, ${org.orgId}, ${entryId}, 6, ${org.accounts.adjustment}, ${org.subsidiaryId},
           '50.0000', 'CAD', '50.0000', 1, 'Card offset')
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
        totalCash: string
        totalCards: string
      }
      assert.ok(loaded.ratesBlocked, 'the missing derivation still pins its banner')
      assert.deepEqual(new Set(loaded.rosterAccounts.map((a) => a.id)), new Set([org.accounts.bank,reserveId,cardId]), 'all active bank/card leaf accounts appear before setup')
      assert.equal(loaded.totalCash, '325.0000', 'cash includes bank accounts awaiting reconciliation setup')
      assert.equal(loaded.totalCards, '-50.0000', 'card balances include cards awaiting setup')
      const match = (await loadMatch({})) as { accounts: { id: string }[] }
      assert.deepEqual(
        match.accounts.map((a) => a.id),
        [org.accounts.bank],
        'Match only offers accounts configured for reconciliation',
      )
      // Every rostered bank opens its detail page; configuration controls
      // workflow availability without granting access to non-bank accounts.
      const detail = (await loadBankingAccount(org.accounts.bank, {})) as { headerTitle: string }
      assert.match(detail.headerTitle, /Cash/, 'the rostered account renders its page')
      const pending = await loadBankingAccount(reserveId, {})
      assert.match(pending.headerTitle, /Reserve Savings/)
      assert.equal(pending.canReconcile, false)
      assert.equal(pending.canConfigure, true)
      assert.equal(pending.configureHref, `/accounts?account=${reserveId}`)
      assert.equal(pending.headerDescription, 'account.setupDescription')
      const configured = await loadBankingAccount(org.accounts.bank, {})
      assert.equal(configured.canReconcile, true)
      assert.equal(configured.canConfigure, false)
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

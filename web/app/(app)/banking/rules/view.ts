import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isUuid, pickString } from '../../../../lib/list-params'
import type { BankRuleView } from './RuleDrawer'

/**
 * The banking-rules list, split into a loader and a spec.
 *
 * Nearly the whole page is the universal entity list (`bank_rule` record
 * type); what is page-specific is the drawer SLOT, which the native page
 * fills with the rule flyout plus every picker it needs, and the two header
 * buttons (run + new). The list's `formatValue` summaries — the "when" and
 * "then" columns — are functions, and a spec can never carry a function, so
 * the list stays a host component placed by name (`entity-list-view`), the
 * same answer the projects page gives for its list.
 *
 * The rule drawer holds unsaved form state, so its remount key rides along
 * as a prop, exactly like `project-drawer`.
 */

interface AccountRow extends Record<string, unknown> { id: string; number: string | null; name: string }
interface DimensionRow extends Record<string, unknown> { id: string; code: string | null; name: string }
interface PartyRow extends Record<string, unknown> { id: string; display_name: string }
interface SeedLineRow extends Record<string, unknown> { description: string | null; amount: string }
type BankRuleRow = BankRuleView & Record<string, unknown>

// Loader-resolved drawer payload: the drawer's own props minus the client
// component, plus the remount key (`key={rule.id}` in the native page).
export interface BankRuleDrawerPayload extends Record<string, unknown> {
  remountKey: string
  rule: BankRuleView | null
  accounts: { value: string; label: string }[]
  reconAccounts: { id: string; label: string }[]
  departments: { value: string; label: string }[]
  locations: { value: string; label: string }[]
  classes: { value: string; label: string }[]
  taxCodes: { value: string; label: string }[]
  parties: { value: string; label: string }[]
  seedFromLine: { description: string | null; amount: string } | null
}

export interface BankingRulesData {
  title: string
  description: string
  backHref: string
  backLabel: string
  currentParams: Record<string, string | string[] | undefined>
  reconAccounts: { id: string; label: string }[]
  drawerOpen: boolean
  drawer: BankRuleDrawerPayload | null
}

export async function loadBankingRules(
  sp: Record<string, string | string[] | undefined>,
): Promise<BankingRulesData> {
  const authz = await requirePermission('banking.reconcile')
  const t = await getTranslations('banking')
  const openId = pickString(sp.rule)
  const fromLine = pickString(sp.fromLine)

  const [offsetAccounts, reconAccountsRes, departments, locations, classes, taxCodes, parties, open, seedLine] =
    (await Promise.all([
      db.execute<AccountRow>(sql`
        select id, number, name from accounts
         where org_id = ${authz.user.orgId} and is_active and not is_summary
         order by number nulls last limit 2000
      `),
      db.execute<AccountRow>(sql`
        select id, number, name from accounts
         where org_id = ${authz.user.orgId} and reconcilable and not is_summary and is_active
         order by number nulls last
      `),
      db.execute<DimensionRow>(sql`select id, code, name from departments where org_id = ${authz.user.orgId} and is_active order by name limit 1000`),
      db.execute<DimensionRow>(sql`select id, code, name from locations where org_id = ${authz.user.orgId} and is_active order by name limit 1000`),
      db.execute<DimensionRow>(sql`select id, code, name from classes where org_id = ${authz.user.orgId} and is_active order by name limit 1000`),
      db.execute<DimensionRow>(sql`select id, code, name from tax_codes where org_id = ${authz.user.orgId} and is_active order by code limit 500`),
      db.execute<PartyRow>(sql`select id, display_name from parties where org_id = ${authz.user.orgId} and is_active order by display_name limit 2000`),
      openId && openId !== 'new' && isUuid(openId)
        ? db.execute<BankRuleRow>(sql`
            select id, name, criteria, outcome, priority, is_active
              from bank_match_rules where id = ${openId} and org_id = ${authz.user.orgId}
          `)
        : Promise.resolve({ rows: [] }),
      fromLine && isUuid(fromLine)
        ? db.execute<SeedLineRow>(sql`
            select l.description, l.amount from bank_statement_lines l
             where l.id = ${fromLine} and l.org_id = ${authz.user.orgId} limit 1
          `)
        : Promise.resolve({ rows: [] }),
    ]))

  const accountOpts = offsetAccounts.rows.map((account) => ({
    value: account.id,
    label: [account.number, account.name].filter(Boolean).join(' · '),
  }))
  const reconAccountOpts = reconAccountsRes.rows.map((account) => ({
    id: account.id,
    label: [account.number, account.name].filter(Boolean).join(' · '),
  }))
  const dimensionOptions = (rows: DimensionRow[]) => rows.map((dimension) => ({
    value: dimension.id,
    label: [dimension.code, dimension.name].filter(Boolean).join(' · '),
  }))
  const openRule = openId === 'new' ? null : (open.rows[0] ?? null)
  const drawerOpen = openId === 'new' || Boolean(open.rows[0])
  const seed = seedLine.rows[0]
    ? { description: seedLine.rows[0].description, amount: seedLine.rows[0].amount }
    : null

  // The `criteria_summary` / `outcome_summary` cell text is produced by the
  // native page's `whenSummary` / `outcomeSummary` closures inside
  // EntityListView's `formatValue`. A spec can never carry a function, so the
  // loader does NOT precompute them — the coordinator's slot addition (see
  // the registry entry) carries the verbatim logic. Nothing else on this page
  // formats values in the loader.

  return {
    title: t('rules.title'),
    description: t('rules.description'),
    backHref: '/banking',
    backLabel: t('home.title'),
    currentParams: sp,
    reconAccounts: reconAccountOpts,
    drawerOpen,
    drawer: drawerOpen
      ? {
          remountKey: openRule ? String(openRule.id) : 'new',
          rule: openRule,
          accounts: accountOpts,
          reconAccounts: reconAccountOpts,
          departments: dimensionOptions(departments.rows),
          locations: dimensionOptions(locations.rows),
          classes: dimensionOptions(classes.rows),
          taxCodes: dimensionOptions(taxCodes.rows),
          parties: parties.rows.map((party) => ({ value: party.id, label: party.display_name })),
          seedFromLine: seed,
        }
      : null,
  }
}

const f = ref<BankingRulesData>()

export function bankingRulesSpec(data: BankingRulesData): PageSpec {
  const newRule = { widget: 'new-bank-rule', props: {} }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-2',
        actions: [
          widget('run-bank-rules', { accounts: data.reconAccounts }),
          widget(newRule.widget, newRule.props),
        ],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'bank_rule',
        sp: data.currentParams,
        emptyAction: newRule,
        // Rendered in the native page's order: the rule flyout is the only
        // drawer child, present exactly when the native page renders it.
        drawer: data.drawer ? { widget: 'bank-rule-drawer', props: { drawer: data.drawer } } : null,
      }),
    ],
  })
}

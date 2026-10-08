import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { loadInternalBilling, type InternalBillingDetail } from '@openbooks/engine/internal-billing'
import { listInternalBillingRules } from '@openbooks/engine/internal-billing'
import { can, type Authz } from './authz'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from './features'
import { subsidiaryVisibleFilter } from './subsidiaries'

export type InternalBillingMethodKey = 'revenue_credit' | 'cost_transfer' | 'intercompany_sale'

export interface InternalBillingOption { id: string; label: string }

export interface InternalBillingRuleChoice {
  code: string
  name: string
  method: InternalBillingMethodKey
  billableByDefault: boolean
  /** Active windows, so the form can tell which version a date falls in. */
  windows: { from: string; to: string | null }[]
}

export interface InternalBillingDrawerData {
  closeHref: string
  /** Null while creating: nothing is written until Save or Post. */
  detail: InternalBillingDetail | null
  canPost: boolean
  today: string
  currency: string
  rules: InternalBillingRuleChoice[]
  /** Null when the dimension is not in use, so its picker stays hidden. */
  options: {
    subsidiaries: InternalBillingOption[] | null
    departments: InternalBillingOption[] | null
    projects: InternalBillingOption[] | null
    locations: InternalBillingOption[] | null
    classes: InternalBillingOption[] | null
    items: InternalBillingOption[]
  }
  defaultSubsidiaryId: string | null
}

async function names(table: 'departments' | 'locations' | 'classes', orgId: string): Promise<InternalBillingOption[] | null> {
  const rows = (await db.execute<{ id: string; label: string }>(sql`
    select id, coalesce(code || ' · ' || name, name) as label
      from ${sql.raw(table)} where org_id = ${orgId} and is_active order by name`)).rows
  return rows.length ? rows : null
}

/**
 * Everything the internal billing drawer shows: the record (or nothing, for
 * a new one), the rules a date can resolve, and the pickers for the
 * dimensions the organization actually uses. Pickers are scoped to the
 * caller's subsidiaries; the writer re-checks every reference.
 */
export async function loadInternalBillingDrawerData(args: {
  authz: Authz
  id: string | 'new'
  closeHref: string
}): Promise<InternalBillingDrawerData | null> {
  const { authz } = args
  const orgId = authz.user.orgId
  const allowed = authz.allowedSubsidiaryIds
  const detail = args.id === 'new' ? null : await loadInternalBilling(orgId, args.id, allowed)
  if (args.id !== 'new' && !detail) return null
  const rules = new Map<string, InternalBillingRuleChoice>()
  for (const rule of await listInternalBillingRules(orgId)) {
    if (!rule.isActive) continue
    const choice = rules.get(rule.code) ?? {
      code: rule.code, name: rule.name, method: rule.method, billableByDefault: rule.billableByDefault, windows: [],
    }
    choice.windows.push({ from: rule.effectiveFrom, to: rule.effectiveTo })
    rules.set(rule.code, choice)
  }
  const multiSubsidiary = await subsidiaryFeatureEnabled(orgId)
  const subsidiaries = multiSubsidiary
    ? (await db.execute<{ id: string; label: string }>(sql`
        select id, name as label from subsidiaries
         where org_id = ${orgId} and is_active and not is_elimination
           ${subsidiaryVisibleFilter(sql`id`, allowed)}
         order by name`)).rows
    : null
  const projectsOn = await isFeatureEnabled(orgId, 'projects')
  const projects = projectsOn
    ? (await db.execute<{ id: string; label: string }>(sql`
        select id, coalesce(code || ' · ' || name, name) as label from projects
         where org_id = ${orgId} and is_active and status not in ('closed', 'cancelled')
           ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })}
         order by name`)).rows
    : null
  const items = (await db.execute<{ id: string; label: string }>(sql`
    select id, coalesce(code || ' · ' || name, name) as label from items
     where org_id = ${orgId} and is_active and kind not in ('inventory', 'assembly', 'kit')
     order by name limit 500`)).rows
  const root = (await db.execute<{ id: string; base_currency: string }>(sql`
    select id, base_currency from subsidiaries where org_id = ${orgId} and parent_id is null order by created_at limit 1`)).rows[0]
  const defaultSubsidiaryId = allowed === null ? root?.id ?? null : allowed.size === 1 ? [...allowed][0]! : null
  return {
    closeHref: args.closeHref,
    detail,
    canPost: can(authz, 'gl.post'),
    today: await businessToday(orgId),
    currency: detail?.document.currency ?? root?.base_currency ?? 'USD',
    rules: [...rules.values()],
    options: {
      subsidiaries: subsidiaries && subsidiaries.length > 1 ? subsidiaries : null,
      departments: await names('departments', orgId),
      projects: projects && projects.length ? projects : null,
      locations: await names('locations', orgId),
      classes: await names('classes', orgId),
      items,
    },
    defaultSubsidiaryId,
  }
}

type SuggestedPair = { debitAccountId: string | null; creditAccountId: string | null }

/**
 * Accounts the rule chooser pre-selects for each method: accounts of the
 * method's types, preferring ones named for internal or intercompany work
 * and, for intercompany sales, only accounts eliminated in consolidation.
 * A suggestion only fills the form; the operator confirms it and the rule
 * endpoint validates it.
 */
export async function suggestInternalBillingAccounts(orgId: string): Promise<Record<InternalBillingMethodKey, SuggestedPair>> {
  const accounts = (await db.execute<{ id: string; type: string; eliminate: boolean; name: string }>(sql`
    select id, type, eliminate, name from accounts
     where org_id = ${orgId} and is_active and not is_summary
       and type in ('income', 'income_other', 'cogs', 'expense', 'expense_other')
     order by number nulls last, name`)).rows
  const internal = /intern|inter-?depart|interco|recover|allocat|transfer/i
  const pick = (types: readonly string[], options: { eliminate?: boolean; except?: string | null } = {}) => {
    const candidates = accounts.filter((account) =>
      types.includes(account.type) &&
      (options.eliminate === undefined || account.eliminate === options.eliminate) &&
      account.id !== options.except)
    return (candidates.find((account) => internal.test(account.name)) ?? candidates[0])?.id ?? null
  }
  const income = ['income', 'income_other'] as const
  const cost = ['cogs', 'expense', 'expense_other'] as const
  const revenueCredit = pick(income)
  const costDebit = pick(['cogs'] as const) ?? pick(cost)
  const icCost = pick(cost, { eliminate: true })
  return {
    revenue_credit: { creditAccountId: revenueCredit, debitAccountId: pick(income, { except: revenueCredit }) },
    cost_transfer: { debitAccountId: costDebit, creditAccountId: pick(['expense', 'expense_other'] as const, { except: costDebit }) ?? pick(cost, { except: costDebit }) },
    intercompany_sale: { debitAccountId: icCost, creditAccountId: pick(income, { eliminate: true }) },
  }
}

import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";
import { pushCustomFieldFilter } from "../list-query";

/* ------------------------------------------------------------------ */
/* Capitalized contract costs (ASC 340-40)                              */
/* ------------------------------------------------------------------ */

export const CONTRACT_COST_ASSET_BASE_JOINS = sql`
  left join revenue_contracts cc_contract on cc_contract.org_id = a.org_id and cc_contract.id = a.revenue_contract_id
  left join parties cc_customer on cc_customer.id = a.customer_party_id
  left join parties cc_rep on cc_rep.id = a.rep_party_id
  left join currencies cc_cur on cc_cur.code = a.currency
  left join lateral (
    select coalesce(sum(amount_minor), 0)::numeric as amortized
      from contract_cost_amortization m
     where m.org_id = a.org_id and m.asset_id = a.id
  ) cc_amort on true
  left join lateral (
    select coalesce(sum(jl.amount), 0) as carrying
      from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
     where jl.org_id = a.org_id
       and jl.contributor_kind = 'contract_cost_asset'
       and jl.contributor_ref = a.id
       and je.status in ('posted', 'reversed')
  ) cc_carry on true`

export const CONTRACT_COST_ASSET_BUILT_IN_EXPR: Record<string, SQL> = {
  contract_number: sql`cc_contract.contract_number`,
  customer_name: sql`cc_customer.display_name`,
  sales_rep: sql`cc_rep.display_name`,
  cost_type: sql`a.cost_type`,
  amount: sql`(a.amount_minor::numeric / (10 ^ cc_cur.minor_units))::text`,
  carrying: sql`cc_carry.carrying::text`,
  capitalized_on: sql`a.capitalized_on`,
  status: sql`a.status`,
}

export const CONTRACT_COST_ASSET_SORTS: Record<string, SQL> = {
  contract: sql`cc_contract.contract_number`,
  customer: sql`cc_customer.display_name`,
  rep: sql`cc_rep.display_name`,
  type: sql`a.cost_type`,
  amount: sql`a.amount_minor`,
  carrying: sql`cc_carry.carrying`,
  capitalized: sql`a.capitalized_on`,
  status: sql`a.status`,
}

function contractCostAssetFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  if (clause.key === 'status') {
    if (clause.operator === 'eq') return sql`a.status = ${value}`
    if (clause.operator === 'ne') return sql`a.status <> ${value}`
  }
  if (clause.key === 'cost_type') {
    if (clause.operator === 'eq') return sql`a.cost_type = ${value}`
    if (clause.operator === 'ne') return sql`a.cost_type <> ${value}`
  }
  return null
}

export function contractCostAssetWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  // Assets carry no subsidiary: a capitalized cost belongs to the contract,
  // not to a legal entity posting scope, so subsidiary scoping does not
  // narrow the list — the org boundary and the read permission govern.
  const parts: SQL[] = [sql`a.org_id = ${orgId}`]
  for (const filter of view.filters) {
    if (pushCustomFieldFilter(parts, filter, "a")) continue
    const predicate = contractCostAssetFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and a.status = ${adhoc.filters.status}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (cc_contract.contract_number ilike ${query} or cc_customer.display_name ilike ${query} or cc_rep.display_name ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

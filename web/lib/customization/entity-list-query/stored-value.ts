import { sql, type SQL } from 'drizzle-orm'
import { dateOrFalse, pushCustomFieldFilter } from '../list-query'
import type { FilterClause, ListViewConfig } from '@openbooks/customization'
import type { EntityAdhoc } from './adhoc'

/**
 * Stored-value account list query. Balances are minor units at ledger
 * precision (ten-thousandths), so amount cells divide back to whole units
 * here — the list never sees the raw integer. Codes render masked: the
 * last four identify the card to its holder without exposing the secret.
 */
export const STORED_VALUE_BUILT_IN_EXPR: Record<string, SQL> = {
  code: sql`'••••-' || sva.code_last4`,
  kind: sql`sva.kind`,
  customer_name: sql`cust.display_name`,
  program_name: sql`svp.name`,
  balance: sql`(sva.balance_minor::numeric / 10000)`,
  issued: sql`(sva.issued_minor::numeric / 10000)`,
  status: sql`sva.status`,
  expires_on: sql`sva.expires_on::text`,
  currency: sql`sva.currency`,
}

export const STORED_VALUE_SORTS: Record<string, SQL> = {
  code: sql`sva.code_last4`,
  kind: sql`sva.kind`,
  customer: sql`cust.display_name`,
  program: sql`svp.name`,
  balance: sql`sva.balance_minor`,
  issued: sql`sva.issued_minor`,
  status: sql`sva.status`,
  expires: sql`sva.expires_on`,
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function storedValueFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  if (clause.key === 'subsidiary' && (clause.operator === 'eq' || clause.operator === 'ne')) {
    // Fail closed on a malformed entity id: showing every entity's balances
    // against a subsidiary filter would misstate what the entity owes.
    if (!UUID_RE.test(value)) return sql`false`
    return clause.operator === 'eq' ? sql`sva.subsidiary_id = ${value}` : sql`sva.subsidiary_id <> ${value}`
  }
  if (clause.key === 'status' && (clause.operator === 'eq' || clause.operator === 'ne')) {
    return clause.operator === 'eq' ? sql`sva.status = ${value}` : sql`sva.status <> ${value}`
  }
  if (clause.key === 'kind' && (clause.operator === 'eq' || clause.operator === 'ne')) {
    return clause.operator === 'eq' ? sql`sva.kind = ${value}` : sql`sva.kind <> ${value}`
  }
  if (clause.key === 'expires_on') {
    if (clause.operator === 'gte') return sql`sva.expires_on >= ${value}`
    if (clause.operator === 'lte') return sql`sva.expires_on <= ${value}`
    if (clause.operator === 'between') {
      const refusedUpper = dateOrFalse(String(clause.to ?? ''))
      if (refusedUpper) return refusedUpper
      return sql`sva.expires_on between ${value} and ${String(clause.to ?? '')}`
    }
  }
  return null
}

export function storedValueAccountWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
): SQL {
  const parts: SQL[] = [sql`sva.org_id = ${orgId}`]
  for (const filter of view.filters) {
    if (pushCustomFieldFilter(parts, filter, null)) continue
    const predicate = storedValueFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (sva.code_last4 ilike ${query} or cust.display_name ilike ${query} or svp.name ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

import { sql, type SQL } from 'drizzle-orm'
import { dateOrFalse, pushCustomFieldFilter } from '../list-query'
import type { EntityAdhoc, ListViewConfig } from '@openbooks/customization'

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

function storedValueFilterPredicate(filter: { key: string; operator: string; value: unknown; to?: unknown }): SQL | null {
  const value = Array.isArray(filter.value) ? String(filter.value[0] ?? '') : String(filter.value ?? '')
  if (filter.key === 'status' && (filter.operator === 'eq' || filter.operator === 'ne')) {
    return filter.operator === 'eq' ? sql`sva.status = ${value}` : sql`sva.status <> ${value}`
  }
  if (filter.key === 'kind' && (filter.operator === 'eq' || filter.operator === 'ne')) {
    return filter.operator === 'eq' ? sql`sva.kind = ${value}` : sql`sva.kind <> ${value}`
  }
  if (filter.key === 'expires_on') {
    if (filter.operator === 'gte') return sql`sva.expires_on >= ${value}`
    if (filter.operator === 'lte') return sql`sva.expires_on <= ${value}`
    if (filter.operator === 'between') {
      const refusedUpper = dateOrFalse(String(filter.to ?? ''))
      if (refusedUpper) return refusedUpper
      return sql`sva.expires_on between ${value} and ${String(filter.to ?? '')}`
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

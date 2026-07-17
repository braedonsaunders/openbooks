import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type {
  ListViewConfig,
  ListColumnPlacement,
  FilterClause,
} from "@openbooks/customization";
import { listColumnMeta, isCustomFieldKey, customFieldDefKey } from "@openbooks/customization";
import type { CustomFieldDef } from "../custom-fields";

/**
 * Vendor-bill list query builder — turns a resolved ListViewConfig + ad-hoc URL
 * filters into the SQL fragments the AP list page renders. The same mapping
 * pattern extends to other record types: whitelisted column→SQL expressions,
 * whitelisted filter→SQL predicates, all parameterized (no identifier ever
 * comes from user input — only catalog keys bind values).
 */

export type ColKind = "reference" | "text" | "date" | "amount" | "status" | "custom" | "actions"

export interface ListColDesc {
  key: string
  kind: ColKind
  label: string
  /** SQL select expression (omitted for the actions column). */
  expr?: SQL
  sortable: boolean
  sortKey?: string
  width?: number | null
  /** For custom columns: the custom field def key. */
  defKey?: string
  defType?: CustomFieldDef["fieldType"]
}

/**
 * A document's gross amount. documents.total is the source of truth — set by
 * computeBillTotals natively and denormalized from the posted entry on import
 * (engine setDocumentTotalsFromEntry + the backfill). The list reads it directly.
 */
export const DOC_AMOUNT_EXPR = sql`d.total`

/** Sort fragments shared by every documents-backed list, keyed by sortKey. */
export const DOCUMENT_SORTS: Record<string, SQL> = {
  number: sql`d.document_number`,
  party: sql`p.display_name`,
  vendor: sql`p.display_name`,
  customer: sql`p.display_name`,
  date: sql`d.document_date`,
  total: DOC_AMOUNT_EXPR,
  balance: sql`d.open_balance`,
  status: sql`d.status`,
}

/** @deprecated use DOCUMENT_SORTS — kept for the AP page's existing import. */
export const VENDOR_BILL_SORTS = DOCUMENT_SORTS

/** Built-in column key → select expression, shared by documents-backed lists. */
export const DOCUMENT_BUILT_IN_EXPR: Record<string, SQL> = {
  document_number: sql`d.document_number`,
  party_name: sql`p.display_name`,
  document_date: sql`d.document_date`,
  reference_number: sql`d.reference_number`,
  total: DOC_AMOUNT_EXPR,
  open_balance: sql`d.open_balance`,
  status: sql`d.status`,
}

const BUILT_IN_EXPR = DOCUMENT_BUILT_IN_EXPR

const SHOW_IN_LIST_BY_KEY = (defs: CustomFieldDef[]) =>
  new Map(defs.filter((d) => d.config.showInList).map((d) => [d.key, d]))

/**
 * Build the ordered, visible column descriptors for a record list table from a
 * resolved view. Generic over record type: `recordType` picks the registry
 * column metadata, `builtInExpr` supplies the whitelisted SQL select expression
 * for each built-in key. Custom (`cf_*`) columns bind against `d.custom`.
 */
export function columnDescriptors(
  recordType: string,
  view: ListViewConfig,
  showInListDefs: CustomFieldDef[],
  builtInExpr: Record<string, SQL>,
  labels: Record<string, string>,
): ListColDesc[] {
  const cfByDefKey = SHOW_IN_LIST_BY_KEY(showInListDefs)
  const out: ListColDesc[] = []
  for (const c of view.columns) {
    if (!c.visible) continue
    if (c.key === "_actions") {
      out.push({ key: "_actions", kind: "actions", label: labels.actions ?? "Actions", sortable: false, width: 44 })
      continue
    }
    if (isCustomFieldKey(c.key)) {
      const defKey = customFieldDefKey(c.key)
      const def = cfByDefKey.get(defKey)
      if (!def) continue
      out.push({
        key: c.key,
        kind: "custom",
        label: c.labelOverride?.trim() ? c.labelOverride.trim() : def.label,
        expr: sql`d.custom->>${defKey}`,
        sortable: false,
        defKey,
        defType: def.fieldType,
        width: c.width,
      })
      continue
    }
    const meta = listColumnMeta(recordType, c.key)
    const expr = builtInExpr[c.key]
    if (!meta || !expr) continue
    out.push({
      key: c.key,
      kind: (meta.kind as ColKind) ?? "text",
      label: c.labelOverride?.trim() ? c.labelOverride.trim() : (labels[c.key] ?? meta.key),
      expr,
      sortable: !!meta.sortable,
      sortKey: meta.sortKey,
      width: c.width ?? meta.defaultWidth ?? null,
    })
  }
  return out
}

/** Build the ordered, visible column descriptors for the AP table. */
export function vendorBillColumnDescriptors(
  view: ListViewConfig,
  showInListDefs: CustomFieldDef[],
  labels: Record<string, string>,
): ListColDesc[] {
  return columnDescriptors("vendor_bill", view, showInListDefs, BUILT_IN_EXPR, labels)
}

/* ------------------------------------------------------------------ */
/* Payments (vendor_payment / customer_payment)                        */
/* ------------------------------------------------------------------ */

/** Payments share the universal journal-fallback amount. */
const PAYMENT_AMOUNT_EXPR = DOC_AMOUNT_EXPR

/**
 * The funding account (bank or card). Prefer the account named in the payment's
 * custom.bankAccountId (native payments); otherwise derive it from the posted
 * entry as the non-control line (everything but the AP/AR control account), so
 * card-funded and imported payments still show where the money moved.
 */
const PAYMENT_BANK_EXPR = sql`coalesce(
  nullif(trim(concat_ws(' ', ca.number, ca.name)), ''),
  (select trim(concat_ws(' ', acc.number, acc.name))
     from journal_lines jl
     join accounts acc on acc.id = jl.account_id
    where jl.entry_id = d.posted_entry_id
      and acc.type not in ('liability_payable', 'asset_receivable')
    order by abs(jl.amount) desc
    limit 1)
)`

/** The funding account's id (for drill-through), resolved the same way as
 *  PAYMENT_BANK_EXPR: custom.bankAccountId, else the entry's non-control line. */
export const PAYMENT_BANK_ID_EXPR = sql`coalesce(
  ca.id,
  (select acc.id
     from journal_lines jl
     join accounts acc on acc.id = jl.account_id
    where jl.entry_id = d.posted_entry_id
      and acc.type not in ('liability_payable', 'asset_receivable')
    order by abs(jl.amount) desc
    limit 1)
)`

export const PAYMENT_BUILT_IN_EXPR: Record<string, SQL> = {
  document_number: sql`d.document_number`,
  party_name: sql`p.display_name`,
  document_date: sql`d.document_date`,
  bank_account: PAYMENT_BANK_EXPR,
  reference_number: sql`d.reference_number`,
  total: PAYMENT_AMOUNT_EXPR,
  status: sql`d.status`,
}

/** Sort fragments for the payments list (keyed by column sortKey). */
export const PAYMENT_SORTS: Record<string, SQL> = {
  number: sql`d.document_number`,
  party: sql`p.display_name`,
  date: sql`d.document_date`,
  total: PAYMENT_AMOUNT_EXPR,
  status: sql`d.status`,
}

/** Build the ordered, visible column descriptors for the payments table. */
export function paymentColumnDescriptors(
  recordType: "vendor_payment" | "customer_payment",
  view: ListViewConfig,
  showInListDefs: CustomFieldDef[],
  labels: Record<string, string>,
): ListColDesc[] {
  return columnDescriptors(recordType, view, showInListDefs, PAYMENT_BUILT_IN_EXPR, labels)
}

/** Allowed ad-hoc URL filters (the quick toolbar filters). */
export interface AdhocFilters {
  q?: string
  status?: string
  vendor?: string
  from?: string
  to?: string
  /** Narrow to a single document kind within the view's kind set. */
  kind?: string
}

function filterPredicate(clause: FilterClause): SQL | null {
  const { key, operator } = clause
  const value = clause.value
  const to = clause.to
  const single = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? "") : String(v ?? ""))
  switch (key) {
    case "status":
      if (operator === "eq") return sql`d.status = ${single(value)}`
      if (operator === "ne") return sql`d.status <> ${single(value)}`
      if (operator === "in" || operator === "not_in") {
        const values = (Array.isArray(value) ? value : [String(value ?? "")]).map(String)
        if (values.length === 0) return operator === "in" ? sql`false` : sql`true`
        const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
        return operator === "in" ? sql`d.status in (${list})` : sql`d.status not in (${list})`
      }
      return null
    case "party_id":
      if (operator === "eq") return sql`d.party_id = ${single(value)}`
      if (operator === "ne") return sql`d.party_id <> ${single(value)}`
      return null
    case "document_date":
      if (operator === "eq") return sql`d.document_date = ${single(value)}`
      if (operator === "gte") return sql`d.document_date >= ${single(value)}`
      if (operator === "lte") return sql`d.document_date <= ${single(value)}`
      if (operator === "between") return sql`d.document_date between ${single(value)} and ${single(to)}`
      return null
    case "reference_number":
      if (operator === "eq") return sql`d.reference_number = ${single(value)}`
      if (operator === "contains") return sql`d.reference_number ilike ${"%" + single(value) + "%"}`
      if (operator === "is_set") return sql`(d.reference_number is not null and d.reference_number <> '')`
      if (operator === "is_not_set") return sql`(d.reference_number is null or d.reference_number = '')`
      return null
    default:
      return null
  }
}

/**
 * The canonical WHERE fragment for any `documents`-backed list: tenant + kind
 * scope, the saved view's structured filters, and the ad-hoc toolbar filters.
 * Every documents list (bills, invoices, orders, payments…) shares this — pass
 * the record type's `kinds`. `orgId` is mandatory: every query is tenant-scoped.
 *
 * `allowedSubsidiaryIds` is the caller's role-based subsidiary visibility
 * (authz.allowedSubsidiaryIds): a non-null Set narrows the list to those
 * subsidiaries; null/undefined = unrestricted.
 */
export function documentWhere(
  kinds: readonly string[],
  view: ListViewConfig,
  adhoc: AdhocFilters,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [
    sql`d.org_id = ${orgId} and d.kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})`,
  ]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and d.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])` : sql`and false`)
  }
  for (const f of view.filters) {
    const p = filterPredicate(f)
    if (p) parts.push(sql`and ${p}`)
  }
  if (adhoc.status) parts.push(sql`and d.status = ${adhoc.status}`)
  if (adhoc.kind) parts.push(sql`and d.kind = ${adhoc.kind}`)
  if (adhoc.vendor) parts.push(sql`and d.party_id = ${adhoc.vendor}`)
  if (adhoc.from) parts.push(sql`and d.document_date >= ${adhoc.from}`)
  if (adhoc.to) parts.push(sql`and d.document_date <= ${adhoc.to}`)
  if (adhoc.q)
    parts.push(
      sql`and (d.document_number ilike ${"%" + adhoc.q + "%"} or p.display_name ilike ${"%" + adhoc.q + "%"} or d.reference_number ilike ${"%" + adhoc.q + "%"})`,
    )
  return sql.join(parts, sql` `)
}

/** Back-compat wrapper for the AP list. */
export function vendorBillWhere(
  view: ListViewConfig,
  adhoc: AdhocFilters,
  kinds: readonly string[] = ["vendor_bill"],
  orgId?: string,
): SQL {
  return documentWhere(kinds, view, adhoc, orgId ?? "")
}

/** Back-compat wrapper for the payments/receipts list (single kind). */
export function paymentWhere(
  view: ListViewConfig,
  adhoc: AdhocFilters,
  kind: string,
  orgId: string,
): SQL {
  return documentWhere([kind], view, adhoc, orgId)
}

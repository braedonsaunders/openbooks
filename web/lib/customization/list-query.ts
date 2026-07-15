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
  /** For custom columns: the custom field def key. */
  defKey?: string
  defType?: CustomFieldDef["fieldType"]
}

/** Sort fragments keyed by the column sortKey (validated by parseListParams). */
export const VENDOR_BILL_SORTS: Record<string, SQL> = {
  number: sql`d.document_number`,
  vendor: sql`p.display_name`,
  date: sql`d.document_date`,
  total: sql`d.total`,
  status: sql`d.status`,
}

const BUILT_IN_EXPR: Record<string, SQL> = {
  document_number: sql`d.document_number`,
  party_name: sql`p.display_name`,
  document_date: sql`d.document_date`,
  reference_number: sql`d.reference_number`,
  total: sql`d.total`,
  status: sql`d.status`,
}

const SHOW_IN_LIST_BY_KEY = (defs: CustomFieldDef[]) =>
  new Map(defs.filter((d) => d.config.showInList).map((d) => [d.key, d]))

/** Build the ordered, visible column descriptors for the AP table. */
export function vendorBillColumnDescriptors(
  view: ListViewConfig,
  showInListDefs: CustomFieldDef[],
  labels: Record<string, string>,
): ListColDesc[] {
  const cfByDefKey = SHOW_IN_LIST_BY_KEY(showInListDefs)
  const out: ListColDesc[] = []
  for (const c of view.columns) {
    if (!c.visible) continue
    if (c.key === "_actions") {
      out.push({ key: "_actions", kind: "actions", label: labels.actions ?? "Actions", sortable: false })
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
      })
      continue
    }
    const meta = listColumnMeta("vendor_bill", c.key)
    const expr = BUILT_IN_EXPR[c.key]
    if (!meta || !expr) continue
    out.push({
      key: c.key,
      kind: (meta.kind as ColKind) ?? "text",
      label: c.labelOverride?.trim() ? c.labelOverride.trim() : (labels[c.key] ?? meta.key),
      expr,
      sortable: !!meta.sortable,
      sortKey: meta.sortKey,
    })
  }
  return out
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
      if (operator === "in")
        return sql`d.status = any(${Array.isArray(value) ? value : [String(value ?? "")]})`
      if (operator === "not_in")
        return sql`d.status <> all(${Array.isArray(value) ? value : [String(value ?? "")]})`
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

/** Combine the saved view filters + ad-hoc URL filters into one WHERE fragment.
 *  `orgId` is mandatory — every documents query must be tenant-scoped. */
export function vendorBillWhere(
  view: ListViewConfig,
  adhoc: AdhocFilters,
  kinds: readonly string[] = ["vendor_bill"],
  orgId?: string,
): SQL {
  const parts: SQL[] = [sql`d.kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})`]
  if (orgId) parts.push(sql`and d.org_id = ${orgId}`)
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

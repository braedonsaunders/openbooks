import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./db.ts";
import { add, cmp, neg, normalizeDecimal, normalizeMoney, sum } from "./money.ts";

export class BillingSourceIntegrityError extends Error {}
const correction = "This generated bill or invoice must preserve its source application or retainage release. Correct or cancel it through the source billing workflow and regenerate it; if account configuration changed, review that configuration before regenerating.";
const refuse = (): never => { throw new BillingSourceIntegrityError(correction); };
type Row = Record<string, unknown>;
const headerFields = ["documentDate", "postingDate", "kind", "partyId", "currency", "projectId", "subsidiaryId", "paymentCardId", "departmentId", "locationId", "classId", "extraDims"];
const lineFields = ["accountId", "itemId", "unit", "taxCodeId", "taxGroupId", "partyId", "departmentId", "projectId", "locationId", "classId", "stockLocationId", "extraDims"];
function canonical(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function camel(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
}
function decimal(value: unknown): string {
  if (typeof value !== "string") return refuse();
  return value;
}
function dateKey(value: unknown): unknown {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}
function headerKey(row: Row, key: string): string {
  return canonical(key.endsWith("Date") ? dateKey(row[key] ?? null) : row[key] ?? (key === "extraDims" ? {} : null));
}
function lineKey(l: Row): string {
  return canonical([
    ...lineFields.map(k => k === "extraDims" ? l[k] ?? {} : l[k] ?? null),
    normalizeDecimal(decimal(l.quantity ?? "1"), 10), normalizeDecimal(decimal(l.unitPrice ?? l.amount), 10),
    normalizeMoney(decimal(l.amount)), normalizeMoney(decimal(l.taxAmount ?? "0")),
    // Untaxed generators predate tax_input_amount; their zero default is not
    // a financial difference from the editor's untaxed base amount.
    l.taxCodeId || l.taxGroupId ? normalizeMoney(decimal(l.taxInputAmount ?? "0")) : null,
  ]);
}
function sameEconomics(a: Row, al: Row[], b: Row, bl: Row[]): boolean {
  return headerFields.every(k => headerKey(a, k) === headerKey(b, k)) &&
    ["subtotal", "taxTotal", "total"].every(k => cmp(decimal(a[k]), decimal(b[k])) === 0) &&
    canonical(al.map(lineKey).sort()) === canonical(bl.map(lineKey).sort());
}
function editableLineKey(line: Row): string {
  return canonical([lineKey(line), line.description ?? null, line.custom ?? {}, line.taxOverridden ?? false]);
}

/** Only relational reservations establish provenance; custom JSON is never authority. */
async function sources(tx: SqlExecutor, orgId: string, documentId: string): Promise<Row[]> {
  return (await tx.execute<Row>(sql`
    select 'vendor_application' as source, id from vendor_pay_applications
      where org_id=${orgId} and vendor_bill_document_id=${documentId}
    union all select 'vendor_release', id from vendor_retainage_releases
      where org_id=${orgId} and vendor_bill_document_id=${documentId}
    union all select 'customer_application', id from pay_applications
      where org_id=${orgId} and invoice_document_id=${documentId}
  `)).rows;
}
async function documentSnapshot(tx: SqlExecutor, orgId: string, id: string) {
  const d = (await tx.execute<Row>(sql`select * from documents where org_id=${orgId} and id=${id}`)).rows[0];
  if (!d) return refuse();
  const lines = (await tx.execute<Row>(sql`select * from document_lines where org_id=${orgId} and document_id=${id} order by line_number`)).rows;
  return { document: camel(d), lines: lines.map(camel) };
}

/** Caller holds the document revision lock. Refuse before audit or line replacement.
 * Returns true for source-linked documents whose original line rows must be kept.
 */
export async function assertGeneratedBillingEdit(
  tx: SqlExecutor, orgId: string, id: string, patch: Row, preparedLines: Row[] | null,
): Promise<boolean> {
  const linked = await sources(tx, orgId, id);
  if (!linked.length) return false;
  if (linked.length !== 1) refuse();
  const before = await documentSnapshot(tx, orgId, id);
  const after = { ...before.document, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  if (!sameEconomics(before.document, before.lines, after, preparedLines ?? before.lines)) refuse();
  // The editor addresses lines by their array position. Equal totals or an
  // unordered match cannot authorize changed descriptions, custom content,
  // tax override evidence, or a reordered source presentation.
  if (preparedLines && canonical(before.lines.map(editableLineKey)) !== canonical(preparedLines.map(editableLineKey))) refuse();
  return true;
}

/** Validate the exact posting input, then repeat under the posting transaction
 * lock to fence stale inputs. No tax policy is invented: these generators emit
 * untaxed gross lines and one retained leg (or one release leg).
 */
export async function assertGeneratedBillingPostable(
  tx: SqlExecutor, orgId: string, id: string,
  input: { document: Row; lines: Row[] }, lock = false,
): Promise<void> {
  if (!["vendor_bill", "customer_invoice"].includes(String(input.document.kind))) return;
  const linked = await sources(tx, orgId, id);
  if (!linked.length) return;
  if (linked.length !== 1) refuse();
  if (lock) {
    await tx.execute(sql`select id from documents where org_id=${orgId} and id=${id} for update`);
    const live = await documentSnapshot(tx, orgId, id);
    if (!sameEconomics(input.document, input.lines, live.document, live.lines)) refuse();
  }
  const source = linked[0]!;
  let evidence: Row;
  let gross: string;
  let retained = "0";
  let grossAmounts: string[] = [];
  let total: string;
  let release = source.source === "vendor_release";
  if (source.source === "vendor_application") {
    evidence = (await tx.execute<Row>(sql`
      select a.status, a.gross_this_period as gross, a.retainage_this_period as retained, a.net_due as total,
        s.vendor_id as party, s.project_id as project, s.currency, p.subsidiary_id as subsidiary
      from vendor_pay_applications a
      join subcontracts s on s.org_id=a.org_id and s.id=a.subcontract_id
      join projects p on p.org_id=s.org_id and p.id=s.project_id
      where a.org_id=${orgId} and a.id=${source.id} and a.vendor_bill_document_id=${id}
      ${lock ? sql`for share of a, s, p` : sql``}
    `)).rows[0]!;
    if (!evidence || evidence.status !== "billed") refuse();
    gross = decimal(evidence.gross); retained = decimal(evidence.retained); total = decimal(evidence.total);
    grossAmounts = (await tx.execute<{ amount: string }>(sql`
      select (work_completed_this_period + materials_stored_current - previous_materials_stored)::text as amount
      from vendor_pay_application_lines where org_id=${orgId} and pay_application_id=${source.id}
    `)).rows.map(l => l.amount).filter(amount => cmp(amount, "0") !== 0);
  } else if (release) {
    evidence = (await tx.execute<Row>(sql`
      select r.amount as total, s.vendor_id as party, s.project_id as project, s.currency, p.subsidiary_id as subsidiary
      from vendor_retainage_releases r
      join subcontracts s on s.org_id=r.org_id and s.id=r.subcontract_id
      join projects p on p.org_id=s.org_id and p.id=s.project_id
      where r.org_id=${orgId} and r.id=${source.id} and r.vendor_bill_document_id=${id}
      ${lock ? sql`for share of r, s, p` : sql``}
    `)).rows[0]!;
    if (!evidence) refuse();
    gross = total = decimal(evidence.total);
  } else {
    evidence = (await tx.execute<Row>(sql`
      select a.kind, a.status, p.customer_id as party, p.id as project, p.subsidiary_id as subsidiary,
        coalesce(s.base_currency,o.base_currency) as currency
      from pay_applications a
      join projects p on p.org_id=a.org_id and p.id=a.project_id
      join orgs o on o.id=p.org_id
      left join subsidiaries s on s.org_id=p.org_id and s.id=p.subsidiary_id
      where a.org_id=${orgId} and a.id=${source.id} and a.invoice_document_id=${id}
      ${lock ? sql`for share of a, p` : sql``}
    `)).rows[0]!;
    if (!evidence || !["invoiced", "posted"].includes(String(evidence.status))) refuse();
    release = evidence.kind === "retainage_release";
    // Customer monetary snapshots live in the immutable generation audit.
    // Extract decimals as text in PostgreSQL; never JSON-parse numeric money.
    const audits = (await tx.execute<Row>(sql`
      select changes->'totals'->>'grossThisPeriod' as gross,
        changes->'totals'->>'retainageThisPeriod' as retained,
        changes->'totals'->>'currentDue' as total, changes->'after'->>'amount' as amount
      from audit_log where org_id=${orgId} and table_name='pay_applications' and row_id=${source.id}
        and action=${release ? "retainage_release" : "invoice"}
        and changes->'after'->>'invoiceId'=${id}
    `)).rows;
    if (audits.length !== 1) refuse();
    const audit = audits[0]!;
    gross = decimal(release ? audit.amount : audit.gross);
    retained = release ? "0" : decimal(audit.retained);
    total = decimal(release ? audit.amount : audit.total);
    if (!release) {
      grossAmounts = (await tx.execute<{ amount: string }>(sql`
        select line->>'grossThisPeriod' as amount from audit_log a,
          lateral jsonb_array_elements(a.changes->'totals'->'lines') line
        where a.org_id=${orgId} and a.table_name='pay_applications' and a.row_id=${source.id}
          and a.action='invoice' and a.changes->'after'->>'invoiceId'=${id}
      `)).rows.map(l => decimal(l.amount)).filter(amount => cmp(amount, "0") !== 0);
    }
  }
  const doc = input.document, lines = input.lines;
  if (!gross || !retained || !total || cmp(gross, "0") <= 0 || cmp(retained, "0") < 0 || cmp(add(gross, neg(retained)), total) !== 0) refuse();
  const kind = String(source.source).startsWith("vendor_") ? "vendor_bill" : "customer_invoice";
  if (doc.kind !== kind || doc.partyId !== evidence.party || doc.projectId !== evidence.project ||
      doc.subsidiaryId !== evidence.subsidiary || doc.currency !== evidence.currency || doc.paymentCardId ||
      cmp(decimal(doc.total), total) !== 0 || cmp(decimal(doc.subtotal), total) !== 0 || cmp(decimal(doc.taxTotal), "0") !== 0) refuse();
  if (lines.some(l => l.projectId !== evidence.project || (l.partyId != null && l.partyId !== evidence.party) ||
      l.itemId || l.taxCodeId || l.taxGroupId || cmp(decimal(l.taxAmount ?? "0"), "0") !== 0)) refuse();
  const components = await tx.execute(sql`select c.id from document_line_tax_components c
    join document_lines l on l.org_id=c.org_id and l.id=c.document_line_id
    where l.org_id=${orgId} and l.document_id=${id} limit 1`);
  if (components.rows.length) refuse();
  const control = (await tx.execute<{ account: string | null }>(sql`
    select settings->'controlAccounts'->>${kind === "vendor_bill" ? "retainagePayable" : "retainageReceivable"} as account
      from orgs where id=${orgId}
  `)).rows[0]?.account;
  if (release) {
    if (!control || lines.length !== 1 || lines[0]!.accountId !== control || cmp(decimal(lines[0]!.amount), total) !== 0) refuse();
  } else {
    // Match source gross lines independently of their sign. The retained leg
    // is one additional line, so historical negative gross adjustments cannot
    // be confused with withheld retainage or silently dropped.
    const grossLines = [...lines];
    if (cmp(retained, "0") > 0) {
      const heldIndex = grossLines.findIndex(l => l.accountId === control && cmp(decimal(l.amount), neg(retained)) === 0);
      if (!control || heldIndex < 0) refuse();
      grossLines.splice(heldIndex, 1);
    }
    if (cmp(sum(grossAmounts), gross) !== 0 ||
        canonical(grossLines.map(l => normalizeMoney(decimal(l.amount))).sort()) !==
        canonical(grossAmounts.map(amount => normalizeMoney(amount)).sort())) refuse();
  }
}

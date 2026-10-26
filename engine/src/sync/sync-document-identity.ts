import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits, normalizeDecimal } from "../money/money.ts";
import { type NativeDocument } from "./native.ts";
import { documentNumberScopeKey } from "../records/numbering.ts";

export function effectiveLineSubsidiary(
  lineSubsidiaryId: string | null | undefined,
  documentSubsidiaryId: string | null | undefined,
): string | null {
  return lineSubsidiaryId ?? documentSubsidiaryId ?? null;
}

/** A zero tax amount carries no tax-code identity in a rate-keyed import. */
export function effectiveTaxCodeId(
  taxAmount: string,
  taxCodeId: string | null | undefined,
): string | null {
  return toUnits(taxAmount) === 0n ? null : (taxCodeId ?? null);
}

/** A posted mirror cannot silently become non-posting without a reversal. */
export function requiresControlledPostingReversal(
  sourcePosting: boolean,
  storedPosted: boolean,
): boolean {
  return storedPosted && !sourcePosting;
}

/** Canonical content key of a native document (change detection). */
function mappedCustomKey(value: Record<string, unknown> | null | undefined): unknown[] {
  if (!value || !Object.keys(value).length) return [];
  return [
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    ),
  ];
}

export function canonicalNativeDocumentKey(d: NativeDocument): string {
  // Line-level source-cleared evidence is deliberately absent: a clear-flip
  // must never amend or re-post the document (see NativeDocLine).
  return JSON.stringify([
    d.kind,
    d.posting,
    d.posting ? null : (d.lifecycleStatus ?? "approved"),
    d.partyId,
    d.subsidiaryId,
    d.documentDate,
    d.postingDate ?? d.documentDate,
    d.postingPeriodId ?? null,
    d.dueDate,
    d.currency,
    normalizeDecimal(d.fxRate ?? "1", 8),
    d.posting ? null : toUnits(d.subtotal ?? "0").toString(),
    d.posting ? null : toUnits(d.total ?? "0").toString(),
    d.memo,
    d.referenceNumber,
    d.controlAccountId,
    d.extraDims ?? {},
    d.lines.map((l) => [
      l.lineNumber,
      l.sourceLineRef ?? null,
      l.accountId,
      l.itemId,
      normalizeDecimal(l.quantity ?? "1", 8),
      l.unit ?? null,
      normalizeDecimal(l.unitPrice ?? l.amount, 8),
      toUnits(l.amount).toString(),
      toUnits(l.taxAmount).toString(),
      l.taxOverridden,
      effectiveTaxCodeId(l.taxAmount, l.taxCodeId),
      l.partyId ?? null,
      l.departmentId,
      l.projectId,
      l.fieldTicketSourceSystem?.trim() || null,
      l.fieldTicketSourceRef?.trim() || null,
      effectiveLineSubsidiary(l.subsidiaryId, d.subsidiaryId),
      l.extraDims ?? {},
      l.description,
      l.isBillable ?? false,
      l.markupPercent == null ? null : normalizeDecimal(l.markupPercent, 4),
      l.billAmount == null ? null : toUnits(l.billAmount).toString(),
      ...mappedCustomKey(l.mappedCustom),
    ]),
    ...mappedCustomKey(d.mappedCustom),
  ]);
}

/** Human-facing source number, kept separate from the immutable sourceRef. */
export function effectiveSourceDocumentNumber(d: NativeDocument): string {
  return d.documentNumber?.trim() || d.sourceRef;
}

/** Adds the immutable source identity to a colliding human-facing number. */
export function collisionSafeSourceDocumentNumber(d: NativeDocument, sourceName: string): string {
  const suffix = ` [${sourceName}:${d.sourceRef}]`;
  return `${effectiveSourceDocumentNumber(d)}${suffix}`;
}

/** Resolves the source number within the document kind and party uniqueness scope. */
export function resolveSourceDocumentNumber(
  d: NativeDocument,
  sourceName: string,
  currentDocumentId: string | undefined,
  numberOwners: ReadonlyMap<string, string>,
  partyId: string | null = d.partyId,
): string {
  const preferred = effectiveSourceDocumentNumber(d);
  const preferredOwner = numberOwners.get(documentNumberScopeKey(d.kind, partyId, preferred));
  if (!preferredOwner || preferredOwner === currentDocumentId) return preferred;

  const alternate = collisionSafeSourceDocumentNumber(d, sourceName);
  const alternateOwner = numberOwners.get(documentNumberScopeKey(d.kind, partyId, alternate));
  if (alternateOwner && alternateOwner !== currentDocumentId) {
    throw new Error(
      `${d.kind} document number ${preferred} and collision-safe number ${alternate} are both owned by other documents`,
    );
  }
  return alternate;
}

/** The same canonical key computed from the stored document. */
type StoredDocumentKeyRow = {
  mapped_custom?: Record<string, unknown> | null;
  id: string;
  kind: string;
  party_id: string | null;
  subsidiary_id: string | null;
  document_date: string;
  posting_date: string | null;
  posting_period_id: string | null;
  due: string | null;
  memo: string | null;
  reference_number: string | null;
  ctrl: string | null;
  extra_dims: Record<string, string | null>;
  posted: boolean;
  status: string;
  currency: string;
  fx_rate: string;
  subtotal: string;
  total: string;
};
type StoredLineKeyRow = {
  mapped_custom?: Record<string, unknown> | null;
  document_id: string;
  line_number: number;
  source_line_ref: string | null;
  account_id: string | null;
  item_id: string | null;
  quantity: string;
  unit: string | null;
  unit_price: string;
  amount: string;
  tax_amount: string;
  tax_overridden: boolean;
  tax_code_id: string | null;
  party_id: string | null;
  department_id: string | null;
  project_id: string | null;
  field_ticket_source_system: string | null;
  field_ticket_source_ref: string | null;
  subsidiary_id: string | null;
  extra_dims: Record<string, string | null>;
  description: string | null;
  is_billable: boolean;
  markup_percent: string | null;
  bill_amount: string | null;
};

function storedCanonicalKey(d: StoredDocumentKeyRow, lines: StoredLineKeyRow[]): string {
  return JSON.stringify([
    d.kind,
    d.posted,
    d.posted ? null : d.status,
    d.party_id,
    d.subsidiary_id,
    d.document_date,
    d.posting_date ?? d.document_date,
    d.posting_period_id,
    d.due,
    d.currency,
    normalizeDecimal(d.fx_rate, 8),
    d.posted ? null : toUnits(d.subtotal).toString(),
    d.posted ? null : toUnits(d.total).toString(),
    d.memo,
    d.reference_number,
    d.ctrl,
    d.extra_dims ?? {},
    lines.map((l) => [
      l.line_number,
      l.source_line_ref,
      l.account_id,
      l.item_id,
      normalizeDecimal(l.quantity, 8),
      l.unit,
      normalizeDecimal(l.unit_price, 8),
      toUnits(l.amount).toString(),
      toUnits(l.tax_amount).toString(),
      l.tax_overridden,
      effectiveTaxCodeId(l.tax_amount, l.tax_code_id),
      l.party_id ?? null,
      l.department_id,
      l.project_id,
      l.field_ticket_source_system ?? null,
      l.field_ticket_source_ref ?? null,
      effectiveLineSubsidiary(l.subsidiary_id, d.subsidiary_id),
      l.extra_dims ?? {},
      l.description,
      l.is_billable,
      l.markup_percent == null ? null : normalizeDecimal(l.markup_percent, 4),
      l.bill_amount == null ? null : toUnits(l.bill_amount).toString(),
      ...mappedCustomKey(l.mapped_custom),
    ]),
    ...mappedCustomKey(d.mapped_custom),
  ]);
}

export async function storedKey(docId: string, orgId: string): Promise<string> {
  const [d] = await db.execute<StoredDocumentKeyRow>(
    sql`
      select kind, party_id, subsidiary_id,
             document_date::text, posting_date::text,
             posting_period_id,
             due_date::text as due,
             memo, reference_number, custom->>'controlAccountId' as ctrl, (select jsonb_object_agg(k,custom->k) from jsonb_object_keys(coalesce(custom->'connectorMappedValues','{}'::jsonb)) k) as mapped_custom, extra_dims, id,
             posted_entry_id is not null as posted, status, currency, fx_rate, subtotal, total
        from documents where id = ${docId} and org_id = ${orgId}`,
    "objects",
  );
  const lines = await db.execute<StoredLineKeyRow>(
    sql`
      select line.line_number, line.custom->>'sourceLineRef' as source_line_ref, (select jsonb_object_agg(k,line.custom->k) from jsonb_object_keys(coalesce(line.custom->'connectorMappedValues','{}'::jsonb)) k) as mapped_custom,
             line.account_id, line.item_id, line.quantity, line.unit, line.unit_price,
             line.amount, line.tax_amount, line.tax_overridden, line.tax_code_id,
             line.party_id, line.department_id, line.project_id, line.subsidiary_id, line.extra_dims, line.description,
             line.is_billable, line.markup_percent, line.bill_amount,
             ticket.custom->'source'->>'system' as field_ticket_source_system,
             ticket.custom->'source'->>'externalId' as field_ticket_source_ref
        from document_lines line
        left join documents ticket on ticket.org_id = line.org_id and ticket.id = line.field_ticket_id
       where line.document_id = ${docId} and line.org_id = ${orgId} order by line.line_number`,
    "objects",
  );
  return storedCanonicalKey(d!, lines);
}

/** Full migrations compare tens of thousands of documents; load their keys in
 * two set queries instead of issuing two round trips per transaction. */
export async function loadStoredKeys(orgId: string, refKey: string): Promise<Map<string, string>> {
  const documents = await db.execute<StoredDocumentKeyRow>(
    sql`
    select id, kind, party_id, subsidiary_id,
           document_date::text, posting_date::text,
           posting_period_id,
           due_date::text as due,
           memo, reference_number, custom->>'controlAccountId' as ctrl, (select jsonb_object_agg(k,custom->k) from jsonb_object_keys(coalesce(custom->'connectorMappedValues','{}'::jsonb)) k) as mapped_custom, extra_dims,
           posted_entry_id is not null as posted, status, currency, fx_rate, subtotal, total
      from documents
     where org_id = ${orgId} and custom->>${refKey} is not null
     order by id`,
    "objects",
  );
  const lineResult = await db.execute<StoredLineKeyRow>(
    sql`
    select dl.document_id, dl.line_number,
           dl.custom->>'sourceLineRef' as source_line_ref, (select jsonb_object_agg(k,dl.custom->k) from jsonb_object_keys(coalesce(dl.custom->'connectorMappedValues','{}'::jsonb)) k) as mapped_custom,
           dl.account_id, dl.item_id, dl.quantity, dl.unit, dl.unit_price,
           dl.amount, dl.tax_amount, dl.tax_overridden,
           dl.tax_code_id, dl.party_id, dl.department_id, dl.project_id, dl.subsidiary_id,
           dl.extra_dims, dl.description,
           dl.is_billable, dl.markup_percent, dl.bill_amount,
           ticket.custom->'source'->>'system' as field_ticket_source_system,
           ticket.custom->'source'->>'externalId' as field_ticket_source_ref
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
      left join documents ticket on ticket.org_id = dl.org_id and ticket.id = dl.field_ticket_id
     where dl.org_id = ${orgId} and d.org_id = ${orgId} and d.custom->>${refKey} is not null
     order by dl.document_id, dl.line_number`,
    "objects",
  );
  const linesByDocument = new Map<string, StoredLineKeyRow[]>();
  for (const line of lineResult) {
    const lines = linesByDocument.get(line.document_id);
    if (lines) lines.push(line);
    else linesByDocument.set(line.document_id, [line]);
  }
  return new Map(
    documents.map((document) => [
      document.id,
      storedCanonicalKey(document, linesByDocument.get(document.id) ?? []),
    ]),
  );
}

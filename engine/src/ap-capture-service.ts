import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "./db.ts";
import { allocateDocumentNumber } from "./document-numbering.ts";
import { inventoryFeatureEnabled } from "./inventory.ts";
import { cmp, fromUnits, sum, toUnits } from "./money.ts";
import {
  extractAzureInvoice,
  validatePurchaseOrderQuantities,
  validateNormalizedCapture,
  type CaptureIssue,
  type CaptureLine,
  type NormalizedCapture,
} from "./ap-capture.ts";
import { getDocumentCaptureRuntimeConfig } from "./ap-capture-config.ts";
import { actorHasPermission } from "./actor-permissions.ts";
import { getS3Blob } from "./file-storage.ts";
import { runRecordFlows } from "./flows/index.ts";

type CaptureRow = {
  id: string;
  org_id: string;
  file_id: string;
  status: string;
  document_kind: "vendor_bill" | "vendor_credit";
  normalized: NormalizedCapture;
  vendor_candidate_id: string | null;
  purchase_order_id: string | null;
  document_id: string | null;
  original_filename: string;
  content_hash: string;
  created_by: string | null;
};

function normalizedKey(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function issue(code: string, severity: "blocking" | "warning", extra: Partial<CaptureIssue> = {}): CaptureIssue {
  return { code, severity, ...extra };
}

async function loadCaptureBlob(orgId: string, fileId: string): Promise<{ bytes: Buffer; contentType: string }> {
  const result = (await db.execute<{ version_id: string; storage_kind: string; content_type: string; bytes: Buffer | null }>(sql`
    select fv.id as version_id, fv.storage_kind, fv.content_type, fb.bytes
      from files f
      join file_versions fv on fv.id = f.current_version_id and fv.file_id = f.id
      left join file_blobs fb on fb.version_id = fv.id
     where f.org_id = ${orgId} and f.id = ${fileId} and not f.is_inactive
  `));
  const row = result.rows[0];
  if (!row) throw new Error("Capture source file is missing");
  const bytes = row.storage_kind === "s3" ? await getS3Blob(row.version_id) : row.bytes;
  if (!bytes) throw new Error("Capture source bytes are missing");
  return { bytes, contentType: row.content_type };
}

async function resolveVendor(orgId: string, capture: NormalizedCapture): Promise<string | null> {
  if (capture.vendorTaxId) {
    const taxKey = normalizedKey(capture.vendorTaxId);
    const tax = (await db.execute<{ id: string }>(sql`
      select distinct p.id
        from parties p
        join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id and vr.is_active
        cross join lateral jsonb_each_text(coalesce(p.tax_ids, '{}'::jsonb)) tax_id
       where p.org_id = ${orgId} and p.is_active
         and regexp_replace(lower(tax_id.value), '[^a-z0-9]', '', 'g') = ${taxKey}
       limit 2
    `));
    if (tax.rows.length === 1) return tax.rows[0]!.id;
  }
  if (!capture.vendorName) return null;
  const alias = normalizedKey(capture.vendorName);
  const learned = (await db.execute<{ id: string | null }>(sql`
    select output->>'partyId' as id from ap_capture_rules
     where org_id = ${orgId} and rule_kind = 'vendor_alias' and is_active
       and match->>'alias' = ${alias}
     order by confirmation_count desc limit 2
  `));
  if (learned.rows.length === 1 && learned.rows[0]!.id) return learned.rows[0]!.id;
  const exact = (await db.execute<{ id: string }>(sql`
    select p.id from parties p
    join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id and vr.is_active
    where p.org_id = ${orgId} and p.is_active
      and (
        regexp_replace(lower(p.display_name), '[^a-z0-9]', '', 'g') = ${alias}
        or regexp_replace(lower(coalesce(p.legal_name, '')), '[^a-z0-9]', '', 'g') = ${alias}
      )
    limit 2
  `));
  return exact.rows.length === 1 ? exact.rows[0]!.id : null;
}

async function resolvePurchaseOrder(
  orgId: string,
  capture: NormalizedCapture,
  vendorId: string | null,
): Promise<string | null> {
  if (!capture.purchaseOrderNumber) return null;
  const result = (await db.execute<{ id: string }>(sql`
    select id from documents
     where org_id = ${orgId} and kind = 'purchase_order' and status = 'approved'
       and (document_number = ${capture.purchaseOrderNumber} or reference_number = ${capture.purchaseOrderNumber})
       and (${vendorId}::uuid is null or party_id = ${vendorId})
       and (${capture.currency}::text is null or currency = ${capture.currency})
     limit 2
  `));
  return result.rows.length === 1 ? result.rows[0]!.id : null;
}

/**
 * Item kinds that are never stock-received, so their purchase-order lines bill
 * on a two-way match (ordered quantity + price). Every other kind — including
 * an unknown or missing kind — requires the receipt leg of the match.
 */
export const RECEIPT_EXEMPT_ITEM_KINDS: ReadonlySet<string> = new Set([
  "service",
  "non_inventory",
  "other_charge",
  "equipment_charge",
  "labor",
  "absence",
  "discount",
]);

const receiptExemptItemKindsSql = sql.join(
  [...RECEIPT_EXEMPT_ITEM_KINDS].map((kind) => sql`${kind}`),
  sql`, `,
);

export function lineRequiresReceipt(itemKind: string | null | undefined): boolean {
  return typeof itemKind !== "string" || !RECEIPT_EXEMPT_ITEM_KINDS.has(itemKind);
}

/** Line-level unit-price tolerance against the ordered price, as a percent. */
export const PRICE_TOLERANCE_PERCENT = "2";

/**
 * Exact numeric(19,4) comparison — no floating point and no rounding drift:
 * |invoiced − ordered| · 100 ≤ |ordered| · tolerance.
 */
export function priceWithinTolerance(
  poUnitPrice: string,
  invoiceUnitPrice: string,
  tolerancePercent: string = PRICE_TOLERANCE_PERCENT,
): boolean {
  const expected = toUnits(poUnitPrice);
  const actual = toUnits(invoiceUnitPrice);
  const diff = expected >= actual ? expected - actual : actual - expected;
  const basis = expected < 0n ? -expected : expected;
  return diff * 1_000_000n <= basis * toUnits(tolerancePercent);
}

export type PurchaseOrderMatchIssue = {
  code: "po_quantity_exceeded" | "receipt_quantity_shortfall" | "po_price_variance";
  expected: string;
  actual: string;
};

type CaptureDocumentKind = CaptureRow["document_kind"];

/**
 * The one three-way match every billing channel shares: ordered quantity,
 * received quantity (for stock kinds) and price. Extraction validation calls
 * it per captured line, materialize re-runs it against fresh purchase-order
 * rows at the write boundary, and manual conversion clamps its remainder with
 * `billableRemainderUnits` so both channels bill against one ceiling.
 */
export function matchPurchaseOrderLine(input: {
  invoiceQuantity: string;
  invoiceUnitPrice: string;
  orderedQuantity: string;
  billedQuantity: string;
  fulfilledQuantity: string;
  poUnitPrice: string;
  itemId: string | null;
  itemKind: string | null;
  documentKind?: CaptureDocumentKind;
}): PurchaseOrderMatchIssue[] {
  const invoiceQuantity = fromUnits(toUnits(input.invoiceQuantity));
  const issues: PurchaseOrderMatchIssue[] = input.documentKind === "vendor_credit"
    ? (() => {
        // A credit releases quantity that a prior bill consumed. It is
        // therefore bounded by the already-billed quantity, not by the
        // remaining ordered/received headroom used by a vendor bill.
        const billed = fromUnits(toUnits(input.billedQuantity));
        return toUnits(invoiceQuantity) <= 0n || cmp(invoiceQuantity, billed) > 0
          ? [{ code: "po_quantity_exceeded" as const, expected: billed, actual: invoiceQuantity }]
          : [];
      })()
    : validatePurchaseOrderQuantities({
        invoiceQuantity,
        orderedQuantity: input.orderedQuantity,
        billedQuantity: input.billedQuantity,
        fulfilledQuantity: input.fulfilledQuantity,
        requiresReceipt: input.itemId !== null && lineRequiresReceipt(input.itemKind),
      });
  if (!priceWithinTolerance(input.poUnitPrice, input.invoiceUnitPrice)) {
    issues.push({
      code: "po_price_variance",
      expected: fromUnits(toUnits(input.poUnitPrice)),
      actual: fromUnits(toUnits(input.invoiceUnitPrice)),
    });
  }
  return issues;
}

/**
 * Exact quantity_billed movement for a PO-backed AP capture. Capture lines
 * retain their positive physical quantity (vendor-credit inventory returns
 * depend on that), while the PO's billed balance moves in the document's
 * commercial direction.
 */
export function purchaseOrderBilledQuantityDelta(
  documentKind: CaptureDocumentKind,
  quantity: string,
): string {
  const units = toUnits(quantity);
  if (units <= 0n) throw new Error("purchase-order capture quantity must be positive");
  return fromUnits(documentKind === "vendor_credit" ? -units : units);
}

/** Received-and-unbilled headroom a purchase-order line can still be billed for. */
export function billableRemainderUnits(input: {
  orderedQuantity: string;
  billedQuantity: string;
  fulfilledQuantity: string;
  itemId: string | null;
  itemKind: string | null;
}): bigint {
  const remaining = toUnits(input.orderedQuantity) - toUnits(input.billedQuantity);
  if (remaining <= 0n) return 0n;
  if (input.itemId === null || !lineRequiresReceipt(input.itemKind)) return remaining;
  const cover = toUnits(input.fulfilledQuantity) - toUnits(input.billedQuantity);
  if (cover <= 0n) return 0n;
  return cover < remaining ? cover : remaining;
}

type PoLine = {
  id: string;
  item_id: string | null;
  account_id: string | null;
  item_code: string | null;
  description: string | null;
  quantity: string;
  quantity_billed: string;
  quantity_fulfilled: string;
  unit_price: string;
  item_kind: string | null;
};

async function mapLines(
  orgId: string,
  capture: NormalizedCapture,
  vendorId: string | null,
  purchaseOrderId: string | null,
  documentKind: CaptureDocumentKind,
): Promise<{ lines: CaptureLine[]; issues: CaptureIssue[] }> {
  const issues: CaptureIssue[] = [];
  if (purchaseOrderId) {
    const source = (await db.execute<PoLine>(sql`
      select dl.id, dl.item_id, coalesce(dl.account_id, i.expense_account_id) as account_id,
             i.code as item_code, dl.description,
             dl.quantity, dl.quantity_billed, dl.quantity_fulfilled, dl.unit_price,
             i.kind as item_kind
        from document_lines dl left join items i on i.id = dl.item_id and i.org_id = dl.org_id
       where dl.org_id = ${orgId} and dl.document_id = ${purchaseOrderId}
       order by dl.line_number
    `));
    const used = new Set<string>();
    const lines = capture.lines.map((line, lineIndex) => {
      const key = line.productCode ? normalizedKey(line.productCode) : "";
      let candidates = key
        ? source.rows.filter((row) => row.item_code && normalizedKey(row.item_code) === key && !used.has(row.id))
        : [];
      if (candidates.length !== 1 && source.rows.length === 1 && capture.lines.length === 1) candidates = source.rows;
      if (candidates.length !== 1) {
        issues.push(issue("po_line_unmatched", "blocking", { lineIndex }));
        return line;
      }
      const po = candidates[0]!;
      used.add(po.id);
      for (const matchIssue of matchPurchaseOrderLine({
        invoiceQuantity: line.quantity,
        invoiceUnitPrice: line.unitPrice,
        orderedQuantity: po.quantity,
        billedQuantity: po.quantity_billed,
        fulfilledQuantity: po.quantity_fulfilled,
        poUnitPrice: String(po.unit_price),
        itemId: po.item_id,
        itemKind: po.item_kind,
        documentKind,
      })) {
        issues.push(issue(matchIssue.code, "blocking", { lineIndex, expected: matchIssue.expected, actual: matchIssue.actual }));
      }
      if (!po.account_id) issues.push(issue("account_unresolved", "blocking", { lineIndex }));
      return {
        ...line,
        itemId: po.item_id,
        accountId: po.account_id,
        purchaseOrderLineId: po.id,
      };
    });
    return { lines, issues };
  }

  const defaultAccount = vendorId
    ? ((await db.execute<{ id: string | null }>(sql`
        select default_expense_account_id as id from vendor_roles
         where org_id = ${orgId} and party_id = ${vendorId} and is_active
      `))).rows[0]?.id ?? null
    : null;
  const requestedItemIds = [...new Set(capture.lines.map((line) => line.itemId).filter((id): id is string => Boolean(id)))];
  const itemResult = requestedItemIds.length
    ? (await db.execute<{ id: string; expense_account_id: string | null }>(sql`
        select id, expense_account_id from items
         where org_id = ${orgId} and is_active
           and id in (${sql.join(requestedItemIds.map((id) => sql`${id}`), sql`, `)})
      `))
    : { rows: [] };
  const itemAccounts = new Map(itemResult.rows.map((row) => [row.id, row.expense_account_id]));
  const learnedResult = vendorId
    ? (await db.execute<{ description: string; account_id: string }>(sql`
        select match->>'description' as description, output->>'accountId' as account_id
          from ap_capture_rules
         where org_id = ${orgId} and rule_kind = 'vendor_account' and is_active
           and match->>'partyId' = ${vendorId}
      `))
    : { rows: [] };
  const learnedAccounts = new Map(learnedResult.rows.map((row) => [row.description, row.account_id]));
  const requestedAccountIds = [...new Set([
    defaultAccount,
    ...capture.lines.map((line) => line.accountId),
    ...itemResult.rows.map((row) => row.expense_account_id),
    ...learnedResult.rows.map((row) => row.account_id),
  ].filter((id): id is string => Boolean(id)))];
  const accountResult = requestedAccountIds.length
    ? (await db.execute<{ id: string }>(sql`
        select id from accounts
         where org_id = ${orgId} and is_active and not is_summary
           and id in (${sql.join(requestedAccountIds.map((id) => sql`${id}`), sql`, `)})
      `))
    : { rows: [] };
  const validAccounts = new Set(accountResult.rows.map((row) => row.id));
  const lines: CaptureLine[] = [];
  for (let lineIndex = 0; lineIndex < capture.lines.length; lineIndex += 1) {
    const line = capture.lines[lineIndex]!;
    const itemId = line.itemId && itemAccounts.has(line.itemId) ? line.itemId : null;
    const candidates = [
      line.accountId,
      itemId ? itemAccounts.get(itemId) : null,
      learnedAccounts.get(normalizedKey(line.description)),
      defaultAccount,
    ];
    const accountId = candidates.find((id): id is string => Boolean(id && validAccounts.has(id))) ?? null;
    if (!accountId) issues.push(issue("account_unresolved", "blocking", { lineIndex }));
    lines.push({ ...line, itemId, accountId, purchaseOrderLineId: null });
  }
  return { lines, issues };
}

export async function resolveAndValidateCapture(input: {
  orgId: string;
  captureItemId: string;
  normalized: NormalizedCapture;
  confidenceThreshold: string;
  vendorId?: string | null;
  purchaseOrderId?: string | null;
  documentKind?: CaptureDocumentKind;
}): Promise<{
  normalized: NormalizedCapture;
  vendorId: string | null;
  purchaseOrderId: string | null;
  issues: CaptureIssue[];
  duplicate: boolean;
}> {
  // Review PATCHes historically omitted the kind from this helper's input.
  // Read the persisted kind in that case so a previously selected vendor
  // credit receives credit matching during re-resolution as well.
  const documentKind = input.documentKind ?? (await db.execute<{ document_kind: CaptureDocumentKind }>(sql`
    select document_kind from ap_capture_items
     where org_id = ${input.orgId} and id = ${input.captureItemId}
  `)).rows[0]?.document_kind ?? "vendor_bill";
  let vendorId = input.vendorId === undefined ? await resolveVendor(input.orgId, input.normalized) : input.vendorId;
  if (vendorId) {
    const valid = (await db.execute(sql`
      select 1 from parties p join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
       where p.org_id = ${input.orgId} and p.id = ${vendorId} and p.is_active and vr.is_active
    `));
    if (!valid.rows[0]) vendorId = null;
  }
  let purchaseOrderId = input.purchaseOrderId === undefined
    ? await resolvePurchaseOrder(input.orgId, input.normalized, vendorId)
    : input.purchaseOrderId;
  if (purchaseOrderId) {
    const valid = (await db.execute<{ party_id: string | null; currency: string }>(sql`
      select party_id, currency from documents where org_id = ${input.orgId} and id = ${purchaseOrderId}
        and kind = 'purchase_order' and status = 'approved'
        and (${vendorId}::uuid is null or party_id = ${vendorId})
        and (${input.normalized.currency}::text is null or currency = ${input.normalized.currency})
    `));
    if (!valid.rows[0]) purchaseOrderId = null;
    else if (!vendorId && valid.rows[0].party_id) vendorId = valid.rows[0].party_id;
  }
  const mapped = await mapLines(input.orgId, input.normalized, vendorId, purchaseOrderId, documentKind);
  const normalized = { ...input.normalized, lines: mapped.lines };
  const issues = [...validateNormalizedCapture(normalized, input.confidenceThreshold), ...mapped.issues];
  if (!vendorId) issues.push(issue("vendor_unresolved", "blocking", { field: "vendorName" }));
  if (input.normalized.purchaseOrderNumber && !purchaseOrderId) {
    issues.push(issue("purchase_order_unresolved", "blocking", { field: "purchaseOrderNumber" }));
  }
  const duplicateResult = (await db.execute<{ "?column?": number }>(sql`
    select 1 from ap_capture_items ci
     where ci.org_id = ${input.orgId} and ci.id <> ${input.captureItemId}
       and ci.status not in ('rejected','failed')
       and (
         ci.content_hash = (select content_hash from ap_capture_items where id = ${input.captureItemId} and org_id = ${input.orgId})
         or (${vendorId}::uuid is not null and ci.vendor_candidate_id = ${vendorId}
             and regexp_replace(lower(nullif(ci.normalized->>'invoiceNumber','')), '[^a-z0-9]', '', 'g')
                 = regexp_replace(lower(${normalized.invoiceNumber}), '[^a-z0-9]', '', 'g'))
       )
    union all
    select 1 from documents d
     where d.org_id = ${input.orgId} and d.kind in ('vendor_bill','vendor_credit') and d.status <> 'voided'
       and ${vendorId}::uuid is not null and d.party_id = ${vendorId}
       and regexp_replace(lower(nullif(d.reference_number,'')), '[^a-z0-9]', '', 'g')
           = regexp_replace(lower(${normalized.invoiceNumber}), '[^a-z0-9]', '', 'g')
    limit 1
  `));
  const duplicate = duplicateResult.rows.length > 0;
  if (duplicate) issues.push(issue("possible_duplicate", "blocking", { field: "invoiceNumber" }));
  return { normalized, vendorId, purchaseOrderId, issues, duplicate };
}

export async function processCaptureItem(input: { orgId: string; captureItemId: string; actorId?: string }): Promise<void> {
  const claimed = (await db.execute<CaptureRow>(sql`
    update ap_capture_items set status = 'extracting', attempts = attempts + 1,
           last_error = null, updated_at = now(), updated_by = ${input.actorId ?? null}
     where org_id = ${input.orgId} and id = ${input.captureItemId} and status in ('queued','failed')
    returning *
  `));
  const item = claimed.rows[0];
  if (!item) return;
  const settings = await getDocumentCaptureRuntimeConfig(input.orgId);
  const attempt = Number((item as unknown as { attempts: number }).attempts);
  const run = (await db.execute<{ id: string }>(sql`
    insert into ap_capture_runs (org_id, capture_item_id, attempt, provider, model, api_version, created_by)
    values (${input.orgId}, ${item.id}, ${attempt}, 'azure_document_intelligence',
            ${settings?.model ?? "prebuilt-invoice"}, '2024-11-30', ${input.actorId ?? item.created_by})
    returning id
  `));
  const runId = run.rows[0]!.id;
  try {
    if (!settings) throw new Error("Document capture is disabled or not configured under Platform → AI");
    const blob = await loadCaptureBlob(input.orgId, item.file_id);
    const extracted = await extractAzureInvoice({
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: settings.model,
      contentType: blob.contentType,
      bytes: blob.bytes,
    });
    const resolved = await resolveAndValidateCapture({
      orgId: input.orgId,
      captureItemId: item.id,
      normalized: extracted.normalized,
      confidenceThreshold: settings.confidenceThreshold,
      documentKind: item.document_kind,
    });
    if (extracted.overallConfidence && cmp(extracted.overallConfidence, settings.confidenceThreshold) < 0) {
      resolved.issues.push(issue("document_low_confidence", "warning", { field: "document" }));
    }
    await db.transaction(async (tx) => {
      for (const field of extracted.evidence) {
        await tx.execute(sql`
          insert into ap_capture_fields (org_id, run_id, field_key, line_index, raw_value,
                                         normalized_value, confidence, page_number, polygon)
          values (${input.orgId}, ${runId}, ${field.fieldKey}, ${field.lineIndex}, ${field.rawValue},
                  ${JSON.stringify(field.normalizedValue)}::jsonb, ${field.confidence},
                  ${field.pageNumber}, ${JSON.stringify(field.polygon)}::jsonb)
        `);
      }
      await tx.execute(sql`
        update ap_capture_runs set status = 'succeeded', raw_provider_payload = ${JSON.stringify(extracted.raw)}::jsonb,
               normalized_snapshot = ${JSON.stringify(resolved.normalized)}::jsonb, finished_at = now()
         where id = ${runId} and org_id = ${input.orgId} and status = 'running'
      `);
      const status = resolved.duplicate ? "duplicate" : resolved.issues.length ? "needs_review" : "ready";
      await tx.execute(sql`
        update ap_capture_items set status = ${status}, normalized = ${JSON.stringify(resolved.normalized)}::jsonb,
               validation_issues = ${JSON.stringify(resolved.issues)}::jsonb,
               overall_confidence = ${extracted.overallConfidence}, vendor_candidate_id = ${resolved.vendorId},
               purchase_order_id = ${resolved.purchaseOrderId}, processed_at = now(), updated_at = now()
         where id = ${item.id} and org_id = ${input.orgId}
      `);
      await tx.execute(sql`
        insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
        values (${input.orgId}, ${item.id}, 'extraction_completed',
                ${JSON.stringify({ status, runId, issueCount: resolved.issues.length })}::jsonb,
                ${input.actorId ?? item.created_by})
      `);
    });
    if (settings.autoCreatePoMatchedDrafts && resolved.purchaseOrderId && !resolved.duplicate
        && resolved.issues.length === 0) {
      await materializeCapture({ orgId: input.orgId, captureItemId: item.id, actorId: input.actorId ?? item.created_by });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Capture failed";
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update ap_capture_runs set status = 'failed', error_message = ${message}, finished_at = now()
         where id = ${runId} and org_id = ${input.orgId} and status = 'running'
      `);
      await tx.execute(sql`
        update ap_capture_items set status = 'failed', last_error = ${message}, updated_at = now()
         where id = ${item.id} and org_id = ${input.orgId}
      `);
      await tx.execute(sql`
        insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
        values (${input.orgId}, ${item.id}, 'extraction_failed', ${JSON.stringify({ message })}::jsonb,
                ${input.actorId ?? item.created_by})
      `);
    });
    throw error;
  }
}

async function nextDocumentNumber(tx: SqlExecutor, orgId: string, kind: string): Promise<string> {
  return allocateDocumentNumber(tx, orgId, kind, kind === "vendor_credit" ? "VCRED-" : "BILL-");
}

export class CaptureMaterializationError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "CaptureMaterializationError";
  }
}

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

/** Effective permission check for engine-side authority gates (role grants + overrides). */

export async function materializeCapture(input: {
  orgId: string;
  captureItemId: string;
  actorId: string | null;
  /** Accept an off-price PO match; requires AP approval and is audited. */
  priceOverride?: boolean;
}): Promise<{ documentId: string; documentNumber: string }> {
  const result = await db.transaction(async (tx) => {
    const loaded = (await tx.execute<CaptureRow>(sql`
      select * from ap_capture_items where org_id = ${input.orgId} and id = ${input.captureItemId} for update
    `));
    const item = loaded.rows[0];
    if (!item) throw new CaptureMaterializationError("Capture item not found");
    if (item.document_id) {
      const existing = (await tx.execute<{ document_number: string }>(sql`select document_number from documents where id = ${item.document_id} and org_id = ${input.orgId}`));
      return { documentId: item.document_id, documentNumber: existing.rows[0]?.document_number ?? "" };
    }
    if (!['ready', 'needs_review'].includes(item.status)) {
      throw new CaptureMaterializationError("Capture item is not ready to create a draft");
    }
    const capture = item.normalized;
    const vendorId = item.vendor_candidate_id;
    if (!vendorId || !capture.invoiceNumber || !capture.invoiceDate || !capture.total || capture.lines.length === 0) {
      throw new CaptureMaterializationError("Vendor, invoice number, date, total and lines are required");
    }
    const unresolved = capture.lines.findIndex((line) => !line.accountId);
    if (unresolved >= 0) throw new CaptureMaterializationError(`Line ${unresolved + 1} needs an account`);
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`ap-capture-materialize:${input.orgId}:${vendorId}:${capture.invoiceNumber}:${item.content_hash}`}, 0))
    `);
    const validVendor = (await tx.execute(sql`
      select 1 from parties p join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
       where p.org_id = ${input.orgId} and p.id = ${vendorId} and p.is_active and vr.is_active
    `));
    if (!validVendor.rows[0]) throw new CaptureMaterializationError("The selected vendor is no longer active");
    const accountIds = [...new Set(capture.lines.map((line) => line.accountId).filter((id): id is string => Boolean(id)))];
    const validAccounts = (await tx.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${input.orgId} and is_active and not is_summary
        and id in (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
    `));
    if (validAccounts.rows.length !== accountIds.length) {
      throw new CaptureMaterializationError("One or more selected accounts are no longer postable");
    }
    const duplicate = (await tx.execute(sql`
      select 1 from ap_capture_items
       where org_id = ${input.orgId} and id <> ${item.id} and content_hash = ${item.content_hash}
         and document_id is not null
      union all
      select 1 from documents
       where org_id = ${input.orgId} and kind in ('vendor_bill','vendor_credit') and status <> 'voided'
         and party_id = ${vendorId}
         and regexp_replace(lower(nullif(reference_number, '')), '[^a-z0-9]', '', 'g')
             = regexp_replace(lower(${capture.invoiceNumber}), '[^a-z0-9]', '', 'g')
      limit 1
    `));
    if (duplicate.rows[0]) throw new CaptureMaterializationError("A draft or posted document already uses this source or vendor invoice number");
    const issues = validateNormalizedCapture(capture);
    if (issues.some((value) => value.severity === "blocking")) {
      throw new CaptureMaterializationError("Resolve the capture math errors before creating a draft");
    }
    // Re-run the shared three-way match against fresh purchase-order rows at
    // the write boundary: a stored review verdict can be stale, and this is
    // the path production actually bills through. Lock the PO parent before
    // its lines, matching convertOrder's lock order so the two channels cannot
    // deadlock while advancing the same order.
    const priceVariances: Array<{ lineIndex: number; expected: string; actual: string }> = [];
    const poLineLocations = new Map<string, string | null>();
    if (item.purchase_order_id) {
      const purchaseOrder = (await tx.execute<{ id: string; kind: string; status: string }>(sql`
        select id, kind, status from documents
         where org_id = ${input.orgId} and id = ${item.purchase_order_id}
         for update
      `)).rows[0];
      if (!purchaseOrder || purchaseOrder.kind !== "purchase_order" || purchaseOrder.status !== "approved") {
        throw new CaptureMaterializationError("The purchase order is no longer approved");
      }
      await tx.execute(sql`
        select id from document_lines
         where org_id = ${input.orgId} and document_id = ${item.purchase_order_id}
         order by line_number
         for update
      `);
      const poLines = new Map(
        (await tx.execute<{
          id: string;
          quantity: string;
          quantity_billed: string;
          quantity_fulfilled: string;
          unit_price: string;
          item_id: string | null;
          item_kind: string | null;
          stock_location_id: string | null;
        }>(sql`
          select dl.id, dl.quantity::text as quantity, dl.quantity_billed::text as quantity_billed,
                 dl.quantity_fulfilled::text as quantity_fulfilled, dl.unit_price::text as unit_price,
                 dl.item_id, i.kind as item_kind, dl.stock_location_id
            from document_lines dl left join items i on i.id = dl.item_id and i.org_id = dl.org_id
           where dl.org_id = ${input.orgId} and dl.document_id = ${item.purchase_order_id}
        `)).rows.map((row) => [row.id, row]),
      );
      for (const poLine of poLines.values()) {
        poLineLocations.set(poLine.id, poLine.stock_location_id);
      }
      capture.lines.forEach((line, lineIndex) => {
        if (!line.purchaseOrderLineId) return;
        const po = poLines.get(line.purchaseOrderLineId);
        if (!po) throw new CaptureMaterializationError(`Purchase order line ${lineIndex + 1} no longer exists`);
        for (const matchIssue of matchPurchaseOrderLine({
          invoiceQuantity: line.quantity,
          invoiceUnitPrice: line.unitPrice,
          orderedQuantity: po.quantity,
          billedQuantity: po.quantity_billed,
          fulfilledQuantity: po.quantity_fulfilled,
          poUnitPrice: po.unit_price,
          itemId: po.item_id,
          itemKind: po.item_kind,
          documentKind: item.document_kind,
        })) {
          if (matchIssue.code === "po_price_variance") {
            priceVariances.push({ lineIndex, expected: matchIssue.expected, actual: matchIssue.actual });
            continue;
          }
          throw new CaptureMaterializationError(
            item.document_kind === "vendor_credit"
              ? `Purchase order line ${lineIndex + 1} has insufficient billed quantity for this credit: ${matchIssue.actual} exceeds ${matchIssue.expected}`
              : `Purchase order line ${lineIndex + 1} cannot bill ${matchIssue.actual}: only ${matchIssue.expected} remains`,
          );
        }
      });
      if (priceVariances.length > 0) {
        const variance = priceVariances[0]!;
        if (!input.priceOverride) {
          throw new CaptureMaterializationError(
            `Line ${variance.lineIndex + 1} price ${variance.actual} differs from the ordered ${variance.expected} by more than the ${PRICE_TOLERANCE_PERCENT}% tolerance`,
          );
        }
        if (!input.actorId || !(await actorHasPermission(tx, input.orgId, input.actorId, "ap.approve"))) {
          throw new CaptureMaterializationError(
            "Overriding the purchase order price match requires AP approval permission",
            403,
          );
        }
        await tx.execute(sql`
          insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
          values (${input.orgId}, ${item.id}, 'price_variance_override',
                  ${JSON.stringify({ tolerancePercent: PRICE_TOLERANCE_PERCENT, variances: priceVariances })}::jsonb,
                  ${input.actorId})
        `);
      }
    }
    const org = (await tx.execute<{ org_currency: string | null; subsidiary_id: string | null; subsidiary_currency: string | null }>(sql`
      select o.base_currency as org_currency, s.id as subsidiary_id,
             s.base_currency as subsidiary_currency
        from orgs o left join lateral (
          select id, base_currency from subsidiaries
           where org_id = o.id and parent_id is null and is_active
           limit 1
        ) s on true where o.id = ${input.orgId}
    `));
    const company = org.rows[0];
    if (!company) throw new CaptureMaterializationError("The company no longer exists");
    const subsidiaryId = company.subsidiary_id;
    if (!subsidiaryId) {
      throw new CaptureMaterializationError("The company has no active root subsidiary");
    }
    const currency = capture.currency ?? company.subsidiary_currency ?? company.org_currency;
    if (!currency) {
      throw new CaptureMaterializationError("The company has no configured base currency");
    }
    // Stored captures and existing bills stay. Turning Inventory off must
    // refuse a materialize that would persist inventory / assembly / kit.
    if (!(await inventoryFeatureEnabled(tx, input.orgId))) {
      const itemIds = [...new Set(
        capture.lines.map((line) => line.itemId).filter((itemId): itemId is string => Boolean(itemId)),
      )];
      for (const itemId of itemIds) {
        const kindRow = (await tx.execute<{ kind: string }>(sql`
          select kind from items where id = ${itemId} and org_id = ${input.orgId}`));
        if (kindRow.rows[0] && INVENTORY_ITEM_KINDS.has(kindRow.rows[0].kind)) {
          throw new CaptureMaterializationError("Inventory is disabled", 404);
        }
      }
    }
    // Stored captures and existing bills stay. Turning Equipment off must
    // refuse a materialize that would persist equipment_charge.
    const equipmentOn = (await tx.execute<{ enabled: boolean }>(sql`
      select coalesce((settings->'features'->>'equipment')::boolean, true) as enabled
        from orgs where id = ${input.orgId}
    `)).rows[0]?.enabled === true;
    if (!equipmentOn) {
      const itemIds = [...new Set(
        capture.lines.map((line) => line.itemId).filter((itemId): itemId is string => Boolean(itemId)),
      )];
      for (const itemId of itemIds) {
        const kindRow = (await tx.execute<{ kind: string }>(sql`
          select kind from items where id = ${itemId} and org_id = ${input.orgId}`));
        if (kindRow.rows[0] && kindRow.rows[0].kind === "equipment_charge") {
          throw new CaptureMaterializationError("Equipment is disabled", 404);
        }
      }
    }
    const documentNumber = await nextDocumentNumber(tx, input.orgId, item.document_kind);
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, party_id, subsidiary_id, document_date,
                             due_date, currency, status, reference_number, memo,
                             subtotal, tax_total, total, created_by, updated_by)
      values (${input.orgId}, ${item.document_kind}, ${documentNumber}, ${vendorId}, ${subsidiaryId},
              ${capture.invoiceDate}, ${capture.dueDate}, ${currency},
              'draft', ${capture.invoiceNumber}, ${capture.memo},
              ${capture.subtotal ?? sum(capture.lines.map((line) => line.amount))},
              ${capture.taxTotal ?? sum(capture.lines.map((line) => line.taxAmount))},
              ${capture.total}, ${input.actorId}, ${input.actorId})
      returning id
    `));
    const documentId = inserted.rows[0]!.id;
    const hasPoLineAdvances = item.purchase_order_id !== null
      && capture.lines.some((line) => line.purchaseOrderLineId !== null && line.purchaseOrderLineId !== undefined);
    if (hasPoLineAdvances) {
      // Migration 0034 protects approved source lines as immutable commercial
      // facts. quantity_billed is operational reconciliation state, so reopen
      // the already-locked PO only for these advances, then restore approved
      // before commit. Any failure rolls the status and the whole materialize
      // back together.
      const reopened = (await tx.execute<{ id: string }>(sql`
        update documents set status = 'draft', updated_at = now(), updated_by = ${input.actorId}
         where id = ${item.purchase_order_id} and org_id = ${input.orgId} and status = 'approved'
         returning id
      `)).rows[0];
      if (!reopened) throw new CaptureMaterializationError("The purchase order changed while it was being materialized", 409);
    }
    for (let index = 0; index < capture.lines.length; index += 1) {
      const line = capture.lines[index]!;
      // A PO-backed bill receives into the warehouse named by the locked PO
      // line. Unlinked capture lines remain explicit-null and posting will
      // require a resolvable warehouse before treating an item as inventory.
      const stockLocationId = line.purchaseOrderLineId
        ? poLineLocations.get(line.purchaseOrderLineId) ?? null
        : null;
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
                                    quantity, unit, unit_price, amount, tax_amount, tax_overridden,
                                    stock_location_id, custom, created_by, updated_by)
        values (${input.orgId}, ${documentId}, ${index + 1}, ${line.itemId ?? null}, ${line.accountId ?? null},
                ${line.description}, ${line.quantity}, ${line.unit}, ${line.unitPrice}, ${line.amount},
                ${line.taxAmount}, ${cmp(line.taxAmount, "0") !== 0},
                ${stockLocationId},
                ${JSON.stringify({ apCaptureEvidence: { captureItemId: item.id, purchaseOrderLineId: line.purchaseOrderLineId ?? null } })}::jsonb,
                ${input.actorId}, ${input.actorId})
      `);
      if (line.purchaseOrderLineId) {
        let billedDelta: string;
        try {
          billedDelta = purchaseOrderBilledQuantityDelta(item.document_kind, line.quantity);
        } catch {
          throw new CaptureMaterializationError(
            `Purchase order line ${index + 1} quantity must be positive`,
          );
        }
        const billedGuard = item.document_kind === "vendor_credit"
          ? sql`and dl.quantity_billed + ${billedDelta} >= 0`
          : sql`and dl.quantity_billed + ${billedDelta} <= dl.quantity
             and (dl.item_id is null or exists (
               select 1 from items i
                where i.id = dl.item_id and i.org_id = ${input.orgId}
                  and (i.kind in (${receiptExemptItemKindsSql})
                       or dl.quantity_fulfilled - dl.quantity_billed >= ${billedDelta})
             ))`;
        const advanced = (await tx.execute<{ id: string }>(sql`
          update document_lines dl set quantity_billed = dl.quantity_billed + ${billedDelta},
                 updated_at = now(), updated_by = ${input.actorId}
           where dl.id = ${line.purchaseOrderLineId} and dl.org_id = ${input.orgId}
             ${billedGuard}
          returning id
        `));
        if (!advanced.rows[0]) {
          throw new CaptureMaterializationError(
            item.document_kind === "vendor_credit"
              ? `Purchase order line ${index + 1} has insufficient billed quantity for this credit`
              : `Purchase order line ${index + 1} is no longer billable`,
          );
        }
      }
    }
    if (hasPoLineAdvances) {
      const restored = (await tx.execute<{ id: string }>(sql`
        update documents set status = 'approved', updated_at = now(), updated_by = ${input.actorId}
         where id = ${item.purchase_order_id} and org_id = ${input.orgId} and status = 'draft'
         returning id
      `)).rows[0];
      if (!restored) throw new CaptureMaterializationError("The purchase order changed while it was being materialized", 409);
    }
    if (item.purchase_order_id) {
      await tx.execute(sql`
        insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
        values (${input.orgId}, ${item.purchase_order_id}, ${documentId}, 'bills', ${input.actorId}, ${input.actorId})
      `);
    }
    await tx.execute(sql`
      insert into file_attachments (org_id, file_id, target_table, target_id, created_by)
      values (${input.orgId}, ${item.file_id}, 'documents', ${documentId}, ${input.actorId})
      on conflict (org_id, file_id, target_table, target_id) do nothing
    `);
    await tx.execute(sql`
      update ap_capture_items set status = 'materialized', document_id = ${documentId},
             materialized_at = now(), validation_issues = '[]'::jsonb,
             updated_at = now(), updated_by = ${input.actorId}
       where id = ${item.id} and org_id = ${input.orgId} and status <> 'materialized'
    `);
    await tx.execute(sql`
      insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
      values (${input.orgId}, ${item.id}, 'draft_created',
              ${JSON.stringify({ documentId, documentNumber })}::jsonb, ${input.actorId})
    `);
    if (capture.vendorName) {
      const alias = normalizedKey(capture.vendorName);
      const existing = (await tx.execute<{ id: string }>(sql`
        select id from ap_capture_rules where org_id = ${input.orgId} and rule_kind = 'vendor_alias'
          and match->>'alias' = ${alias} and output->>'partyId' = ${vendorId} for update
      `));
      if (existing.rows[0]) {
        await tx.execute(sql`
          update ap_capture_rules set confirmation_count = confirmation_count + 1,
                 is_active = confirmation_count + 1 >= 3, updated_at = now(), updated_by = ${input.actorId}
           where id = ${existing.rows[0].id} and org_id = ${input.orgId}
        `);
      } else {
        await tx.execute(sql`
          insert into ap_capture_rules (org_id, rule_kind, match, output, created_by, updated_by)
          values (${input.orgId}, 'vendor_alias', ${JSON.stringify({ alias })}::jsonb,
                  ${JSON.stringify({ partyId: vendorId })}::jsonb, ${input.actorId}, ${input.actorId})
          on conflict do nothing
        `);
      }
    }
    if (!item.purchase_order_id) {
      for (const line of capture.lines) {
        if (!line.accountId || !line.description) continue;
        const description = normalizedKey(line.description);
        const existing = (await tx.execute<{ id: string }>(sql`
          select id from ap_capture_rules where org_id = ${input.orgId} and rule_kind = 'vendor_account'
            and match->>'partyId' = ${vendorId} and match->>'description' = ${description}
            and output->>'accountId' = ${line.accountId} for update
        `));
        if (existing.rows[0]) {
          await tx.execute(sql`
            update ap_capture_rules set confirmation_count = confirmation_count + 1,
                   is_active = confirmation_count + 1 >= 3, updated_at = now(), updated_by = ${input.actorId}
             where id = ${existing.rows[0].id} and org_id = ${input.orgId}
          `);
        } else {
          await tx.execute(sql`
            insert into ap_capture_rules (org_id, rule_kind, match, output, created_by, updated_by)
            values (${input.orgId}, 'vendor_account',
                    ${JSON.stringify({ partyId: vendorId, description })}::jsonb,
                    ${JSON.stringify({ accountId: line.accountId })}::jsonb,
                    ${input.actorId}, ${input.actorId})
            on conflict do nothing
          `);
        }
      }
    }
    return { documentId, documentNumber };
  });
  const kind = (await db.execute<{ kind: string }>(sql`select kind from documents where id = ${result.documentId} and org_id = ${input.orgId}`));
  await runRecordFlows(
    { kind: "on_create", source: "api" },
    kind.rows[0]?.kind ?? "vendor_bill",
    result.documentId,
    { orgId: input.orgId, userId: input.actorId ?? undefined },
  );
  return result;
}

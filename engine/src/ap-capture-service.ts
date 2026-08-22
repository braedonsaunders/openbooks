import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "./db.ts";
import { inventoryFeatureEnabled } from "./inventory.ts";
import { cmp, sum } from "./money.ts";
import {
  extractAzureInvoice,
  validatePurchaseOrderQuantities,
  validateNormalizedCapture,
  type CaptureIssue,
  type CaptureLine,
  type NormalizedCapture,
} from "./ap-capture.ts";
import { getDocumentCaptureRuntimeConfig } from "./ap-capture-config.ts";
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
    if (tax.rows.length === 1) return tax.rows[0].id;
  }
  if (!capture.vendorName) return null;
  const alias = normalizedKey(capture.vendorName);
  const learned = (await db.execute<{ id: string | null }>(sql`
    select output->>'partyId' as id from ap_capture_rules
     where org_id = ${orgId} and rule_kind = 'vendor_alias' and is_active
       and match->>'alias' = ${alias}
     order by confirmation_count desc limit 2
  `));
  if (learned.rows.length === 1 && learned.rows[0].id) return learned.rows[0].id;
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
  return exact.rows.length === 1 ? exact.rows[0].id : null;
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
  return result.rows.length === 1 ? result.rows[0].id : null;
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
  item_kind: string | null;
};

async function mapLines(
  orgId: string,
  capture: NormalizedCapture,
  vendorId: string | null,
  purchaseOrderId: string | null,
): Promise<{ lines: CaptureLine[]; issues: CaptureIssue[] }> {
  const issues: CaptureIssue[] = [];
  if (purchaseOrderId) {
    const source = (await db.execute<PoLine>(sql`
      select dl.id, dl.item_id, coalesce(dl.account_id, i.expense_account_id) as account_id,
             i.code as item_code, dl.description,
             dl.quantity, dl.quantity_billed, dl.quantity_fulfilled, i.kind as item_kind
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
      const po = candidates[0];
      used.add(po.id);
      for (const quantityIssue of validatePurchaseOrderQuantities({
        invoiceQuantity: line.quantity,
        orderedQuantity: po.quantity,
        billedQuantity: po.quantity_billed,
        fulfilledQuantity: po.quantity_fulfilled,
        requiresReceipt: Boolean(po.item_kind && po.item_kind !== "service"),
      })) issues.push(issue(quantityIssue.code, "blocking", { lineIndex, expected: quantityIssue.expected, actual: quantityIssue.actual }));
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
    const line = capture.lines[lineIndex];
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
}): Promise<{
  normalized: NormalizedCapture;
  vendorId: string | null;
  purchaseOrderId: string | null;
  issues: CaptureIssue[];
  duplicate: boolean;
}> {
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
  const mapped = await mapLines(input.orgId, input.normalized, vendorId, purchaseOrderId);
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
  const runId = run.rows[0].id;
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

async function nextDocumentNumber(tx: SqlExecutor, orgId: string, kind: string, subsidiaryId: string | null): Promise<string> {
  const prefix = kind === "vendor_credit" ? "VCRED-" : "BILL-";
  const configured = subsidiaryId
    ? ((await tx.execute(sql`
        select 1 from number_sequences where org_id = ${orgId} and document_kind = ${kind}
          and subsidiary_id = ${subsidiaryId} limit 1
      `))).rows.length > 0
    : false;
  const sequenceSubsidiaryId = configured ? subsidiaryId : null;
  const result = (await tx.execute<{ prefix: string; next_number: number; padding: number }>(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${sequenceSubsidiaryId}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding
  `));
  const row = result.rows[0];
  return `${row.prefix}${String(row.next_number).padStart(row.padding, "0")}`;
}

export class CaptureMaterializationError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "CaptureMaterializationError";
  }
}

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

export async function materializeCapture(input: {
  orgId: string;
  captureItemId: string;
  actorId: string | null;
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
    const documentNumber = await nextDocumentNumber(tx, input.orgId, item.document_kind, subsidiaryId);
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
    const documentId = inserted.rows[0].id;
    for (let index = 0; index < capture.lines.length; index += 1) {
      const line = capture.lines[index];
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
                                    quantity, unit, unit_price, amount, tax_amount, tax_overridden,
                                    custom, created_by, updated_by)
        values (${input.orgId}, ${documentId}, ${index + 1}, ${line.itemId ?? null}, ${line.accountId ?? null},
                ${line.description}, ${line.quantity}, ${line.unit}, ${line.unitPrice}, ${line.amount},
                ${line.taxAmount}, ${cmp(line.taxAmount, "0") !== 0},
                ${JSON.stringify({ apCaptureEvidence: { captureItemId: item.id, purchaseOrderLineId: line.purchaseOrderLineId ?? null } })}::jsonb,
                ${input.actorId}, ${input.actorId})
      `);
      if (line.purchaseOrderLineId) {
        const advanced = (await tx.execute<{ id: string }>(sql`
          update document_lines dl set quantity_billed = dl.quantity_billed + ${line.quantity},
                 updated_at = now(), updated_by = ${input.actorId}
           where dl.id = ${line.purchaseOrderLineId} and dl.org_id = ${input.orgId}
             and dl.quantity_billed + ${line.quantity} <= dl.quantity
             and (dl.item_id is null or exists (
               select 1 from items i
                where i.id = dl.item_id and i.org_id = ${input.orgId}
                  and (i.kind = 'service' or dl.quantity_fulfilled - dl.quantity_billed >= ${line.quantity})
             ))
          returning id
        `));
        if (!advanced.rows[0]) throw new CaptureMaterializationError(`Purchase order line ${index + 1} is no longer billable`);
      }
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

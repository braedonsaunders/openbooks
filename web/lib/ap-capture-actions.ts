import "server-only";
import { sql } from "drizzle-orm";
import { apCaptureReprocessJobId, enqueueApCapture } from "@openbooks/jobs";
import { db, withOrgTransaction, type SqlExecutor } from "@openbooks/engine/platform/db";
import { lockScopeRows, ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { apCaptureSubsidiaryScope } from "@openbooks/engine/records/file-cabinet-access";
import { NextResponse } from "next/server";
import {
  isDocumentRevisionToken,
  documentRevisionCounterSql,
} from "@openbooks/engine/records/revision";
import { canonicalDecimal, normalizeMoney } from "@openbooks/engine/money";
import type { NormalizedCapture } from "@openbooks/engine/payables/ap-capture";
import { getDocumentCaptureSettings } from "@openbooks/engine/payables/ap-capture-config";
import { resolveAndValidateCapture } from "@openbooks/engine/payables/ap-capture-service";
import { isDocKindEnabled } from "./documents";
import { isFeatureEnabled } from "./features";
import { guardSubsidiaryScope, type Authz } from "./authz";
import { subsidiaryVisibleFilter } from "./subsidiaries";

export class ApCaptureActionRefusal extends Error {
  readonly name = "ApCaptureActionRefusal";
  constructor(
    message: string,
    readonly code: string,
    readonly corrections?: number,
  ) {
    super(message);
  }
}

/** Resolve a capture through the same vendor/order visibility boundary used by capture actions. */
export async function findVisibleApCapture(input: {
  orgId: string;
  captureItemId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(
    sql`
      select ci.id
        from ap_capture_items ci
        left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
        left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ci.org_id = ${input.orgId} and ci.id = ${input.captureItemId}
       ${apCaptureSubsidiaryScope(input.allowedSubsidiaryIds)}
    `,
    "objects",
  );
  return Boolean(rows[0]);
}

function apCaptureVisibleExists(orgId: string, id: string, allowed: ReadonlySet<string> | null) {
  return sql`exists (
    select 1 from ap_capture_items ci
    left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
    left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
    where ci.org_id = ${orgId} and ci.id = ${id}
    ${apCaptureSubsidiaryScope(allowed)}
  )`;
}

async function lockApCaptureScope(
  tx: SqlExecutor,
  orgId: string,
  id: string,
  allowed: ReadonlySet<string> | null,
): Promise<boolean> {
  const capture = (
    await tx.execute<{ vendorId: string | null; purchaseOrderId: string | null }>(
      sql`
    select vendor_candidate_id as "vendorId", purchase_order_id as "purchaseOrderId"
      from ap_capture_items where org_id = ${orgId} and id = ${id} for update
  `,
      "objects",
    )
  )[0];
  if (!capture) return false;
  try {
    await lockScopeRows(
      tx,
      orgId,
      [
        ...(capture.vendorId ? [{ kind: "party" as const, id: capture.vendorId }] : []),
        ...(capture.purchaseOrderId
          ? [{ kind: "document" as const, id: capture.purchaseOrderId }]
          : []),
      ],
      allowed,
      "share",
      { orgWideNull: true },
    );
    return true;
  } catch (error) {
    if (error instanceof ScopeNotFoundError) return false;
    throw error;
  }
}

/** Reject a visible capture and append its event under the row and subject locks. */
export async function rejectApCapture(input: {
  orgId: string;
  actorId: string;
  captureItemId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    if (
      !(await lockApCaptureScope(tx, input.orgId, input.captureItemId, input.allowedSubsidiaryIds))
    ) {
      throw new ApCaptureActionRefusal("not_rejectable", "not_rejectable");
    }
    const changed = await tx.execute<{ id: string }>(
      sql`
      update ap_capture_items set status = 'rejected', updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${input.captureItemId} and status <> 'materialized'
         and ${apCaptureVisibleExists(input.orgId, input.captureItemId, input.allowedSubsidiaryIds)}
       returning id
    `,
      "objects",
    );
    if (!changed[0]) throw new ApCaptureActionRefusal("not_rejectable", "not_rejectable");
    await tx.execute(sql`
      insert into ap_capture_events (org_id, capture_item_id, event_kind, actor_id)
      values (${input.orgId}, ${input.captureItemId}, 'rejected', ${input.actorId})
    `);
  });
}

/** Queue provider extraction after recording the explicit correction-discard decision. */
export async function reprocessApCapture(input: {
  orgId: string;
  actorId: string;
  captureItemId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  confirmDiscardCorrections: boolean;
}): Promise<{ discardedCorrections: number }> {
  const queued = await db.transaction(async (tx) => {
    if (
      !(await lockApCaptureScope(tx, input.orgId, input.captureItemId, input.allowedSubsidiaryIds))
    ) {
      throw new ApCaptureActionRefusal("not_reprocessable", "not_reprocessable");
    }
    const corrected = (
      await tx.execute<{ n: number }>(
        sql`
        select count(*)::int as n from ap_capture_corrections
         where org_id = ${input.orgId} and capture_item_id = ${input.captureItemId}
      `,
        "objects",
      )
    )[0]!.n;
    if (corrected > 0 && !input.confirmDiscardCorrections) {
      throw new ApCaptureActionRefusal(
        `reprocessing discards ${corrected} operator correction${corrected === 1 ? "" : "s"} — resubmit with confirmDiscardCorrections to discard them and reprocess`,
        "confirm_required",
        corrected,
      );
    }
    const changed = await tx.execute<{ id: string; attempts: number }>(
      sql`
      update ap_capture_items set status = 'queued', last_error = null, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${input.captureItemId}
         and status in ('failed','needs_review','ready','duplicate')
         and ${apCaptureVisibleExists(input.orgId, input.captureItemId, input.allowedSubsidiaryIds)}
       returning id, attempts
    `,
      "objects",
    );
    if (!changed[0]) throw new ApCaptureActionRefusal("not_reprocessable", "not_reprocessable");
    const generation = changed[0].attempts;
    await tx.execute(sql`
      insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
      values (${input.orgId}, ${input.captureItemId}, 'reprocess_queued',
              ${corrected > 0 ? JSON.stringify({ discardedCorrections: corrected }) : "{}"}::jsonb,
              ${input.actorId})
    `);
    return { corrected, generation };
  });

  try {
    await enqueueApCapture(
      {
        orgId: input.orgId,
        captureItemId: input.captureItemId,
        actorId: input.actorId,
        allowedSubsidiaryIds:
          input.allowedSubsidiaryIds === null ? null : [...input.allowedSubsidiaryIds],
      },
      { jobId: apCaptureReprocessJobId(input.captureItemId, queued.generation) },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "queue_unavailable";
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update ap_capture_items set status = 'failed', last_error = ${message}, updated_at = now()
         where org_id = ${input.orgId} and id = ${input.captureItemId} and status = 'queued'
           and ${apCaptureVisibleExists(input.orgId, input.captureItemId, input.allowedSubsidiaryIds)}
      `);
      await tx.execute(sql`
        insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
        values (${input.orgId}, ${input.captureItemId}, 'queue_failed', ${JSON.stringify({ message })}::jsonb, ${input.actorId})
      `);
    });
    throw error;
  }
  return { discardedCorrections: queued.corrected };
}

type ReviewCaptureBody = {
  documentKind?: "vendor_bill" | "vendor_credit";
  expectedUpdatedAt?: string;
  normalized: NormalizedCapture;
  purchaseOrderId?: string | null;
  vendorId?: string | null;
};

function resolvedAssociationsInScope(
  orgId: string,
  allowed: ReadonlySet<string> | null,
  vendorId: string | null,
  purchaseOrderId: string | null,
) {
  if (allowed === null) return sql`true`;
  if (allowed.size === 0) return sql`false`;
  const vendorOk = !vendorId
    ? sql`true`
    : sql`exists (
        select 1 from parties vendor
         where vendor.org_id = ${orgId} and vendor.id = ${vendorId}
         ${subsidiaryVisibleFilter(sql`vendor.subsidiary_id`, allowed, { orgWideNull: true })}
      )`;
  const purchaseOrderOk = !purchaseOrderId
    ? sql`true`
    : sql`exists (
        select 1 from documents po
         where po.org_id = ${orgId} and po.id = ${purchaseOrderId}
         ${subsidiaryVisibleFilter(sql`po.subsidiary_id`, allowed, { orgWideNull: true })}
      )`;
  return sql`${vendorOk} and ${purchaseOrderOk}`;
}

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

function normalizeReviewText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function normalizeReviewMoney(value: string | null): string | null {
  if (value === null) return null;
  const exact = canonicalDecimal(value, 4);
  if (exact === null) return value;
  try {
    return normalizeMoney(exact);
  } catch {
    return value;
  }
}

function normalizeReviewCapture(input: NormalizedCapture): NormalizedCapture {
  return {
    ...input,
    vendorName: normalizeReviewText(input.vendorName),
    vendorTaxId: normalizeReviewText(input.vendorTaxId),
    invoiceNumber: normalizeReviewText(input.invoiceNumber),
    invoiceDate: input.invoiceDate === "" ? null : input.invoiceDate,
    dueDate: input.dueDate === "" ? null : input.dueDate,
    purchaseOrderNumber: normalizeReviewText(input.purchaseOrderNumber),
    currency: normalizeReviewText(input.currency)?.toUpperCase() ?? null,
    subtotal: normalizeReviewMoney(input.subtotal),
    taxTotal: normalizeReviewMoney(input.taxTotal),
    total: normalizeReviewMoney(input.total),
    memo: normalizeReviewText(input.memo),
    lines: input.lines.map((line) => ({
      ...line,
      description: line.description.trim(),
      productCode: normalizeReviewText(line.productCode),
      unit: normalizeReviewText(line.unit),
      quantity: normalizeReviewMoney(line.quantity) ?? line.quantity,
      unitPrice: normalizeReviewMoney(line.unitPrice) ?? line.unitPrice,
      amount: normalizeReviewMoney(line.amount) ?? line.amount,
      taxAmount: normalizeReviewMoney(line.taxAmount) ?? line.taxAmount,
      confidence: normalizeReviewMoney(line.confidence),
    })),
  };
}

/** Save AP capture corrections through the page's locked, audited review path. */
export async function reviewApCapture(
  gate: Authz,
  id: string,
  body: ReviewCaptureBody,
): Promise<NextResponse> {
  if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
    return NextResponse.json(
      { error: "A current capture revision is required; reload the capture and try again" },
      { status: 409 },
    );
  }
  const expectedRevision = body.expectedUpdatedAt;
  const normalized = normalizeReviewCapture(body.normalized);
  const nextVendorId = body.vendorId;
  const nextPurchaseOrderId = body.purchaseOrderId;
  const current = await db.execute<{
    normalized: NormalizedCapture;
    status: string;
    document_kind: string;
    vendor_candidate_id: string | null;
    purchase_order_id: string | null;
  }>(
    sql`
      select ci.normalized, ci.status, ci.document_kind, ci.vendor_candidate_id, ci.purchase_order_id
        from ap_capture_items ci
        left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
        left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ci.org_id = ${gate.user.orgId} and ci.id = ${id}
       ${apCaptureSubsidiaryScope(gate.allowedSubsidiaryIds)}
    `,
    "objects",
  );
  if (!current[0]) return NextResponse.json({ error: "record not found" }, { status: 404 });
  if (["materialized", "rejected", "extracting", "queued"].includes(current[0].status)) {
    return NextResponse.json({ error: "not_editable" }, { status: 409 });
  }
  if (!(await isFeatureEnabled(gate.user.orgId, "inventory"))) {
    const storedIds = new Set(
      (current[0].normalized.lines ?? [])
        .map((line) => line.itemId)
        .filter((itemId): itemId is string => Boolean(itemId)),
    );
    for (const line of normalized.lines) {
      if (!line.itemId || storedIds.has(line.itemId)) continue;
      const item = await db.execute<{ kind: string }>(
        sql`select kind from items where id = ${line.itemId} and org_id = ${gate.user.orgId}`,
        "objects",
      );
      if (item[0] && INVENTORY_ITEM_KINDS.has(item[0].kind))
        return NextResponse.json({ error: "record not found" }, { status: 404 });
    }
  }
  if (!(await isFeatureEnabled(gate.user.orgId, "equipment"))) {
    const storedIds = new Set(
      (current[0].normalized.lines ?? [])
        .map((line) => line.itemId)
        .filter((itemId): itemId is string => Boolean(itemId)),
    );
    for (const line of normalized.lines) {
      if (!line.itemId || storedIds.has(line.itemId)) continue;
      const item = await db.execute<{ kind: string }>(
        sql`select kind from items where id = ${line.itemId} and org_id = ${gate.user.orgId}`,
        "objects",
      );
      if (item[0]?.kind === "equipment_charge")
        return NextResponse.json({ error: "record not found" }, { status: 404 });
    }
  }
  if (
    nextPurchaseOrderId &&
    nextPurchaseOrderId !== current[0].purchase_order_id &&
    !(await isDocKindEnabled(gate.user.orgId, "purchase_order"))
  ) {
    return NextResponse.json({ error: "record not found" }, { status: 404 });
  }
  const settings = await getDocumentCaptureSettings(gate.user.orgId);
  let saved: {
    resolved: Awaited<ReturnType<typeof resolveAndValidateCapture>>;
    kind: "vendor_bill" | "vendor_credit";
  };
  try {
    saved = await withOrgTransaction(gate.user.orgId, async () => {
      const locked = await db.execute<{
        normalized: NormalizedCapture;
        status: string;
        document_kind: string;
        vendor_candidate_id: string | null;
        purchase_order_id: string | null;
        revision: string;
      }>(
        sql`
          select ci.normalized, ci.status, ci.document_kind, ci.vendor_candidate_id, ci.purchase_order_id,
                 ${documentRevisionCounterSql(sql`ci.revision_seq`)} as revision
            from ap_capture_items ci
            left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
            left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
           where ci.org_id = ${gate.user.orgId} and ci.id = ${id}
           ${apCaptureSubsidiaryScope(gate.allowedSubsidiaryIds)}
           for update of ci
        `,
        "objects",
      );
      const live = locked[0];
      if (!live) throw new Error("capture_not_found");
      if (["materialized", "rejected", "extracting", "queued"].includes(live.status))
        throw new Error("capture_not_editable");
      if (live.revision !== expectedRevision) throw new Error("capture_revision_conflict");
      const kind = body.documentKind ?? live.document_kind;
      if (kind !== "vendor_bill" && kind !== "vendor_credit")
        throw new Error("invalid_document_kind");
      const resolved = await resolveAndValidateCapture({
        orgId: gate.user.orgId,
        captureItemId: id,
        normalized,
        confidenceThreshold: settings.confidenceThreshold,
        vendorId: nextVendorId,
        purchaseOrderId: nextPurchaseOrderId,
        documentKind: kind,
      });
      if (resolved.vendorId) {
        const vendor = (
          await db.execute<{ subsidiaryId: string | null }>(
            sql`select subsidiary_id as "subsidiaryId" from parties where org_id = ${gate.user.orgId} and id = ${resolved.vendorId} for update`,
            "objects",
          )
        )[0];
        if (!vendor || guardSubsidiaryScope(gate, vendor.subsidiaryId, { orgWideNull: true }))
          throw new Error("capture_not_found");
      }
      if (resolved.purchaseOrderId) {
        const purchaseOrder = (
          await db.execute<{ subsidiaryId: string | null }>(
            sql`select subsidiary_id as "subsidiaryId" from documents where org_id = ${gate.user.orgId} and id = ${resolved.purchaseOrderId} for update`,
            "objects",
          )
        )[0];
        if (
          !purchaseOrder ||
          guardSubsidiaryScope(gate, purchaseOrder.subsidiaryId, { orgWideNull: true })
        )
          throw new Error("capture_not_found");
      }
      const before = live.normalized;
      const headerKeys = [
        "vendorName",
        "vendorTaxId",
        "invoiceNumber",
        "invoiceDate",
        "dueDate",
        "purchaseOrderNumber",
        "currency",
        "subtotal",
        "taxTotal",
        "total",
        "memo",
      ] as const;
      for (const key of headerKeys) {
        if (JSON.stringify(before[key]) !== JSON.stringify(resolved.normalized[key])) {
          await db.execute(
            sql`insert into ap_capture_corrections (org_id, capture_item_id, field_key, before_value, after_value, corrected_by) values (${gate.user.orgId}, ${id}, ${key}, ${JSON.stringify(before[key])}::jsonb, ${JSON.stringify(resolved.normalized[key])}::jsonb, ${gate.user.id})`,
          );
        }
      }
      const maxLines = Math.max(before.lines.length, resolved.normalized.lines.length);
      for (let lineIndex = 0; lineIndex < maxLines; lineIndex += 1) {
        if (
          JSON.stringify(before.lines[lineIndex] ?? null) !==
          JSON.stringify(resolved.normalized.lines[lineIndex] ?? null)
        ) {
          await db.execute(
            sql`insert into ap_capture_corrections (org_id, capture_item_id, field_key, line_index, before_value, after_value, corrected_by) values (${gate.user.orgId}, ${id}, 'line', ${lineIndex}, ${JSON.stringify(before.lines[lineIndex] ?? null)}::jsonb, ${JSON.stringify(resolved.normalized.lines[lineIndex] ?? null)}::jsonb, ${gate.user.id})`,
          );
        }
      }
      const selections: Array<[string, unknown, unknown]> = [
        ["documentKind", live.document_kind, kind],
        ["vendorCandidateId", live.vendor_candidate_id, resolved.vendorId],
        ["purchaseOrderId", live.purchase_order_id, resolved.purchaseOrderId],
      ];
      for (const [fieldKey, beforeValue, afterValue] of selections) {
        if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;
        await db.execute(
          sql`insert into ap_capture_corrections (org_id, capture_item_id, field_key, before_value, after_value, corrected_by) values (${gate.user.orgId}, ${id}, ${fieldKey}, ${JSON.stringify(beforeValue)}::jsonb, ${JSON.stringify(afterValue)}::jsonb, ${gate.user.id})`,
        );
      }
      const status = resolved.duplicate
        ? "duplicate"
        : resolved.issues.length
          ? "needs_review"
          : "ready";
      const savedRow = await db.execute<{ id: string }>(
        sql`
          update ap_capture_items set normalized = ${JSON.stringify(resolved.normalized)}::jsonb,
                 validation_issues = ${JSON.stringify(resolved.issues)}::jsonb, status = ${status},
                 document_kind = ${kind}, vendor_candidate_id = ${resolved.vendorId},
                 purchase_order_id = ${resolved.purchaseOrderId}, assigned_to = ${gate.user.id},
                 updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
                 updated_by = ${gate.user.id}
           where org_id = ${gate.user.orgId} and id = ${id}
             and exists (select 1 from ap_capture_items ci
               left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
               left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
               where ci.org_id = ${gate.user.orgId} and ci.id = ${id}
               ${apCaptureSubsidiaryScope(gate.allowedSubsidiaryIds)})
             and ${resolvedAssociationsInScope(gate.user.orgId, gate.allowedSubsidiaryIds, resolved.vendorId, resolved.purchaseOrderId)}
           returning id
        `,
        "objects",
      );
      if (!savedRow[0]) throw new Error("capture_not_found");
      await db.execute(
        sql`insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id) values (${gate.user.orgId}, ${id}, 'review_saved', ${JSON.stringify({ status, issueCount: resolved.issues.length })}::jsonb, ${gate.user.id})`,
      );
      return { resolved, kind };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_document_kind")
      return NextResponse.json({ error: error.message }, { status: 422 });
    if (error instanceof Error && error.message === "capture_not_found")
      return NextResponse.json({ error: "record not found" }, { status: 404 });
    if (error instanceof Error && error.message === "capture_not_editable")
      return NextResponse.json({ error: "not_editable" }, { status: 409 });
    if (error instanceof Error && error.message === "capture_revision_conflict")
      return NextResponse.json(
        { error: "This capture changed after you opened it; reload and reapply your corrections" },
        { status: 409 },
      );
    throw error;
  }
  const { resolved, kind } = saved;
  const fresh =
    (
      await db.execute<{ updatedAt: string }>(
        sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as "updatedAt" from ap_capture_items where org_id = ${gate.user.orgId} and id = ${id}`,
        "objects",
      )
    )[0]?.updatedAt ?? expectedRevision;
  return NextResponse.json({
    normalized: resolved.normalized,
    validationIssues: resolved.issues,
    vendorId: resolved.vendorId,
    purchaseOrderId: resolved.purchaseOrderId,
    status: resolved.duplicate ? "duplicate" : resolved.issues.length ? "needs_review" : "ready",
    documentKind: kind,
    updatedAt: fresh,
  });
}

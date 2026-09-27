import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalDecimal, compareDecimal, isPositiveDecimal } from "../money/exact-decimal.ts";
import { decimalNullRefusal } from "../money/decimal-refusal.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { assertReturnSourceSelectable } from "../inventory/returnable-sources.ts";
import { postedReturnEvidenceScope } from "../inventory/return-quantities.ts";
import { InventoryError } from "../inventory/contracts.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";

export type ReturnStage = "requested" | "receiving" | "inspected" | "done" | "rejected";
export type ReturnDisposition = "restock" | "scrap" | "vendor-return";
export type ReturnRefusalCode =
  | "feature_disabled" | "not_found" | "invalid_input" | "invalid_quantity"
  | "source_unavailable" | "source_fully_returned" | "exceeds_returnable_quantity"
  | "mixed_source_documents" | "approval_pending" | "approval_routing_failed"
  | "wrong_stage" | "changed_concurrently";

/** A return lifecycle refusal with the stable detail returned by API routes. */
export class ReturnRefusal extends Error {
  readonly name = "ReturnRefusal";

  constructor(
    message: string,
    readonly code: ReturnRefusalCode,
    readonly status: 404 | 409 | 422,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

const FEATURE = "returnAuthorizations";
const FEATURE_REMEDY = "Turn on Return Authorizations on Company Settings → Features";
const RMA_REMEDY = "Reload the return authorization and try again";

type RmaHeader = Record<string, unknown> & {
  id: string;
  kind: string;
  status: string;
  document_number: string;
  party_id: string | null;
  subsidiary_id: string | null;
  document_date: string;
  currency: string;
  source_document_id: string | null;
  stage: ReturnStage | null;
  customer_credit_id: string | null;
};

type RmaLine = Record<string, unknown> & {
  line_id: string;
  line_number: number;
  item_id: string | null;
  lot_id: string | null;
  serial_id: string | null;
  stock_location_id: string | null;
  quantity: string;
  custom: Record<string, unknown> | null;
  authorized: string | null;
  received: string | null;
  accepted: string | null;
  disposition: ReturnDisposition | null;
  disposition_location_id: string | null;
  vendor_credit_id: string | null;
  source_issue_movement_id: string | null;
  scrap_movement_id: string | null;
};

export type ReturnAuthorization = {
  id: string;
  documentNumber: string;
  customerId: string | null;
  subsidiaryId: string | null;
  sourceDocumentId: string | null;
  status: string;
  stage: ReturnStage | null;
  customerCreditId: string | null;
  lines: Array<{
    lineId: string;
    lineNumber: number;
    itemId: string | null;
    lotId: string | null;
    serialId: string | null;
    sourceIssueMovementId: string | null;
    authorized: string;
    received: string;
    accepted: string;
    disposition: ReturnDisposition | null;
    dispositionLocationId: string | null;
    vendorCreditId: string | null;
    scrapMovementId: string | null;
  }>;
};

function refusal(message: string, code: ReturnRefusalCode, status: 404 | 409 | 422, remedy?: string): ReturnRefusal {
  return new ReturnRefusal(message, code, status, remedy);
}

export async function assertReturnAuthorizationsFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, FEATURE, runner))) {
    throw refusal(`Return Authorizations is turned off for this organization`, "feature_disabled", 409, FEATURE_REMEDY);
  }
}

function parseQuantity(value: unknown, label: string, allowZero = false): string {
  const quantity = canonicalDecimal(value, 8);
  if (quantity === null) {
    throw refusal(decimalNullRefusal(label, "a quantity", value, 8), "invalid_quantity", 422, "Enter an exact quantity with up to eight decimal places");
  }
  if (allowZero ? compareDecimal(quantity, "0") < 0 : !isPositiveDecimal(quantity)) {
    throw refusal(`${label} must be ${allowZero ? "zero or greater" : "greater than zero"}`, "invalid_quantity", 422, "Enter a valid quantity");
  }
  return quantity;
}

function parseAcceptedQuantity(value: unknown, label: string): string {
  const quantity = parseQuantity(value, label, true);
  if ((quantity.split(".")[1]?.length ?? 0) > 4) {
    throw refusal(`${label} exceeds the four decimal places supported by inventory movements`, "invalid_quantity", 422, "Enter an accepted quantity with no more than four decimal places");
  }
  return quantity;
}

async function lockRma(runner: SqlExecutor, orgId: string, documentId: string, scope: ReadonlySet<string> | null): Promise<RmaHeader> {
  const row = (await runner.execute<RmaHeader>(sql`
    select d.id, d.kind, d.status, d.document_number, d.party_id, d.subsidiary_id,
           d.document_date::text as document_date, d.currency,
           null::uuid as source_document_id, null::text as stage, null::uuid as customer_credit_id
      from documents d
     where d.org_id = ${orgId} and d.id = ${documentId}
     for update`)).rows[0];
  if (!row || row.kind !== "rma" || !subsidiaryScopeAllows(scope, row.subsidiary_id)) {
    throw refusal("Return authorization not found", "not_found", 404);
  }
  const side = (await runner.execute<{ source_document_id: string; stage: ReturnStage; customer_credit_id: string | null }>(sql`
    select source_document_id, stage, customer_credit_id from rma_documents
     where org_id = ${orgId} and document_id = ${documentId} for update`)).rows[0];
  return { ...row, source_document_id: side?.source_document_id ?? null, stage: side?.stage ?? null, customer_credit_id: side?.customer_credit_id ?? null };
}

function sourceMovementId(line: RmaLine): string | null { return line.source_issue_movement_id; }

async function loadDocumentLines(runner: SqlExecutor, orgId: string, documentId: string): Promise<RmaLine[]> {
  return (await runner.execute<RmaLine>(sql`
    select l.id as line_id, l.line_number, l.item_id, l.stock_location_id,
           movement.lot_id, movement.serial_id,
           l.quantity::text as quantity, l.custom,
           r.authorized::text as authorized, r.received::text as received,
           r.accepted::text as accepted, r.disposition, r.disposition_location_id,
           r.vendor_credit_id, r.source_issue_movement_id, r.scrap_movement_id
      from document_lines l
      left join rma_lines r on r.line_id = l.id and r.org_id = l.org_id
      left join inventory_movements movement on movement.id = r.source_issue_movement_id and movement.org_id = r.org_id
     where l.org_id = ${orgId} and l.document_id = ${documentId}
     order by l.line_number
     for update of l`)).rows;
}

async function returnedByCreditNumbers(runner: SqlExecutor, orgId: string, movementId: string): Promise<string[]> {
  return (await runner.execute<{ document_number: string }>(sql`
    select distinct credit.document_number
      from inventory_movements prior
      join document_lines credit_line on credit_line.id = prior.document_line_id and credit_line.org_id = prior.org_id
      join documents credit on credit.id = credit_line.document_id and credit.org_id = credit_line.org_id
     where ${postedReturnEvidenceScope({
       orgId,
       returnKind: "receipt",
       evidenceKey: "sourceIssueMovementId",
       sourceId: sql`${movementId}`,
     })}
     order by credit.document_number`)).rows.map((row) => row.document_number);
}

/** Authorize a draft RMA against live customer shipment movements, then route it through Flows. */
export async function authorizeReturn(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  documentId: string,
  sourceSelections: Array<{ lineNumber: number; sourceIssueMovementId: string; lotId?: string | null; serialId?: string | null }>,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ReturnAuthorization> {
  await assertReturnAuthorizationsFeature(runner, orgId);
  const header = await lockRma(runner, orgId, documentId, allowedSubsidiaryIds);
  if (header.stage !== null) return getReturnAuthorization(runner, orgId, documentId, allowedSubsidiaryIds);
  if (header.status !== "draft") {
    throw refusal(`${header.document_number} is ${header.status}; only a draft can be authorized`, "wrong_stage", 409, "Edit the draft return or create a new authorization");
  }
  if (!header.party_id || !header.subsidiary_id) {
    throw refusal(`${header.document_number} needs a customer and legal entity`, "invalid_input", 422, "Select the customer and legal entity on the return form");
  }
  const lines = await loadDocumentLines(runner, orgId, documentId);
  if (lines.length === 0) throw refusal(`${header.document_number} has no return lines`, "invalid_input", 422, "Add at least one return line");
  if (sourceSelections.length !== lines.length || new Set(sourceSelections.map((line) => line.lineNumber)).size !== sourceSelections.length) {
    throw refusal("Return source selections must name every line exactly once", "invalid_input", 422, "Choose a returnable source for every line");
  }

  const selectedSources = new Set<string>();
  const sourceDocuments = new Set<string>();
  for (const line of lines) {
    const selection = sourceSelections.find((entry) => entry.lineNumber === line.line_number);
    const sourceId = selection?.sourceIssueMovementId;
    if (!sourceId || !line.item_id || !line.stock_location_id) {
      throw refusal(`Line ${line.line_number} needs a customer shipment, item and stock location`, "invalid_input", 422, "Choose a returnable source on every line");
    }
    if (selectedSources.has(sourceId)) {
      throw refusal(`Line ${line.line_number} repeats a shipment movement`, "invalid_input", 422, "Use one RMA line for each source movement");
    }
    selectedSources.add(sourceId);
    const quantity = parseQuantity(line.quantity, `Line ${line.line_number} authorized quantity`);
    const movement = (await runner.execute<{ id: string }>(sql`
      select id from inventory_movements where org_id = ${orgId} and id = ${sourceId} for update`)).rows[0];
    if (!movement) throw refusal(`Line ${line.line_number} shipment not found`, "source_unavailable", 422, "Choose a customer shipment from the returnable sources");
    let source;
    try {
      source = await assertReturnSourceSelectable(runner, orgId, {
        side: "sales",
        partyId: header.party_id,
        itemId: line.item_id,
        stockLocationId: line.stock_location_id,
        movementId: sourceId,
        subsidiaryIds: [header.subsidiary_id],
        lotId: selection?.lotId ?? null,
        serialId: selection?.serialId ?? null,
      }, `Line ${line.line_number}`);
    } catch (error) {
      if (error instanceof InventoryError) {
        const credits = await returnedByCreditNumbers(runner, orgId, sourceId);
        if (credits.length > 0) {
          throw refusal(
            `Line ${line.line_number} shipment was already returned on ${credits.join(", ")}`,
            "source_fully_returned", 409,
            "Choose a different returnable shipment, or review the named customer credit",
          );
        }
        throw refusal(`${error.message}`, "source_unavailable", 422, "Choose a posted, unreversed shipment with quantity remaining");
      }
      throw error;
    }
    if (!source.documentId) throw refusal(`Line ${line.line_number} shipment has no source document`, "source_unavailable", 422, "Choose a customer invoice or sales fulfillment");
    sourceDocuments.add(source.documentId);
    const active = (await runner.execute<{ quantity: string }>(sql`
      select coalesce(sum(rl.authorized), 0)::text as quantity
        from rma_lines rl
        join rma_documents rd on rd.document_id = rl.document_id and rd.org_id = rl.org_id
       where rl.org_id = ${orgId} and rl.source_issue_movement_id = ${sourceId}
         and rd.stage in ('requested', 'receiving', 'inspected')`)).rows[0]?.quantity ?? "0";
    const available = (await runner.execute<{ quantity: string }>(sql`
      select (${source.remaining}::numeric - ${active}::numeric)::text as quantity`)).rows[0]?.quantity ?? "0";
    if (compareDecimal(quantity, available) > 0) {
      throw refusal(
        `Line ${line.line_number} authorizes ${quantity}, but only ${available} remains after existing return authorizations`,
        "exceeds_returnable_quantity", 409,
        "Reduce the authorized quantity or complete/reject the other return authorizations",
      );
    }
  }
  if (sourceDocuments.size !== 1) {
    throw refusal("An RMA must refer to one customer source document", "mixed_source_documents", 422, "Create a separate return authorization for each invoice or sales fulfillment");
  }
  const sourceDocumentId = [...sourceDocuments][0]!;
  const created = (await runner.execute<{ document_id: string }>(sql`
    insert into rma_documents (document_id, org_id, source_document_id, decided_at, decided_by, created_by, updated_by)
    values (${documentId}, ${orgId}, ${sourceDocumentId}, now(), ${actorId}, ${actorId}, ${actorId})
    returning document_id`)).rows[0];
  if (!created) throw new Error("RMA authorization was not recorded");
  let inserted = 0;
  for (const line of lines) {
    const sourceId = sourceSelections.find((entry) => entry.lineNumber === line.line_number)!.sourceIssueMovementId;
    const quantity = parseQuantity(line.quantity, `Line ${line.line_number} authorized quantity`);
    const row = (await runner.execute<{ line_id: string }>(sql`
      insert into rma_lines (line_id, org_id, document_id, source_issue_movement_id, authorized, created_by, updated_by)
      values (${line.line_id}, ${orgId}, ${documentId}, ${sourceId}, ${quantity}, ${actorId}, ${actorId})
      returning line_id`)).rows[0];
    if (!row) throw new Error(`RMA line ${line.line_number} was not recorded`);
    inserted++;
  }
  if (inserted !== lines.length) throw new Error("not every RMA line was authorized");
  await writeAudit(runner, orgId, actorId, documentId, "insert", {
    before: null,
    after: { stage: "requested", sourceDocumentId, lines: lines.map((line) => ({
      lineId: line.line_id,
      sourceIssueMovementId: sourceSelections.find((entry) => entry.lineNumber === line.line_number)!.sourceIssueMovementId,
      authorized: line.quantity,
    })) },
  });
  const submission = await submitAndReleaseIfUngated("rma", documentId, actorId);
  if (submission.flowError) {
    throw refusal(submission.flowError, "approval_routing_failed", 422, "Correct the return authorization approval flow, then authorize again");
  }
  return getReturnAuthorization(runner, orgId, documentId, allowedSubsidiaryIds);
}

/** Reject an unreceived request with a reason and an audited lifecycle transition. */
export async function rejectReturn(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  documentId: string,
  reason: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<void> {
  await assertReturnAuthorizationsFeature(runner, orgId);
  const header = await lockRma(runner, orgId, documentId, allowedSubsidiaryIds);
  if (header.stage !== "requested") throw refusal(`${header.document_number} is ${header.stage ?? "a draft"}; only a requested return can be rejected`, "wrong_stage", 409, "Reject the request before receiving it");
  if (typeof reason !== "string" || reason.trim().length < 8 || reason.trim().length > 1000) {
    throw refusal("A rejection reason must contain 8 to 1,000 characters", "invalid_input", 422, "Enter a clear reason for rejecting the return");
  }
  const updatedDoc = await runner.execute(sql`
    update documents set status = 'voided', updated_by = ${actorId}, updated_at = now()
     where id = ${documentId} and org_id = ${orgId} and kind = 'rma' and status in ('draft', 'approved')`);
  if (updatedDoc.rowCount !== 1) throw refusal(`${header.document_number} changed before it could be rejected`, "changed_concurrently", 409, RMA_REMEDY);
  const updated = await runner.execute(sql`
    update rma_documents set stage = 'rejected', rejection_reason = ${reason.trim()}, updated_by = ${actorId}, updated_at = now()
     where document_id = ${documentId} and org_id = ${orgId} and stage = 'requested'`);
  if (updated.rowCount !== 1) throw refusal(`${header.document_number} changed before it could be rejected`, "changed_concurrently", 409, RMA_REMEDY);
  await writeAudit(runner, orgId, actorId, documentId, "update", {
    mode: "rma_rejected", before: { stage: header.stage, status: header.status },
    after: { stage: "rejected", status: "voided", reason: reason.trim() },
  });
}

/** Record actual arrival quantities without posting inventory or financial activity. */
export async function receiveReturn(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  documentId: string,
  receivedLines: Array<{ lineId: string; received: string }>,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ReturnAuthorization> {
  await assertReturnAuthorizationsFeature(runner, orgId);
  const header = await lockRma(runner, orgId, documentId, allowedSubsidiaryIds);
  if (header.stage !== "requested") throw refusal(`${header.document_number} is ${header.stage ?? "a draft"}; only an authorized request can be received`, "wrong_stage", 409, "Receive a return while it is requested");
  if (header.status !== "approved") throw refusal(`${header.document_number} is awaiting approval`, "approval_pending", 409, "Approve the return authorization in Flows before receiving goods");
  const lines = await loadDocumentLines(runner, orgId, documentId);
  if (receivedLines.length !== lines.length || new Set(receivedLines.map((line) => line.lineId)).size !== receivedLines.length) {
    throw refusal("Received quantities must name every return line exactly once", "invalid_input", 422, "Reload the return and enter an arrived quantity for each line");
  }
  for (const line of lines) {
    const received = receivedLines.find((entry) => entry.lineId === line.line_id);
    if (!received) throw refusal(`Line ${line.line_number} received quantity is missing`, "invalid_input", 422, "Enter an arrived quantity for each line");
    const quantity = parseQuantity(received.received, `Line ${line.line_number} received quantity`, true);
    if (compareDecimal(quantity, line.authorized ?? "0") > 0) {
      throw refusal(`Line ${line.line_number} received quantity exceeds its authorization`, "invalid_quantity", 422, "Enter no more than the authorized quantity");
    }
    const updatedLine = await runner.execute(sql`
      update rma_lines set received = ${quantity}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId} and line_id = ${line.line_id}`);
    if (updatedLine.rowCount !== 1) throw refusal(`Line ${line.line_number} changed while being received`, "changed_concurrently", 409, RMA_REMEDY);
  }
  const updated = await runner.execute(sql`
    update rma_documents set stage = 'receiving', received_at = now(), received_by = ${actorId}, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and document_id = ${documentId} and stage = 'requested'`);
  if (updated.rowCount !== 1) throw refusal(`${header.document_number} changed while goods were being received`, "changed_concurrently", 409, RMA_REMEDY);
  await writeAudit(runner, orgId, actorId, documentId, "update", {
    mode: "rma_received", before: { stage: "requested" },
    after: { stage: "receiving", lines: receivedLines.map((line) => ({ lineId: line.lineId, received: line.received })) },
  });
  return getReturnAuthorization(runner, orgId, documentId, allowedSubsidiaryIds);
}

export type InspectionLine = {
  lineId: string;
  accepted: string;
  disposition: ReturnDisposition | null;
  dispositionLocationId: string | null;
  vendorId?: string | null;
};

export function validateReturnInspection(
  authorization: ReturnAuthorization,
  inspectionLines: InspectionLine[],
): void {
  if (authorization.stage !== "receiving" && authorization.stage !== "inspected") {
    throw refusal(`${authorization.documentNumber} is ${authorization.stage ?? "a draft"}; only received goods can be inspected`, "wrong_stage", 409, "Receive the authorized goods before inspection");
  }
  if (inspectionLines.length !== authorization.lines.length || new Set(inspectionLines.map((line) => line.lineId)).size !== inspectionLines.length) {
    throw refusal("Inspection decisions must name every return line exactly once", "invalid_input", 422, "Reload the return and inspect each line");
  }
  for (const line of authorization.lines) {
    const decision = inspectionLines.find((entry) => entry.lineId === line.lineId);
    if (!decision) throw refusal(`Line ${line.lineNumber} inspection is missing`, "invalid_input", 422, "Inspect each received line");
    const accepted = parseAcceptedQuantity(decision.accepted, `Line ${line.lineNumber} accepted quantity`);
    if (compareDecimal(accepted, line.received) > 0) {
      throw refusal(`Line ${line.lineNumber} accepted quantity exceeds goods received`, "invalid_quantity", 422, "Accept no more than the quantity received");
    }
    if (compareDecimal(accepted, "0") === 0) {
      if (decision.disposition !== null || decision.dispositionLocationId !== null) {
        throw refusal(`Line ${line.lineNumber} has no accepted quantity for its disposition`, "invalid_input", 422, "Clear the disposition when no units are accepted");
      }
    } else if (!decision.disposition || !decision.dispositionLocationId) {
      throw refusal(`Line ${line.lineNumber} needs a disposition location`, "invalid_input", 422, "Choose restock, scrap or vendor return and its location");
    }
    if (decision.disposition === "vendor-return" && !decision.vendorId) {
      throw refusal(`Line ${line.lineNumber} needs a vendor for the return draft`, "invalid_input", 422, "Select the vendor who supplied the goods");
    }
  }
}

/** Persist inspected quantities and disposition evidence before the caller posts their effects. */
export async function recordReturnInspection(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  documentId: string,
  inspectionLines: InspectionLine[],
  customerCreditId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ReturnAuthorization> {
  await assertReturnAuthorizationsFeature(runner, orgId);
  const header = await lockRma(runner, orgId, documentId, allowedSubsidiaryIds);
  if (header.stage !== "receiving" && header.stage !== "inspected") {
    throw refusal(`${header.document_number} is ${header.stage ?? "a draft"}; only received goods can be inspected`, "wrong_stage", 409, "Receive the authorized goods before inspection");
  }
  if (header.customer_credit_id && header.customer_credit_id !== customerCreditId) {
    throw refusal(`${header.document_number} already names another customer credit`, "changed_concurrently", 409, RMA_REMEDY);
  }
  const lines = await loadDocumentLines(runner, orgId, documentId);
  const current = await getReturnAuthorization(runner, orgId, documentId, allowedSubsidiaryIds);
  validateReturnInspection(current, inspectionLines);
  for (const line of lines) {
    const decision = inspectionLines.find((entry) => entry.lineId === line.line_id);
    if (!decision) throw refusal(`Line ${line.line_number} inspection is missing`, "invalid_input", 422, "Inspect each received line");
    const accepted = parseAcceptedQuantity(decision.accepted, `Line ${line.line_number} accepted quantity`);
    if (compareDecimal(accepted, line.received ?? "0") > 0) {
      throw refusal(`Line ${line.line_number} accepted quantity exceeds goods received`, "invalid_quantity", 422, "Accept no more than the quantity received");
    }
    if (compareDecimal(accepted, "0") === 0) {
      if (decision.disposition !== null || decision.dispositionLocationId !== null) {
        throw refusal(`Line ${line.line_number} has no accepted quantity for its disposition`, "invalid_input", 422, "Clear the disposition when no units are accepted");
      }
    } else if (!decision.disposition || !decision.dispositionLocationId) {
      throw refusal(`Line ${line.line_number} needs a disposition location`, "invalid_input", 422, "Choose restock, scrap or vendor return and its location");
    }
    if (decision.disposition === "vendor-return" && !decision.vendorId) {
      throw refusal(`Line ${line.line_number} needs a vendor for the return draft`, "invalid_input", 422, "Select the vendor who supplied the goods");
    }
    const updated = await runner.execute(sql`
      update rma_lines set accepted = ${accepted}, disposition = ${decision.disposition},
             disposition_location_id = ${decision.dispositionLocationId}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId} and line_id = ${line.line_id}`);
    if (updated.rowCount !== 1) throw refusal(`Line ${line.line_number} changed during inspection`, "changed_concurrently", 409, RMA_REMEDY);
  }
  const stage = await runner.execute(sql`
    update rma_documents set stage = 'inspected', customer_credit_id = ${customerCreditId},
           inspected_at = coalesce(inspected_at, now()), inspected_by = coalesce(inspected_by, ${actorId}),
           updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and document_id = ${documentId} and stage in ('receiving', 'inspected')`);
  if (stage.rowCount !== 1) throw refusal(`${header.document_number} changed during inspection`, "changed_concurrently", 409, RMA_REMEDY);
  await writeAudit(runner, orgId, actorId, documentId, "update", {
    mode: "rma_inspected", before: { stage: header.stage },
    after: { stage: "inspected", customerCreditId, lines: inspectionLines.map(({ lineId, accepted, disposition, dispositionLocationId }) => ({ lineId, accepted, disposition, dispositionLocationId })) },
  });
  return getReturnAuthorization(runner, orgId, documentId, allowedSubsidiaryIds);
}

/** Finish inspection after the credit and all inventory effects have succeeded in the same transaction. */
export async function completeReturnInspection(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  documentId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ReturnAuthorization> {
  await assertReturnAuthorizationsFeature(runner, orgId);
  const header = await lockRma(runner, orgId, documentId, allowedSubsidiaryIds);
  if (header.stage === "done") return getReturnAuthorization(runner, orgId, documentId, allowedSubsidiaryIds);
  if (header.stage !== "inspected" || !header.customer_credit_id) {
    throw refusal(`${header.document_number} has not been inspected`, "wrong_stage", 409, "Inspect the received goods before completing the return");
  }
  const updated = await runner.execute(sql`
    update rma_documents set stage = 'done', updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and document_id = ${documentId} and stage = 'inspected' and customer_credit_id = ${header.customer_credit_id}`);
  if (updated.rowCount !== 1) throw refusal(`${header.document_number} changed before inspection completed`, "changed_concurrently", 409, RMA_REMEDY);
  await writeAudit(runner, orgId, actorId, documentId, "update", {
    mode: "rma_completed", before: { stage: "inspected" }, after: { stage: "done", customerCreditId: header.customer_credit_id },
  });
  return getReturnAuthorization(runner, orgId, documentId, allowedSubsidiaryIds);
}

export async function getReturnAuthorization(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ReturnAuthorization> {
  await assertReturnAuthorizationsFeature(runner, orgId);
  const header = (await runner.execute<RmaHeader>(sql`
    select d.id, d.kind, d.status, d.document_number, d.party_id, d.subsidiary_id,
           d.document_date::text as document_date, d.currency,
           r.source_document_id, r.stage, r.customer_credit_id
      from documents d join rma_documents r on r.document_id = d.id and r.org_id = d.org_id
     where d.org_id = ${orgId} and d.id = ${documentId}`)).rows[0];
  if (!header || header.kind !== "rma" || !subsidiaryScopeAllows(allowedSubsidiaryIds, header.subsidiary_id)) {
    throw refusal("Return authorization not found", "not_found", 404);
  }
  const lines = (await runner.execute<RmaLine>(sql`
    select l.id as line_id, l.line_number, l.item_id, l.stock_location_id, movement.lot_id, movement.serial_id,
           l.quantity::text as quantity,
           l.custom, r.authorized::text as authorized, r.received::text as received,
           r.accepted::text as accepted, r.disposition, r.disposition_location_id, r.vendor_credit_id,
           r.source_issue_movement_id, r.scrap_movement_id
      from document_lines l join rma_lines r on r.line_id = l.id and r.org_id = l.org_id
      left join inventory_movements movement on movement.id = r.source_issue_movement_id and movement.org_id = r.org_id
     where l.org_id = ${orgId} and l.document_id = ${documentId}
     order by l.line_number`)).rows;
  return {
    id: header.id,
    documentNumber: header.document_number,
    customerId: header.party_id,
    subsidiaryId: header.subsidiary_id,
    sourceDocumentId: header.source_document_id,
    status: header.status,
    stage: header.stage,
    customerCreditId: header.customer_credit_id,
    lines: lines.map((line) => ({
      lineId: line.line_id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      lotId: line.lot_id,
      serialId: line.serial_id,
      sourceIssueMovementId: sourceMovementId(line),
      authorized: line.authorized ?? "0",
      received: line.received ?? "0",
      accepted: line.accepted ?? "0",
      disposition: line.disposition,
      dispositionLocationId: line.disposition_location_id,
      vendorCreditId: line.vendor_credit_id,
      scrapMovementId: line.scrap_movement_id,
    })),
  };
}

export async function listReturnAuthorizations(
  runner: SqlExecutor,
  orgId: string,
  scope: ReadonlySet<string> | null,
): Promise<ReturnAuthorization[]> {
  await assertReturnAuthorizationsFeature(runner, orgId);
  const docs = (await runner.execute<{ id: string }>(sql`
    select d.id from documents d join rma_documents r on r.document_id = d.id and r.org_id = d.org_id
     where d.org_id = ${orgId}
       ${scope === null ? sql`` : scope.size === 0 ? sql`and false` : sql`and d.subsidiary_id = any(${uuidArray([...scope])}::uuid[])`}
     order by d.document_date desc, d.document_number desc limit 500`)).rows;
  const result: ReturnAuthorization[] = [];
  for (const doc of docs) result.push(await getReturnAuthorization(runner, orgId, doc.id, scope));
  return result;
}

async function writeAudit(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  documentId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
): Promise<void> {
  const result = await runner.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'rma_documents', ${documentId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`);
  if (result.rows.length !== 1) throw new Error("return authorization change was not audited");
}

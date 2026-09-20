import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { InventoryError } from "./contracts.ts";
import { assertMovementOwner, inventoryFeatureEnabled } from "./profile-policy.ts";
import { lockInventoryPosition } from "./position.ts";
import { issueInventory } from "./movements.ts";
import { loadDocumentInventoryLines, unprofiledInventoryLines, assertNoUnprofiledInventoryLines, inventoryPostingEffectKey, UUID_RE, isJsonRecord, type DocumentInventoryLine } from "./document-lines.ts";

/**
 * One predicate for "the fulfilment path owns this invoice's stock", read by
 * both the pre-post guard below and the post-commit issue hook. An invoice
 * converted from a sales order must never move stock a second time.
 */
async function isFulfilmentGovernedInvoice(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<boolean> {
  const governed = await runner.execute(sql`
    select 1
      from document_links link
      join documents source
        on source.id = link.from_document_id and source.org_id = link.org_id
     where link.org_id = ${orgId} and link.to_document_id = ${documentId}
       and link.link_type = 'bills' and source.kind = 'sales_order'
     limit 1`);
  return !!governed.rows[0];
}

/**
 * A standalone invoice may only post into a state its issue effects can
 * satisfy: an inventory-kind line without a costing profile — or with a
 * profile but no resolvable stock location — would otherwise post revenue
 * with no COGS and no stock movement, failing only inside the post-commit
 * effects drain after the journal has committed (F-t07-003). Governed
 * invoices (sold through fulfillment) already clear this at shipment; this
 * is the backstop for the legacy ship-and-bill path. Fail before posting,
 * like the bill leg.
 */
export async function assertInvoiceIssuesPostable(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<void> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return;
  assertNoUnprofiledInventoryLines(await unprofiledInventoryLines(runner, orgId, documentId));
  if (await isFulfilmentGovernedInvoice(runner, orgId, documentId)) return;
  await loadDocumentInventoryLines(runner, orgId, documentId);
}

function salesFulfillmentTrackingSelection(
  line: DocumentInventoryLine,
): { lotId: string | null; serialId: string | null } {
  const evidence = isJsonRecord(line.custom) ? line.custom.fulfillment : null;
  const label = `sales-fulfillment line ${line.lineNumber} (item ${line.itemId})`;
  if (!isJsonRecord(evidence)) {
    throw new InventoryError(`${label} requires immutable fulfillment evidence`);
  }
  const sourceLineId = evidence.sourceLineId;
  const lotId = evidence.lotId ?? null;
  const serialId = evidence.serialId ?? null;
  if (typeof sourceLineId !== "string" || !UUID_RE.test(sourceLineId)) {
    throw new InventoryError(`${label} requires a valid source sales-order line`);
  }
  if (lotId !== null && (typeof lotId !== "string" || !UUID_RE.test(lotId))) {
    throw new InventoryError(`${label} lotId must be a UUID`);
  }
  if (
    serialId !== null &&
    (typeof serialId !== "string" || !UUID_RE.test(serialId))
  ) {
    throw new InventoryError(`${label} serialId must be a UUID`);
  }
  return { lotId, serialId };
}

/**
 * Issue every inventory line on an approved sales-fulfillment document in the
 * caller's transaction. The fulfillment writer locks source order lines; this
 * function additionally locks inventory positions before checking movement
 * evidence, so a retry waits for the winning shipment and then observes its
 * committed movement instead of consuming a second layer.
 */
export async function applySalesFulfillmentInventoryIssues(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  documentId: string,
  date: string,
  subsidiaryId: string | null,
): Promise<number> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return 0;
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  if (lines.length === 0) return 0;
  const ctx = await loadSubsidiaryContext(runner, orgId);
  const movementSubsidiaryId = subsidiaryId ?? ctx.rootId;
  assertMovementOwner(ctx, movementSubsidiaryId);
  for (const key of [
    ...new Set(lines.map((line) => `${line.itemId}:${line.stockLocationId}`)),
  ].sort()) {
    const separator = key.indexOf(":");
    await lockInventoryPosition(
      runner,
      key.slice(0, separator),
      key.slice(separator + 1),
    );
  }
  let count = 0;
  for (const line of lines) {
    const seen = (await runner.execute(sql`
      select 1 from inventory_movements
       where org_id = ${orgId} and document_line_id = ${line.lineId}
         and kind = 'issue'
       limit 1`));
    if (seen.rows[0]) continue;
    const selection = salesFulfillmentTrackingSelection(line);
    await issueInventory(orgId, actorId, {
      itemId: line.itemId,
      stockLocationId: line.stockLocationId,
      quantity: line.quantity,
      subsidiaryId: movementSubsidiaryId,
      date,
      documentLineId: line.lineId,
      idempotencyKey: inventoryPostingEffectKey(line.lineId, "issue"),
      lotId: selection.lotId,
      serialId: selection.serialId,
      departmentId: line.departmentId,
      projectId: line.projectId,
      locationId: line.locationId,
      memo: "COGS (sales fulfillment)",
      tx: runner,
    });
    count++;
  }
  return count;
}

/**
 * A standalone invoice can represent a combined ship-and-bill policy, so it
 * retains the legacy issue hook. An invoice converted from a sales order is
 * governed by explicit fulfillment and must never move stock a second time.
 */
export async function applyInventoryIssuesForInvoice(
  orgId: string,
  actorId: string | null,
  documentId: string,
  date: string,
  subsidiaryId: string,
): Promise<number> {
  if (!(await inventoryFeatureEnabled(db, orgId))) return 0;
  if (await isFulfilmentGovernedInvoice(db, orgId, documentId)) return 0;
  const lines = await loadDocumentInventoryLines(db, orgId, documentId);
  let count = 0;
  for (const l of lines) {
    const seen = (await db.execute(sql`
      select 1 from inventory_movements where org_id = ${orgId} and document_line_id = ${l.lineId} and kind = 'issue' limit 1`));
    if (seen.rows[0]) continue;
    await issueInventory(orgId, actorId, {
      itemId: l.itemId,
      stockLocationId: l.stockLocationId,
      quantity: l.quantity,
      subsidiaryId,
      date,
      documentLineId: l.lineId,
      idempotencyKey: inventoryPostingEffectKey(l.lineId, "issue"),
      memo: "COGS (invoice)",
    });
    count++;
  }
  return count;
}

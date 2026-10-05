import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { InventoryError } from "./contracts.ts";
import { assertDocumentLinesUntracked } from "./tracking.ts";
import { assertMovementOwner, inventoryFeatureEnabled } from "./profile-policy.ts";
import { lockInventoryPosition } from "./position.ts";
import { issueInventory, type IssueInput } from "./movements.ts";
import { loadDocumentInventoryLines, unprofiledInventoryLines, assertNoUnprofiledInventoryLines, inventoryPostingEffectKey, isJsonRecord, type DocumentInventoryLine } from "./document-lines.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  inventoryKitComponentEffectKey,
  kitComponentQuantities,
  kitLabel,
  loadKitComponents,
  parseKitComponentPicks,
  type KitComponent,
  type KitComponentPick,
} from "./kits.ts";
import { resolveProfile } from "./profile-policy.ts";

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
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  // A standalone invoice names no lot or serial per line, so a tracked line
  // could never issue: without this guard revenue posts and the post-commit
  // drain fails with COGS never booked against it. Refuse before posting,
  // through the same helper as the bill leg.
  assertDocumentLinesUntracked(lines, {
    movement: "issue",
    carrier: "standalone-invoice lines",
    remedy: "ship the goods on a sales-fulfillment document naming the lot or serial instead",
  });
  // Kit lines explode at issue time, so the same backstop applies one level
  // down: a kit whose recipe is missing or names a tracked component could
  // never issue from a standalone invoice. Refuse before posting, naming the
  // shipment flow that carries component lot and serial evidence.
  const document = (await runner.execute<{ document_date: string }>(sql`
    select document_date::text as document_date from documents
     where org_id = ${orgId} and id = ${documentId}`)).rows[0];
  const date = document?.document_date;
  for (const line of lines) {
    if (line.itemKind !== "kit" || !date) continue;
    const kitName = await kitLabel(runner, orgId, line.itemId);
    const components = await loadKitComponents(runner, orgId, line.itemId, date);
    for (const component of components) {
      const profile = await resolveProfile(orgId, component.componentItemId, runner);
      if (profile.tracking !== "none") {
        const componentName = await kitLabel(runner, orgId, component.componentItemId);
        throw new InventoryError(
          `invoice line ${line.lineNumber} (kit ${kitName}) contains ${profile.tracking}-tracked ` +
            `component ${componentName}; standalone-invoice lines cannot carry component lot or serial ` +
            `evidence — ship the goods on a sales-fulfillment document naming the ${profile.tracking} instead`,
        );
      }
    }
  }
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
  if (!isUuid(sourceLineId)) {
    throw new InventoryError(`${label} requires a valid source sales-order line`);
  }
  if (lotId !== null && !isUuid(lotId)) {
    throw new InventoryError(`${label} lotId must be a UUID`);
  }
  if (
    serialId !== null &&
    !isUuid(serialId)
  ) {
    throw new InventoryError(`${label} serialId must be a UUID`);
  }
  return { lotId, serialId };
}

/**
 * A kit line's explosion plan: every effective component with its exact
 * quantity and the lot/serial/bin pick the shipment made for it. Untracked
 * components without an explicit pick issue from the kit line's own stock
 * location; tracked components must each name their pick, and a lot or
 * serial named on the kit line itself is refused — it can only ever belong
 * to one component, so it is chosen per component instead.
 */
interface KitExplosion {
  components: KitComponent[];
  quantities: Map<string, string>;
  picks: Map<string, KitComponentPick>;
}

async function explodeKitLine(
  runner: SqlExecutor,
  orgId: string,
  line: DocumentInventoryLine,
  date: string,
  movementLabel: string,
): Promise<KitExplosion> {
  const label = movementLabel;
  const kitName = await kitLabel(runner, orgId, line.itemId);
  const components = await loadKitComponents(runner, orgId, line.itemId, date);
  const picks = parseKitComponentPicks(line.custom, label) ?? [];
  const pickByComponent = new Map<string, KitComponentPick>();
  for (const pick of picks) {
    if (pickByComponent.has(pick.componentItemId)) {
      throw new InventoryError(
        `${label} names component ${pick.componentItemId} twice; list each kit component once`,
      );
    }
    if (!components.some((component) => component.componentItemId === pick.componentItemId)) {
      throw new InventoryError(
        `${label} names component ${pick.componentItemId}, which is not in kit ${kitName}'s bill of materials effective on ${date}`,
      );
    }
    pickByComponent.set(pick.componentItemId, pick);
  }
  // Component tracking decides which picks are owed: the kit profile's own
  // tracking never moves stock, so fulfillment evidence is read here only to
  // refuse a lot/serial stored on the kit line instead of on a component.
  // Standalone invoice lines carry no fulfillment evidence at all.
  const evidence = isJsonRecord(line.custom) ? line.custom.fulfillment : null;
  if (isJsonRecord(evidence)) {
    const selection = salesFulfillmentTrackingSelection(line);
    if (selection.lotId !== null || selection.serialId !== null) {
      throw new InventoryError(
        `${label} names a lot or serial on kit ${kitName}; choose lots and serials per component instead`,
      );
    }
  }
  for (const component of components) {
    const profile = await resolveProfile(orgId, component.componentItemId, runner);
    const pick = pickByComponent.get(component.componentItemId);
    if (profile.tracking !== "none" && !pick) {
      const componentName = await kitLabel(runner, orgId, component.componentItemId);
      throw new InventoryError(
        `${label} ${profile.tracking}-tracked component ${componentName} needs its ${profile.tracking} ` +
          `chosen on the shipment; pick the component explicitly instead`,
      );
    }
    if (pick && ((profile.tracking === "lot" && !pick.lotId) || (profile.tracking === "serial" && !pick.serialId))) {
      const componentName = await kitLabel(runner, orgId, component.componentItemId);
      throw new InventoryError(
        `${label} component ${componentName} is ${profile.tracking}-tracked but names no ${profile.tracking}; ` +
          `choose the ${profile.tracking} on the shipment instead`,
      );
    }
  }
  const quantities = new Map(
    kitComponentQuantities(kitName, line.quantity, components).map((entry) => [entry.componentItemId, entry.quantity]),
  );
  return { components, quantities, picks: pickByComponent };
}

function kitComponentIssueInput(
  line: DocumentInventoryLine,
  componentItemId: string,
  quantity: string,
  pick: KitComponentPick | undefined,
  subsidiaryId: string,
  date: string,
  memo: string,
  tx: SqlExecutor,
): IssueInput {
  return {
    itemId: componentItemId,
    stockLocationId: pick?.stockLocationId ?? line.stockLocationId,
    quantity,
    subsidiaryId,
    date,
    documentLineId: line.lineId,
    idempotencyKey: inventoryKitComponentEffectKey(line.lineId, componentItemId),
    lotId: pick?.lotId ?? null,
    serialId: pick?.serialId ?? null,
    departmentId: line.departmentId,
    projectId: line.projectId,
    locationId: line.locationId,
    memo,
    tx,
  };
}

/**
 * Issue every inventory line on an approved sales-fulfillment document in the
 * caller's transaction. The fulfillment writer locks source order lines; this
 * function additionally locks inventory positions before checking movement
 * evidence, so a retry waits for the winning shipment and then observes its
 * committed movement instead of consuming a second layer.
 *
 * Kit lines never issue themselves: each explodes into one issue per
 * component, keyed per (line, component) so re-runs stay no-ops.
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
  const explosions = new Map<string, KitExplosion>();
  for (const line of lines) {
    if (line.itemKind === "kit") {
      explosions.set(
        line.lineId,
        await explodeKitLine(
          runner, orgId, line, date,
          `sales-fulfillment line ${line.lineNumber} (item ${line.itemId})`,
        ),
      );
    }
  }
  const positions = new Set<string>();
  for (const line of lines) {
    const explosion = explosions.get(line.lineId);
    if (!explosion) {
      positions.add(`${line.itemId}:${line.stockLocationId}`);
      continue;
    }
    for (const component of explosion.components) {
      const pick = explosion.picks.get(component.componentItemId);
      positions.add(`${component.componentItemId}:${pick?.stockLocationId ?? line.stockLocationId}`);
    }
  }
  for (const key of [...positions].sort()) {
    const separator = key.indexOf(":");
    await lockInventoryPosition(
      runner,
      key.slice(0, separator),
      key.slice(separator + 1),
    );
  }
  let count = 0;
  for (const line of lines) {
    const explosion = explosions.get(line.lineId);
    if (!explosion) {
      const seen = (await runner.execute(sql`
        select 1 from inventory_movements
         where org_id = ${orgId} and document_line_id = ${line.lineId}
           and kind = 'issue'
         limit 1`));
      if (seen.rows[0]) continue;
      const selection = salesFulfillmentTrackingSelection(line);
      await issueInventory(
        orgId,
        actorId,
        salesLineIssueInput(line, selection, movementSubsidiaryId, date, "COGS (sales fulfillment)", runner),
      );
      count++;
      continue;
    }
    for (const component of explosion.components) {
      const seen = (await runner.execute(sql`
        select 1 from inventory_movements
         where org_id = ${orgId} and document_line_id = ${line.lineId}
           and item_id = ${component.componentItemId} and kind = 'issue'
         limit 1`));
      if (seen.rows[0]) continue;
      await issueInventory(
        orgId,
        actorId,
        kitComponentIssueInput(
          line,
          component.componentItemId,
          explosion.quantities.get(component.componentItemId)!,
          explosion.picks.get(component.componentItemId),
          movementSubsidiaryId,
          date,
          "COGS (sales fulfillment)",
          runner,
        ),
      );
      count++;
    }
  }
  return count;
}

/**
 * One line-to-issue mapping for both sales legs. Fulfillment supplies the
 * lot/serial selection from its immutable evidence; the standalone drain
 * passes none (tracked standalone lines are refused pre-post, and any that
 * reach the drain fail inside its transaction). Dimensions ride every leg:
 * dropping them booked COGS without the department/project/location the
 * revenue carries.
 */
function salesLineIssueInput(
  line: DocumentInventoryLine,
  selection: { lotId: string | null; serialId: string | null },
  subsidiaryId: string,
  date: string,
  memo: string,
  tx: SqlExecutor,
): IssueInput {
  return {
    itemId: line.itemId,
    stockLocationId: line.stockLocationId,
    quantity: line.quantity,
    subsidiaryId,
    date,
    documentLineId: line.lineId,
    idempotencyKey: inventoryPostingEffectKey(line.lineId, "issue"),
    lotId: selection.lotId,
    serialId: selection.serialId,
    departmentId: line.departmentId,
    projectId: line.projectId,
    locationId: line.locationId,
    memo,
    tx,
  };
}

/**
 * A standalone invoice can represent a combined ship-and-bill policy, so it
 * retains the legacy issue hook. An invoice converted from a sales order is
 * governed by explicit fulfillment and must never move stock a second time.
 *
 * All lines issue in ONE transaction: a failure on any line rolls every
 * sibling back, so a tracking failure on line 2 can never leave line 1's
 * COGS committed against revenue. The post-commit effects drain retries
 * the whole set (recording a terminal failure if it never clears).
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
  return db.transaction(async (tx) => {
    const lines = await loadDocumentInventoryLines(tx, orgId, documentId);
    const explosions = new Map<string, KitExplosion>();
    for (const line of lines) {
      if (line.itemKind === "kit") {
        explosions.set(
          line.lineId,
          await explodeKitLine(tx, orgId, line, date, `invoice line ${line.lineNumber} (item ${line.itemId})`),
        );
      }
    }
    const positions = new Set<string>();
    for (const line of lines) {
      const explosion = explosions.get(line.lineId);
      if (!explosion) {
        positions.add(`${line.itemId}:${line.stockLocationId}`);
        continue;
      }
      for (const component of explosion.components) {
        const pick = explosion.picks.get(component.componentItemId);
        positions.add(`${component.componentItemId}:${pick?.stockLocationId ?? line.stockLocationId}`);
      }
    }
    for (const key of [...positions].sort()) {
      const separator = key.indexOf(":");
      await lockInventoryPosition(
        tx,
        key.slice(0, separator),
        key.slice(separator + 1),
      );
    }
    let count = 0;
    for (const l of lines) {
      const explosion = explosions.get(l.lineId);
      if (!explosion) {
        const seen = (await tx.execute(sql`
          select 1 from inventory_movements where org_id = ${orgId} and document_line_id = ${l.lineId} and kind = 'issue' limit 1`));
        if (seen.rows[0]) continue;
        await issueInventory(
          orgId,
          actorId,
          salesLineIssueInput(l, { lotId: null, serialId: null }, subsidiaryId, date, "COGS (invoice)", tx),
        );
        count++;
        continue;
      }
      for (const component of explosion.components) {
        const seen = (await tx.execute(sql`
          select 1 from inventory_movements where org_id = ${orgId} and document_line_id = ${l.lineId}
            and item_id = ${component.componentItemId} and kind = 'issue' limit 1`));
        if (seen.rows[0]) continue;
        await issueInventory(
          orgId,
          actorId,
          kitComponentIssueInput(
            l,
            component.componentItemId,
            explosion.quantities.get(component.componentItemId)!,
            explosion.picks.get(component.componentItemId),
            subsidiaryId,
            date,
            "COGS (invoice)",
            tx,
          ),
        );
        count++;
      }
    }
    return count;
  });
}

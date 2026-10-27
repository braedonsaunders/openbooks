import { sql } from "drizzle-orm";
import { InventoryError, type Runner } from "./contracts.ts";
import { resolveProfile, inventoryFeatureEnabled } from "./profile-policy.ts";
import {
  loadDocumentInventoryLines,
  isJsonRecord,
  isAllowanceLine,
  loadItemLabels,
  type DocumentInventoryLine,
} from "./document-lines.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  kitComponentMovesStock,
  kitComponentQuantities,
  kitLabel,
  loadKitComponents,
  parseKitComponentReturnSources,
} from "./kits.ts";

export interface CustomerCreditInventoryReturnSelection {
  /** Posted issue movement whose sale is being returned. */
  sourceIssueMovementId: string;
  /** Required for lot-tracked stock and forbidden for other tracking modes. */
  lotId: string | null;
  /** Required for serial-tracked stock and forbidden for other tracking modes. */
  serialId: string | null;
}

/**
 * Native sales-return evidence is stored on the immutable posted credit line,
 * naming the issue movement whose units are coming back. The issue is what
 * carries the cost the return must restore, so the link is the valuation
 * evidence as well as the provenance.
 */
export function parseCustomerCreditInventoryReturnSelection(
  custom: unknown,
  lineLabel = "customer-credit inventory line",
): CustomerCreditInventoryReturnSelection {
  const evidence = isJsonRecord(custom) ? custom.inventoryReturn : null;
  if (!isJsonRecord(evidence)) {
    throw new InventoryError(
      `${lineLabel} is a stocked item: choose the shipment the goods are returned from, ` +
        `or post the credit with no goods returned`,
    );
  }
  const sourceIssueMovementId = evidence.sourceIssueMovementId;
  const lotId = evidence.lotId ?? null;
  const serialId = evidence.serialId ?? null;
  if (typeof sourceIssueMovementId !== "string" || !isUuid(sourceIssueMovementId)) {
    throw new InventoryError(`${lineLabel} requires a valid inventoryReturn.sourceIssueMovementId`);
  }
  if (lotId !== null && !isUuid(lotId)) {
    throw new InventoryError(`${lineLabel} inventoryReturn.lotId must be a UUID`);
  }
  if (serialId !== null && !isUuid(serialId)) {
    throw new InventoryError(`${lineLabel} inventoryReturn.serialId must be a UUID`);
  }
  return { sourceIssueMovementId, lotId, serialId };
}

export interface CustomerCreditInventoryReturnLine extends DocumentInventoryLine {
  selection: CustomerCreditInventoryReturnSelection;
  /** Set on kit-exploded pseudo-lines: the kit item the return was raised on. */
  kitItemId: string | null;
}

/** Operator label for a credit line: line number plus the item's catalog code. */
function customerCreditLineLabel(line: DocumentInventoryLine, labels: Map<string, string>): string {
  return `Line ${line.lineNumber} (${labels.get(line.itemId) ?? line.itemId})`;
}

export async function loadCustomerCreditInventoryReturnLines(
  runner: Runner,
  orgId: string,
  documentId: string,
  requireEvidence: boolean,
): Promise<CustomerCreditInventoryReturnLine[]> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return [];
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  const labels = await loadItemLabels(
    runner,
    orgId,
    lines.map((line) => line.itemId),
  );
  const returns: CustomerCreditInventoryReturnLine[] = [];
  for (const line of lines) {
    const label = customerCreditLineLabel(line, labels);
    const custom = isJsonRecord(line.custom) ? line.custom : null;
    // An explicit no-goods-returned choice settles commercially, exactly
    // like a line that never chose a return: revenue reverses and no stock
    // moves. The flag only records that the operator made the choice.
    if (isAllowanceLine(line.custom)) {
      if (custom && "inventoryReturn" in custom) {
        throw new InventoryError(
          `${label} cannot both return goods and have no goods returned — ` +
            `keep the shipment the goods are returned from, or keep no goods returned, not both`,
        );
      }
      continue;
    }
    if (!custom || !("inventoryReturn" in custom)) {
      // A credit memo may legitimately carry no stock at all (a price
      // concession, a goodwill credit). Only lines that CLAIM a return are
      // held to the evidence contract at posting time.
      if (!requireEvidence) continue;
      throw new InventoryError(
        `${label} is a stocked item: choose the shipment the goods are returned from, ` +
          `or post the credit with no goods returned`,
      );
    }
    // Kit lines never return themselves: they expand into one pseudo-line
    // per component below, each naming its own source issue movement.
    if (line.itemKind === "kit") continue;
    returns.push({
      ...line,
      kitItemId: null,
      selection: parseCustomerCreditInventoryReturnSelection(line.custom, label),
    });
  }
  return returns;
}

/**
 * Expand kit credit lines into one return pseudo-line per component. A kit
 * sale issues one movement per stocked component, so a kit return names one
 * source issue movement per stocked component and restores each at the cost
 * its units left at. Non-stocked recipe lines never moved, so they name no
 * source and settle in money only. Component quantities re-derive from the
 * kit line exactly as the shipment derived them (line quantity × quantity
 * per), and every component returns to the credit line's own stock location
 * — the one place a credit line can name, and the location the operator
 * chose for the physical return.
 */
export async function expandKitCustomerCreditReturnLines(
  runner: Runner,
  orgId: string,
  documentId: string,
  date: string,
): Promise<CustomerCreditInventoryReturnLine[]> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return [];
  const lines = (await loadDocumentInventoryLines(runner, orgId, documentId)).filter(
    (line) => line.itemKind === "kit",
  );
  const returns: CustomerCreditInventoryReturnLine[] = [];
  for (const line of lines) {
    const custom = isJsonRecord(line.custom) ? line.custom : null;
    // A kit line without return evidence is a commercial-only credit, like
    // any other evidence-less line: it reverses revenue and restores nothing.
    if (!custom || !("inventoryReturn" in custom)) continue;
    if (isAllowanceLine(line.custom)) {
      throw new InventoryError(
        `document line ${line.lineNumber} (kit ${await kitLabel(runner, orgId, line.itemId)}) ` +
          `cannot both return goods and have no goods returned — keep one or the other, not both`,
      );
    }
    const lineLabel = `document line ${line.lineNumber} (kit ${await kitLabel(runner, orgId, line.itemId)})`;
    const topEvidence = custom.inventoryReturn;
    if (isJsonRecord(topEvidence) && (topEvidence.lotId != null || topEvidence.serialId != null)) {
      throw new InventoryError(
        `${lineLabel} names a lot or serial on the kit; choose lots and serials per component in inventoryReturn.kitComponents instead`,
      );
    }
    const sources = parseKitComponentReturnSources(line.custom, lineLabel);
    const components = await loadKitComponents(runner, orgId, line.itemId, date);
    if (sources.length > components.length) {
      throw new InventoryError(
        `${lineLabel} names ${sources.length} source shipments ` +
          `but kit ${await kitLabel(runner, orgId, line.itemId)} has ${components.length} components ` +
          `effective on ${date}; return every component at most once`,
      );
    }
    const seenSources = new Set<string>();
    for (const source of sources) {
      if (seenSources.has(source.sourceIssueMovementId)) {
        throw new InventoryError(
          `${lineLabel} names source shipment ${source.sourceIssueMovementId} twice`,
        );
      }
      seenSources.add(source.sourceIssueMovementId);
    }
    const quantities = new Map(
      kitComponentQuantities(
        await kitLabel(runner, orgId, line.itemId),
        line.quantity,
        components,
      ).map((entry) => [entry.componentItemId, entry.quantity]),
    );
    const sourceByComponent = new Map<
      string,
      { sourceIssueMovementId: string; lotId: string | null; serialId: string | null }
    >();
    const usedComponents = new Set<string>();
    for (const source of sources) {
      // The source must be a component issue of THIS kit's own sale: its
      // document line carries the kit item, so a standalone sale of the
      // same component can never price this kit's return.
      const movement = (
        await runner.execute<{ item_id: string }>(
          sql`
        select movement.item_id
          from inventory_movements movement
          join document_lines source_line
            on source_line.id = movement.document_line_id
           and source_line.org_id = movement.org_id
         where movement.org_id = ${orgId} and movement.id = ${source.sourceIssueMovementId}
           and source_line.item_id = ${line.itemId}`,
          "objects",
        )
      )[0];
      if (!movement || !quantities.has(movement.item_id) || usedComponents.has(movement.item_id)) {
        throw new InventoryError(
          `${lineLabel} source shipment ${source.sourceIssueMovementId} is not an unclaimed component issue of this kit return`,
        );
      }
      usedComponents.add(movement.item_id);
      sourceByComponent.set(movement.item_id, source);
    }
    for (const component of components) {
      const source = sourceByComponent.get(component.componentItemId);
      if (!source) {
        // The sale never moved a non-stocked recipe line, so there is no
        // source to name and nothing to restore: it settles in money only.
        // A stocked component without a source is a half-return — refuse by
        // name instead of restoring its siblings and losing it.
        if (kitComponentMovesStock(component.componentKind)) {
          throw new InventoryError(
            `${lineLabel} names no source shipment for stocked component ` +
              `${await kitLabel(runner, orgId, component.componentItemId)}; return every stocked component together`,
          );
        }
        continue;
      }
      // The component's own tracking governs its return evidence: a tracked
      // component without its lot or serial is refused by the same source
      // validation as a direct return, before anything posts.
      const profile = await resolveProfile(orgId, component.componentItemId, runner);
      returns.push({
        ...line,
        itemId: component.componentItemId,
        itemKind: "kit-component",
        quantity: quantities.get(component.componentItemId)!,
        tracking: profile.tracking,
        kitItemId: line.itemId,
        selection: {
          sourceIssueMovementId: source.sourceIssueMovementId,
          lotId: source.lotId,
          serialId: source.serialId,
        },
      });
    }
  }
  return returns;
}

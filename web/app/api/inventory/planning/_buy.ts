import { DemandPlanningError, markBuySuggestionConverted, type DemandPlanningRefusalCode } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { createOrderDraft } from "@/lib/order-cycle";
import { applyOrderEdit, OrderEditError } from "@/lib/order-draft-edit";
import type { SessionUser } from "@/lib/auth";
import { orderEditServices } from "../../_order/handlers";

export interface BuyConvertLine {
  suggestionId: string;
  itemId: string;
  itemLabel: string;
  quantity: string;
  unit: string;
  stockLocationId: string;
  dueDate: string;
  runNumber: string;
}

interface BuyConvertAuth {
  user: SessionUser;
  allowedSubsidiaryIds: Set<string> | null;
  permissions: Set<string>;
}

/**
 * The order-edit refusal carries its own machine code, which is not a
 * planning code: only a code the planning surface defines passes through,
 * everything else becomes the generic order-edit refusal.
 */
function planningRefusalCode(code: unknown): DemandPlanningRefusalCode {
  return code === "vendor_required" || code === "transfer_locations_required" || code === "orders_disabled"
    ? code
    : "order_edit_refused";
}

/**
 * One supplier's purchase suggestions become one purchase-order draft: the
 * draft id is the group's first suggestion id, so a lost-response retry
 * replays the same draft instead of booking a second order, and each
 * suggestion is marked converted exactly once. Mirrors the manufacturing
 * planned-order purchase route, extended to several lines.
 */
export async function convertBuyGroup(
  auth: BuyConvertAuth,
  args: { subsidiaryId: string; supplierId: string; dueDate: string; lines: BuyConvertLine[] },
): Promise<{ id: string; suggestionIds: string[]; replayed: boolean }> {
  const draftId = args.lines[0]!.suggestionId;
  let draft: Awaited<ReturnType<typeof createOrderDraft>>;
  try {
    draft = await createOrderDraft(auth.user.orgId, auth.user.id, "purchase_order", draftId, args.subsidiaryId);
  } catch (error) {
    if (error instanceof Error && error.message === "Orders feature is disabled") {
      throw new DemandPlanningError("Orders are disabled.", "orders_disabled", "turn on Orders in Company Settings → Features", 409);
    }
    throw error;
  }
  if (!draft.replayed) {
    const revision = (await db.execute<{ updated_at: string }>(orderEditServices.platform.sql`
      select ${orderEditServices.platform.documentRevisionCounterSql(orderEditServices.platform.sql`revision_seq`)} as updated_at
        from documents where org_id=${auth.user.orgId} and id=${draft.id} and kind='purchase_order'
    `)).rows[0]?.updated_at;
    if (!revision) throw new Error("The purchase order draft revision could not be read.");
    try {
      const edited = await applyOrderEdit({
        orgId: auth.user.orgId,
        userId: auth.user.id,
        user: auth.user,
        allowedSubsidiaryIds: auth.allowedSubsidiaryIds,
        permissions: auth.permissions,
        services: orderEditServices,
      }, { kind: "purchase_order", readPerm: "ap.read", createPerm: "ap.create" }, draft.id, {
        expectedUpdatedAt: revision,
        partyId: args.supplierId,
        dueDate: args.dueDate,
        lines: args.lines.map((line) => ({
          itemId: line.itemId,
          quantity: line.quantity,
          unit: line.unit,
          stockLocationId: line.stockLocationId,
          description: `${line.itemLabel} for ${line.runNumber}`,
        })),
      });
      if (!edited.ok) {
        const refusal = await edited.json() as { error?: unknown; code?: unknown; remedy?: unknown };
        throw new DemandPlanningError(
          typeof refusal.error === "string" ? refusal.error : "Purchase order edit was refused.",
          planningRefusalCode(refusal.code),
          typeof refusal.remedy === "string" ? refusal.remedy : "correct the purchase order and retry",
          edited.status as 400 | 404 | 409 | 422,
        );
      }
    } catch (error) {
      if (error instanceof OrderEditError) {
        const refusal = typeof error.body === "object" && error.body !== null ? error.body as { code?: unknown; remedy?: unknown } : {};
        throw new DemandPlanningError(
          error.message,
          planningRefusalCode(refusal.code),
          typeof refusal.remedy === "string" ? refusal.remedy : "correct the purchase order and retry",
          error.status as 400 | 404 | 409 | 422,
        );
      }
      throw error;
    }
  }
  for (const line of args.lines) {
    await markBuySuggestionConverted(db, auth.user.orgId, auth.user.id, line.suggestionId, draft.id);
  }
  return { id: draft.id, suggestionIds: args.lines.map((line) => line.suggestionId), replayed: draft.replayed };
}

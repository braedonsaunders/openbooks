import "server-only";
import { can, type Authz } from "@/lib/authz";
import { createOrderDraft } from "@/lib/order-cycle";
import { applyOrderEdit, OrderEditError } from "@/lib/order-draft-edit";
import { orderEditServices } from "@/app/api/_order/handlers";
import { readPurchaseOrderRevisionToken } from "@openbooks/engine/records/document-revision-read";
import {
  ManufacturingError,
  ManufacturingNotFoundError,
} from "@openbooks/engine/manufacturing/errors";
import {
  convertPlannedOrder,
  getPlannedOrder,
  markBuyPlannedOrderConverted,
} from "@openbooks/engine/manufacturing/mrp";
import { db } from "@openbooks/engine/platform/db";
import { subsidiaryScopeAllows } from "@/lib/authz";

export type PlannedOrderConversionInput = {
  vendorId?: string;
  fromLocationId?: string;
  toLocationId?: string;
};

/** The route and application command share the same conversion and draft-edit path. */
export async function convertManufacturingPlannedOrder(
  authz: Authz,
  plannedOrderId: string,
  input: PlannedOrderConversionInput,
) {
  const orgId = authz.user.orgId;
  const actorId = authz.user.id;
  const suggestion = await getPlannedOrder(db, orgId, plannedOrderId, actorId);
  if (!subsidiaryScopeAllows(authz.allowedSubsidiaryIds, suggestion.subsidiaryId))
    throw new ManufacturingNotFoundError();
  if (suggestion.action !== "buy")
    return convertPlannedOrder(db, orgId, actorId, plannedOrderId, {
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
    });

  if (!can(authz, "purchase_orders.create"))
    throw new ManufacturingError("Missing required grant: purchase_orders.create.", {
      status: 403,
      code: "purchase_order_create_forbidden",
      remedy: "Ask an administrator to grant purchase_orders.create.",
    });
  if (suggestion.status === "converted" && suggestion.converted_ref_id)
    return { id: suggestion.converted_ref_id, action: "buy", replayed: true };
  if (!input.vendorId)
    throw new ManufacturingError("Choose a vendor for this purchase suggestion.", {
      status: 400,
      code: "mrp_vendor_required",
      remedy: "choose a vendor before converting the suggestion",
    });
  if (!suggestion.base_unit)
    throw new ManufacturingError("This item has no inventory unit configured.", {
      status: 409,
      code: "mrp_item_not_stocked",
      remedy: "add an inventory costing profile with a base unit",
    });

  let draft: Awaited<ReturnType<typeof createOrderDraft>>;
  try {
    draft = await createOrderDraft(
      orgId,
      actorId,
      "purchase_order",
      suggestion.id,
      suggestion.subsidiaryId,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Orders feature is disabled")
      throw new ManufacturingError("Orders are disabled.", {
        status: 409,
        code: "orders_disabled",
        remedy: "turn on Orders in Company Settings → Features",
      });
    throw error;
  }

  const revision = await readPurchaseOrderRevisionToken(db, orgId, draft.id);
  if (!revision) throw new Error("The purchase order draft revision could not be read.");
  try {
    const edited = await applyOrderEdit(
      {
        orgId,
        userId: actorId,
        user: authz.user,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        permissions: authz.permissions,
        services: orderEditServices,
      },
      {
        kind: "purchase_order",
        readPerm: "purchase_orders.read",
        createPerm: "purchase_orders.create",
      },
      draft.id,
      {
        expectedUpdatedAt: revision,
        partyId: input.vendorId,
        dueDate: suggestion.due_date,
        lines: [
          {
            itemId: suggestion.item_id,
            quantity: suggestion.quantity,
            unit: suggestion.base_unit,
            description: `${suggestion.item_code?.trim() || suggestion.item_name} for MRP run ${suggestion.run_number}`,
          },
        ],
      },
    );
    if (!edited.ok) {
      const refusal = (await edited.json()) as {
        error?: unknown;
        code?: unknown;
        remedy?: unknown;
      };
      throw new ManufacturingError(
        typeof refusal.error === "string" ? refusal.error : "Purchase order edit was refused.",
        {
          status: edited.status,
          code: typeof refusal.code === "string" ? refusal.code : "order_edit_refused",
          remedy: typeof refusal.remedy === "string" ? refusal.remedy : undefined,
        },
      );
    }
  } catch (error) {
    if (error instanceof OrderEditError) {
      const refusal =
        typeof error.body === "object" && error.body !== null
          ? (error.body as { code?: unknown; remedy?: unknown })
          : {};
      throw new ManufacturingError(error.message, {
        status: error.status,
        code: typeof refusal.code === "string" ? refusal.code : "order_edit_refused",
        remedy: typeof refusal.remedy === "string" ? refusal.remedy : undefined,
      });
    }
    throw error;
  }

  return markBuyPlannedOrderConverted(db, orgId, actorId, plannedOrderId, draft.id);
}

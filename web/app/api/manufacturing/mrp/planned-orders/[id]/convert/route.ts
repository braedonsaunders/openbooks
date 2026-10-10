import { z } from "zod";
import { convertPlannedOrder, getPlannedOrder, markBuyPlannedOrderConverted } from "@openbooks/engine/src/manufacturing/mrp.ts";
import { ManufacturingError } from "@openbooks/engine/src/manufacturing/errors.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { can, guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { createOrderDraft } from "@/lib/order-cycle";
import { applyOrderEdit, OrderEditError } from "@/lib/order-draft-edit";
import { orderEditServices } from "../../../../../_order/handlers";
import { manufacturingTransaction } from "../../../../_transaction";

const Params = z.object({ id: z.string().uuid() });
// Make suggestions derive their work order from the saved plan. Buy and
// transfer suggestions still require their vendor or locations in the service.
const Body = z.union([
  z.object({}).strict().transform(() => ({ fromLocationId: undefined, toLocationId: undefined, vendorId: undefined })),
  z.object({ vendorId: z.string().uuid(), fromLocationId: z.string().uuid().optional(), toLocationId: z.string().uuid().optional() }).strict(),
  z.object({ fromLocationId: z.string().uuid(), toLocationId: z.string().uuid().optional(), vendorId: z.string().uuid().optional() }).strict(),
  z.object({ toLocationId: z.string().uuid(), fromLocationId: z.string().uuid().optional(), vendorId: z.string().uuid().optional() }).strict(),
], { error: "Send an empty object for the saved plan, or valid location/vendor identifiers." });

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturingMrp", params: Params, body: Body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const suggestion = await getPlannedOrder(db, authz.user.orgId, params.id,authz.user.id);
    const denied = guardSubsidiaryScope(authz, suggestion.subsidiaryId);
    if (denied) return denied;
    if (suggestion.action === "buy") {
      if (!can(authz, "purchase_orders.create")) {
        return Response.json({ error: "forbidden", permission: "purchase_orders.create", message: "Missing required grant: purchase_orders.create." }, { status: 403 });
      }
      if (suggestion.status === "converted" && suggestion.converted_ref_id) {
        return Response.json({ id: suggestion.converted_ref_id, action: "buy", replayed: true }, { status: 200 });
      }
      if (!body.vendorId) {
        throw new ManufacturingError("Choose a vendor for this purchase suggestion.", {
          status: 400, code: "mrp_vendor_required", remedy: "choose a vendor before converting the suggestion",
        });
      }
      if (!suggestion.base_unit) {
        throw new ManufacturingError("This item has no inventory unit configured.", {
          status: 409, code: "mrp_item_not_stocked", remedy: "add an inventory costing profile with a base unit",
        });
      }
      let draft: Awaited<ReturnType<typeof createOrderDraft>>;
      try {
        draft = await createOrderDraft(authz.user.orgId, authz.user.id, "purchase_order", suggestion.id, suggestion.subsidiaryId);
      } catch (error) {
        if (error instanceof Error && error.message === "Orders feature is disabled") {
          throw new ManufacturingError("Orders are disabled.", {
            status: 409, code: "orders_disabled", remedy: "turn on Orders in Company Settings → Features",
          });
        }
        throw error;
      }
      const revision = (await db.execute<{ updated_at: string }>(orderEditServices.platform.sql`
        select ${orderEditServices.platform.documentRevisionCounterSql(orderEditServices.platform.sql`revision_seq`)} as updated_at
          from documents where org_id=${authz.user.orgId} and id=${draft.id} and kind='purchase_order'
      `)).rows[0]?.updated_at;
      if (!revision) throw new Error("The purchase order draft revision could not be read.");
      try {
        const edited = await applyOrderEdit({
          orgId: authz.user.orgId,
          userId: authz.user.id,
          user: authz.user,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          permissions: authz.permissions,
          services: orderEditServices,
        }, { kind: "purchase_order", readPerm: "purchase_orders.read", createPerm: "purchase_orders.create" }, draft.id, {
          expectedUpdatedAt: revision,
          partyId: body.vendorId,
          dueDate: suggestion.due_date,
          lines: [{
            itemId: suggestion.item_id,
            quantity: suggestion.quantity,
            unit: suggestion.base_unit,
            description: `${suggestion.item_code?.trim() || suggestion.item_name} for MRP run ${suggestion.run_number}`,
          }],
        });
        if (!edited.ok) {
          const refusal = await edited.json() as { error?: unknown; code?: unknown; remedy?: unknown };
          throw new ManufacturingError(typeof refusal.error === "string" ? refusal.error : "Purchase order edit was refused.", {
            status: edited.status,
            code: typeof refusal.code === "string" ? refusal.code : "order_edit_refused",
            remedy: typeof refusal.remedy === "string" ? refusal.remedy : undefined,
          });
        }
      } catch (error) {
        if (error instanceof OrderEditError) {
          const refusal = typeof error.body === "object" && error.body !== null ? error.body as { code?: unknown; remedy?: unknown } : {};
          throw new ManufacturingError(error.message, {
            status: error.status,
            code: typeof refusal.code === "string" ? refusal.code : "order_edit_refused",
            remedy: typeof refusal.remedy === "string" ? refusal.remedy : undefined,
          });
        }
        throw error;
      }
      const result = await markBuyPlannedOrderConverted(db, authz.user.orgId, authz.user.id, params.id, draft.id);
      return Response.json(result, { status: result.replayed ? 200 : 201 });
    }
    const result = await convertPlannedOrder(db, authz.user.orgId, authz.user.id, params.id, body);
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  }),
});

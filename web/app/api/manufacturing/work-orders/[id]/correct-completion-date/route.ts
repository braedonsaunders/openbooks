import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { isoDate } from "@/lib/api/json";
import {
  correctWorkOrderCompletionDate,
  executeManufacturingCompletionDateCorrection,
} from "@openbooks/engine/manufacturing/execution";
import { db } from "@openbooks/engine/platform/db";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";
import { loadScopedWorkOrder } from "../../_scope";

const Params = z.object({ id: uuidString() });
const Body = z
  .object({
    correctedOn: isoDate(),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

/** Re-date a completed work order's finished-goods receipts to the day production finished. */
export const POST = defineRoute({
  permission: "items.post",
  feature: "manufacturing",
  params: Params,
  body: Body,
  handler: async ({ request, authz, params, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      if (!can(authz, "manufacturing.manage")) {
        return Response.json(
          { error: "missing permission: manufacturing.manage" },
          { status: 403 },
        );
      }
      const scoped = await loadScopedWorkOrder(authz, params.id);
      if (!scoped.ok) return scoped.response;
      const key = request.headers.get("Idempotency-Key");
      if (key) {
        const result = await executeManufacturingCompletionDateCorrection(
          authz.user.orgId,
          authz.user.id,
          authz.allowedSubsidiaryIds,
          params.id,
          key,
          body,
        );
        return Response.json(result.value, {
          headers: { "Idempotency-Replayed": String(result.replayed) },
        });
      }
      return Response.json(
        await correctWorkOrderCompletionDate(db, authz.user.orgId, authz.user.id, params.id, body),
      );
    }),
});

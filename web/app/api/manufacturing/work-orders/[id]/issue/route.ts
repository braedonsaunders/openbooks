import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { isoDate } from "@/lib/api/json";
import { issueMaterials } from "@openbooks/engine/manufacturing/materials";
import { executeManufacturingIssue } from "@openbooks/engine/manufacturing/execution";
import { db } from "@openbooks/engine/platform/db";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";
import { loadScopedWorkOrder } from "../../_scope";

const Params = z.object({ id: uuidString() });
const Body = z
  .object({
    lines: z
      .array(
        z
          .object({
            materialId: uuidString(),
            quantity: z.string(),
            lotId: uuidString().nullable().optional(),
            serialId: uuidString().nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    issuedOn: isoDate().nullable().optional(),
  })
  .strict();

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
      const result = await loadScopedWorkOrder(authz, params.id);
      if (!result.ok) return result.response;
      const key = request.headers.get("Idempotency-Key");
      if (key) {
        const result = await executeManufacturingIssue(
          authz.user.orgId,
          authz.user.id,
          authz.allowedSubsidiaryIds,
          params.id,
          key,
          body.lines,
          body.issuedOn ?? null,
        );
        return Response.json(result.value, {
          headers: { "Idempotency-Replayed": String(result.replayed) },
        });
      }
      return Response.json(
        await issueMaterials(db, authz.user.orgId, authz.user.id, params.id, body.lines, {
          issuedOn: body.issuedOn ?? null,
        }),
      );
    }),
});

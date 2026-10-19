import { createNormalizationRequest } from "@openbooks/engine/billing/metrics/metrics-normalization-service";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

const Body = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/),
    reason: z.string().min(1),
    idempotencyKey: uuidString(),
  })
  .strict();

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "saasMetrics",
  scope: "unrestricted",
  body: Body,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const outcome = await createNormalizationRequest({
      orgId: authz.user.orgId,
      month: body.month,
      reason: body.reason,
      requestedBy: authz.user.id,
      idempotencyKey: body.idempotencyKey,
    });
    return Response.json(outcome, { status: outcome.created ? 201 : 200 });
  },
});

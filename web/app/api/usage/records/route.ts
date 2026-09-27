import { ingestUsageRecords, listUsageRecords } from "@openbooks/engine/src/billing/usage/records.ts";
import { defineRoute } from "@/lib/api/route";
import { created } from "@/lib/api/responses";
import { z } from "zod";

const Query = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  meterId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict();
const RecordInput = z.object({
  meterKey: z.string().trim().min(1),
  customerId: z.string().uuid(),
  subscriptionId: z.string().uuid().nullable().optional(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  quantity: z.string(),
  distinctKey: z.string().nullable().optional(),
  source: z.enum(["api", "import", "connector_stripe", "manual"]),
  sourceRef: z.string().nullable().optional(),
  idempotencyKey: z.string().trim().min(1),
}).strict();
const Body = z.object({ records: z.array(RecordInput).min(1).max(500) }).strict();

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  handler: async ({ request, authz }) => {
    const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "Invalid usage record filters" }, { status: 400 });
    return Response.json(await listUsageRecords(authz.user.orgId, parsed.data, authz.allowedSubsidiaryIds));
  },
});

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  body: Body,
  handler: async ({ authz, body }) => created({ records: await ingestUsageRecords(
    authz.user.orgId,
    authz.user.id,
    body.records,
    authz.allowedSubsidiaryIds,
  ) }),
});

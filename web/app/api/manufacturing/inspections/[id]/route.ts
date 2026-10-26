import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { readManufacturingInspection } from "@openbooks/engine/manufacturing/quality-workspace";
import { recordQualityInspection } from "@openbooks/engine/manufacturing/quality-execution";
import { disposeQualityInspection } from "@openbooks/engine/manufacturing/quality-disposition";
const params = z.object({ id: uuidString() }).strict();
export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturing",
  params,
  handler: async ({ authz, params }) =>
    withOrgTransaction(authz.user.orgId, async () =>
      Response.json(
        await readManufacturingInspection(db, authz.user.orgId, authz.user.id, params.id),
      ),
    ),
});
const body = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("inspect"),
      outcome: z.enum(["pass", "fail"]),
      measurements: z.record(z.string(), z.string()),
      reason: z.string().trim().min(5).max(500),
      quantity: z.string().optional(),
      lotId: uuidString().nullable().optional(),
      serialId: uuidString().nullable().optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("dispose"),
      action: z.enum(["use_as_is", "scrap", "rework"]),
      reason: z.string().trim().min(5).max(500),
      requestKey: uuidString(),
      scrapReasonId: uuidString().optional(),
      reworkRoutingId: uuidString().optional(),
      reworkSequence: z.number().int().positive().optional(),
    })
    .strict(),
]);
export const POST = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params,
  body,
  handler: async ({ authz, params, body }) =>
    withOrgTransaction(authz.user.orgId, async () => {
      const value =
        body.command === "inspect"
          ? await recordQualityInspection(db, authz.user.orgId, authz.user.id, params.id, body)
          : await disposeQualityInspection(db, authz.user.orgId, authz.user.id, params.id, body);
      return Response.json(value);
    }),
});

import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import {
  getRouting,
  updateRouting,
  type RoutingInput,
} from "@openbooks/engine/manufacturing/routings";
import { guardRoutingSubsidiaryScope } from "../../_scope";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { manufacturingTransaction } from "../../_transaction";

const Params = z.object({ id: uuidString() });
const Patch = z
  .object({
    code: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    effectiveFrom: z.string().optional(),
    effectiveTo: z.string().nullable().optional(),
    defaultIssueLocationId: uuidString().nullable().optional(),
    defaultReceiptLocationId: uuidString().nullable().optional(),
    overheadBasis: z.enum(["labor_hours", "machine_hours", "units"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturing",
  params: Params,
  handler: async ({ authz, params }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const row = await getRouting(db, authz.user.orgId, params.id);
      if (!row) return notFound("routing");
      const denied = guardRoutingSubsidiaryScope(authz, row);
      return denied ?? Response.json(row);
    }),
});

export const PATCH = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params: Params,
  body: Patch,
  handler: async ({ authz, params, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const current = await getRouting(db, authz.user.orgId, params.id);
      if (!current) return notFound("routing");
      const denied = guardRoutingSubsidiaryScope(authz, current);
      if (denied) return denied;
      return Response.json(
        await updateRouting(
          db,
          authz.user.orgId,
          authz.user.id,
          params.id,
          body as Partial<RoutingInput>,
        ),
      );
    }),
});

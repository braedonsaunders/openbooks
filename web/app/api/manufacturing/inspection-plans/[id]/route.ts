import { defineRoute } from "@/lib/api/route";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { saveInspectionPlan } from "@openbooks/engine/inventory/inspections";
import { InspectionPlanBody } from "../contract";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  scope: "unrestricted",
  feature: "manufacturing",
  params: z.object({ id: uuidString() }).strict(),
  body: InspectionPlanBody.extend({ expectedRevision: z.number().int().positive() }),
  handler: async ({ authz, body, params }) =>
    withOrgTransaction(authz.user.orgId, async () =>
      Response.json(
        await saveInspectionPlan(db, authz.user.orgId, authz.user.id, { ...body, id: params.id }),
      ),
    ),
});

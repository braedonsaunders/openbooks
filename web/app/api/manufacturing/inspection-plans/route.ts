import { defineRoute } from "@/lib/api/route";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { saveInspectionPlan } from "@openbooks/engine/inventory/inspections";
import { InspectionPlanBody } from "./contract";
import { uuidString } from "@openbooks/engine/platform/identifiers";
export const POST = defineRoute({
  permission: "admin.setup.manage",
  scope: "unrestricted",
  feature: "manufacturing",
  body: InspectionPlanBody,
  handler: async ({ request, authz, body }) => {
    const id = uuidString().parse(request.headers.get("Idempotency-Key"));
    return withOrgTransaction(authz.user.orgId, async () =>
      Response.json(
        await saveInspectionPlan(db, authz.user.orgId, authz.user.id, { ...body, id }),
        { status: 201 },
      ),
    );
  },
});

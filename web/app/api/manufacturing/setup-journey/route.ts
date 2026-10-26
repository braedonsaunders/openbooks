import { db } from "@openbooks/engine/platform/db";
import { readOperatingSetupJourney } from "@openbooks/engine/manufacturing/setup-journey";
import { defineRoute } from "@/lib/api/route";
import { SetupJourneyBody } from "../../operating-profiles/setup-journey/contract";
import { manufacturingTransaction } from "../_transaction";

export const POST = defineRoute({
  permission: "admin.setup.manage",
  scope: "unrestricted",
  feature: "manufacturing",
  body: SetupJourneyBody,
  handler: ({ authz, body }) =>
    manufacturingTransaction(authz.user.orgId, async () =>
      Response.json(await readOperatingSetupJourney(db, authz.user.orgId, authz.user.id, body)),
    ),
});

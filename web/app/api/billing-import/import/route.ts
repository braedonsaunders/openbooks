import { runBillingImportById } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";
import { billingImportByIdBody } from "@/lib/billing-import-schemas";

export const POST = defineRoute({
  permission: "sync.run",
  feature: "billingHistoryImport",
  scope: "unrestricted",
  body: billingImportByIdBody,
  handler: async ({ authz, body }) =>
    Response.json(await runBillingImportById(authz.user.orgId, authz.user.id, body.runId)),
});

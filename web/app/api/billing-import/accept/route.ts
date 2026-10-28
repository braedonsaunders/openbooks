import { acceptBillingImportRun, type BillingImportConfig } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";
import { acceptBillingImportBody } from "@/lib/billing-import-schemas";

export const POST = defineRoute({
  permission: "sync.run",
  feature: "billingHistoryImport",
  scope: "unrestricted",
  body: acceptBillingImportBody,
  handler: async ({ authz, body }) =>
    Response.json(
      await acceptBillingImportRun(
        authz.user.orgId,
        authz.user.id,
        body.runId,
        body.config as Partial<BillingImportConfig>,
      ),
    ),
});

import { listBillingImportMappingOptions } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";

export const GET = defineRoute({
  permission: "sync.run",
  feature: "billingHistoryImport",
  scope: "unrestricted",
  handler: async ({ authz }) =>
    Response.json(await listBillingImportMappingOptions(authz.user.orgId)),
});

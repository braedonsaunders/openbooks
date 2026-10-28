import { runBillingPreflight, type BillingHistoryProvider } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";
import { billingPreflightBody } from "@/lib/billing-import-schemas";

export const POST = defineRoute({
  permission: "sync.run",
  feature: "billingHistoryImport",
  scope: "unrestricted",
  body: billingPreflightBody,
  handler: async ({ authz, body }) =>
    Response.json(
      await runBillingPreflight(
        authz.user.orgId,
        authz.user.id,
        body.provider as BillingHistoryProvider,
        body.externalAccount,
        body.site ? { apiKey: body.apiKey, site: body.site } : { apiKey: body.apiKey },
        {},
      ),
    ),
});

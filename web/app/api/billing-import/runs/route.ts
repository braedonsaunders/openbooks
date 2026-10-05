import { listBillingImportRuns, type BillingHistoryProvider } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";

const PROVIDERS = new Set(["chargebee", "recurly", "maxio", "zuora"]);

export const GET = defineRoute({
  permission: "sync.run",
  feature: "billingHistoryImport",
  handler: async ({ request, authz }) => {
    const provider = new URL(request.url).searchParams.get("provider");
    if (provider !== null && !PROVIDERS.has(provider)) {
      return Response.json({ error: "unknown billing provider" }, { status: 400 });
    }
    return Response.json(await listBillingImportRuns(
      authz.user.orgId,
      (provider ?? undefined) as BillingHistoryProvider | undefined,
    ));
  },
});

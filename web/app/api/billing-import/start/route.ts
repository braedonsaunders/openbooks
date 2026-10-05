import { runBillingPreflight } from "@openbooks/engine/src/sync/billing-history-import.ts";
import type { BillingHistoryProvider } from "@openbooks/engine/src/sync/billing-history-import.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Body = z.object({
  provider: z.enum(["chargebee", "recurly", "maxio", "zuora"]),
  externalAccount: z.string().min(1),
  apiKey: z.string().min(1),
  site: z.string().min(1).nullish(),
}).strict();

export const POST = defineRoute({
  permission: "sync.run",
  feature: "billingHistoryImport",
  body: Body,
  handler: async ({ authz, body }) => Response.json(await runBillingPreflight(
    authz.user.orgId,
    authz.user.id,
    body.provider as BillingHistoryProvider,
    body.externalAccount,
    body.site ? { apiKey: body.apiKey, site: body.site } : { apiKey: body.apiKey },
    {},
  )),
});

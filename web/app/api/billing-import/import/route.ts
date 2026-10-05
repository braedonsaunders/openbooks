import { runBillingImportById } from "@openbooks/engine/src/sync/billing-history-import.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Body = z.object({
  runId: z.string().uuid(),
}).strict();

export const POST = defineRoute({
  permission: "sync.run",
  feature: "billingHistoryImport",
  body: Body,
  handler: async ({ authz, body }) => Response.json(await runBillingImportById(
    authz.user.orgId,
    authz.user.id,
    body.runId,
  )),
});

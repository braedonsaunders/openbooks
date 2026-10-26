import { runBillingImportById } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

const Body = z
  .object({
    runId: uuidString(),
  })
  .strict();

export const POST = defineRoute({
  permission: "sync.run",
  feature: "billingHistoryImport",
  scope: "unrestricted",
  body: Body,
  handler: async ({ authz, body }) =>
    Response.json(await runBillingImportById(authz.user.orgId, authz.user.id, body.runId)),
});

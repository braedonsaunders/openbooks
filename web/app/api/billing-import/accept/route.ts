import { acceptBillingImportRun, type BillingImportConfig } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

const Config = z
  .object({
    mode: z.enum(["post_historical", "opening_balances"]).optional(),
    cutoverOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullish(),
    historyDepthMonths: z.number().int().positive().nullish(),
    incomeAccountId: uuidString().nullish(),
    clearingAccountId: uuidString().nullish(),
    taxCodeId: uuidString().nullish(),
    planMap: z.record(z.string(), uuidString()).optional(),
    customerMap: z.record(z.string(), uuidString()).optional(),
    autoSync: z.boolean().optional(),
  })
  .strict();

const Body = z
  .object({
    runId: uuidString(),
    config: Config,
  })
  .strict();

export const POST = defineRoute({
  permission: "sync.run",
  feature: "billingHistoryImport",
  scope: "unrestricted",
  body: Body,
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

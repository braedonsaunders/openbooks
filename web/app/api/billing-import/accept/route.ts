import {
  acceptBillingImportRun,
  type BillingImportConfig,
} from "@openbooks/engine/src/sync/billing-history-import.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Config = z.object({
  mode: z.enum(["post_historical", "opening_balances"]).optional(),
  cutoverOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  historyDepthMonths: z.number().int().positive().nullish(),
  incomeAccountId: z.string().uuid().nullish(),
  clearingAccountId: z.string().uuid().nullish(),
  taxCodeId: z.string().uuid().nullish(),
  planMap: z.record(z.string(), z.string().uuid()).optional(),
  customerMap: z.record(z.string(), z.string().uuid()).optional(),
  autoSync: z.boolean().optional(),
}).strict();

const Body = z.object({
  runId: z.string().uuid(),
  config: Config,
}).strict();

export const POST = defineRoute({
  permission: "sync.run",
  feature: "billingHistoryImport",
  body: Body,
  handler: async ({ authz, body }) => Response.json(await acceptBillingImportRun(
    authz.user.orgId,
    authz.user.id,
    body.runId,
    body.config as Partial<BillingImportConfig>,
  )),
});

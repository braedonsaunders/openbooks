import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { runScheduledJournalReversals } from "@openbooks/engine/ledger/journal-reversals";
import { isoDate } from "@/lib/api/json";
export const POST = defineRoute({
  permission: "gl.post",
  feature: { none: "Approved journal reversals are a core accounting lifecycle." },
  body: z.object({ action: z.literal("run_due"), asOf: isoDate().optional() }).strict(),
  handler: async ({ body, authz }) =>
    Response.json(
      await runScheduledJournalReversals({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        asOf: body.asOf,
      }),
    ),
});

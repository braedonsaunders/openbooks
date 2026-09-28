import { voidAndRebillRateRun } from "@openbooks/engine/src/billing/usage/rate-run.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Params = z.object({ id: z.string().uuid() }).strict();
// An empty command uses the service's recorded "Usage rating inputs changed"
// reason; a supplied reason must be usable audit evidence.
const Body = z.union([
  z.object({}).strict().transform(() => ({ reason: undefined })),
  z.object({ reason: z.string().trim().min(1, "Enter a reason for the void and rebill.").max(1000, "Keep the void and rebill reason within 1000 characters.") }).strict(),
], { error: "Send an empty object for the standard rebill reason, or a nonblank reason of at most 1000 characters." });

export const POST = defineRoute({
  permission: "usage.bill",
  feature: "usageBilling",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => Response.json(await voidAndRebillRateRun(
    authz.user.orgId,
    authz.user.id,
    params.id,
    body.reason,
    authz.allowedSubsidiaryIds,
  )),
});

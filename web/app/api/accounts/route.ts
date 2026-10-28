import { defineRoute } from "@/lib/api/route";
import { createAccountAction, createAccountBodySchema } from "@/lib/accounts/create-action";

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "gl.manage",
  feature: {
    none: "Chart of accounts setup is always available and is governed by account permissions.",
  },
  body: createAccountBodySchema,
  handler: createAccountAction,
});

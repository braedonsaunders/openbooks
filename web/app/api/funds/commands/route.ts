import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createFund } from "@openbooks/engine/nonprofit/funds";

export const runtime = "nodejs";

const fundCommandBody = z.strictObject({
  action: z.literal("create"),
  code: z.string(),
  name: z.string(),
  kind: z.enum(["operating", "restricted", "endowment", "plant", "board_designated"]),
  restrictionClass: z.string(),
  budgetaryControl: z.enum(["off", "advisory", "hard"]),
});

export const POST = defineRoute({
  permission: "funds.manage",
  feature: "fundAccounting",
  scope: "unrestricted",
  body: fundCommandBody,
  handler: async ({ authz, body }) => {
    const { action: _action, ...fields } = body;
    const fund = await createFund({ ...fields, orgId: authz.user.orgId, actorId: authz.user.id });
    return NextResponse.json({ ok: true, fund }, { status: 201 });
  },
});

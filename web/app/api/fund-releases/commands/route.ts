import { defineRoute } from "@/lib/api/route";
import { uuidId } from "../../../../lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createFundRelease } from "@openbooks/engine/nonprofit/releases";

export const runtime = "nodejs";

const releaseCommandBody = z.strictObject({
  action: z.literal("create"),
  fromFundId: uuidId,
  toFundId: uuidId,
  releaseAccountId: uuidId,
  releaseDate: z.string(),
  amount: z.string(),
  purpose: z.string(),
  satisfactionRef: z.string(),
});

export const POST = defineRoute({
  permission: "funds.manage",
  feature: "fundAccounting",
  scope: "unrestricted",
  body: releaseCommandBody,
  handler: async ({ authz, body }) => {
    const { action: _action, ...fields } = body;
    const release = await createFundRelease({
      ...fields,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
    });
    return NextResponse.json({ ok: true, release }, { status: 201 });
  },
});

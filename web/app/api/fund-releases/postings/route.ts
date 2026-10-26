import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { guardPermission } from "../../../../lib/authz";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { z } from "zod";
import { submitFundRelease, voidFundRelease } from "@openbooks/engine/nonprofit/releases";

export const runtime = "nodejs";

const postingBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("submit"), releaseId: uuidString() }),
  z.strictObject({
    action: z.literal("void"),
    releaseId: uuidString(),
    voidDate: z.string(),
    reason: z.string(),
  }),
]);

export const POST = defineRoute({
  authorize: async () => {
    const manage = await guardPermission("funds.manage");
    if (manage instanceof Response)
      return NextResponse.json(await manage.json(), { status: manage.status });
    const post = await guardPermission("gl.post");
    if (post instanceof Response)
      return NextResponse.json(await post.json(), { status: post.status });
    return post;
  },
  feature: "fundAccounting",
  scope: "unrestricted",
  body: postingBody,
  handler: async ({ authz, body }) => {
    const orgId = authz.user.orgId;
    const actorId = authz.user.id;
    if (body.action === "submit") {
      const release = await submitFundRelease({ orgId, releaseId: body.releaseId, actorId });
      return NextResponse.json({ ok: true, release });
    }
    const release = await voidFundRelease({
      orgId,
      releaseId: body.releaseId,
      actorId,
      voidDate: body.voidDate,
      reason: body.reason,
    });
    return NextResponse.json({ ok: true, release });
  },
});

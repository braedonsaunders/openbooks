import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import { EXTERNAL_LINK_OBJECT_TYPES } from "@openbooks/schema";
import {
  CommerceError,
  getChannel,
  linkExternal,
  listExternalLinks,
  unlinkExternal,
} from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const linkBodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("link"),
    objectType: z.enum(EXTERNAL_LINK_OBJECT_TYPES),
    externalId: z.string().trim().min(1).max(200),
    externalParentId: z.string().trim().min(1).max(200).nullish(),
    nativeTable: z.string().trim().min(1),
    nativeId: z.string().uuid(),
  }),
  z.strictObject({
    action: z.literal("unlink"),
    objectType: z.enum(EXTERNAL_LINK_OBJECT_TYPES),
    externalId: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1),
  }),
]);

function notFoundWhenMissing(error: unknown) {
  if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
  throw error;
}

export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const objectType = new URL(request.url).searchParams.get("objectType") ?? "";
    if (!(EXTERNAL_LINK_OBJECT_TYPES as readonly string[]).includes(objectType)) {
      return NextResponse.json(
        { error: "objectType_required", remedy: `Choose one of ${EXTERNAL_LINK_OBJECT_TYPES.join(", ")}.` },
        { status: 422 },
      );
    }
    try {
      const channel = await getChannel(gate.user.orgId, id);
      const links = await listExternalLinks(gate.user.orgId, {
        provider: channel.kind,
        externalAccount: channel.externalAccount,
        objectType,
      });
      return NextResponse.json({ links });
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});

export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: linkBodySchema,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      const channel = await getChannel(gate.user.orgId, id);
      const key = { provider: channel.kind, externalAccount: channel.externalAccount };
      if (body.action === "unlink") {
        await unlinkExternal(
          gate.user.orgId,
          gate.user.id,
          { ...key, objectType: body.objectType, externalId: body.externalId },
          body.reason,
          "salesChannels",
        );
        return NextResponse.json({ unlinked: true });
      }
      const link = await linkExternal(
        gate.user.orgId,
        gate.user.id,
        {
          channelId: id,
          provider: key.provider,
          externalAccount: key.externalAccount,
          objectType: body.objectType,
          externalId: body.externalId,
          externalParentId: body.externalParentId ?? null,
          nativeTable: body.nativeTable,
          nativeId: body.nativeId,
        },
        "salesChannels",
      );
      return NextResponse.json({ link });
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});

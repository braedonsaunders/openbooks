import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import { setPostingPolicy } from "@openbooks/engine/src/commerce/posting-policies.ts";
import { CommerceError } from "@openbooks/engine/src/commerce/errors.ts";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const policyBodySchema = z.strictObject({
  mode: z.enum(["per_order", "daily_summary"]),
  unpaidCreatesSalesOrder: z.boolean().optional(),
  guestCustomerPartyId: z.string().uuid().nullable().optional(),
  createPromotionOnMatchMiss: z.boolean().optional(),
  cutoffTz: z.string().max(60).optional(),
  excludedTags: z.array(z.string().max(120)).optional(),
  excludedSources: z.array(z.string().max(120)).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "effectiveFrom must be YYYY-MM-DD"),
});

/**
 * Write a new effective-dated posting policy for the channel. The prior
 * open row closes the day before, so orders already posted keep their
 * documents and the switch never reinterprets history.
 */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: policyBodySchema,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      const policy = await setPostingPolicy(gate.user.orgId, gate.user.id, {
        channelId: id,
        mode: body.mode,
        unpaidCreatesSalesOrder: body.unpaidCreatesSalesOrder,
        guestCustomerPartyId: body.guestCustomerPartyId,
        createPromotionOnMatchMiss: body.createPromotionOnMatchMiss,
        cutoffTz: body.cutoffTz,
        excludedTags: body.excludedTags,
        excludedSources: body.excludedSources,
        effectiveFrom: body.effectiveFrom,
      });
      return NextResponse.json({ effectiveFrom: policy.effectiveFrom, mode: policy.mode });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") {
        return notFound("channel");
      }
      throw error;
    }
  },
});

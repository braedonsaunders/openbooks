import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CommerceError,
  decimalToMinorUnits,
  minorUnitsForCurrency,
  recordChannelAdSpend,
} from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const adSpendBodySchema = z.strictObject({
  spendDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMajor: z.string().regex(/^\d+(\.\d{1,4})?$/),
  currency: z.string().trim().min(3).max(3),
  source: z.string().trim().max(120).nullish(),
});

/**
 * Record one day's marketing spend for a channel from its ad platform
 * export. Idempotent by channel, day and source: re-importing the same
 * source replaces its figure, and that day's orders restate with CM3.
 */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: adSpendBodySchema,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      const currency = body.currency.trim().toUpperCase();
      const minorUnits = await minorUnitsForCurrency(currency);
      const amountMinor = decimalToMinorUnits(body.amountMajor, minorUnits);
      const { spendId } = await recordChannelAdSpend(gate.user.orgId, gate.user.id, {
        channelId: id,
        spendDate: body.spendDate,
        amountMinor,
        currency,
        source: body.source?.trim() ? body.source.trim() : "manual",
      });
      return NextResponse.json({ spendId });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") {
        return notFound("channel");
      }
      throw error;
    }
  },
});

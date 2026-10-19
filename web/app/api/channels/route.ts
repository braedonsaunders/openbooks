import { defineRoute } from "@/lib/api/route";
import { created } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { sql } from "drizzle-orm";
import {
  channelAttention,
  createChannel,
  listChannels,
  registeredChannelKinds,
} from "@openbooks/engine/commerce";
import { businessToday, businessTimeZone } from "@openbooks/engine/platform/business-date/module";
import { db } from "@openbooks/engine/platform/database";
import { channelAssignmentRefusal, channelsInScope } from "@/lib/channel-scope";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";

export const runtime = "nodejs";

const createBodySchema = z.strictObject({
  kind: z.string().trim().min(1),
  name: z.string().trim().min(1),
  subsidiaryId: uuidString().nullish(),
  currency: z.string().trim().min(3).max(3),
  externalAccount: z.string().trim().min(1),
  secrets: z.record(z.string(), z.json()).nullish(),
  webhookSecret: z.string().trim().min(1).nullish(),
  settings: z.record(z.string(), z.json()).nullish(),
});

export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  handler: async ({ authz: gate }) => {
    // Channels assigned to a subsidiary outside the caller's scope stay hidden.
    const orgId = gate.user.orgId;
    const [channelRows, attention, today, timeZone] = await Promise.all([
      listChannels(orgId),
      channelAttention(orgId),
      businessToday(orgId),
      businessTimeZone(orgId),
    ]);
    const channels = channelsInScope(gate, channelRows);
    const orderScope = subsidiaryVisibleFilter(sql`c.subsidiary_id`, gate.allowedSubsidiaryIds);
    const ordersToday = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count
        from channel_orders o
        join sales_channels c on c.org_id = o.org_id and c.id = o.channel_id
       where o.org_id = ${orgId}
         and o.ordered_at >= (${today}::date::timestamp at time zone ${timeZone})
         and o.ordered_at < ((${today}::date + 1)::timestamp at time zone ${timeZone})${orderScope}`)).rows[0]?.count ?? "0";
    return NextResponse.json({
      channels: channels.map((channel) => ({
        ...channel,
        attention: attention[channel.id] ?? { failed: 0, dead: 0, lastReceivedAt: null },
      })),
      ordersToday,
      // Installed storefront connectors. Empty until a connector pack lands;
      // the home renders its teaching empty state instead of a dead button.
      kinds: registeredChannelKinds(),
    });
  },
});

export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  body: createBodySchema,
  handler: async ({ authz: gate, body }) => {
    const refused = channelAssignmentRefusal(gate, body.subsidiaryId);
    if (refused) return refused;
    const { channel, webhookSecret } = await createChannel(gate.user.orgId, gate.user.id, {
      kind: body.kind,
      name: body.name,
      subsidiaryId: body.subsidiaryId ?? null,
      currency: body.currency,
      externalAccount: body.externalAccount,
      secrets: body.secrets ?? null,
      webhookSecret: body.webhookSecret ?? null,
      settings: body.settings ?? {},
    });
    return created({ channel, webhookSecret });
  },
});

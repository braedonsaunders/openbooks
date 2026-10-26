import "server-only";

import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import {
  channelAttention,
  ensureShopifyAdapterRegistered,
  getChannelMarginSummary,
  listChannels,
  registeredChannelKinds,
} from "@openbooks/engine/commerce";
import { businessToday, businessTimeZone } from "@openbooks/engine/platform/business-date";
import { db } from "@openbooks/engine/platform/database";
import { page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../lib/authz";
import { builtInReportDefinitionId } from "../../../lib/custom-reports";
import { requireFeatureEnabled } from "../../../lib/feature-gates";
import { channelsInScope } from "../../../lib/channel-scope";
import { subsidiaryVisibleFilter } from "../../../lib/subsidiaries";
import type { Channel, MarginChannel } from "./channel-cards";
import { channelTabs } from "./channel-tabs";
import { countChannelExceptions } from "./orders/view";

/**
 * The home console owns ListPageLayout and PageHeader while its figures are
 * loaded here under the same permission and subsidiary scope as the channel
 * work queues. Channel writes stay guarded by their API permissions.
 */

export interface ChannelsHomeData {
  channels: Channel[];
  kinds: string[];
  ordersToday: string;
  exceptionCount: number;
  margin: MarginChannel[];
  marginReportHref: string;
  tabs: ReturnType<typeof channelTabs>;
}

export async function loadChannelsHome(): Promise<ChannelsHomeData> {
  const authz = await requirePermission("channels.read");
  await requireFeatureEnabled(authz.user.orgId, "salesChannels");
  const orgId = authz.user.orgId;
  const t = await getTranslations("channels");
  const unrestricted = authz.allowedSubsidiaryIds === null;
  ensureShopifyAdapterRegistered();

  const [today, timeZone, channelRows, attention, exceptionCount, marginSummary, marginReportId] =
    await Promise.all([
      businessToday(orgId),
      businessTimeZone(orgId),
      listChannels(orgId),
      channelAttention(orgId),
      countChannelExceptions(orgId, authz.allowedSubsidiaryIds),
      unrestricted ? getChannelMarginSummary(orgId, 30) : Promise.resolve([]),
      unrestricted && can(authz, "reports.read")
        ? builtInReportDefinitionId(orgId, "order-margin-by-channel")
        : Promise.resolve(null),
    ]);

  const orderScope = subsidiaryVisibleFilter(sql`c.subsidiary_id`, authz.allowedSubsidiaryIds);
  const ordersToday =
    (
      await db.execute<{ count: string }>(
        sql`
    select count(*)::text as count
      from channel_orders o
      join sales_channels c on c.org_id = o.org_id and c.id = o.channel_id
     where o.org_id = ${orgId}
       and o.ordered_at >= (${today}::date::timestamp at time zone ${timeZone})
       and o.ordered_at < ((${today}::date + 1)::timestamp at time zone ${timeZone})${orderScope}`,
        "objects",
      )
    )[0]?.count ?? "0";

  const channels = channelsInScope(authz, channelRows).map((channel) => ({
    id: channel.id,
    kind: channel.kind,
    name: channel.name,
    status: channel.status,
    currency: channel.currency,
    externalAccount: channel.externalAccount,
    lastSyncAt: channel.lastSyncAt,
    attention: attention[channel.id] ?? { failed: 0, dead: 0, lastReceivedAt: null },
  }));
  const margin: MarginChannel[] = marginSummary.map((row) => ({
    channelId: row.channelId,
    channelName: row.channelName,
    currency: row.currency,
    minorUnits: row.minorUnits,
    orders: row.orders,
    revenueMinor: row.revenueMinor.toString(),
    cm2Minor: row.cm2Minor.toString(),
    estimatedOrders: row.estimatedOrders,
    adSpendMinor: row.adSpendMinor.toString(),
  }));

  return {
    channels,
    kinds: registeredChannelKinds(),
    ordersToday,
    exceptionCount,
    margin,
    marginReportHref: marginReportId ? `/reports/custom/run/${marginReportId}` : "/reports",
    tabs: channelTabs(t, "overview", exceptionCount),
  };
}

export function channelsHomeSpec(data: ChannelsHomeData): PageSpec {
  return page({
    route: "/channels",
    layout: "bare",
    header: [],
    body: [widgetBlock("channels-console", { data })],
  });
}

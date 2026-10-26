/**
 * The channels home shows one parent collection: every channel exactly
 * once, carrying its own attention state and margin summaries inline.
 * Attention and margin rows never render as separate entity lists.
 */
export interface ChannelAttention {
  failed: number;
  dead: number;
  lastReceivedAt: string | null;
}

export interface Channel {
  id: string;
  kind: string;
  name: string;
  status: string;
  currency: string;
  externalAccount: string;
  lastSyncAt: string | null;
  attention: ChannelAttention;
}

export interface MarginChannel {
  channelId: string;
  channelName: string;
  currency: string;
  minorUnits: number | null;
  orders: number;
  revenueMinor: string;
  cm2Minor: string;
  estimatedOrders: number;
  adSpendMinor: string;
}

export interface ChannelCard {
  channel: Channel;
  outstanding: number;
  marginRows: MarginChannel[];
}

/** Exact percentage value with two decimal places, suitable for formatExactPercent. */
export function channelMarginPercentValue(cm2Minor: string, revenueMinor: string): string | null {
  const revenue = BigInt(revenueMinor);
  if (revenue <= 0n) return null;
  const hundredths = (BigInt(cm2Minor) * 10000n) / revenue;
  const negative = hundredths < 0n;
  const magnitude = negative ? -hundredths : hundredths;
  return `${negative ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
}

export function channelCards(
  channels: readonly Channel[],
  margin: readonly MarginChannel[] | null,
): ChannelCard[] {
  return channels.map((channel) => ({
    channel,
    outstanding: channel.attention.failed + channel.attention.dead,
    marginRows: (margin ?? []).filter((row) => row.channelId === channel.id),
  }));
}

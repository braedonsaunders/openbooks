import { ShopifyClient } from "../../connectors/shopify.ts";
import { addCalendarDays } from "../../platform/civil-date.ts";
import { CommerceError } from "../errors.ts";
import { loadShopifyChannel } from "./channel-access.ts";
import { shopMinorUnits } from "./orders.ts";

export interface ChannelDayTotal {
  channelId: string;
  day: string;
  orderCount: number;
  grossMinor: bigint;
  currency: string;
}

interface DayTotalOrderNode {
  totalPriceSet?: {
    shopMoney?: { amount?: unknown; currencyCode?: unknown };
  } | null;
}

const DAY_TOTALS_QUERY = `query commerceDayTotals($query: String!, $after: String) {
  orders(first: 250, after: $after, query: $query, sortKey: CREATED_AT) {
    edges { node { totalPriceSet { shopMoney { amount currencyCode } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/**
 * The storefront's own day totals: every order Shopify created on a UTC day,
 * counted and summed in shop money. This is the external truth the close
 * completeness proof measures ingestion against — OpenBooks never trusts its
 * own subledger to prove its own completeness. Days are UTC on both sides:
 * the close check aggregates channel_orders.ordered_at over the same UTC
 * window, so a shop whose local day straddles UTC midnight still ties as
 * long as both sides use the same boundary (documented on the tile).
 */
export async function fetchChannelDayTotals(
  orgId: string,
  channelId: string,
  day: string,
  options: { transport?: typeof fetch } = {},
): Promise<ChannelDayTotal> {
  assertDay(day);
  const access = await loadShopifyChannel(orgId, channelId);
  if (access.status !== "active") {
    throw new CommerceError(
      "shopify_channel_not_active",
      `Channel "${access.name}" is ${access.status}, so its storefront totals cannot be read.`,
      "Resume the channel under Channels, then run the completeness check again.",
      { field: "channelId" },
    );
  }
  const client = new ShopifyClient({
    shopDomain: access.shop,
    accessToken: access.accessToken,
    transport: options.transport,
    apiVersion: access.settings.apiVersion,
  });
  const totals = await readShopDayTotals(client, day, access.currency);
  return { channelId, day, ...totals };
}

function assertDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new CommerceError(
      "shopify_day_invalid",
      `Completeness day "${day}" is not a calendar date.`,
      "Run the completeness check for one YYYY-MM-DD day at a time.",
      { field: "day" },
    );
  }
}

/**
 * The paginated walk over the storefront, separated from channel access so
 * the unit test drives it against a fake transport with the real currency
 * math. Network is the only double; nothing pure is doubled.
 */
export async function readShopDayTotals(
  client: ShopifyClient,
  day: string,
  fallbackCurrency: string,
): Promise<{ orderCount: number; grossMinor: bigint; currency: string }> {
  assertDay(day);
  const range = `created_at:>=${day}T00:00:00Z created_at:<${nextDay(day)}T00:00:00Z`;
  let orderCount = 0;
  let grossMinor = 0n;
  let currency: string | null = null;
  const pages = client.paginate<DayTotalOrderNode>(
    DAY_TOTALS_QUERY,
    { query: range },
    (data) => {
      const connection = (data as { orders?: { edges?: { node: DayTotalOrderNode }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }).orders;
      if (!connection || !Array.isArray(connection.edges) || !connection.pageInfo) {
        throw new Error(
          "Shopify answered the day-totals query without an orders connection — retry the completeness check, and ask your administrator if it persists",
        );
      }
      return {
        edges: connection.edges,
        pageInfo: {
          hasNextPage: connection.pageInfo.hasNextPage ?? false,
          endCursor: connection.pageInfo.endCursor ?? null,
        },
      };
    },
  );
  for await (const node of pages) {
    const money = node.totalPriceSet?.shopMoney;
    const amount = typeof money?.amount === "string" ? money.amount : null;
    const code = typeof money?.currencyCode === "string" ? money.currencyCode : null;
    if (amount === null || code === null) continue;
    currency ??= code;
    if (code !== currency) continue;
    grossMinor += shopMinorUnits(amount, code);
    orderCount += 1;
  }
  return { orderCount, grossMinor, currency: currency ?? fallbackCurrency };
}

function nextDay(day: string): string {
  return addCalendarDays(day, 1);
}

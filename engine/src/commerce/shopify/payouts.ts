import { sql } from "drizzle-orm";
import { ShopifyClient } from "../../connectors/shopify.ts";
import { parseShopifyPaymentsPayout } from "../../payments/psp-settlement.ts";
import type { ParsedSettlement } from "../../payments/psp-settlement.ts";
import { importPulledSettlements } from "../../payments/psp-pull.ts";
import { orgFeatureEnabled } from "../../organization/org-feature-lock.ts";
import { db, orgContext, withBypass, withOrg } from "../../platform/db.ts";
import { addCalendarDays, isoDateOf } from "../../platform/civil-date.ts";
import { loadShopifyChannel } from "./channel-access.ts";
import { CommerceError } from "../errors.ts";

/**
 * Shopify Payments payout pull. Payouts and their balance transactions are
 * read through the channel's storefront credentials (the provider config
 * holds only the pull toggle, never the token) and normalized through the
 * documented payout parser into settlement batches — idempotent on
 * (shopify_payments, payout id). Every GraphQL field is validated on the
 * way in: a shape Shopify changed refuses naming the field instead of
 * booking a half-read payout.
 */

function refuse(code: string, message: string, remedy: string, field: string | null = null): never {
  throw new CommerceError(code, message, remedy, { field, status: 422 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textField(node: Record<string, unknown>, field: string, what: string): string {
  const value = node[field];
  if (typeof value !== "string" || value.trim() === "") {
    refuse(
      "shopify_payout_shape",
      `Shopify payout ${what} carries no ${field}.`,
      "Re-run the payout pull; if this repeats, the Shopify API shape changed and the payout importer needs updating before this payout can import.",
      field,
    );
  }
  return (value as string).trim();
}

function moneyField(node: Record<string, unknown>, field: string, what: string): { amount: string; currency: string } {
  const money = node[field];
  if (!isRecord(money) || typeof money.amount !== "string" || typeof money.currencyCode !== "string") {
    refuse(
      "shopify_payout_shape",
      `Shopify payout ${what} carries no ${field} money.`,
      "Re-run the payout pull; if this repeats, the Shopify API shape changed and the payout importer needs updating before this payout can import.",
      field,
    );
  }
  return { amount: (money.amount as string).trim(), currency: (money.currencyCode as string).trim() };
}

type PayoutNode = { id: string; issuedAt: string; net: { amount: string; currency: string } };

const PAYOUTS_QUERY = `
  query ShopifyPayoutPull($first: Int!, $after: String) {
    shopifyPaymentsAccount {
      payouts(first: $first, after: $after, reverse: true) {
        edges { cursor node { id issuedAt net { amount currencyCode } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

function pickPayouts(data: unknown): { edges: { node: PayoutNode }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const account = isRecord(data) ? data.shopifyPaymentsAccount : null;
  const payouts = isRecord(account) ? account.payouts : null;
  if (!isRecord(payouts) || !Array.isArray(payouts.edges) || !isRecord(payouts.pageInfo)) {
    refuse(
      "shopify_payout_shape",
      "Shopify answered the payouts query without a payouts connection.",
      "Re-run the payout pull; if this repeats, the Shopify API shape changed and the payout importer needs updating.",
      null,
    );
  }
  return payouts as {
    edges: { node: PayoutNode }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

type BalanceNode = {
  id?: string | null;
  type: string;
  amount: { amount: string; currencyCode: string };
  fee?: { amount: string; currencyCode: string } | null;
  net?: { amount: string; currencyCode: string } | null;
  sourceOrderId?: string | null;
};

const PAYOUT_TRANSACTIONS_QUERY = `
  query ShopifyPayoutTransactions($payoutId: ID!, $first: Int!, $after: String) {
    node(id: $payoutId) {
      ... on ShopifyPaymentsPayout {
        id
        balanceTransactions(first: $first, after: $after) {
          edges { cursor node { id type amount { amount currencyCode } fee { amount currencyCode } net { amount currencyCode } sourceOrderId } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

function pickBalanceTransactions(data: unknown, payoutId: string): {
  edges: { node: BalanceNode }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
} {
  const node = isRecord(data) ? data.node : null;
  const txns = isRecord(node) ? node.balanceTransactions : null;
  if (!isRecord(txns) || !Array.isArray(txns.edges) || !isRecord(txns.pageInfo)) {
    refuse(
      "shopify_payout_shape",
      `Shopify payout ${payoutId} answered without a balance-transactions connection.`,
      "Re-run the payout pull; if this repeats, the Shopify API shape changed and the payout importer needs updating before this payout can import.",
      null,
    );
  }
  return txns as {
    edges: { node: BalanceNode }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** Read recent payouts with their balance transactions through one channel. */
export async function fetchShopifyPayouts(
  client: ShopifyClient,
  opts: { sinceDate?: string; limit?: number } = {},
): Promise<ParsedSettlement[]> {
  const limit = opts.limit ?? 20;
  const settlements: ParsedSettlement[] = [];
  let seen = 0;
  for await (const payout of client.paginate<PayoutNode>(PAYOUTS_QUERY, { first: 50 }, pickPayouts)) {
    if (seen >= limit) break;
    seen += 1;
    const payoutNode = payout as unknown as Record<string, unknown>;
    const id = textField(payoutNode, "id", "entry");
    const issuedAt = textField(payoutNode, "issuedAt", id).slice(0, 10);
    if (opts.sinceDate && issuedAt < opts.sinceDate) continue;
    const net = moneyField(payoutNode, "net", id);
    const transactions: {
      id?: string | null;
      type: string;
      amount: string | number;
      fee?: string | number | null;
      net?: string | number | null;
      currency?: string | null;
      sourceOrderId?: string | null;
    }[] = [];
    for await (const txn of client.paginate<BalanceNode>(
      PAYOUT_TRANSACTIONS_QUERY,
      { payoutId: id, first: 100 },
      (data) => pickBalanceTransactions(data, id),
    )) {
      const row = txn as unknown as Record<string, unknown>;
      const amount = isRecord(row.amount) ? row.amount : null;
      const fee = isRecord(row.fee) ? row.fee : null;
      const netTxn = isRecord(row.net) ? row.net : null;
      transactions.push({
        id: typeof row.id === "string" ? row.id : null,
        type: typeof row.type === "string" ? row.type : "",
        amount: amount && typeof amount.amount === "string" ? amount.amount : "",
        fee: fee && typeof fee.amount === "string" ? fee.amount : null,
        net: netTxn && typeof netTxn.amount === "string" ? netTxn.amount : null,
        currency: amount && typeof amount.currencyCode === "string" ? amount.currencyCode : null,
        sourceOrderId: typeof row.sourceOrderId === "string" ? row.sourceOrderId : null,
      });
    }
    settlements.push(
      parseShopifyPaymentsPayout(
        { id, currency: net.currency, net: net.amount, issuedAt },
        transactions,
        issuedAt,
      ),
    );
  }
  return settlements;
}

export interface ShopifyPayoutPullScanResult {
  ran: number;
  failed: number;
  orgErrors: { orgId: string; error: string }[];
}

/**
 * Scheduled Shopify Payments payout pull. Orgs with the pull toggle on drain
 * every active Shopify channel through fetchShopifyPayouts into settlement
 * batches — idempotent on (shopify_payments, payout id), so a refetch
 * converges instead of duplicating.
 */
export async function runDueShopifyPayoutPulls(
  now: Date = new Date(),
  transport?: typeof fetch,
): Promise<ShopifyPayoutPullScanResult> {
  const result: ShopifyPayoutPullScanResult = { ran: 0, failed: 0, orgErrors: [] };
  // Simulation (and other tenant-scoped callers) run this helper while an
  // ambient org context is active. Keep that context as a hard candidate
  // boundary even though the scheduler's unscoped invocation legitimately
  // scans every production tenant under bypass: without this predicate, one
  // tenant's scan would pull another tenant's payouts.
  const scopedOrgId = orgContext.getStore()?.orgId;
  const orgScope = scopedOrgId ? sql`and c.org_id = ${scopedOrgId}` : sql``;
  // bypass: scheduler-tick — the unscoped scan finds pull-enabled Shopify
  // Payments configs across every production organization.
  const configs = await withBypass(async () =>
    (await db.execute<{ orgId: string; lastPullAt: string | null }>(sql`
      select c.org_id as "orgId", c.last_pull_at::text as "lastPullAt"
        from psp_provider_configs c
       where c.provider = 'shopify_payments' and c.is_enabled and c.pull_enabled ${orgScope}
       order by c.org_id`)).rows);
  for (const config of configs) {
    const gated = await withOrg(config.orgId, () => orgFeatureEnabled(config.orgId, "banking"));
    if (!gated) {
      console.info(`[shopify-payout-pull] scan skipped org ${config.orgId}: feature off`);
      continue;
    }
    try {
      const channels = await withOrg(config.orgId, async () =>
        (await db.execute<{ id: string }>(sql`
          select id from sales_channels
           where org_id = ${config.orgId} and kind = 'shopify' and status = 'active'
           order by id`)).rows);
      if (channels.length === 0) {
        throw new CommerceError(
          "shopify_payout_pull_no_channel",
          "Scheduled Shopify payout pull is on, but no active Shopify channel exists.",
          "Connect a Shopify channel under Channels, or turn scheduled pull off under Setup → Payment providers.",
          { field: null, status: 422 },
        );
      }
      const today = isoDateOf(now);
      const sinceDate = config.lastPullAt
        ? config.lastPullAt.slice(0, 10)
        : addCalendarDays(today, -7);
      const settlements: ParsedSettlement[] = [];
      for (const channel of channels) {
        // Sequential channels share one pull cursor: parallel imports would
        // interleave their idempotency checks and could advance the cursor
        // past a failed channel.
        const access = await withOrg(config.orgId, () => loadShopifyChannel(config.orgId, channel.id));
        const client = new ShopifyClient({
          shopDomain: access.shop,
          accessToken: access.accessToken,
          ...(transport ? { transport } : {}),
        });
        settlements.push(...await fetchShopifyPayouts(client, { sinceDate }));
      }
      await importPulledSettlements(config.orgId, "shopify_payments", settlements, null, null);
      result.ran += 1;
    } catch (e) {
      result.failed += 1;
      result.orgErrors.push({ orgId: config.orgId, error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) });
    }
  }
  return result;
}

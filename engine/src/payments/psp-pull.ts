import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import type { FetchFn } from "./acceptance.ts";
import {
  importSettlementBatch,
  parsePaypalTransactions,
  parseStripeBalanceTransactions,
  type ImportAccounts,
  type ParsedSettlement,
  type PspProvider,
} from "./psp-settlement.ts";

/**
 * Scheduled payout fetch (pull mode). A provider config with pull enabled
 * fetches its payouts on a schedule; each fetched payout becomes a
 * settlement batch through importSettlementBatch, idempotent on
 * (provider, external ref) — a refetch converges instead of duplicating.
 *
 * Shopify pull arrives later: payout fetching needs the channel's
 * storefront credentials, so Shopify imports stay push-only for now.
 */

export type PullFetchFn = FetchFn;

// fetch-redirect-audit: allow
const defaultFetch: PullFetchFn = (url, init) => fetch(url, init);

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBody(
  provider: string,
  res: { json: () => Promise<unknown> },
): Promise<Record<string, unknown>> {
  const body = await res.json().catch(() => null);
  if (!isJsonRecord(body)) {
    throw new PaymentError(`${provider} returned an unreadable response body`);
  }
  return body;
}

function base64Encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export interface PullSecrets {
  apiKey?: string;
  apiBase?: string;
}

const STRIPE_PULL_BASE = "https://api.stripe.com";

/** Allowlisted Stripe API base for pull (same contract as acceptance). */
export function resolveStripePullBase(apiBase?: string): string {
  const base = (apiBase ?? STRIPE_PULL_BASE).trim().replace(/\/+$/, "");
  if (base !== STRIPE_PULL_BASE) {
    throw new PaymentError("stripe API endpoint is not allowlisted");
  }
  return base;
}

export interface StripePayoutSummary {
  id: string;
  currency: string;
  arrivalDate: string;
}

/** List recent Stripe payouts (ids only — balances fetch per payout). */
export async function fetchStripePayouts(
  secrets: PullSecrets,
  fetchFn: PullFetchFn = defaultFetch,
  opts: { limit?: number; startingAfter?: string } = {},
): Promise<StripePayoutSummary[]> {
  if (!secrets.apiKey) throw new PaymentError("stripe secret key is not configured");
  const base = resolveStripePullBase(secrets.apiBase);
  const params = new URLSearchParams({ limit: String(opts.limit ?? 20) });
  if (opts.startingAfter) params.set("starting_after", opts.startingAfter);
  const res = await fetchFn(`${base}/v1/payouts?${params}`, {
    method: "GET",
    redirect: "error",
    headers: { authorization: `Bearer ${secrets.apiKey}` },
  });
  const body = await readJsonBody("stripe", res);
  if (res.status >= 400) {
    const message = isJsonRecord(body.error) && typeof body.error.message === "string" ? body.error.message : res.status;
    throw new PaymentError(`stripe payout fetch failed: ${message}`);
  }
  const data = Array.isArray(body.data) ? body.data : [];
  return data.map((row) => {
    const payout = isJsonRecord(row) ? row : {};
    const id = payout.id;
    const currency = payout.currency;
    if (typeof id !== "string" || id === "" || typeof currency !== "string" || currency === "") {
      throw new PaymentError("stripe payout fetch returned a payout without id or currency");
    }
    const arrival = typeof payout.arrival_date === "number"
      ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    return { id, currency: currency.toUpperCase(), arrivalDate: arrival };
  });
}

/** Fetch one payout's balance transactions and parse them into a settlement. */
export async function fetchStripePayoutSettlement(
  secrets: PullSecrets,
  payout: StripePayoutSummary,
  fetchFn: PullFetchFn = defaultFetch,
): Promise<ParsedSettlement> {
  if (!secrets.apiKey) throw new PaymentError("stripe secret key is not configured");
  const base = resolveStripePullBase(secrets.apiBase);
  const params = new URLSearchParams({ payout: payout.id, limit: "100" });
  const res = await fetchFn(`${base}/v1/balance_transactions?${params}`, {
    method: "GET",
    redirect: "error",
    headers: { authorization: `Bearer ${secrets.apiKey}` },
  });
  const body = await readJsonBody("stripe", res);
  if (res.status >= 400) {
    const message = isJsonRecord(body.error) && typeof body.error.message === "string" ? body.error.message : res.status;
    throw new PaymentError(`stripe balance fetch failed for payout ${payout.id}: ${message}`);
  }
  const data = Array.isArray(body.data) ? body.data : [];
  return parseStripeBalanceTransactions(
    data.map((row) => {
      const txn = isJsonRecord(row) ? row : {};
      return {
        id: String(txn.id ?? ""),
        type: String(txn.type ?? ""),
        amount: txn.amount as number,
        fee: txn.fee as number | undefined,
        net: txn.net as number | undefined,
        currency: String(txn.currency ?? payout.currency),
        created: txn.created as number | undefined,
        description: (txn.description as string | null) ?? null,
        available_on: txn.available_on as number | undefined,
        exchange_rate: (txn.exchange_rate as number | string | null) ?? null,
      };
    }),
    payout.id,
    payout.arrivalDate,
  );
}

const PAYPAL_PULL_BASES = new Set([
  "https://api-m.paypal.com",
  "https://api-m.sandbox.paypal.com",
]);

/** Allowlisted PayPal API base for pull (live and sandbox hosts only). */
export function resolvePaypalPullBase(apiBase?: string): string {
  const base = (apiBase ?? "https://api-m.sandbox.paypal.com").trim().replace(/\/+$/, "");
  if (!PAYPAL_PULL_BASES.has(base)) {
    throw new PaymentError("paypal API endpoint is not allowlisted");
  }
  return base;
}

async function fetchPaypalAccessToken(
  secrets: PullSecrets,
  base: string,
  fetchFn: PullFetchFn,
): Promise<string> {
  // For PayPal the stored apiKey is the "client_id:client_secret" pair the
  // token endpoint exchanges for a bearer token; nothing else is stored.
  const pair = (secrets.apiKey ?? "").split(":", 2);
  if (pair.length !== 2 || !pair[0] || !pair[1]) {
    throw new PaymentError("paypal client credentials are not configured; store them as client_id:client_secret");
  }
  const res = await fetchFn(`${base}/v1/oauth2/token`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Basic ${base64Encode(`${pair[0]}:${pair[1]}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await readJsonBody("paypal", res);
  if (res.status >= 400 || typeof body.access_token !== "string" || body.access_token === "") {
    throw new PaymentError(`paypal token exchange failed: ${res.status}`);
  }
  return body.access_token;
}

/** Fetch one PayPal Transaction Search page and parse it into a settlement. */
export async function fetchPaypalSettlement(
  secrets: PullSecrets,
  reference: string,
  range: { startDate: string; endDate: string },
  fetchFn: PullFetchFn = defaultFetch,
): Promise<ParsedSettlement> {
  const base = resolvePaypalPullBase(secrets.apiBase);
  const token = await fetchPaypalAccessToken(secrets, base, fetchFn);
  const params = new URLSearchParams({
    start_date: `${range.startDate}T00:00:00Z`,
    end_date: `${range.endDate}T23:59:59Z`,
    fields: "all",
    page_size: "500",
    page: "1",
  });
  const res = await fetchFn(`${base}/v1/reporting/transactions?${params}`, {
    method: "GET",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await readJsonBody("paypal", res);
  if (res.status >= 400) {
    const message = typeof body.message === "string" ? body.message : res.status;
    throw new PaymentError(`paypal transaction fetch failed: ${message}`);
  }
  const details = Array.isArray(body.transaction_details) ? body.transaction_details : [];
  return parsePaypalTransactions(
    {
      reference,
      transactions: details.map((row) => {
        const detail = isJsonRecord(row) ? row : {};
        return { transaction_info: isJsonRecord(detail.transaction_info) ? {
          transaction_id: detail.transaction_info.transaction_id as string | undefined,
          transaction_event_code: detail.transaction_info.transaction_event_code as string | undefined,
          transaction_initiated_date: detail.transaction_info.transaction_initiated_date as string | undefined,
          transaction_updated_date: detail.transaction_info.transaction_updated_date as string | undefined,
          transaction_amount: detail.transaction_info.transaction_amount as
            | { currency_code?: string; value?: string | number }
            | undefined,
          fee_amount: detail.transaction_info.fee_amount as
            | { currency_code?: string; value?: string | number }
            | undefined,
        } : {} };
      }),
    },
    range.endDate,
  );
}

/**
 * Import pulled settlements with the provider config's default accounts.
 * Each import is idempotent on (provider, external ref); the pull cursor
 * advances only after every batch in the page imports.
 */
export async function importPulledSettlements(
  orgId: string,
  provider: PspProvider,
  settlements: ParsedSettlement[],
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ batchIds: string[] }> {
  if (provider !== "stripe" && provider !== "paypal") {
    throw new PaymentError(`scheduled pull is not available for ${provider}`);
  }
  return withOrg(orgId, async () => {
    const config = (await db.execute<{
      default_bank_account_id: string | null;
      default_fee_account_id: string | null;
      default_dispute_account_id: string | null;
      default_fx_account_id: string | null;
      default_clearing_account_id: string | null;
    }>(sql`
      select default_bank_account_id, default_fee_account_id, default_dispute_account_id,
             default_fx_account_id, default_clearing_account_id
        from psp_provider_configs
       where org_id = ${orgId} and provider = ${provider} and is_enabled and pull_enabled
    `)).rows[0];
    if (!config) {
      throw new PaymentError(
        `scheduled pull is not enabled for ${provider}; enable it in Company Settings → Payment Providers`,
      );
    }
    const accounts: Partial<ImportAccounts> = {
      bankAccountId: config.default_bank_account_id ?? undefined,
      feeAccountId: config.default_fee_account_id ?? undefined,
      disputeAccountId: config.default_dispute_account_id ?? undefined,
      fxAccountId: config.default_fx_account_id ?? undefined,
      clearingAccountId: config.default_clearing_account_id ?? undefined,
    };
    const batchIds: string[] = [];
    for (const parsed of settlements) {
      // Sequential imports share one pull cursor: parallel batches would
      // interleave their idempotency checks and could advance the cursor past
      // a failed import.
      const { batchId } = await importSettlementBatch(orgId, actorId, parsed, accounts, allowedSubsidiaryIds);
      batchIds.push(batchId);
    }
    const pulled = (await db.execute(sql`
      update psp_provider_configs set last_pull_at = now(), updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and provider = ${provider}
    `));
    if ((pulled.rowCount ?? 0) !== 1) {
      throw new PaymentError("provider pull cursor could not advance");
    }
    return { batchIds };
  });
}

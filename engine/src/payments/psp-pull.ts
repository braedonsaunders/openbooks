import { sql } from "drizzle-orm";
import { db, orgContext, withBypass, withOrg } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import { addCalendarDays, isoDateOf } from "../platform/civil-date.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { fromMinorUnits, type FetchFn } from "./acceptance.ts";
import { cmp } from "../money/money.ts";
import {
  importSettlementBatch,
  parsePaypalTransactions,
  parseStripeBalanceTransactions,
  PspSettlementError,
  summarizeSettlement,
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
 * Shopify payout fetching uses the owning channel's storefront credentials
 * in commerce/shopify; its parsed settlements share this import path.
 */

export type PullFetchFn = FetchFn;

// The FetchFn type requires redirect: "error", and this default states it
// again at the global fetch boundary so a caller omitting it still refuses.
const defaultFetch: PullFetchFn = (url, init) => fetch(url, { ...init, redirect: "error" });

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
  /** Independent provider payout total in currency minor units. */
  amount?: number;
}

/** Retrieve a complete Stripe list; missing or repeated cursors refuse. */
async function fetchStripeRows(
  secrets: PullSecrets,
  path: string,
  params: URLSearchParams,
  label: string,
  fetchFn: PullFetchFn,
): Promise<Record<string, unknown>[]> {
  if (!secrets.apiKey) throw new PaymentError("stripe secret key is not configured");
  const base = resolveStripePullBase(secrets.apiBase);
  const rows: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (let page = 0; page < 10_000; page += 1) {
    const res = await fetchFn(`${base}${path}?${params}`, {
      method: "GET", redirect: "error", headers: { authorization: `Bearer ${secrets.apiKey}` },
    });
    const body = await readJsonBody("stripe", res);
    if (res.status >= 400) {
      const message = isJsonRecord(body.error) && typeof body.error.message === "string" ? body.error.message : res.status;
      throw new PaymentError(`stripe ${label} fetch failed: ${message}; retry the complete pull`);
    }
    if (!Array.isArray(body.data) || typeof body.has_more !== "boolean") {
      throw new PaymentError(`stripe ${label} returned no reliable pagination evidence; retry the complete pull`);
    }
    const data: Record<string, unknown>[] = [];
    for (const value of body.data) {
      if (!isJsonRecord(value) || typeof value.id !== "string" || !value.id || ids.has(value.id)) {
        throw new PaymentError(`stripe ${label} returned a missing or repeated record id; retry the complete pull`);
      }
      ids.add(value.id);
      data.push(value);
    }
    rows.push(...data);
    if (!body.has_more) return rows;
    const last = data.at(-1);
    if (!last || last.id === params.get("starting_after")) {
      throw new PaymentError(`stripe ${label} returned no advancing pagination cursor; retry the complete pull`);
    }
    params.set("starting_after", last.id as string);
  }
  throw new PaymentError(`stripe ${label} exceeds the pull pagination limit; import the complete provider settlement export instead`);
}

/** List every payout after the optional cursor; limit is the page size. */
export async function fetchStripePayouts(
  secrets: PullSecrets,
  fetchFn: PullFetchFn = defaultFetch,
  opts: { limit?: number; startingAfter?: string } = {},
): Promise<StripePayoutSummary[]> {
  const limit = opts.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PaymentError("stripe payout page size must be between 1 and 100");
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.startingAfter) params.set("starting_after", opts.startingAfter);
  const data = await fetchStripeRows(secrets, "/v1/payouts", params, "payout", fetchFn);
  return data.map((payout) => {
    const id = payout.id;
    const currency = payout.currency;
    if (typeof id !== "string" || id === "" || typeof currency !== "string" || currency === "") {
      throw new PaymentError("stripe payout fetch returned a payout without id or currency");
    }
    if (!Number.isSafeInteger(payout.amount)) throw new PaymentError(`stripe payout ${id} has no exact payout total; retry the complete pull`);
    const arrival = typeof payout.arrival_date === "number"
      ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    return { id, currency: currency.toUpperCase(), arrivalDate: arrival, amount: payout.amount as number };
  });
}

/** Fetch one payout's balance transactions and parse them into a settlement. */
export async function fetchStripePayoutSettlement(
  secrets: PullSecrets,
  payout: StripePayoutSummary,
  fetchFn: PullFetchFn = defaultFetch,
): Promise<ParsedSettlement> {
  const params = new URLSearchParams({ payout: payout.id, limit: "100" });
  const data = await fetchStripeRows(secrets, "/v1/balance_transactions", params, `balance for payout ${payout.id}`, fetchFn);
  const parsed = parseStripeBalanceTransactions(
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
  if (payout.amount !== undefined) {
    if (!Number.isSafeInteger(payout.amount)) throw new PaymentError(`stripe payout ${payout.id} has no exact payout total; retry the complete pull`);
    const expected = fromMinorUnits(BigInt(payout.amount), payout.currency);
    const actual = summarizeSettlement(parsed.lines).netAmount;
    if (cmp(actual, expected) !== 0) throw new PaymentError(`stripe payout ${payout.id} does not reconcile: provider total ${expected}, fetched settlement net ${actual}; retry the complete pull`);
    parsed.raw = { ...parsed.raw, providerPayoutAmount: expected };
  }
  return parsed;
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

/** Fetch every page in a PayPal Transaction Search range before parsing. */
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
  const details: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  let totalPages: number | undefined;
  let totalItems: number | undefined;
  for (let page = 1; ; page += 1) {
    params.set("page", String(page));
    const res = await fetchFn(`${base}/v1/reporting/transactions?${params}`, {
      method: "GET", redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    const body = await readJsonBody("paypal", res);
    if (res.status >= 400) {
      const message = typeof body.message === "string" ? body.message : res.status;
      throw new PaymentError(`paypal transaction fetch failed on page ${page}: ${message}; retry the complete pull`);
    }
    if (!Array.isArray(body.transaction_details) || !Number.isSafeInteger(body.total_pages)
      || !Number.isSafeInteger(body.total_items) || (body.total_pages as number) < 0
      || (body.total_pages as number) > 10_000 || (body.total_items as number) < 0
      || (body.page !== undefined && body.page !== page)) {
      throw new PaymentError("paypal returned no reliable pagination evidence; retry the complete pull");
    }
    if (totalPages !== undefined && (totalPages !== body.total_pages || totalItems !== body.total_items)) {
      throw new PaymentError("paypal transaction range changed during pagination; retry the complete pull");
    }
    totalPages = body.total_pages as number;
    totalItems = body.total_items as number;
    for (const value of body.transaction_details) {
      const id = isJsonRecord(value) && isJsonRecord(value.transaction_info) ? value.transaction_info.transaction_id : null;
      if (!isJsonRecord(value) || typeof id !== "string" || !id || ids.has(id)) {
        throw new PaymentError("paypal returned a missing or repeated transaction id; retry the complete pull");
      }
      ids.add(id);
      details.push(value);
    }
    if (page >= totalPages) break;
    if (body.transaction_details.length === 0) throw new PaymentError("paypal returned an empty page before the end of the range; retry the complete pull");
  }
  if (details.length !== totalItems) throw new PaymentError(`paypal transaction count does not reconcile: provider ${totalItems}, fetched ${details.length}; retry the complete pull`);
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
 * advances only after every fetched batch imports.
 */
export async function importPulledSettlements(
  orgId: string,
  provider: PspProvider,
  settlements: ParsedSettlement[],
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ batchIds: string[] }> {
  if (provider !== "stripe" && provider !== "paypal" && provider !== "shopify_payments") {
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

export interface PspPayoutPullScanResult {
  ran: number;
  failed: number;
  orgErrors: { orgId: string; error: string }[];
}

type PullConfigRow = {
  orgId: string;
  provider: string;
  secrets: string | null;
  lastPullAt: string | null;
};

function pullApiKey(orgId: string, provider: string, secrets: string | null): string {
  if (!secrets) {
    throw new PaymentError(
      `${provider} pull credentials are not configured; store an API key under Setup → Payment providers, then enable scheduled pull`,
    );
  }
  let apiKey: unknown;
  try {
    apiKey = unsealJson<{ apiKey?: unknown }>(secrets, { orgId, purpose: "payment.provider.secrets" }).apiKey;
  } catch {
    throw new PaymentError(
      `${provider} pull credentials could not be opened; store a fresh API key under Setup → Payment providers`,
    );
  }
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new PaymentError(
      `${provider} pull credentials are not configured; store an API key under Setup → Payment providers, then enable scheduled pull`,
    );
  }
  return apiKey;
}

/**
 * Scheduled payout pull for Stripe and PayPal (the `psp_payout_pull` scan).
 * Every org with a pull-enabled provider config fetches its recent payouts
 * into settlement batches through importPulledSettlements — idempotent on
 * (provider, payout ref), so a refetch converges instead of duplicating.
 * Shopify pull lives with the channel credentials in commerce/shopify.
 */
export async function runDuePspPayoutPulls(
  now: Date = new Date(),
  fetchFn: PullFetchFn = defaultFetch,
): Promise<PspPayoutPullScanResult> {
  const result: PspPayoutPullScanResult = { ran: 0, failed: 0, orgErrors: [] };
  // Simulation (and other tenant-scoped callers) run this helper while an
  // ambient org context is active. Keep that context as a hard candidate
  // boundary even though the scheduler's unscoped invocation legitimately
  // scans every production tenant under bypass: without this predicate, one
  // tenant's scan would pull another tenant's payouts.
  const scopedOrgId = orgContext.getStore()?.orgId;
  const orgScope = scopedOrgId ? sql`and c.org_id = ${scopedOrgId}` : sql``;
  // bypass: scheduler-tick — the unscoped scan finds pull-enabled provider
  // configs across every production organization.
  const configs = await withBypass(async () =>
    (await db.execute<PullConfigRow>(sql`
      select c.org_id as "orgId", c.provider, c.secrets, c.last_pull_at::text as "lastPullAt"
        from psp_provider_configs c
       where c.provider in ('stripe', 'paypal') and c.is_enabled and c.pull_enabled ${orgScope}
       order by c.org_id, c.provider`)).rows);
  for (const config of configs) {
    const gated = await withOrg(config.orgId, () => orgFeatureEnabled(config.orgId, "banking"));
    if (!gated) {
      console.info(`[psp-payout-pull] scan skipped org ${config.orgId}: feature off`);
      continue;
    }
    try {
      const today = isoDateOf(now);
      if (config.provider === "stripe") {
        const apiKey = pullApiKey(config.orgId, config.provider, config.secrets);
        const payouts = await fetchStripePayouts({ apiKey }, fetchFn, { limit: 20 });
        const settlements: ParsedSettlement[] = [];
        for (const payout of payouts) {
          // Sequential fetches share one pull cursor: parallel pages would
          // interleave their imports and could advance the cursor past a
          // failed payout.
          settlements.push(await fetchStripePayoutSettlement({ apiKey }, payout, fetchFn));
        }
        await importPulledSettlements(config.orgId, "stripe", settlements, null, null);
      } else {
        const apiKey = pullApiKey(config.orgId, config.provider, config.secrets);
        const startDate = config.lastPullAt ? config.lastPullAt.slice(0, 10) : addCalendarDays(today, -7);
        let settlements: ParsedSettlement[] = [];
        try {
          settlements = [
            await fetchPaypalSettlement(
              { apiKey },
              `paypal-transactions|${startDate}|${today}`,
              { startDate, endDate: today },
              fetchFn,
            ),
          ];
        } catch (e) {
          // A quiet window is not a failure: importing zero batches still
          // advances the pull cursor past the empty range.
          if (!(e instanceof PspSettlementError) || e.message !== "settlement batch has no evidence lines") throw e;
        }
        await importPulledSettlements(config.orgId, "paypal", settlements, null, null);
      }
      result.ran += 1;
    } catch (e) {
      result.failed += 1;
      result.orgErrors.push({ orgId: config.orgId, error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) });
    }
  }
  return result;
}

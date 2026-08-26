import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "./db.ts";
import {
  importStatement,
  SYSTEM_ACTOR_ID,
  type ParsedStatementLine,
  type StatementSourceEvidence,
} from "./banking.ts";
import { addCalendarDays, businessToday } from "./business-date.ts";
import { neg, normalizeMoney } from "./money.ts";
import { canonicalDecimal } from "./exact-decimal.ts";
import { sealJson, unsealJson } from "./secrets.ts";

/**
 * Live bank-feed providers — the aggregator side of Bank Feeds. Each adapter
 * turns a provider's API into openbooks' neutral ParsedStatementLine[], which
 * flows straight into the same importStatement pipeline (dedupe → statement →
 * matching → reconciliation) that OFX/CSV/SFTP files use. Statements land with
 * source 'feed_api'.
 *
 * Bank-perspective sign convention throughout: +deposit / −withdrawal. Each
 * adapter normalizes its provider's own convention to that.
 */

export type BankFeedProvider = "plaid" | "gocardless" | "truelayer";

export interface FeedFetchResult {
  lines: ParsedStatementLine[];
  currency?: string | null;
  /** Exact provider response bytes retained by the statement audit log. */
  sourceEvidence: StatementSourceEvidence;
}

export interface BankFeedAdapter {
  key: BankFeedProvider;
  /** Verify credentials without importing anything. */
  test(creds: Record<string, string>): Promise<{ ok: boolean; detail?: string }>;
  /** Pull transactions for one external account since `sinceIso` (inclusive). */
  fetch(
    creds: Record<string, string>,
    externalAccountId: string,
    sinceIso: string,
    untilIso: string,
  ): Promise<FeedFetchResult>;
}

class FeedError extends Error {}

/** Provider amounts persist onto statement lines. Reject anything that is
 *  not an exact decimal at ledger scale — String() would otherwise let
 *  IEEE-754 noise through into importStatement. */
function exactFeedAmount(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw new FeedError("feed amount must be an exact decimal with at most four places");
  }
  try {
    return normalizeMoney(exact);
  } catch {
    throw new FeedError("feed amount must be an exact decimal with at most four places");
  }
}

async function jsonResponse(res: Response): Promise<{ body: any; raw: Uint8Array }> {
  const raw = new Uint8Array(await res.arrayBuffer());
  const text = Buffer.from(raw).toString("utf8");
  if (!res.ok) {
    throw new FeedError(`provider responded ${res.status}: ${text.slice(0, 300)}`);
  }
  return { body: text ? JSON.parse(text) : {}, raw };
}

async function asJson(res: Response): Promise<any> {
  return (await jsonResponse(res)).body;
}

/** Provider credentials must never cross an HTTP redirect boundary. Even a
 *  trusted API origin can otherwise redirect a POST (including its body and
 *  authorization headers) to a host that was never allowlisted. */
function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "error" });
}

/**
 * Preserve one provider response byte-for-byte. Paginated responses are
 * wrapped as strings in a versioned JSON envelope so every original response
 * remains exactly recoverable without pretending the pages were one response.
 */
export function bankFeedSourceEvidence(
  provider: BankFeedProvider,
  rawResponses: readonly Uint8Array[],
): StatementSourceEvidence {
  if (rawResponses.length === 0) throw new FeedError("bank feed returned no response evidence");
  const bundled = rawResponses.length !== 1 || rawResponses[0]!.byteLength === 0;
  return {
    content: bundled
      ? JSON.stringify({
          format: "openbooks.bank-feed-response-bundle.v1",
          provider,
          encoding: "base64",
          responses: rawResponses.map((raw) => Buffer.from(raw).toString("base64")),
        })
      : rawResponses[0]!,
    filename: `bank-feed-${provider}-${bundled ? "responses" : "response"}.json`,
    contentType: "application/json",
  };
}

// --------------------------------------------------------------------------
// GoCardless Bank Account Data (formerly Nordigen) — free, pan-European.
// Auth: exchange secret_id/secret_key for a bearer token, then read the
// account's transactions. Amounts are already account-perspective signed.
// --------------------------------------------------------------------------
const GOCARDLESS_BASE = "https://bankaccountdata.gocardless.com/api/v2";

async function gocardlessToken(creds: Record<string, string>): Promise<string> {
  if (!creds.secretId || !creds.secretKey) throw new FeedError("GoCardless secret_id / secret_key required");
  const res = await providerFetch(`${GOCARDLESS_BASE}/token/new/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ secret_id: creds.secretId, secret_key: creds.secretKey }),
  });
  const body = await asJson(res);
  if (!body.access) throw new FeedError("GoCardless did not return an access token");
  return body.access as string;
}

const gocardless: BankFeedAdapter = {
  key: "gocardless",
  async test(creds) {
    try {
      await gocardlessToken(creds);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
  async fetch(creds, externalAccountId, sinceIso, untilIso) {
    if (!externalAccountId) throw new FeedError("GoCardless account id required");
    const token = await gocardlessToken(creds);
    const res = await providerFetch(
      `${GOCARDLESS_BASE}/accounts/${encodeURIComponent(externalAccountId)}/transactions/?date_from=${sinceIso}&date_to=${untilIso}`,
      { headers: { Authorization: `Bearer ${token}`, accept: "application/json" } },
    );
    const { body, raw } = await jsonResponse(res);
    // Booked only: pendings change or vanish, so importing them would leave
    // statement evidence that can never reconcile at sign-off.
    const txns: any[] = body?.transactions?.booked ?? [];
    let currency: string | null = null;
    const lines: ParsedStatementLine[] = txns.map((t) => {
      currency ??= t?.transactionAmount?.currency ?? null;
      return {
        postedOn: (t.bookingDate || t.valueDate || sinceIso).slice(0, 10),
        amount: exactFeedAmount(t?.transactionAmount?.amount),
        description:
          t.remittanceInformationUnstructured ||
          (Array.isArray(t.remittanceInformationUnstructuredArray)
            ? t.remittanceInformationUnstructuredArray.join(" ")
            : null) ||
          t.creditorName ||
          t.debtorName ||
          null,
        counterpartyRef: t.creditorName || t.debtorName || null,
        bankTransactionId: t.transactionId || t.internalTransactionId || null,
      };
    });
    return { lines, currency, sourceEvidence: bankFeedSourceEvidence("gocardless", [raw]) };
  },
};

// --------------------------------------------------------------------------
// Plaid Transactions. Plaid's `amount` is POSITIVE for money leaving the
// account, so we negate to the bank-statement convention.
// --------------------------------------------------------------------------
const PLAID_PAGE_SIZE = 500;
// 20 pages × 500 = 10,000 transactions per sync; past that we abort loudly
// rather than silently truncating a 90-day cold start on a busy account.
const PLAID_MAX_PAGES = 20;
const PLAID_API_BASES = {
  production: "https://production.plaid.com",
  sandbox: "https://sandbox.plaid.com",
} as const;

/** Resolve only Plaid's published API environments. Credential data must never
 * become part of an outbound hostname: besides misconfiguration, values with a
 * slash can turn string interpolation into a request to an arbitrary host.
 * Two independent fences: the name must strictly equal a known environment,
 * and the lookup must hit an own key of the base table — inherited prototype
 * names ("toString", "constructor") or polluted Object.prototype entries once
 * resolved as truthy bases here. Non-string credential values (JSON payloads
 * are untrusted) fail closed instead of reaching String methods. */
export function plaidApiBase(environment?: unknown): string {
  const normalized =
    environment === undefined
      ? "production"
      : typeof environment === "string"
        ? environment.trim().toLowerCase() || "production"
        : "";
  if (normalized !== "production" && normalized !== "sandbox") {
    throw new FeedError("Plaid environment must be production or sandbox");
  }
  if (!Object.hasOwn(PLAID_API_BASES, normalized)) {
    throw new FeedError("Plaid environment must be production or sandbox");
  }
  return PLAID_API_BASES[normalized];
}

/**
 * Accumulate every transactions/get page until Plaid reports has_more=false.
 * The page fetcher is injected so pagination is testable in isolation; the
 * hard page cap throws instead of letting history fall off the end silently.
 */
export async function plaidFetchAllTransactions(
  fetchPage: (offset: number) => Promise<{ transactions?: unknown[]; has_more?: boolean }>,
): Promise<any[]> {
  const all: unknown[] = [];
  for (let offset = 0, page = 1; ; offset += PLAID_PAGE_SIZE, page += 1) {
    if (page > PLAID_MAX_PAGES) {
      throw new FeedError(
        `Plaid feed exceeded ${PLAID_MAX_PAGES} pages (${PLAID_MAX_PAGES * PLAID_PAGE_SIZE} transactions) — narrow the sync window instead of truncating history`,
      );
    }
    const body = await fetchPage(offset);
    all.push(...(body.transactions ?? []));
    if (!body.has_more) return all;
  }
}

const plaid: BankFeedAdapter = {
  key: "plaid",
  async test(creds) {
    if (!creds.clientId || !creds.secret || !creds.accessToken) {
      return { ok: false, detail: "Plaid client_id, secret and access_token required" };
    }
    try {
      const base = plaidApiBase(creds.env);
      const res = await providerFetch(`${base}/accounts/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: creds.clientId, secret: creds.secret, access_token: creds.accessToken }),
      });
      await asJson(res);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
  async fetch(creds, externalAccountId, sinceIso, untilIso) {
    const accountId = externalAccountId.trim();
    if (!accountId) throw new FeedError("Plaid account id required");
    const base = plaidApiBase(creds.env);
    const today = untilIso;
    const rawResponses: Uint8Array[] = [];
    const transactions = await plaidFetchAllTransactions(async (offset) => {
      const res = await providerFetch(`${base}/transactions/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          access_token: creds.accessToken,
          start_date: sinceIso,
          end_date: today,
          options: { account_ids: [accountId], count: PLAID_PAGE_SIZE, offset },
        }),
      });
      const { body, raw } = await jsonResponse(res);
      rawResponses.push(raw);
      return body;
    });
    let currency: string | null = null;
    const lines: ParsedStatementLine[] = transactions.map((t) => {
      currency ??= t.iso_currency_code ?? null;
      // Plaid: positive amount = outflow. Bank convention wants −withdrawal.
      const signed = neg(exactFeedAmount(t.amount));
      return {
        postedOn: (t.date || sinceIso).slice(0, 10),
        amount: signed,
        description: t.name || t.merchant_name || null,
        counterpartyRef: t.merchant_name || null,
        bankTransactionId: t.transaction_id || null,
      };
    });
    return { lines, currency, sourceEvidence: bankFeedSourceEvidence("plaid", rawResponses) };
  },
};

// --------------------------------------------------------------------------
// TrueLayer Data API (UK/EU open banking). Amounts are account-perspective
// signed already (negative = debit).
// --------------------------------------------------------------------------
const truelayer: BankFeedAdapter = {
  key: "truelayer",
  async test(creds) {
    if (!creds.accessToken) return { ok: false, detail: "TrueLayer access_token required" };
    try {
      const res = await providerFetch("https://api.truelayer.com/data/v1/accounts", {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      await asJson(res);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
  async fetch(creds, externalAccountId, sinceIso, untilIso) {
    if (!externalAccountId) throw new FeedError("TrueLayer account id required");
    const today = untilIso;
    const res = await providerFetch(
      `https://api.truelayer.com/data/v1/accounts/${encodeURIComponent(externalAccountId)}/transactions?from=${sinceIso}T00:00:00Z&to=${today}T23:59:59Z`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } },
    );
    const { body, raw } = await jsonResponse(res);
    let currency: string | null = null;
    const lines: ParsedStatementLine[] = (body.results ?? []).map((t: any) => {
      currency ??= t.currency ?? null;
      return {
        postedOn: (t.timestamp || sinceIso).slice(0, 10),
        amount: exactFeedAmount(t.amount),
        description: t.description || t.merchant_name || null,
        counterpartyRef: t.merchant_name || null,
        bankTransactionId: t.transaction_id || t.normalised_provider_transaction_id || null,
      };
    });
    return { lines, currency, sourceEvidence: bankFeedSourceEvidence("truelayer", [raw]) };
  },
};

const ADAPTERS: Record<BankFeedProvider, BankFeedAdapter> = { gocardless, plaid, truelayer };

export function getBankFeedAdapter(provider: string): BankFeedAdapter | null {
  if (!Object.hasOwn(ADAPTERS, provider)) return null;
  return ADAPTERS[provider as BankFeedProvider];
}

/**
 * Test a connection's stored credentials (called by the "Test" button).
 * ctx.orgId scopes the lookup: a connection id from another organization
 * fails closed instead of probing its sealed credentials.
 */
export async function testBankFeedConnection(
  connectionId: string,
  ctx: { orgId: string },
): Promise<{ ok: boolean; detail?: string }> {
  const row = await withBypass(async () =>
    (await db.execute<{ orgId: string; provider: string; credentials: string | null }>(sql`
      select c.org_id as "orgId", c.provider, c.credentials
        from bank_feed_connections c
        join orgs o on o.id = c.org_id
       where c.id = ${connectionId}
         and c.org_id = ${ctx.orgId}
         and coalesce((o.settings->'features'->>'bankFeeds')::boolean, false)
    `)),
  );
  const conn = row.rows[0];
  if (!conn) return { ok: false, detail: "connection not found" };
  // Defense-in-depth: withBypass skips RLS, so re-prove tenancy on the loaded
  // row before unsealing anything.
  if (conn.orgId !== ctx.orgId) throw new Error("bank feed connection belongs to another organization");
  const adapter = getBankFeedAdapter(conn.provider);
  if (!adapter) return { ok: false, detail: "provider is not an API feed" };
  const creds = unsealJson<Record<string, string>>(conn.credentials) ?? {};
  return adapter.test(creds);
}

function cadenceIntervalMs(cadence: string): number {
  return cadence === "hourly" ? 3_600_000 : 86_400_000;
}

function sinceFor(lastSyncAt: Date | string | null, today: string): string {
  if (!lastSyncAt) {
    // Cold start: pull the last 90 days so the first sync has history.
    return addCalendarDays(today, -90);
  }
  const synced = (lastSyncAt instanceof Date ? lastSyncAt : new Date(lastSyncAt)).toISOString().slice(0, 10);
  // Re-pull a two-day overlap; importStatement dedupes on the provider txn id.
  return addCalendarDays(synced, -2);
}

export interface FeedSyncOutcome {
  connectionId: string;
  imported: number;
  duplicates: number;
  error?: string;
}

/**
 * Fetch and import one connection. `actorId` is the persisted provenance for
 * every statement/audit write: the interactive caller's user id, or
 * {@link SYSTEM_ACTOR_ID} on the scheduled path — never a placeholder.
 */
async function syncOne(
  row: {
    id: string;
    orgId: string;
    provider: string;
    accountId: string;
    credentials: string | null;
    externalAccountId: string | null;
    lastSyncAt: Date | string | null;
  },
  actorId: string,
): Promise<FeedSyncOutcome> {
  const adapter = getBankFeedAdapter(row.provider);
  if (!adapter) return { connectionId: row.id, imported: 0, duplicates: 0, error: "not an API provider" };
  const creds = unsealJson<Record<string, string>>(row.credentials) ?? {};
  const until = await businessToday(row.orgId);
  const since = sinceFor(row.lastSyncAt, until);
  const { lines, currency, sourceEvidence } = await adapter.fetch(
    creds,
    row.externalAccountId ?? "",
    since,
    until,
  );

  let imported = 0;
  let duplicates = 0;
  if (lines.length) {
    const result = await withOrg(row.orgId, () =>
      importStatement(
        {
          accountId: row.accountId,
          source: "feed_api",
          lines,
          currency: currency ?? undefined,
          sourceEvidence,
        },
        { orgId: row.orgId, userId: actorId },
      ),
    );
    imported = result.imported;
    duplicates = result.duplicates;
  }
  return { connectionId: row.id, imported, duplicates };
}

/**
 * Record one sync attempt. `last_sync_at` is the SUCCESS watermark that
 * `sinceFor` derives the next pull window from, so it may only move when the
 * sync completed without error — advancing it over a failed window would make
 * the next sync start after transactions that were never imported, dropping
 * them permanently and invisibly. Attempt bookkeeping (result payload, error,
 * status) is recorded either way. An empty-but-successful pull also advances:
 * the provider provably had nothing in the window.
 */
async function recordSyncOutcome(
  connection: { id: string; orgId: string },
  outcome: FeedSyncOutcome,
): Promise<void> {
  const lastResult = JSON.stringify({ imported: outcome.imported, duplicates: outcome.duplicates });
  await withBypass(async () => {
    await db.execute(outcome.error
      ? sql`
        update bank_feed_connections
           set last_result = ${lastResult}::jsonb,
               last_error = ${outcome.error},
               status = 'error'
         where id = ${connection.id} and org_id = ${connection.orgId}
      `
      : sql`
        update bank_feed_connections
           set last_sync_at = now(),
               last_result = ${lastResult}::jsonb,
               last_error = null,
               status = 'connected'
         where id = ${connection.id} and org_id = ${connection.orgId}
      `);
  });
}

/**
 * Scan every active API bank-feed connection that is due, claim it with a
 * compare-and-swap on next_sync_at (so multiple app servers never double-pull),
 * fetch and import. Run from the scheduler every tick — self-throttling.
 */
export async function runDueBankFeeds(): Promise<FeedSyncOutcome[]> {
  const now = Date.now();
  const due = await withBypass(async () =>
    (await db.execute<{
        id: string;
        orgId: string;
        provider: string;
        accountId: string;
        credentials: string | null;
        externalAccountId: string | null;
        syncCadence: string;
        nextSyncAt: Date | null;
        lastSyncAt: Date | string | null;
      }>(sql`
      select c.id, c.org_id as "orgId", c.provider, c.account_id as "accountId", c.credentials,
             c.external_account_id as "externalAccountId", c.sync_cadence as "syncCadence",
             c.next_sync_at as "nextSyncAt", c.last_sync_at as "lastSyncAt"
        from bank_feed_connections c
        join orgs o on o.id = c.org_id
       where c.is_active and c.provider in ('plaid', 'gocardless', 'truelayer')
         and o.env_kind = 'production'
         and coalesce((o.settings->'features'->>'bankFeeds')::boolean, false)
         and c.sync_cadence <> 'manual'
         and (c.next_sync_at is null or c.next_sync_at <= now())
    `)),
  );

  const outcomes: FeedSyncOutcome[] = [];
  for (const row of due.rows) {
    const nextSync = new Date(now + cadenceIntervalMs(row.syncCadence));
    // Claim: only the tick that moves next_sync_at off its current value wins.
    const claimed = await withBypass(async () =>
      (await db.execute<{ id: string }>(sql`
        update bank_feed_connections set next_sync_at = ${nextSync}
         where id = ${row.id} and org_id = ${row.orgId}
           and (next_sync_at is null and ${row.nextSyncAt === null} or next_sync_at = ${row.nextSyncAt})
        returning id
      `)),
    );
    if (!claimed.rows.length) continue;

    let outcome: FeedSyncOutcome;
    try {
      outcome = await syncOne(row, SYSTEM_ACTOR_ID);
    } catch (e) {
      outcome = { connectionId: row.id, imported: 0, duplicates: 0, error: e instanceof Error ? e.message : String(e) };
    }
    await recordSyncOutcome(row, outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Force-sync one connection now (the "Sync now" button). ctx.orgId scopes the
 * lookup: a foreign connection id fails closed before any tenant escalation
 * or statement write can occur. ctx.userId is the authenticated operator and
 * becomes the persisted actor for every statement/audit write this sync makes.
 */
export async function syncBankFeedNow(
  connectionId: string,
  ctx: { orgId: string; userId: string },
): Promise<FeedSyncOutcome> {
  const row = await withBypass(async () =>
    (await db.execute<{
        id: string;
        orgId: string;
        provider: string;
        accountId: string;
        credentials: string | null;
        externalAccountId: string | null;
        lastSyncAt: Date | string | null;
      }>(sql`
      select c.id, c.org_id as "orgId", c.provider, c.account_id as "accountId", c.credentials,
             c.external_account_id as "externalAccountId", c.last_sync_at as "lastSyncAt"
        from bank_feed_connections c
        join orgs o on o.id = c.org_id
       where c.id = ${connectionId}
         and c.org_id = ${ctx.orgId}
         and coalesce((o.settings->'features'->>'bankFeeds')::boolean, false)
    `)),
  );
  const conn = row.rows[0];
  if (!conn) throw new FeedError("connection not found");
  // Defense-in-depth: withBypass skips RLS, so re-prove tenancy on the loaded
  // row before escalating into it via withOrg in syncOne.
  if (conn.orgId !== ctx.orgId) throw new Error("bank feed connection belongs to another organization");
  let outcome: FeedSyncOutcome;
  try {
    outcome = await syncOne(conn, ctx.userId);
  } catch (e) {
    outcome = { connectionId, imported: 0, duplicates: 0, error: e instanceof Error ? e.message : String(e) };
  }
  await recordSyncOutcome(conn, outcome);
  return outcome;
}

/** Helper the API layer uses to seal a credentials object before storing. */
export function sealCredentials(creds: Record<string, string>): string {
  return sealJson(creds);
}

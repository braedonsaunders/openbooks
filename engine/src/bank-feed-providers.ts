import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "./db.ts";
import { importStatement, type ParsedStatementLine } from "./banking.ts";
import { neg, normalizeMoney } from "./money.ts";
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
  ): Promise<FeedFetchResult>;
}

class FeedError extends Error {}

async function asJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!res.ok) {
    throw new FeedError(`provider responded ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

// --------------------------------------------------------------------------
// GoCardless Bank Account Data (formerly Nordigen) — free, pan-European.
// Auth: exchange secret_id/secret_key for a bearer token, then read the
// account's transactions. Amounts are already account-perspective signed.
// --------------------------------------------------------------------------
const GOCARDLESS_BASE = "https://bankaccountdata.gocardless.com/api/v2";

async function gocardlessToken(creds: Record<string, string>): Promise<string> {
  if (!creds.secretId || !creds.secretKey) throw new FeedError("GoCardless secret_id / secret_key required");
  const res = await fetch(`${GOCARDLESS_BASE}/token/new/`, {
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
  async fetch(creds, externalAccountId, sinceIso) {
    if (!externalAccountId) throw new FeedError("GoCardless account id required");
    const token = await gocardlessToken(creds);
    const res = await fetch(
      `${GOCARDLESS_BASE}/accounts/${encodeURIComponent(externalAccountId)}/transactions/?date_from=${sinceIso}`,
      { headers: { Authorization: `Bearer ${token}`, accept: "application/json" } },
    );
    const body = await asJson(res);
    // Booked only: pendings change or vanish, so importing them would leave
    // statement evidence that can never reconcile at sign-off.
    const txns: any[] = body?.transactions?.booked ?? [];
    let currency: string | null = null;
    const lines: ParsedStatementLine[] = txns.map((t) => {
      currency ??= t?.transactionAmount?.currency ?? null;
      return {
        postedOn: (t.bookingDate || t.valueDate || sinceIso).slice(0, 10),
        amount: String(t?.transactionAmount?.amount ?? "0"),
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
    return { lines, currency };
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

/**
 * Accumulate every transactions/get page until Plaid reports has_more=false.
 * The page fetcher is injected so pagination is testable in isolation; the
 * hard page cap throws instead of letting history fall off the end silently.
 */
export async function plaidFetchAllTransactions(
  fetchPage: (offset: number) => Promise<{ transactions?: any[]; has_more?: boolean }>,
): Promise<any[]> {
  const all: any[] = [];
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
      const env = creds.env || "production";
      const res = await fetch(`https://${env}.plaid.com/accounts/get`, {
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
  async fetch(creds, externalAccountId, sinceIso) {
    const env = creds.env || "production";
    const today = new Date().toISOString().slice(0, 10);
    const accountOptions = externalAccountId ? { account_ids: [externalAccountId] } : {};
    const transactions = await plaidFetchAllTransactions(async (offset) => {
      const res = await fetch(`https://${env}.plaid.com/transactions/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          access_token: creds.accessToken,
          start_date: sinceIso,
          end_date: today,
          options: { ...accountOptions, count: PLAID_PAGE_SIZE, offset },
        }),
      });
      return await asJson(res);
    });
    let currency: string | null = null;
    const lines: ParsedStatementLine[] = transactions.map((t: any) => {
      currency ??= t.iso_currency_code ?? null;
      // Plaid: positive amount = outflow. Bank convention wants −withdrawal.
      const signed = t.amount != null ? neg(normalizeMoney(String(t.amount))) : "0.0000";
      return {
        postedOn: (t.date || sinceIso).slice(0, 10),
        amount: signed,
        description: t.name || t.merchant_name || null,
        counterpartyRef: t.merchant_name || null,
        bankTransactionId: t.transaction_id || null,
      };
    });
    return { lines, currency };
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
      const res = await fetch("https://api.truelayer.com/data/v1/accounts", {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      await asJson(res);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
  async fetch(creds, externalAccountId, sinceIso) {
    if (!externalAccountId) throw new FeedError("TrueLayer account id required");
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `https://api.truelayer.com/data/v1/accounts/${encodeURIComponent(externalAccountId)}/transactions?from=${sinceIso}T00:00:00Z&to=${today}T23:59:59Z`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } },
    );
    const body = await asJson(res);
    let currency: string | null = null;
    const lines: ParsedStatementLine[] = (body.results ?? []).map((t: any) => {
      currency ??= t.currency ?? null;
      return {
        postedOn: (t.timestamp || sinceIso).slice(0, 10),
        amount: t.amount != null ? String(t.amount) : "0",
        description: t.description || t.merchant_name || null,
        counterpartyRef: t.merchant_name || null,
        bankTransactionId: t.transaction_id || t.normalised_provider_transaction_id || null,
      };
    });
    return { lines, currency };
  },
};

const ADAPTERS: Record<BankFeedProvider, BankFeedAdapter> = { gocardless, plaid, truelayer };

export function getBankFeedAdapter(provider: string): BankFeedAdapter | null {
  return (ADAPTERS as Record<string, BankFeedAdapter>)[provider] ?? null;
}

/** Test a connection's stored credentials (called by the "Test" button). */
export async function testBankFeedConnection(
  connectionId: string,
): Promise<{ ok: boolean; detail?: string }> {
  const row = await withBypass(async () =>
    (await db.execute<{ provider: string; credentials: string | null }>(sql`
      select c.provider, c.credentials
        from bank_feed_connections c
        join orgs o on o.id = c.org_id
       where c.id = ${connectionId}
         and coalesce((o.settings->'features'->>'bankFeeds')::boolean, false)
    `)),
  );
  const conn = row.rows[0];
  if (!conn) return { ok: false, detail: "connection not found" };
  const adapter = getBankFeedAdapter(conn.provider);
  if (!adapter) return { ok: false, detail: "provider is not an API feed" };
  const creds = unsealJson<Record<string, string>>(conn.credentials) ?? {};
  return adapter.test(creds);
}

function cadenceIntervalMs(cadence: string): number {
  return cadence === "hourly" ? 3_600_000 : 86_400_000;
}

function sinceFor(lastSyncAt: Date | string | null): string {
  if (!lastSyncAt) {
    // Cold start: pull the last 90 days so the first sync has history.
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 90);
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(lastSyncAt);
  // Re-pull a two-day overlap; importStatement dedupes on the provider txn id.
  d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
}

export interface FeedSyncOutcome {
  connectionId: string;
  imported: number;
  duplicates: number;
  error?: string;
}

async function syncOne(row: {
  id: string;
  orgId: string;
  provider: string;
  accountId: string;
  credentials: string | null;
  externalAccountId: string | null;
  lastSyncAt: Date | string | null;
}): Promise<FeedSyncOutcome> {
  const adapter = getBankFeedAdapter(row.provider);
  if (!adapter) return { connectionId: row.id, imported: 0, duplicates: 0, error: "not an API provider" };
  const creds = unsealJson<Record<string, string>>(row.credentials) ?? {};
  const since = sinceFor(row.lastSyncAt);
  const { lines, currency } = await adapter.fetch(creds, row.externalAccountId ?? "", since);

  let imported = 0;
  let duplicates = 0;
  if (lines.length) {
    const result = await withOrg(row.orgId, () =>
      importStatement(
        { accountId: row.accountId, source: "feed_api", lines, currency: currency ?? undefined },
        { orgId: row.orgId, userId: "00000000-0000-0000-0000-000000000000" },
      ),
    );
    imported = result.imported;
    duplicates = result.duplicates;
  }
  return { connectionId: row.id, imported, duplicates };
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
         where id = ${row.id}
           and (next_sync_at is null and ${row.nextSyncAt === null} or next_sync_at = ${row.nextSyncAt})
        returning id
      `)),
    );
    if (!claimed.rows.length) continue;

    let outcome: FeedSyncOutcome;
    try {
      outcome = await syncOne(row);
    } catch (e) {
      outcome = { connectionId: row.id, imported: 0, duplicates: 0, error: e instanceof Error ? e.message : String(e) };
    }
    await withBypass(async () => {
      await db.execute(sql`
        update bank_feed_connections
           set last_sync_at = now(),
               last_result = ${JSON.stringify({ imported: outcome.imported, duplicates: outcome.duplicates })}::jsonb,
               last_error = ${outcome.error ?? null},
               status = ${outcome.error ? "error" : "connected"}
         where id = ${row.id}
      `);
    });
    outcomes.push(outcome);
  }
  return outcomes;
}

/** Force-sync one connection now (the "Sync now" button). */
export async function syncBankFeedNow(connectionId: string): Promise<FeedSyncOutcome> {
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
         and coalesce((o.settings->'features'->>'bankFeeds')::boolean, false)
    `)),
  );
  const conn = row.rows[0];
  if (!conn) throw new FeedError("connection not found");
  let outcome: FeedSyncOutcome;
  try {
    outcome = await syncOne(conn);
  } catch (e) {
    outcome = { connectionId, imported: 0, duplicates: 0, error: e instanceof Error ? e.message : String(e) };
  }
  await withBypass(async () => {
    await db.execute(sql`
      update bank_feed_connections
         set last_sync_at = now(),
             last_result = ${JSON.stringify({ imported: outcome.imported, duplicates: outcome.duplicates })}::jsonb,
             last_error = ${outcome.error ?? null},
             status = ${outcome.error ? "error" : "connected"}
       where id = ${connectionId}
    `);
  });
  return outcome;
}

/** Helper the API layer uses to seal a credentials object before storing. */
export function sealCredentials(creds: Record<string, string>): string {
  return sealJson(creds);
}

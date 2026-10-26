import { sql } from "drizzle-orm";
import {
  db,
  withBypass,
  withOrg,
  withOrgContext,
  withOrgTransaction,
  type SqlExecutor,
} from "../platform/db.ts";
import {
  importStatement,
  requireBankAccountInScope,
  SYSTEM_ACTOR_ID,
  type ParsedStatementLine,
  type StatementSourceEvidence,
} from "./banking.ts";
import { addCalendarDays, businessToday } from "../platform/business-date.ts";
import { neg, normalizeMoney } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { sealJson, unsealJson } from "../platform/secrets.ts";
import { assertRealDate } from "./statement-parsers/shared.ts";

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
    options?: BankFeedFetchOptions,
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

/** One provider HTTP exchange, headers and body included, may take at most this long. */
const BANK_FEED_REQUEST_TIMEOUT_MS = 30_000;
/** A whole feed sync (Plaid paginates) may spend at most this long on provider I/O. */
const BANK_FEED_SYNC_DEADLINE_MS = 120_000;
/** Largest provider response body accepted. Larger bodies are refused, never truncated. */
const BANK_FEED_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;

export interface BankFeedFetchOptions {
  /** Caller deadline or cancellation, combined with the per-request deadline. */
  signal?: AbortSignal;
  /** Per-request deadline override; defaults to the provider request timeout. */
  requestTimeoutMs?: number;
}

function providerDeadlineError(provider: string): FeedError {
  return new FeedError(`${provider} did not respond before the bank feed deadline; retry the sync`);
}

function providerResponseTooLargeError(provider: string): FeedError {
  return new FeedError(
    `${provider} response exceeded the ${BANK_FEED_RESPONSE_MAX_BYTES / (1024 * 1024)} MB limit; ` +
      "set this connection to sync hourly so each pull covers less history, then retry",
  );
}

/** Settle with `work`, or with the signal's reason as soon as it aborts. A
 *  provider that ignores the abort signal still cannot hold the sync open. */
function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** Read the whole body under the deadline, refusing as soon as it exceeds the byte cap. */
async function readCappedBody(
  provider: string,
  res: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const next = await untilAborted(signal, reader.read());
      if (next.done) break;
      received += next.value.byteLength;
      if (received > BANK_FEED_RESPONSE_MAX_BYTES) throw providerResponseTooLargeError(provider);
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  const raw = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

/** Keep provider JSON number tokens on amount fields exact before JSON.parse
 *  rounds them through IEEE-754. Other provider fields retain normal JSON
 *  types, while every mapped amount still passes the same decimal validator. */
function parseProviderJson(text: string): unknown {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  for (let index = 0; index < text.length;) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"') break;
    }
    let key: unknown;
    try {
      key = JSON.parse(text.slice(start, index));
    } catch {
      continue;
    }
    if (key !== "amount") continue;
    let valueStart = index;
    while (/\s/.test(text[valueStart] ?? "")) valueStart += 1;
    if (text[valueStart] !== ":") continue;
    valueStart += 1;
    while (/\s/.test(text[valueStart] ?? "")) valueStart += 1;
    numberPattern.lastIndex = valueStart;
    const match = numberPattern.exec(text);
    if (!match) continue;
    replacements.push({
      start: valueStart,
      end: numberPattern.lastIndex,
      value: JSON.stringify(match[0]),
    });
  }
  let exactText = text;
  for (const replacement of replacements.reverse()) {
    exactText = `${exactText.slice(0, replacement.start)}${replacement.value}${exactText.slice(replacement.end)}`;
  }
  return JSON.parse(exactText) as unknown;
}

/** Narrow an untrusted provider payload to a field bag. Anything that is
 *  not a JSON object projects to {} so every existing optional-chain read
 *  keeps its missing-envelope meaning. */
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the GoCardless bearer token off an untrusted token payload. Anything
 *  but a non-empty string fails closed: the old check passed any truthy
 *  value through into the Authorization header. */
function gocardlessAccessToken(body: unknown): string {
  const access = isJsonRecord(body) ? body.access : undefined;
  if (typeof access !== "string" || access === "") {
    throw new FeedError("GoCardless did not return an access token");
  }
  return access;
}

/** Project an untrusted provider list field. Missing stays missing (empty);
 *  a present-but-not-a-list fails closed with a named FeedError instead of
 *  an accidental TypeError two frames later. */
function providerTransactionList<T>(value: unknown, provider: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new FeedError(`${provider} transactions were not a list`);
  return value as T[];
}

/** One GoCardless booked-transaction object; every field is optional because
 *  the provider omits what it does not know and the mapper falls back. */
export interface GoCardlessTransaction {
  bookingDate?: string;
  bookingDateTime?: string;
  valueDate?: string;
  valueDateTime?: string;
  transactionAmount?: { amount?: unknown; currency?: string };
  remittanceInformationUnstructured?: string;
  remittanceInformationUnstructuredArray?: string[];
  creditorName?: string;
  debtorName?: string;
  internalTransactionId?: string;
  transactionId?: string;
}

/** Keep the bank's calendar date; an import window is not booking evidence. */
function gocardlessPostedOn(transaction: GoCardlessTransaction): string {
  const value =
    transaction.bookingDate ||
    transaction.bookingDateTime ||
    transaction.valueDate ||
    transaction.valueDateTime;
  if (typeof value !== "string") {
    throw new FeedError(
      "GoCardless booked transaction has no booking or value date; obtain dated transaction evidence before importing",
    );
  }
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) {
    throw new FeedError(
      "GoCardless booked transaction has an invalid booking or value date; obtain corrected transaction evidence before importing",
    );
  }
  return assertRealDate(parts[1]!, parts[2]!, parts[3]!, "GoCardless booking date");
}

/** One Plaid transactions/get transaction object. */
export interface PlaidTransaction {
  pending?: boolean;
  iso_currency_code?: string;
  amount?: unknown;
  date?: string;
  name?: string;
  merchant_name?: string;
  transaction_id?: string;
}

/** One TrueLayer Data API transaction object. */
export interface TrueLayerTransaction {
  currency?: string;
  timestamp?: string;
  amount?: unknown;
  description?: string;
  merchant_name?: string;
  transaction_id?: string;
  normalised_provider_transaction_id?: string;
}

/** One provider JSON exchange under a deadline. The deadline covers the
 *  headers and the body, so a trickling response cannot hold a sync open.
 *
 *  Provider credentials must never cross an HTTP redirect boundary. Even a
 *  trusted API origin can otherwise redirect a POST (including its body and
 *  authorization headers) to a host that was never allowlisted. */
async function providerJson(
  provider: string,
  url: string,
  init: RequestInit,
  options: BankFeedFetchOptions = {},
): Promise<{ body: unknown; raw: Uint8Array }> {
  const requestDeadline = AbortSignal.timeout(
    options.requestTimeoutMs ?? BANK_FEED_REQUEST_TIMEOUT_MS,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, requestDeadline])
    : requestDeadline;
  try {
    const res = await untilAborted(signal, fetch(url, { ...init, redirect: "error", signal }));
    const raw = await readCappedBody(provider, res, signal);
    const text = Buffer.from(raw).toString("utf8");
    if (!res.ok) {
      throw new FeedError(`provider responded ${res.status}: ${text.slice(0, 300)}`);
    }
    return { body: text ? (parseProviderJson(text) as unknown) : {}, raw };
  } catch (error) {
    if (signal.aborted) throw providerDeadlineError(provider);
    throw error;
  }
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

async function gocardlessToken(
  creds: Record<string, string>,
  options?: BankFeedFetchOptions,
): Promise<string> {
  if (!creds.secretId || !creds.secretKey)
    throw new FeedError("GoCardless secret_id / secret_key required");
  const { body } = await providerJson(
    "GoCardless",
    `${GOCARDLESS_BASE}/token/new/`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ secret_id: creds.secretId, secret_key: creds.secretKey }),
    },
    options,
  );
  return gocardlessAccessToken(body);
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
  async fetch(creds, externalAccountId, sinceIso, untilIso, options) {
    if (!externalAccountId) throw new FeedError("GoCardless account id required");
    const token = await gocardlessToken(creds, options);
    const { body, raw } = await providerJson(
      "GoCardless",
      `${GOCARDLESS_BASE}/accounts/${encodeURIComponent(externalAccountId)}/transactions/?date_from=${sinceIso}&date_to=${untilIso}`,
      { headers: { Authorization: `Bearer ${token}`, accept: "application/json" } },
      options,
    );
    // Booked only: pendings change or vanish, so importing them would leave
    // statement evidence that can never reconcile at sign-off.
    const payload = isJsonRecord(body) ? body : {};
    const envelope = isJsonRecord(payload.transactions) ? payload.transactions.booked : undefined;
    const txns = providerTransactionList<GoCardlessTransaction>(envelope, "GoCardless booked");
    let currency: string | null = null;
    const lines: ParsedStatementLine[] = txns.map((t) => {
      currency ??= t?.transactionAmount?.currency ?? null;
      return {
        postedOn: gocardlessPostedOn(t),
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
        // The bank-supplied transactionId is not unique per booking; the
        // provider's internal id is the stable dedupe identity.
        bankTransactionId: t.internalTransactionId || t.transactionId || null,
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
 * Accumulate every transactions/get page against its total_transactions.
 * The page fetcher is injected so pagination is testable in isolation; the
 * hard page cap throws instead of letting history fall off the end silently.
 */
export async function plaidFetchAllTransactions(
  fetchPage: (
    offset: number,
  ) => Promise<{ transactions: PlaidTransaction[]; total_transactions: unknown }>,
): Promise<PlaidTransaction[]> {
  const all: PlaidTransaction[] = [];
  let expectedTotal: number | undefined;
  const identities = new Set<string>();
  for (let page = 1; ; page += 1) {
    if (page > PLAID_MAX_PAGES) {
      throw new FeedError(
        `Plaid feed exceeded ${PLAID_MAX_PAGES} pages (${PLAID_MAX_PAGES * PLAID_PAGE_SIZE} transactions) — narrow the sync window instead of truncating history`,
      );
    }
    const body = await fetchPage(all.length);
    const total = body.total_transactions;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
      throw new FeedError(
        "Plaid did not return a valid transaction total; retry the complete sync window",
      );
    }
    expectedTotal ??= total;
    if (total !== expectedTotal) {
      throw new FeedError(
        "Plaid transaction total changed during pagination; retry the complete sync window",
      );
    }
    if (
      !Array.isArray(body.transactions) ||
      body.transactions.length > PLAID_PAGE_SIZE ||
      all.length + body.transactions.length > total
    ) {
      throw new FeedError(
        "Plaid transaction page does not match its total; retry the complete sync window",
      );
    }
    if (!body.transactions.length && all.length < total) {
      throw new FeedError(
        "Plaid returned an incomplete transaction page; retry the complete sync window",
      );
    }
    for (const transaction of body.transactions) {
      if (transaction?.transaction_id) {
        if (identities.has(transaction.transaction_id)) {
          throw new FeedError(
            "Plaid repeated a transaction during pagination; retry the complete sync window",
          );
        }
        identities.add(transaction.transaction_id);
      }
    }
    all.push(...body.transactions);
    if (all.length === total) return all;
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
      await providerJson("Plaid", `${base}/accounts/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          access_token: creds.accessToken,
        }),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
  async fetch(creds, externalAccountId, sinceIso, untilIso, options) {
    const accountId = externalAccountId.trim();
    if (!accountId) throw new FeedError("Plaid account id required");
    const base = plaidApiBase(creds.env);
    const today = untilIso;
    const rawResponses: Uint8Array[] = [];
    const transactions = await plaidFetchAllTransactions(async (offset) => {
      const { body, raw } = await providerJson(
        "Plaid",
        `${base}/transactions/get`,
        {
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
        },
        options,
      );
      rawResponses.push(raw);
      const payload = isJsonRecord(body) ? body : {};
      return {
        transactions: payload.transactions as PlaidTransaction[],
        total_transactions: payload.total_transactions,
      };
    });
    let currency: string | null = null;
    // Settled only: pending authorizations change amount, post under a new
    // transaction id, or vanish, so importing them would leave statement
    // evidence that can never reconcile at sign-off (same reason GoCardless
    // takes booked transactions only).
    const lines: ParsedStatementLine[] = transactions
      .filter((t) => !t?.pending)
      .map((t) => {
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
      await providerJson("TrueLayer", "https://api.truelayer.com/data/v1/accounts", {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
  async fetch(creds, externalAccountId, sinceIso, untilIso, options) {
    if (!externalAccountId) throw new FeedError("TrueLayer account id required");
    const today = untilIso;
    const { body, raw } = await providerJson(
      "TrueLayer",
      `https://api.truelayer.com/data/v1/accounts/${encodeURIComponent(externalAccountId)}/transactions?from=${sinceIso}T00:00:00Z&to=${today}T23:59:59Z`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } },
      options,
    );
    let currency: string | null = null;
    const txns = providerTransactionList<TrueLayerTransaction>(
      isJsonRecord(body) ? body.results : undefined,
      "TrueLayer",
    );
    const lines: ParsedStatementLine[] = txns.map((t) => {
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
  credentialSnapshot?: string | null,
): Promise<{ ok: boolean; detail?: string }> {
  const row = await withOrgContext(
    ctx.orgId,
    async () =>
      await db.execute<{ orgId: string; provider: string; credentials: string | null }>(
        sql`
      select c.org_id as "orgId", c.provider, c.credentials
        from bank_feed_connections c
        join orgs o on o.id = c.org_id
       where c.id = ${connectionId}
         and c.org_id = ${ctx.orgId}
         and case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end -- registry fallback shape (non-boolean stored values fall back to the default instead of throwing 22P02)
    `,
        "objects",
      ),
  );
  const conn = row[0];
  if (!conn) return { ok: false, detail: "connection not found" };
  const adapter = getBankFeedAdapter(conn.provider);
  if (!adapter) return { ok: false, detail: "provider is not an API feed" };
  const sealedCredentials =
    credentialSnapshot === undefined ? conn.credentials : credentialSnapshot;
  const creds =
    sealedCredentials == null
      ? {}
      : (unsealJson<Record<string, string>>(sealedCredentials, {
          orgId: ctx.orgId,
          purpose: "bankfeed.credentials",
        }) ?? {});
  return adapter.test(creds);
}

function cadenceIntervalMs(cadence: string): number {
  return cadence === "hourly" ? 3_600_000 : 86_400_000;
}

/**
 * Default re-pull overlap in days. Late-posting transactions (booking dates
 * days behind the last successful sync — weekend batches, slow banks) fall
 * outside a 2-day overlap forever: dedupe prevents duplicates, not gaps, and
 * pending transactions are filtered out, so nothing ever re-covers them.
 * Fourteen days covers weekly-batch stragglers without re-pulling months of
 * history on every tick; importStatement dedupes on the provider txn id, so
 * the wider window only costs provider paging.
 */
export const DEFAULT_FEED_SYNC_OVERLAP_DAYS = 14;

/**
 * Overlap ceiling in days. Wider than the 90-day cold start is pointless —
 * it would re-pull cold-start history on every sync, and Plaid's 10k-per-sync
 * page cap turns that into a loud abort on busy accounts.
 */
export const MAX_FEED_SYNC_OVERLAP_DAYS = 90;

/**
 * Resolve a connection's configured overlap to whole days. Null/undefined
 * means the default; anything outside 0..90 refuses by name (surfaced as the
 * sync outcome's error, never a silently narrowed window).
 */
export function resolveFeedSyncOverlapDays(value: unknown): number {
  if (value === null || value === undefined) return DEFAULT_FEED_SYNC_OVERLAP_DAYS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_FEED_SYNC_OVERLAP_DAYS
  ) {
    throw new FeedError(
      `sync overlap must be a whole number of days from 0 to ${MAX_FEED_SYNC_OVERLAP_DAYS}`,
    );
  }
  return value;
}

export function sinceFor(
  lastSyncAt: Date | string | null,
  today: string,
  overlapDays: number = DEFAULT_FEED_SYNC_OVERLAP_DAYS,
): string {
  // Reads the SUCCESS watermark only. Attempt bookkeeping (last_attempt_at)
  // must never feed into this window: failed syncs happen on top of the last
  // real cursor, and a retry has to re-cover their whole unimported span.
  if (!lastSyncAt) {
    // Cold start: pull the last 90 days so the first sync has history.
    return addCalendarDays(today, -90);
  }
  const synced = (lastSyncAt instanceof Date ? lastSyncAt : new Date(lastSyncAt))
    .toISOString()
    .slice(0, 10);
  // Re-pull the overlap; importStatement dedupes on the provider txn id.
  return addCalendarDays(synced, -overlapDays);
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
    syncOverlapDays: number | null;
    configurationRevision: string;
  },
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<FeedSyncOutcome> {
  const adapter = getBankFeedAdapter(row.provider);
  if (!adapter)
    return { connectionId: row.id, imported: 0, duplicates: 0, error: "not an API provider" };
  const creds =
    row.credentials == null
      ? {}
      : (unsealJson<Record<string, string>>(row.credentials, {
          orgId: row.orgId,
          purpose: "bankfeed.credentials",
        }) ?? {});
  const until = await businessToday(row.orgId);
  // A misconfigured overlap refuses here and surfaces as the outcome's
  // error (callers catch into it) — never a silently narrowed window.
  const since = sinceFor(row.lastSyncAt, until, resolveFeedSyncOverlapDays(row.syncOverlapDays));
  // One deadline bounds every provider request this feed makes (Plaid pages
  // included), so a stalled feed fails its own outcome instead of holding the
  // scheduler tick for the other connections.
  const { lines, currency, sourceEvidence } = await adapter.fetch(
    creds,
    row.externalAccountId ?? "",
    since,
    until,
    { signal: AbortSignal.timeout(BANK_FEED_SYNC_DEADLINE_MS) },
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
          // Unattended sync: flagged possible duplicates import for review
          // rather than being dropped with no operator to decide.
          includePossibleDuplicates: true,
          beforeWrite: (executor) => assertCurrentSyncConfiguration(executor, row),
        },
        { orgId: row.orgId, userId: actorId, allowedSubsidiaryIds },
      ),
    );
    imported = result.imported;
    duplicates = result.duplicates;
  } else {
    await withOrg(row.orgId, () => assertCurrentSyncConfiguration(db, row));
  }
  return { connectionId: row.id, imported, duplicates };
}

/** Hold the configuration row stable while fetched lines enter the ledger. */
async function assertCurrentSyncConfiguration(
  executor: SqlExecutor,
  connection: { id: string; orgId: string; configurationRevision: string },
): Promise<void> {
  const current = await executor.execute(
    sql`
    select c.id from bank_feed_connections c
      join orgs o on o.id = c.org_id
     where c.id = ${connection.id} and c.org_id = ${connection.orgId}
       and c.updated_at::text = ${connection.configurationRevision}
       and c.is_active and c.provider in ('plaid', 'gocardless', 'truelayer')
       and case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end
     for share of c, o
  `,
    "objects",
  );
  if (!current.length)
    throw new FeedError("Bank feed configuration changed during sync; run the sync again");
}

/**
 * Record one finished sync attempt. Two independent cursors:
 *
 *  - `last_sync_at` is the SUCCESS watermark that `sinceFor` derives the next
 *    pull window from, so it may only move when the sync completed without
 *    error — advancing it over a failed window would make the next sync start
 *    after transactions that were never imported, dropping them permanently
 *    and invisibly. An empty-but-successful pull also advances: the provider
 *    provably had nothing in the window.
 *  - `last_attempt_at` is the ATTEMPT watermark: moved on every finished
 *    attempt (success or failure) so operator surfaces can show how recently
 *    a failing feed actually tried. It never feeds back into window
 *    derivation.
 */
async function recordSyncOutcome(
  connection: { id: string; orgId: string; configurationRevision: string },
  outcome: FeedSyncOutcome,
): Promise<boolean> {
  const lastResult = JSON.stringify({ imported: outcome.imported, duplicates: outcome.duplicates });
  return withOrgTransaction(connection.orgId, async () => {
    const result = await db.execute(
      outcome.error
        ? sql`
        update bank_feed_connections
           set last_attempt_at = now(),
               last_result = ${lastResult}::jsonb,
               last_error = ${outcome.error},
               status = 'error'
         where id = ${connection.id} and org_id = ${connection.orgId}
           and updated_at::text = ${connection.configurationRevision} and is_active
           and exists (select 1 from orgs o where o.id = bank_feed_connections.org_id
             and case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end)
         returning id
      `
        : sql`
        update bank_feed_connections
           set last_attempt_at = now(),
               last_sync_at = now(),
               last_result = ${lastResult}::jsonb,
               last_error = null,
               status = 'connected'
         where id = ${connection.id} and org_id = ${connection.orgId}
           and updated_at::text = ${connection.configurationRevision} and is_active
           and exists (select 1 from orgs o where o.id = bank_feed_connections.org_id
             and case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end)
         returning id
      `,
      "objects",
    );
    return result.length > 0;
  });
}

/** Wall-clock budget for one scheduler pass over due bank feeds. Feeds the pass
 *  has not started when the budget is spent stay due for the next tick. */
export const BANK_FEED_PASS_BUDGET_MS = 5 * 60_000;

export interface RunDueBankFeedsOptions {
  /** Time a pass may spend starting feeds. Defaults to BANK_FEED_PASS_BUDGET_MS. */
  budgetMs?: number;
  /** Monotonic millisecond clock. Defaults to performance.now(). */
  clock?: () => number;
}

/**
 * Run one pass over feeds that are already due. A feed is started only while
 * the budget has time left. Feeds the pass does not reach are counted as
 * deferred and are never handed to syncFeed, so their next_sync_at is
 * untouched and they stay due. A failure while claiming or recording one feed
 * becomes that feed's outcome error and never stops the pass.
 */
export async function runDueFeedPass<Row extends { id: string }>(
  rows: readonly Row[],
  syncFeed: (row: Row) => Promise<FeedSyncOutcome | null>,
  limits: { budgetMs: number; clock: () => number },
): Promise<{ outcomes: FeedSyncOutcome[]; deferred: number }> {
  const startedAt = limits.clock();
  const outcomes: FeedSyncOutcome[] = [];
  for (const [index, row] of rows.entries()) {
    if (limits.clock() - startedAt >= limits.budgetMs) {
      return { outcomes, deferred: rows.length - index };
    }
    try {
      const outcome = await syncFeed(row);
      if (outcome) outcomes.push(outcome);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        `[bank-feeds] connection ${row.id} could not be claimed or recorded: ${message}`,
      );
      outcomes.push({
        connectionId: row.id,
        imported: 0,
        duplicates: 0,
        error: `bank feed could not be claimed or recorded: ${message}`,
      });
    }
  }
  return { outcomes, deferred: 0 };
}

/**
 * Scan every active API bank-feed connection that is due, claim it with a
 * compare-and-swap on next_sync_at (so multiple app servers never double-pull),
 * fetch and import. Run from the scheduler every tick — self-throttling.
 *
 * A pass starts feeds only while its budget has time left. Feeds it does not
 * reach are never claimed, so they stay due and the next tick picks them up.
 */
export async function runDueBankFeeds(
  options: RunDueBankFeedsOptions = {},
): Promise<FeedSyncOutcome[]> {
  const now = Date.now();
  // bypass: scheduler-tick — the scan finds due feed connections across every organization.
  const due = await withBypass(
    async () =>
      await db.execute<{
        id: string;
        orgId: string;
        provider: string;
        accountId: string;
        credentials: string | null;
        externalAccountId: string | null;
        syncCadence: string;
        nextSyncAt: Date | null;
        lastSyncAt: Date | string | null;
        syncOverlapDays: number | null;
        configurationRevision: string;
      }>(
        sql`
      select c.id, c.org_id as "orgId", c.provider, c.account_id as "accountId", c.credentials,
             c.external_account_id as "externalAccountId", c.sync_cadence as "syncCadence",
             c.next_sync_at as "nextSyncAt", c.last_sync_at as "lastSyncAt",
             c.sync_overlap_days as "syncOverlapDays",
             c.updated_at::text as "configurationRevision"
        from bank_feed_connections c
        join orgs o on o.id = c.org_id
       where c.is_active and c.provider in ('plaid', 'gocardless', 'truelayer')
         and o.env_kind = 'production'
         and case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end -- registry fallback shape (non-boolean stored values fall back to the default instead of throwing 22P02)
         and c.sync_cadence <> 'manual'
         and (c.next_sync_at is null or c.next_sync_at <= now())
    `,
        "objects",
      ),
  );

  const { outcomes, deferred } = await runDueFeedPass(due, (row) => claimAndSyncDueFeed(row, now), {
    budgetMs: options.budgetMs ?? BANK_FEED_PASS_BUDGET_MS,
    clock: options.clock ?? (() => performance.now()),
  });
  if (deferred > 0) {
    console.warn(
      `[bank-feeds] pass budget of ${options.budgetMs ?? BANK_FEED_PASS_BUDGET_MS} ms spent; ` +
        `deferred ${deferred} due feed(s) to the next tick`,
    );
  }
  return outcomes;
}

/**
 * Claim one due connection and sync it. Returns null when another replica won
 * the claim first. Failures of the sync are recorded on the returned outcome;
 * a failure to record that outcome is logged and recorded on it too.
 */
async function claimAndSyncDueFeed(
  row: {
    id: string;
    orgId: string;
    syncCadence: string;
    nextSyncAt: Date | null;
    configurationRevision: string;
  },
  now: number,
): Promise<FeedSyncOutcome | null> {
  const nextSync = new Date(now + cadenceIntervalMs(row.syncCadence));
  // The scan is only a candidate list. Claim the row only if its complete
  // configuration revision and eligibility are still current, and sync
  // exclusively from the values returned by that successful claim.
  const claimed = await withOrgTransaction(
    row.orgId,
    async () =>
      await db.execute<{
        id: string;
        orgId: string;
        provider: string;
        accountId: string;
        credentials: string | null;
        externalAccountId: string | null;
        syncCadence: string;
        nextSyncAt: Date | null;
        lastSyncAt: Date | string | null;
        syncOverlapDays: number | null;
        configurationRevision: string;
      }>(
        sql`
      update bank_feed_connections c set next_sync_at = ${nextSync}
        from orgs o
       where c.id = ${row.id} and c.org_id = ${row.orgId} and o.id = c.org_id
         and c.updated_at::text = ${row.configurationRevision}
         and c.is_active and c.provider in ('plaid', 'gocardless', 'truelayer')
         and o.env_kind = 'production'
         and case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end
         and c.sync_cadence <> 'manual'
         and (c.next_sync_at is null and ${row.nextSyncAt === null} or c.next_sync_at = ${row.nextSyncAt})
      returning c.id, c.org_id as "orgId", c.provider,
                c.account_id as "accountId", c.credentials,
                c.external_account_id as "externalAccountId",
                c.sync_cadence as "syncCadence", c.next_sync_at as "nextSyncAt",
                c.last_sync_at as "lastSyncAt", c.sync_overlap_days as "syncOverlapDays",
                c.updated_at::text as "configurationRevision"
    `,
        "objects",
      ),
  );
  const claim = claimed[0];
  if (!claim) return null;

  let outcome: FeedSyncOutcome;
  try {
    outcome = await syncOne(claim, SYSTEM_ACTOR_ID, null);
  } catch (e) {
    outcome = {
      connectionId: row.id,
      imported: 0,
      duplicates: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  try {
    if (!(await recordSyncOutcome(claim, outcome)))
      outcome.error = "Bank feed configuration changed during sync; run the sync again";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[bank-feeds] connection ${row.id} sync outcome could not be recorded: ${message}`,
    );
    outcome.error = `sync outcome could not be recorded: ${message}`;
  }
  return outcome;
}

/**
 * Force-sync one connection now (the "Sync now" button). ctx.orgId scopes the
 * lookup: a foreign connection id fails closed before any tenant escalation
 * or statement write can occur. ctx.userId is the authenticated operator and
 * becomes the persisted actor for every statement/audit write this sync makes.
 */
export async function syncBankFeedNow(
  connectionId: string,
  ctx: { orgId: string; userId: string; allowedSubsidiaryIds: ReadonlySet<string> | null },
): Promise<FeedSyncOutcome> {
  const row = await withOrgContext(
    ctx.orgId,
    async () =>
      await db.execute<{
        id: string;
        orgId: string;
        provider: string;
        accountId: string;
        credentials: string | null;
        externalAccountId: string | null;
        lastSyncAt: Date | string | null;
        syncOverlapDays: number | null;
        configurationRevision: string;
      }>(
        sql`
      select c.id, c.org_id as "orgId", c.provider, c.account_id as "accountId", c.credentials,
             c.external_account_id as "externalAccountId", c.last_sync_at as "lastSyncAt",
             c.sync_overlap_days as "syncOverlapDays", c.updated_at::text as "configurationRevision"
        from bank_feed_connections c
        join orgs o on o.id = c.org_id
       where c.id = ${connectionId}
         and c.org_id = ${ctx.orgId}
         and c.is_active and c.provider in ('plaid', 'gocardless', 'truelayer')
         and case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end -- registry fallback shape (non-boolean stored values fall back to the default instead of throwing 22P02)
    `,
        "objects",
      ),
  );
  const conn = row[0];
  if (!conn) throw new FeedError("connection not found");
  // The route gates the connection's account before calling, and the engine
  // re-proves it here on the freshly loaded row: a sync filing another
  // entity's statements refuses before any network or statement write, and
  // outside the outcome-catching try below so the refusal throws instead of
  // reading as a sync error.
  await requireBankAccountInScope(db, ctx.orgId, conn.accountId, ctx.allowedSubsidiaryIds);
  let outcome: FeedSyncOutcome;
  try {
    outcome = await syncOne(conn, ctx.userId, ctx.allowedSubsidiaryIds);
  } catch (e) {
    outcome = {
      connectionId,
      imported: 0,
      duplicates: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (!(await recordSyncOutcome(conn, outcome)))
    outcome.error = "Bank feed configuration changed during sync; run the sync again";
  return outcome;
}

/** Helper the API layer uses to seal a credentials object before storing. */
export function sealCredentials(orgId: string, creds: Record<string, string>): string {
  return sealJson(creds, { orgId, purpose: "bankfeed.credentials" });
}

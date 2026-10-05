import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { add, cmp, neg } from "../money/money.ts";
import { unsealJson } from "../platform/secrets.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import {
  providerCommitEnabled,
  providerMoney,
  readTaxProviderJson,
  readTaxRateProviderConfig,
  taxProviderFetch,
  TAX_PROVIDER_REQUEST_TIMEOUT_MS,
  TaxRateProviderError,
  wireAmountOrThrow,
  type Address,
  type TaxProviderOutboundOptions,
  type TaxRateProviderConfigRow,
} from "./rate-providers.ts";

/**
 * Provider transaction commits. Avalara is quote-only until a posted sales
 * document commits its transaction: without the commit AvaTax returns and
 * filing cannot be fed. Posting enqueues one row per provider and direction;
 * the periodic tax_provider_commit scan performs the provider call with
 * retries, records the outcome, and voids on document void. A provider total
 * that differs from posted tax is recorded and surfaced, never adjusted.
 *
 * Only the merchant's own tax is committed: marketplace-collected lines are
 * the facilitator's liability to report, so sending them to the merchant's
 * provider company would post another business's liability as ours.
 */

export class TaxProviderCommitError extends Error {}

/** Document kinds that commit, and the direction they commit as. Cash-sale
 * kinds join this map with the commerce cash-documents change; the map is
 * the only place a kind is admitted, so that change is one entry here. */
export const PROVIDER_COMMIT_KINDS: Record<string, "sale" | "return"> = {
  customer_invoice: "sale",
  customer_credit: "return",
  cash_sale: "sale",
  cash_refund: "return",
};

/** Commits are retried with backoff this many times before going terminal. */
export const MAX_PROVIDER_COMMIT_ATTEMPTS = 12;
/** First retry delay; doubles per attempt up to the cap. */
export const PROVIDER_COMMIT_BACKOFF_BASE_MS = 60_000;
export const PROVIDER_COMMIT_BACKOFF_CAP_MS = 6 * 3_600_000;
/** Rows claimed per scan tick; the scan re-arms and returns for the rest. */
const PROVIDER_COMMIT_SCAN_BATCH = 100;

export function providerCommitBackoffMs(attempts: number): number {
  const backoff = PROVIDER_COMMIT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(backoff, PROVIDER_COMMIT_BACKOFF_CAP_MS);
}

/**
 * The provider document code for an OpenBooks document: the operator-visible
 * document number namespaced by the org so two tenants sharing a provider
 * company can never address each other's transactions.
 */
export function providerCodeForDocument(documentNumber: string, orgId: string): string {
  return `${orgId.slice(0, 8)}-${documentNumber}`;
}

type Runner = Pick<SqlExecutor, "execute">;

// A type alias, not an interface: execute<T extends Record<string, unknown>>
// rejects interfaces (no implicit index signature).
export type ProviderCommitRow = {
  id: string;
  orgId: string;
  documentId: string;
  provider: string;
  providerCode: string;
  kind: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  voidRequestedAt: Date | null;
  committedAt: Date | null;
  providerResponseExcerpt: Record<string, unknown> | null;
}

const COMMIT_ROW_COLS = sql`
  id, org_id as "orgId", document_id as "documentId", provider,
  provider_code as "providerCode", kind, status, attempts,
  next_attempt_at as "nextAttemptAt", last_error as "lastError",
  void_requested_at as "voidRequestedAt", committed_at as "committedAt",
  provider_response_excerpt as "providerResponseExcerpt"`;

/**
 * Enqueue the provider commit for a posted sales document, inside the
 * posting transaction so a post can never commit without its tracking row.
 * No provider configured, provider disabled, manual rates, or the commit
 * switch off: no row (there is nothing to commit to). Returns the row id,
 * or null when nothing was enqueued.
 */
export async function enqueueProviderCommitTx(
  runner: Runner,
  args: { orgId: string; documentId: string; kind: string; documentNumber: string; actorId: string | null },
): Promise<string | null> {
  const direction = PROVIDER_COMMIT_KINDS[args.kind];
  if (!direction) return null;
  const config = await readTaxRateProviderConfig(args.orgId, runner);
  if (!config?.isEnabled || config.provider === "manual") return null;
  if (!providerCommitEnabled(config.settings)) return null;
  const providerCode = providerCodeForDocument(args.documentNumber, args.orgId);
  if (config.provider === "custom_http") {
    // A custom hook has a quote contract but no commit contract: record the
    // skip by name so the operator sees why nothing was committed.
    const skipped = (await runner.execute<{ id: string }>(sql`
      insert into tax_provider_transactions
        (org_id, document_id, provider, provider_code, kind, status, attempts,
         last_error, created_by, updated_by)
      values (${args.orgId}, ${args.documentId}, ${config.provider}, ${providerCode}, ${direction},
              'skipped', 0,
              'the custom tax hook has no commit contract — configure Avalara or TaxJar to commit transactions',
              ${args.actorId}, ${args.actorId})
      returning id
    `));
    if (!skipped.rows[0]) throw new TaxProviderCommitError("the provider commit skip was not stored — no row was written");
    return skipped.rows[0].id;
  }
  const inserted = (await runner.execute<{ id: string }>(sql`
    insert into tax_provider_transactions
      (org_id, document_id, provider, provider_code, kind, status, created_by, updated_by)
    values (${args.orgId}, ${args.documentId}, ${config.provider}, ${providerCode}, ${direction},
            'pending', ${args.actorId}, ${args.actorId})
    returning id
  `));
  // A write that matches zero rows is a failure, not a success: without the
  // row the scan never commits and the operator never learns it.
  if (!inserted.rows[0]) throw new TaxProviderCommitError("the provider commit was not enqueued — no row was written");
  return inserted.rows[0].id;
}

/**
 * Mark a document's provider rows for voiding, inside the void transaction
 * so a void can never commit without voiding its provider transactions.
 * Zero rows is normal (no provider configured); returns the marked count.
 */
export async function requestProviderVoidTx(
  runner: Runner,
  args: { orgId: string; documentId: string },
): Promise<number> {
  const marked = (await runner.execute(sql`
    update tax_provider_transactions
       set void_requested_at = coalesce(void_requested_at, now()),
           next_attempt_at = now(),
           updated_at = now()
     where org_id = ${args.orgId} and document_id = ${args.documentId}
       and status in ('pending', 'committed', 'failed')
  `));
  return marked.rowCount ?? 0;
}

/** Operator retry for a terminally failed row: re-arms it for the scan. */
export async function retryProviderTransaction(
  orgId: string,
  transactionId: string,
  actorId: string | null,
): Promise<void> {
  await withOrgContext(orgId, async () => {
    const rearmed = (await db.execute(sql`
      update tax_provider_transactions
         set status = 'pending', attempts = 0, next_attempt_at = now(),
             last_error = null, updated_at = now(), updated_by = ${actorId}
       where id = ${transactionId} and org_id = ${orgId} and status = 'failed'
    `));
    if ((rearmed.rowCount ?? 0) !== 1) {
      throw new TaxProviderCommitError(
        "that provider transaction cannot be retried — only failed rows retry; committed, voided and pending rows need no retry",
      );
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_provider_transactions', ${transactionId}, 'update',
              ${JSON.stringify({ event: "provider_commit_retried" })}::jsonb, ${actorId})
    `);
  });
}

/** Commit status for a document's drawer chip, newest first. */
export async function readProviderTransactionsForDocument(
  orgId: string,
  documentId: string,
): Promise<ProviderCommitRow[]> {
  return withOrgContext(orgId, async () => {
    const rows = (await db.execute<ProviderCommitRow>(sql`
      select ${COMMIT_ROW_COLS} from tax_provider_transactions
       where org_id = ${orgId} and document_id = ${documentId}
       order by created_at desc
    `)).rows;
    return rows;
  });
}

export interface ProviderCommitListFilters {
  status?: string;
  provider?: string;
  limit?: number;
  offset?: number;
}

/** Activity list over commit rows, newest first. */
export async function listProviderTransactions(
  orgId: string,
  filters: ProviderCommitListFilters = {},
): Promise<ProviderCommitRow[]> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  return withOrgContext(orgId, async () => {
    const rows = (await db.execute<ProviderCommitRow>(sql`
      select ${COMMIT_ROW_COLS} from tax_provider_transactions
       where org_id = ${orgId}
         ${filters.status ? sql`and status = ${filters.status}` : sql``}
         ${filters.provider ? sql`and provider = ${filters.provider}` : sql``}
       order by created_at desc
       limit ${limit} offset ${offset}
    `)).rows;
    return rows;
  });
}

interface CommitSecrets {
  accountId?: string;
  licenseKey?: string;
  apiKey?: string;
}

async function commitSecretsOf(row: TaxRateProviderConfigRow): Promise<CommitSecrets> {
  if (!row.secrets) return {};
  return (await unsealJson(row.secrets, { orgId: row.orgId, purpose: "tax.provider.secrets" })) as CommitSecrets;
}

interface CommitDocumentLine {
  lineNumber: number;
  amount: string;
  taxAmount: string;
  marketplace: boolean;
}

interface CommitDocument {
  id: string;
  kind: string;
  documentNumber: string;
  currency: string;
  postingDate: string;
  partyId: string | null;
  subsidiaryId: string | null;
  shipToCountry: string | null;
  shipToRegion: string | null;
  entityCountry: string | null;
  lines: CommitDocumentLine[];
  /** Full posted tax, including any marketplace share, for the excerpt. */
  postedTax: string;
  /** The merchant's own posted tax: the figure the provider must agree with. */
  merchantTax: string;
}

async function loadCommitDocument(orgId: string, documentId: string): Promise<CommitDocument | null> {
  const doc = (await db.execute<{
    id: string;
    kind: string;
    documentNumber: string;
    currency: string;
    postingDate: string | null;
    documentDate: string;
    partyId: string | null;
    subsidiaryId: string | null;
    shipToCountry: string | null;
    shipToRegion: string | null;
    taxTotal: string;
  }>(sql`
    select id, kind, document_number as "documentNumber", currency,
           posting_date::text as "postingDate", document_date::text as "documentDate",
           party_id as "partyId", subsidiary_id as "subsidiaryId",
           ship_to_country as "shipToCountry", ship_to_region as "shipToRegion",
           tax_total::text as "taxTotal"
      from documents where org_id = ${orgId} and id = ${documentId}
  `)).rows[0];
  if (!doc) return null;
  const lines = (await db.execute<{
    lineNumber: number;
    amount: string;
    taxAmount: string;
    marketplace: boolean;
  }>(sql`
    select line_number as "lineNumber", amount::text as amount,
           tax_amount::text as "taxAmount",
           (marketplace_facilitator is not null) as marketplace
      from document_lines
     where org_id = ${orgId} and document_id = ${documentId}
     order by line_number
  `)).rows;
  // The selling entity's country is the commit's origin address: the
  // document subsidiary when set, else the organization itself.
  let entityCountry: string | null = null;
  if (doc.subsidiaryId) {
    entityCountry = (await db.execute<{ country: string | null }>(sql`
      select country from subsidiaries where org_id = ${orgId} and id = ${doc.subsidiaryId}
    `)).rows[0]?.country ?? null;
  } else {
    entityCountry = (await db.execute<{ country: string | null }>(sql`
      select country from orgs where id = ${orgId}
    `)).rows[0]?.country ?? null;
  }
  let merchantTax = "0";
  for (const line of lines) {
    if (!line.marketplace) merchantTax = add(merchantTax, line.taxAmount);
  }
  return {
    id: doc.id,
    kind: doc.kind,
    documentNumber: doc.documentNumber,
    currency: doc.currency,
    postingDate: doc.postingDate ?? doc.documentDate,
    partyId: doc.partyId,
    subsidiaryId: doc.subsidiaryId,
    shipToCountry: doc.shipToCountry,
    shipToRegion: doc.shipToRegion,
    entityCountry,
    lines: lines.map((l) => ({
      lineNumber: Number(l.lineNumber),
      amount: l.amount,
      taxAmount: l.taxAmount,
      marketplace: l.marketplace,
    })),
    postedTax: doc.taxTotal,
    merchantTax,
  };
}

/**
 * Avalara committed transaction: the quote call with a permanent document
 * type, the document code, and commit:true. Return kinds ride as
 * ReturnInvoice with negated line amounts (AvaTax reads returns as negative
 * documents); sales ride as SalesInvoice with posted amounts.
 */
export async function commitViaAvalara(
  args: {
    code: string;
    direction: "sale" | "return";
    currency: string;
    commitDate: string;
    customerCode: string;
    companyCode: string;
    accountId: string;
    licenseKey: string;
    baseUrl?: string;
    shipFrom: Address;
    shipTo: Address;
    lines: CommitDocumentLine[];
  },
  options: TaxProviderOutboundOptions = {},
): Promise<{ providerTax: string; raw: Record<string, unknown> }> {
  const sign = args.direction === "return" ? -1 : 1;
  const body = {
    type: args.direction === "return" ? "ReturnInvoice" : "SalesInvoice",
    code: args.code,
    companyCode: args.companyCode,
    date: args.commitDate,
    currencyCode: args.currency,
    customerCode: args.customerCode,
    commit: true,
    addresses: { shipFrom: args.shipFrom, shipTo: args.shipTo },
    lines: args.lines.map((line) => ({
      number: String(line.lineNumber),
      quantity: 1,
      amount: sign * wireAmountOrThrow(line.amount),
    })),
  };
  const auth = Buffer.from(`${args.accountId}:${args.licenseKey}`).toString("base64");
  const res = await taxProviderFetch(
    `${args.baseUrl ?? "https://rest.avatax.com"}/api/v2/transactions/create`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { ...options, providerLabel: "Avalara" },
  );
  const raw = await readTaxProviderJson(res, "Avalara", options.timeoutMs ?? TAX_PROVIDER_REQUEST_TIMEOUT_MS);
  if (!res.ok) throw new TaxRateProviderError(`Avalara ${res.status}: ${JSON.stringify(raw).slice(0, 400)}`);
  if (raw.committed !== true) {
    throw new TaxRateProviderError(
      "Avalara accepted the transaction but did not commit it — refusing to record an uncommitted commit",
    );
  }
  return { providerTax: providerMoney(raw.totalTax, "totalTax"), raw };
}

/** Avalara void: DocVoided cancellation of a committed document code. */
export async function voidViaAvalara(
  args: { code: string; accountId: string; licenseKey: string; baseUrl?: string; companyCode: string },
  options: TaxProviderOutboundOptions = {},
): Promise<void> {
  const auth = Buffer.from(`${args.accountId}:${args.licenseKey}`).toString("base64");
  const res = await taxProviderFetch(
    `${args.baseUrl ?? "https://rest.avatax.com"}/api/v2/companies/${encodeURIComponent(args.companyCode)}/transactions/${encodeURIComponent(args.code)}/void`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "DocVoided" }),
    },
    { ...options, providerLabel: "Avalara" },
  );
  const raw = await readTaxProviderJson(res, "Avalara", options.timeoutMs ?? TAX_PROVIDER_REQUEST_TIMEOUT_MS);
  if (!res.ok) throw new TaxRateProviderError(`Avalara ${res.status}: ${JSON.stringify(raw).slice(0, 400)}`);
}

export interface TaxJarCommitArgs {
  code: string;
  direction: "sale" | "return";
  currency: string;
  commitDate: string;
  shipTo: Address;
  lines: CommitDocumentLine[];
  postedTax: string;
  apiKey: string;
  baseUrl?: string;
}

/**
 * TaxJar committed transaction: orders record the sale, refunds record the
 * return, both with positive collected amounts (TaxJar's convention — unlike
 * AvaTax, its refund documents are positive). The recorded sales_tax is the
 * tax actually collected, reported back verbatim.
 */
export async function commitViaTaxJar(
  args: TaxJarCommitArgs,
  options: TaxProviderOutboundOptions = {},
): Promise<{ providerTax: string; raw: Record<string, unknown> }> {
  if (args.currency !== "USD") {
    throw new TaxRateProviderError(
      `TaxJar commits only support USD documents; currency "${args.currency}" must be committed through another provider`,
    );
  }
  if (!args.shipTo.country || !args.shipTo.region) {
    throw new TaxRateProviderError(
      "TaxJar commit needs a destination country and state — set the customer ship-to address before the commit runs",
    );
  }
  const path = args.direction === "return" ? "refunds" : "orders";
  const body = {
    transaction_id: args.code,
    transaction_date: args.commitDate,
    to_country: args.shipTo.country,
    to_state: args.shipTo.region,
    ...(args.shipTo.postalCode ? { to_zip: args.shipTo.postalCode } : {}),
    ...(args.shipTo.city ? { to_city: args.shipTo.city } : {}),
    shipping: 0,
    sales_tax: wireAmountOrThrow(args.postedTax),
    line_items: args.lines.map((line) => ({
      id: String(line.lineNumber),
      quantity: 1,
      unit_price: wireAmountOrThrow(line.amount),
    })),
  };
  const res = await taxProviderFetch(
    `${args.baseUrl ?? "https://api.taxjar.com"}/v2/transactions/${path}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { ...options, providerLabel: "TaxJar" },
  );
  const raw = await readTaxProviderJson(res, "TaxJar", options.timeoutMs ?? TAX_PROVIDER_REQUEST_TIMEOUT_MS);
  if (!res.ok) throw new TaxRateProviderError(`TaxJar ${res.status}: ${JSON.stringify(raw).slice(0, 400)}`);
  const recorded = (raw.order ?? raw.refund ?? {}) as { sales_tax?: unknown };
  return { providerTax: providerMoney(recorded.sales_tax, "sales_tax"), raw };
}

/** TaxJar void: delete the recorded order or refund. */
export async function voidViaTaxJar(
  args: { code: string; direction: "sale" | "return"; apiKey: string; baseUrl?: string },
  options: TaxProviderOutboundOptions = {},
): Promise<void> {
  const path = args.direction === "return" ? "refunds" : "orders";
  const res = await taxProviderFetch(
    `${args.baseUrl ?? "https://api.taxjar.com"}/v2/transactions/${path}/${encodeURIComponent(args.code)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${args.apiKey}` },
    },
    { ...options, providerLabel: "TaxJar" },
  );
  const raw = await readTaxProviderJson(res, "TaxJar", options.timeoutMs ?? TAX_PROVIDER_REQUEST_TIMEOUT_MS);
  if (!res.ok) throw new TaxRateProviderError(`TaxJar ${res.status}: ${JSON.stringify(raw).slice(0, 400)}`);
}

/** Excerpt persisted per attempt: bounded evidence, never the full body. */
function excerptFor(args: {
  code: string;
  postedTax: string;
  merchantTax: string;
  providerTax: string;
  mismatch: string;
}): Record<string, unknown> {
  return {
    code: args.code,
    postedTax: args.postedTax,
    merchantTax: args.merchantTax,
    providerTax: args.providerTax,
    mismatch: args.mismatch,
  };
}

/** A provider "no such transaction" shapes the void into a skip, not a loop. */
function isProviderNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(^|[^0-9])404([^0-9]|$)/.test(message) || /not found|does not exist|unknown transaction/i.test(message);
}

/**
 * A malformed request (4xx other than rate-limiting) will never succeed on
 * retry: fail it terminally now instead of burning the attempt budget.
 */
function isTerminalProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Avalara 4\d\d|TaxJar 4\d\d/.test(message) && !/429/.test(message);
}

async function markCommitted(
  orgId: string,
  rowId: string,
  excerpt: Record<string, unknown>,
): Promise<void> {
  const updated = (await db.execute(sql`
    update tax_provider_transactions
       set status = 'committed', attempts = attempts + 1, committed_at = now(),
           last_error = null, provider_response_excerpt = ${JSON.stringify(excerpt)}::jsonb,
           updated_at = now()
     where id = ${rowId} and org_id = ${orgId} and status = 'pending'
  `));
  // The scan claims the row before working it; zero rows means the claim
  // was lost (an operator retry raced the scan) — fail loudly, never silently.
  if ((updated.rowCount ?? 0) !== 1) throw new TaxProviderCommitError("the provider commit finished but its row was no longer pending");
}

async function markVoided(orgId: string, rowId: string): Promise<void> {
  const updated = (await db.execute(sql`
    update tax_provider_transactions
       set status = 'voided', attempts = attempts + 1, last_error = null,
           updated_at = now()
     where id = ${rowId} and org_id = ${orgId} and void_requested_at is not null
  `));
  if ((updated.rowCount ?? 0) !== 1) throw new TaxProviderCommitError("the provider void finished but its row no longer requests a void");
}

async function markSkipped(orgId: string, rowId: string, reason: string): Promise<void> {
  const updated = (await db.execute(sql`
    update tax_provider_transactions
       set status = 'skipped', attempts = attempts + 1, last_error = ${reason},
           updated_at = now()
     where id = ${rowId} and org_id = ${orgId}
  `));
  if ((updated.rowCount ?? 0) !== 1) throw new TaxProviderCommitError("the provider commit skip was not stored — no row was written");
}

async function markAttemptFailed(
  orgId: string,
  rowId: string,
  error: unknown,
  terminal: boolean,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const attempts = (await db.execute<{ attempts: number }>(sql`
    select attempts from tax_provider_transactions where id = ${rowId} and org_id = ${orgId}
  `)).rows[0]?.attempts ?? 0;
  const exhausted = terminal || attempts + 1 >= MAX_PROVIDER_COMMIT_ATTEMPTS;
  const updated = (await db.execute(sql`
    update tax_provider_transactions
       set status = ${exhausted ? "failed" : "pending"},
           attempts = attempts + 1,
           next_attempt_at = ${exhausted ? new Date() : new Date(Date.now() + providerCommitBackoffMs(attempts + 1))},
           last_error = ${message.slice(0, 1000)},
           updated_at = now()
     where id = ${rowId} and org_id = ${orgId}
  `));
  if ((updated.rowCount ?? 0) !== 1) throw new TaxProviderCommitError("the provider commit failure was not recorded — no row was written");
}

async function processCommitRow(
  orgId: string,
  row: ProviderCommitRow,
  options: TaxProviderOutboundOptions,
): Promise<"committed" | "voided" | "skipped" | "deferred"> {
  const doc = await loadCommitDocument(orgId, row.documentId);
  if (!doc) {
    await markSkipped(orgId, row.id, "the document is gone — its provider commit has nothing to commit");
    return "skipped";
  }
  const direction = row.kind === "return" ? "return" : "sale";
  const config = await readTaxRateProviderConfig(orgId);
  if (!config?.isEnabled || config.provider === "manual" || config.provider !== row.provider) {
    await markSkipped(
      orgId,
      row.id,
      "the tax provider is no longer configured for commits — reconfigure the provider in Setup → Taxes to commit this document",
    );
    return "skipped";
  }
  if (!providerCommitEnabled(config.settings)) {
    // The operator switched commits off mid-flight: leave the row pending
    // for a later re-enable rather than skipping work they may still want.
    return "deferred";
  }
  if (typeof config.settings.commitTransactions !== "boolean") {
    await markAttemptFailed(orgId, row.id, new TaxRateProviderError(
      "settings.commitTransactions must be a boolean — switch transaction commits on or off in the provider settings",
    ), true);
    return "deferred";
  }
  const secrets = await commitSecretsOf(config);
  const companyCode = config.settings.companyCode == null ? "DEFAULT" : String(config.settings.companyCode);
  const baseUrl = config.settings.baseUrl == null ? undefined : String(config.settings.baseUrl);
  await assertNotSandbox(orgId, row.voidRequestedAt ? "tax provider void" : "tax provider commit");

  if (row.voidRequestedAt) {
    if (row.status === "pending") {
      await markSkipped(orgId, row.id, "the document was voided before the provider commit ran — nothing was committed");
      return "skipped";
    }
    try {
      if (row.provider === "avalara") {
        if (!secrets.accountId || !secrets.licenseKey) {
          throw new TaxRateProviderError("Avalara accountId and licenseKey required — re-enter the provider credentials");
        }
        await voidViaAvalara({ code: row.providerCode, accountId: secrets.accountId, licenseKey: secrets.licenseKey, baseUrl, companyCode }, options);
      } else {
        if (!secrets.apiKey) throw new TaxRateProviderError("TaxJar apiKey required — re-enter the provider credentials");
        await voidViaTaxJar({ code: row.providerCode, direction, apiKey: secrets.apiKey, baseUrl }, options);
      }
    } catch (error) {
      if (isProviderNotFound(error)) {
        await markSkipped(orgId, row.id, `the provider reports no such transaction (${row.providerCode}) — nothing to void`);
        return "skipped";
      }
      await markAttemptFailed(orgId, row.id, error, isTerminalProviderError(error));
      return "deferred";
    }
    await markVoided(orgId, row.id);
    return "voided";
  }

  if (row.status !== "pending") return "deferred";
  const merchantLines = doc.lines.filter((line) => !line.marketplace);
  if (merchantLines.length === 0) {
    await markSkipped(orgId, row.id, "every line on this document is marketplace-collected — there is no merchant tax to commit");
    return "skipped";
  }
  try {
    let providerTax: string;
    if (row.provider === "avalara") {
      if (!secrets.accountId || !secrets.licenseKey) {
        throw new TaxRateProviderError("Avalara accountId and licenseKey required — re-enter the provider credentials");
      }
      const committed = await commitViaAvalara(
        {
          code: row.providerCode,
          direction,
          currency: doc.currency,
          commitDate: doc.postingDate,
          customerCode: doc.partyId ?? "OPENBOOKS",
          companyCode,
          accountId: secrets.accountId,
          licenseKey: secrets.licenseKey,
          baseUrl,
          shipFrom: { country: doc.entityCountry },
          shipTo: { country: doc.shipToCountry, region: doc.shipToRegion },
          lines: merchantLines,
        },
        options,
      );
      // Return documents ride negated; compare like with like.
      providerTax = direction === "return" ? neg(committed.providerTax) : committed.providerTax;
    } else {
      if (!secrets.apiKey) throw new TaxRateProviderError("TaxJar apiKey required — re-enter the provider credentials");
      const committed = await commitViaTaxJar(
        {
          code: row.providerCode,
          direction,
          currency: doc.currency,
          commitDate: doc.postingDate,
          shipTo: { country: doc.shipToCountry, region: doc.shipToRegion },
          lines: merchantLines,
          postedTax: doc.merchantTax,
          apiKey: secrets.apiKey,
          baseUrl,
        },
        options,
      );
      providerTax = committed.providerTax;
    }
    // A provider total that differs from posted merchant tax is evidence of
    // a rate or rounding difference between the provider and the ledger:
    // record it on the row for the operator. The books never move — the
    // posted tax stands and the difference stays visible until the mapping
    // or rate is fixed and the document is corrected.
    const mismatch = cmp(providerTax, doc.merchantTax) === 0 ? "0.0000" : providerTax;
    await markCommitted(orgId, row.id, excerptFor({
      code: row.providerCode,
      postedTax: doc.postedTax,
      merchantTax: doc.merchantTax,
      providerTax,
      mismatch,
    }));
    return "committed";
  } catch (error) {
    await markAttemptFailed(orgId, row.id, error, isTerminalProviderError(error));
    return "deferred";
  }
}

export interface ProviderCommitScanResult {
  scanned: number;
  committed: number;
  voided: number;
  skipped: number;
  failed: number;
  orgErrors: { orgId: string; error: string }[];
}

/**
 * Scheduler entry point for the tax_provider_commit scan: commits due rows
 * and performs requested voids across every production org with due work.
 * One tenant's failure is recorded by name and the scan continues.
 */
export async function runTaxProviderCommitScan(
  options: TaxProviderOutboundOptions = {},
): Promise<ProviderCommitScanResult> {
  const result: ProviderCommitScanResult = {
    scanned: 0, committed: 0, voided: 0, skipped: 0, failed: 0, orgErrors: [],
  };
  // bypass: scheduler-tick — the unscoped scan discovers due rows in every
  // production organization, then works each row inside its own tenant scope.
  const due = await withBypass(() => db.execute<{ orgId: string }>(sql`
    select distinct t.org_id as "orgId"
      from tax_provider_transactions t
      join orgs o on o.id = t.org_id
     where o.env_kind = 'production'
       and t.next_attempt_at <= now()
       and (t.status = 'pending' or (t.void_requested_at is not null and t.status in ('committed', 'failed')))
     limit ${PROVIDER_COMMIT_SCAN_BATCH}
  `));
  for (const { orgId } of due.rows) {
    try {
      const one = await runTaxProviderCommitScanForOrg(orgId, options);
      result.scanned += one.scanned;
      result.committed += one.committed;
      result.voided += one.voided;
      result.skipped += one.skipped;
      result.failed += one.failed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.orgErrors.push({ orgId, error: message.slice(0, 1000) });
    }
  }
  return result;
}

/** Work every due row for one organization inside its tenant scope. */
export async function runTaxProviderCommitScanForOrg(
  orgId: string,
  options: TaxProviderOutboundOptions = {},
): Promise<ProviderCommitScanResult> {
  const result: ProviderCommitScanResult = {
    scanned: 0, committed: 0, voided: 0, skipped: 0, failed: 0, orgErrors: [],
  };
  if (!orgId.trim()) throw new TaxProviderCommitError("orgId is required for an org-scoped provider commit scan");
  await withOrgContext(orgId, async () => {
    const due = (await db.execute<ProviderCommitRow>(sql`
      select ${COMMIT_ROW_COLS} from tax_provider_transactions
       where org_id = ${orgId}
         and next_attempt_at <= now()
         and (status = 'pending' or (void_requested_at is not null and status in ('committed', 'failed')))
       order by next_attempt_at
       limit ${PROVIDER_COMMIT_SCAN_BATCH}
       for update skip locked
    `)).rows;
    for (const row of due) {
      result.scanned += 1;
      try {
        const outcome = await processCommitRow(orgId, row, options);
        if (outcome === "committed") result.committed += 1;
        else if (outcome === "voided") result.voided += 1;
        else if (outcome === "skipped") result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        result.orgErrors.push({ orgId, error: `document ${row.documentId}: ${message}`.slice(0, 1000) });
      }
    }
  });
  return result;
}

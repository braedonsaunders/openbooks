import { sql } from "drizzle-orm";
import { monthlyRecurringRevenue } from "../billing/subscription-billing.ts";
import {
  activateLifecycle,
  applyAmendment,
  createPlanVersion,
  publishPlanVersion,
} from "../billing/advanced-subscriptions.ts";
import { createSubscriptionInvoice } from "../billing/subscription-billing.ts";
import { ingestUsageRecords } from "../billing/usage/records.ts";
import { createPromotion, setPromotionStatus } from "../sales/promotions.ts";
import { listAllChargebee, listChargebeeEvents } from "../connectors/chargebee.ts";
import { fetchWithConnectorRetry } from "../connectors/http-retry.ts";
import { guardedFetch } from "../connectors/ssrf-guard.ts";
import { listAllRecurly } from "../connectors/recurly.ts";
import { listAllMaxio, maxioUpdatedBounds } from "../connectors/maxio.ts";
import { listAllZuora, pollZuoraQuery, submitZuoraQuery } from "../connectors/zuora.ts";
import type { ConnectorTransport } from "../connectors/chargebee.ts";
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { db, withOrg } from "../platform/db.ts";
import { addMonthsClamped } from "../platform/civil-date.ts";
import { businessToday } from "../platform/business-date.ts";
import { sealJson, unsealJson } from "../platform/secrets.ts";
import { createPaymentDocument, updateDraftPayment } from "../payments/payment-documents.ts";
import { postPaymentWithApplications } from "../payments/payment-posting.ts";
import { sameCurrencyAllocation, type AllocationInput } from "../payments/settlement-policy.ts";
import { THREE_DECIMAL_CURRENCIES, ZERO_DECIMAL_CURRENCIES } from "../payments/acceptance.ts";
import {
  BillingHistoryError,
  deriveChangesFromInvoices,
  emptyBillingHistory,
  mapChargebeeCoupon,
  mapChargebeeCreditNote,
  mapChargebeeCustomer,
  mapChargebeeEvent,
  mapChargebeeInvoice,
  mapChargebeePayment,
  mapChargebeePlan,
  mapChargebeeSubscription,
  mapMaxioCoupon,
  mapMaxioCustomer,
  mapMaxioInvoice,
  mapMaxioPayment,
  mapMaxioPlan,
  mapMaxioSubscription,
  mapMaxioUsage,
  mapRecurlyCoupon,
  mapRecurlyCredit,
  mapRecurlyCustomer,
  mapRecurlyInvoice,
  mapRecurlyPayment,
  mapRecurlyPlan,
  mapRecurlySubscription,
  mapZuoraAmendment,
  mapZuoraCreditMemo,
  mapZuoraCustomer,
  mapZuoraInvoice,
  mapZuoraPayment,
  mapZuoraPlan,
  mapZuoraRevenueSchedule,
  mapZuoraSubscription,
  mapZuoraUsage,
  monthRange,
  planBillingPreflight,
  reconcileBillingHistory,
  type BillingHistoryProvider,
  type BillingPreflight,
  type BillingReconciliation,
  type CanonicalBillingHistory,
  type CanonicalPlan,
  type CanonicalSubscription,
  type PreflightCatalog,
  type PricedPlan,
} from "./billing-history.ts";

/**
 * Billing-platform history import runner — fetch, map, persist, reconcile.
 *
 * The canonical model (billing-history.ts) never touches the network or the
 * database; this module does both. A `BillingHistorySource` supplies provider
 * payloads (live connector pulls seal their credentials per org; tests
 * supply fixtures), the runner persists them into native records
 * idempotently through `external_links`, then reconciles MRR, open AR and
 * deferred revenue before the run can complete.
 *
 * Native targets, each written through its own module's contract:
 * customers → parties + customer_roles; plans → subscription_plans +
 * published plan versions; subscriptions → subscriptions + lifecycles +
 * component amendments; invoices/credits → AR documents (posted, or drafts
 * as opening balances); payments → receipts with native allocations; usage
 * → usage records; coupons → promotions; revenue schedules → the deferred
 * leg of the reconciliation (no native revenue contract is invented).
 */

const FEATURE = "billingHistoryImport";
const FEATURE_REMEDY = "Enable Billing history import in Company Settings → Features.";
const CREDENTIALS_PURPOSE = "billing_import.secrets";

function refuse(code: string, message: string, remedy: string, status: 422 | 409 = 422): never {
  throw new BillingHistoryError(code, message, remedy, status);
}

/** A provider pull: live connector reads seal credentials per org; fixtures stand in for tests. */
export interface BillingHistorySource {
  provider: BillingHistoryProvider;
  externalAccount: string;
  pull: (since: string | null) => Promise<CanonicalBillingHistory>;
}

export interface BillingImportConfig {
  mode: "post_historical" | "opening_balances";
  cutoverOn: string | null;
  historyDepthMonths: number | null;
  incomeAccountId: string | null;
  clearingAccountId: string | null;
  taxCodeId: string | null;
  planMap: Record<string, string>;
  customerMap: Record<string, string>;
  autoSync: boolean;
  sealedCredentials: string | null;
}

export interface BillingImportOptions {
  orgId: string;
  actorId: string;
  mode: "post_historical" | "opening_balances";
  cutoverOn?: string | null;
  historyDepthMonths?: number | null;
  incomeAccountId?: string | null;
  clearingAccountId?: string | null;
  taxCodeId?: string | null;
  planMap?: Record<string, string>;
  customerMap?: Record<string, string>;
  autoSync?: boolean;
  transport?: ConnectorTransport;
}

export interface BillingImportRefusal {
  objectType: string;
  externalId: string;
  code: string;
  message: string;
  remedy: string;
}

export interface BillingImportCounts {
  customers: number;
  plans: number;
  subscriptions: number;
  invoices: number;
  creditNotes: number;
  payments: number;
  usage: number;
  coupons: number;
  revenueSchedules: number;
  amendments: number;
  skipped: number;
}

export interface BillingImportResult {
  runId: string;
  counts: BillingImportCounts;
  refusals: BillingImportRefusal[];
  reconciliation: BillingReconciliation;
}

type ObjectType = "customer" | "subscription" | "price" | "meter" | "subscription_item" | "invoice" | "credit_note" | "payment" | "coupon";

/** The single isolated writer for billing-platform external identities. */
export async function recordBillingLink(
  orgId: string,
  provider: BillingHistoryProvider,
  externalAccount: string,
  objectType: ObjectType,
  externalId: string,
  nativeTable: string,
  nativeId: string,
  externalUpdatedAt: string | null,
): Promise<"created" | "replayed"> {
  {
    const existing = await db.execute<{ native_id: string }>(sql`
      select native_id from external_links
       where org_id = ${orgId} and provider = ${provider} and external_account = ${externalAccount}
         and object_type = ${objectType} and external_id = ${externalId}
    `);
    const found = existing.rows[0];
    if (found) {
      if (found.native_id !== nativeId) {
        refuse(
          "billing_import_link_conflict",
          `${provider} ${objectType} ${externalId} is already linked to a different OpenBooks record.`,
          "Review the existing link on the import run before re-mapping it.",
          409,
        );
      }
      return "replayed";
    }
    // A retried insert for the same external object is an expected unique-key
    // collision, never a second link: re-read to confirm the target.
    const inserted = await db.execute(sql`
      insert into external_links
        (org_id, provider, external_account, object_type, external_id, native_table, native_id, external_updated_at, last_synced_at)
      values (${orgId}, ${provider}, ${externalAccount}, ${objectType}, ${externalId}, ${nativeTable}, ${nativeId},
              ${externalUpdatedAt}, now())
      on conflict (org_id, provider, external_account, object_type, external_id) do nothing
    `);
    if ((inserted.rowCount ?? 0) === 0) return "replayed";
    const verify = await db.execute<{ native_id: string }>(sql`
      select native_id from external_links
       where org_id = ${orgId} and provider = ${provider} and external_account = ${externalAccount}
         and object_type = ${objectType} and external_id = ${externalId}
    `);
    if (verify.rows[0]?.native_id !== nativeId) {
      refuse(
        "billing_import_link_conflict",
        `${provider} ${objectType} ${externalId} is already linked to a different OpenBooks record.`,
        "Review the existing link on the import run before re-mapping it.",
        409,
      );
    }
    return "created";
  }
}

export async function findBillingLink(
  orgId: string,
  provider: BillingHistoryProvider,
  externalAccount: string,
  objectType: ObjectType,
  externalId: string,
): Promise<string | null> {
  const found = await (db.execute<{ native_id: string }>(sql`
    select native_id from external_links
     where org_id = ${orgId} and provider = ${provider} and external_account = ${externalAccount}
       and object_type = ${objectType} and external_id = ${externalId}
  `));
  return found.rows[0]?.native_id ?? null;
}

// --- Credentials ---------------------------------------------------------------

/** Seal a provider credential bundle against the org — the ciphertext, never the key, reaches the run row. */
export function sealBillingCredentials(orgId: string, credentials: Record<string, string>): string {
  return sealJson(credentials, { orgId, purpose: CREDENTIALS_PURPOSE });
}

function unsealBillingCredentials(orgId: string, sealed: string): Record<string, string> {
  try {
    return unsealJson<Record<string, string>>(sealed, { orgId, purpose: CREDENTIALS_PURPOSE });
  } catch {
    refuse(
      "billing_import_credentials_unreadable",
      "The stored billing credential cannot be opened — it was sealed for another organization or is corrupt.",
      "Reconnect the billing platform with a fresh API key, then run the import again.",
    );
  }
}

// --- Live pulls ------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

async function pullChargebee(
  account: string,
  credentials: Record<string, string>,
  cursor: Record<string, string>,
  transport: ConnectorTransport | undefined,
): Promise<CanonicalBillingHistory> {
  const apiKey = credentials.apiKey;
  if (!apiKey) refuse("billing_import_credentials_missing", "The Chargebee connection has no API key.", "Reconnect Chargebee with a fresh API key, then run the import again.");
  const site = { site: account, apiKey };
  const since = cursor.customers ? String(Math.floor(new Date(cursor.customers).getTime() / 1000)) : undefined;
  const customerBounds: Record<string, string> = since ? { "updated_at[after]": since } : {};
  const history = emptyBillingHistory();
  const customers = await listAllChargebee<JsonObject>(site, "customers", customerBounds, transport);
  for (const row of customers) history.customers.push(mapChargebeeCustomer((row.customer ?? row) as JsonObject));
  const plans = await listAllChargebee<JsonObject>(site, "plans", {}, transport);
  for (const row of plans) history.plans.push(mapChargebeePlan((row.plan ?? row) as JsonObject));
  const subscriptionBounds: Record<string, string> = since ? { "updated_at[after]": since } : {};
  const subscriptions = await listAllChargebee<JsonObject>(site, "subscriptions", subscriptionBounds, transport);
  const events = await listChargebeeEvents(
    site,
    ["subscription_changed", "subscription_renewed", "subscription_cancelled", "subscription_reactivated", "subscription_paused", "subscription_resumed"],
    cursor.subscriptions ?? undefined,
    transport,
  );
  const changesBySubscription = new Map<string, typeof history.subscriptions[number]["changes"]>();
  for (const event of events) {
    const change = mapChargebeeEvent(event);
    const content = typeof event.content === "object" && event.content !== null ? event.content as JsonObject : null;
    const snapshot = content && typeof content.subscription === "object" && content.subscription !== null
      ? content.subscription as JsonObject
      : null;
    const subscriptionId = snapshot && typeof snapshot.id === "string" ? snapshot.id : "";
    if (!change || !subscriptionId) continue;
    const list = changesBySubscription.get(subscriptionId) ?? [];
    list.push(change);
    changesBySubscription.set(subscriptionId, list);
  }
  for (const row of subscriptions) {
    const sub = mapChargebeeSubscription((row.subscription ?? row) as JsonObject);
    const stated = (changesBySubscription.get(sub.externalId) ?? []).sort((a, b) => a.seq - b.seq);
    sub.changes = stated.map((change, index) => ({ ...change, seq: index }));
    history.subscriptions.push(sub);
  }
  const invoiceBounds: Record<string, string> = since ? { "updated_at[after]": since } : {};
  const invoices = await listAllChargebee<JsonObject>(site, "invoices", invoiceBounds, transport);
  for (const row of invoices) history.invoices.push(mapChargebeeInvoice((row.invoice ?? row) as JsonObject));
  const noteBounds: Record<string, string> = since ? { "updated_at[after]": since } : {};
  const notes = await listAllChargebee<JsonObject>(site, "credit_notes", noteBounds, transport);
  for (const row of notes) history.creditNotes.push(mapChargebeeCreditNote((row.credit_note ?? row) as JsonObject));
  const transactionBounds: Record<string, string> = since ? { "updated_at[after]": since } : {};
  const transactions = await listAllChargebee<JsonObject>(site, "transactions", transactionBounds, transport);
  for (const row of transactions) {
    const payment = mapChargebeePayment((row.transaction ?? row) as JsonObject);
    if (payment) history.payments.push(payment);
  }
  const coupons = await listAllChargebee<JsonObject>(site, "coupons", {}, transport);
  for (const row of coupons) history.coupons.push(mapChargebeeCoupon((row.coupon ?? row) as JsonObject));
  return history;
}

async function pullRecurly(
  credentials: Record<string, string>,
  cursor: Record<string, string>,
  transport: ConnectorTransport | undefined,
): Promise<CanonicalBillingHistory> {
  const apiKey = credentials.apiKey;
  if (!apiKey) refuse("billing_import_credentials_missing", "The Recurly connection has no API key.", "Reconnect Recurly with a fresh API key, then run the import again.");
  const site = { apiKey };
  const bounds: Record<string, string> = cursor.invoices ? { begin_time: cursor.invoices } : {};
  const customerBounds: Record<string, string> = cursor.customers ? { begin_time: cursor.customers } : {};
  const subscriptionBounds: Record<string, string> = cursor.subscriptions ? { begin_time: cursor.subscriptions } : {};
  const history = emptyBillingHistory();
  for (const row of await listAllRecurly(site, "accounts", customerBounds, transport)) {
    history.customers.push(mapRecurlyCustomer(row));
  }
  for (const row of await listAllRecurly(site, "plans", {}, transport)) {
    history.plans.push(mapRecurlyPlan(row));
  }
  const subscriptionRows = await listAllRecurly(site, "subscriptions", subscriptionBounds, transport);
  for (const row of subscriptionRows) history.subscriptions.push(mapRecurlySubscription(row));
  for (const row of await listAllRecurly(site, "invoices", bounds, transport)) {
    history.invoices.push(mapRecurlyInvoice(row));
  }
  for (const row of await listAllRecurly(site, "credit_invoices", bounds, transport)) {
    history.creditNotes.push(mapRecurlyCredit(row));
  }
  for (const row of await listAllRecurly(site, "transactions", bounds, transport)) {
    const payment = mapRecurlyPayment(row);
    if (payment) history.payments.push(payment);
  }
  for (const row of await listAllRecurly(site, "coupons", {}, transport)) {
    history.coupons.push(mapRecurlyCoupon(row));
  }
  for (const sub of history.subscriptions) {
    if (sub.changes.length) continue;
    const derived = deriveChangesFromInvoices(sub.externalId, history.invoices);
    sub.changes = derived;
  }
  return history;
}

async function pullMaxio(
  account: string,
  credentials: Record<string, string>,
  cursor: Record<string, string>,
  transport: ConnectorTransport | undefined,
): Promise<CanonicalBillingHistory> {
  const apiKey = credentials.apiKey;
  if (!apiKey) refuse("billing_import_credentials_missing", "The Maxio connection has no API key.", "Reconnect Maxio with a fresh API key, then run the import again.");
  const site = { subdomain: account, apiKey };
  const history = emptyBillingHistory();
  const bounds = maxioUpdatedBounds(cursor.customers);
  for (const row of await listAllMaxio<JsonObject>(site, "/customers.json", bounds, transport)) {
    history.customers.push(mapMaxioCustomer(row));
  }
  for (const product of await listAllMaxio<JsonObject>(site, "/products.json", {}, transport)) {
    const handle = String((product.product as JsonObject | undefined)?.handle ?? (product as JsonObject).handle ?? "");
    if (!handle) continue;
    for (const point of await listAllMaxio<JsonObject>(site, `/products/${handle}/price_points.json`, {}, transport)) {
      history.plans.push(mapMaxioPlan({ ...(point.price_point ?? point as JsonObject), product_handle: handle }));
    }
  }
  for (const row of await listAllMaxio<JsonObject>(site, "/subscriptions.json", maxioUpdatedBounds(cursor.subscriptions), transport)) {
    history.subscriptions.push(mapMaxioSubscription(row));
  }
  for (const row of await listAllMaxio<JsonObject>(site, "/invoices.json", maxioUpdatedBounds(cursor.invoices), transport)) {
    history.invoices.push(mapMaxioInvoice(row));
  }
  for (const row of await listAllMaxio<JsonObject>(site, "/invoices/payments.json", maxioUpdatedBounds(cursor.payments), transport)) {
    const payment = mapMaxioPayment(row);
    if (payment) history.payments.push(payment);
  }
  for (const row of await listAllMaxio<JsonObject>(site, "/coupons.json", {}, transport)) {
    history.coupons.push(mapMaxioCoupon(row));
  }
  for (const sub of history.subscriptions) {
    const usages = await listAllMaxio<JsonObject>(
      site,
      `/subscriptions/${encodeURIComponent(sub.externalId)}/usages.json`,
      maxioUpdatedBounds(cursor.usage),
      transport,
    );
    for (const usage of usages) history.usage.push(mapMaxioUsage(usage, sub.externalId));
  }
  for (const sub of history.subscriptions) {
    if (sub.changes.length) continue;
    sub.changes = deriveChangesFromInvoices(sub.externalId, history.invoices);
  }
  return history;
}

async function downloadZuoraQueryFile(
  site: { clientId: string; clientSecret: string; environment: "production" | "sandbox" },
  url: string,
  transport: ConnectorTransport | undefined,
): Promise<JsonObject[]> {
  const tokenRes = await fetchWithConnectorRetry(
    `${site.environment === "production" ? "https://rest.zuora.com" : "https://rest.sandbox.eu.zuora.com"}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: site.clientId, client_secret: site.clientSecret }),
      redirect: "error",
    },
    { describe: "Zuora", transport: transport ?? guardedFetch },
  );
  if (!tokenRes.ok) {
    refuse("billing_import_credentials_missing", "Zuora refused the stored client credentials.", "Reconnect Zuora with a fresh client ID and secret, then run the import again.");
  }
  const token = (await tokenRes.json() as { access_token?: string }).access_token;
  if (!token) {
    refuse("billing_import_credentials_missing", "Zuora answered without an access token.", "Reconnect Zuora with a fresh client ID and secret, then run the import again.");
  }
  const res = await fetchWithConnectorRetry(
    url,
    { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error" },
    { describe: "Zuora", transport: transport ?? guardedFetch },
  );
  if (!res.ok) {
    refuse("billing_import_query_failed", `Zuora answered the history query file with HTTP ${res.status}.`, "Run the import again; if it persists, narrow the history depth and import incrementally.");
  }
  const body = await res.text();
  const rows: JsonObject[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as JsonObject);
    } catch {
      refuse("billing_import_query_failed", "A Zuora history query file is not valid JSON.", "Run the import again; if it persists, narrow the history depth and import incrementally.");
    }
  }
  return rows;
}

async function pullZuora(
  credentials: Record<string, string>,
  cursor: Record<string, string>,
  transport: ConnectorTransport | undefined,
): Promise<CanonicalBillingHistory> {
  const { clientId, clientSecret, environment } = credentials;
  if (!clientId || !clientSecret) {
    refuse("billing_import_credentials_missing", "The Zuora connection has no client credentials.", "Reconnect Zuora with a fresh client ID and secret, then run the import again.");
  }
  const site = { clientId, clientSecret, environment: (environment === "sandbox" ? "sandbox" : "production") as "production" | "sandbox" };
  const history = emptyBillingHistory();
  const since = cursor.subscriptions ? ` where UpdatedDate > '${cursor.subscriptions}'` : "";
  for (const row of await listAllZuora(site, "/v1/accounts", {}, transport)) {
    history.customers.push(mapZuoraCustomer(row));
  }
  // Amendments and usage ride Data Query jobs at any real volume; REST lists
  // carry the catalog and the financial documents.
  const amendmentJob = await submitZuoraQuery(
    site,
    `select Id, SubscriptionId, Type, EffectiveDate, ProductRatePlanChargeId, ProductRatePlanId, Quantity, Sequence, Status from Amendment${since} order by EffectiveDate`,
    transport,
  );
  const usageJob = await submitZuoraQuery(
    site,
    `select Id, SubscriptionId, Quantity, UnitOfMeasure, StartDateTime, UpdatedDate from Usage${since} order by StartDateTime`,
    transport,
  );
  for (const row of await listAllZuora(site, "/v1/products", {}, transport)) {
    const charges = Array.isArray((row as JsonObject).productRatePlanCharges) ? (row as JsonObject).productRatePlanCharges as JsonObject[] : [];
    for (const charge of charges) history.plans.push(mapZuoraPlan(charge));
  }
  for (const row of await listAllZuora(site, "/v1/subscriptions", {}, transport)) {
    history.subscriptions.push(mapZuoraSubscription(row));
  }
  const amendmentFiles = await pollZuoraQuery(site, amendmentJob.id, transport);
  const amendmentsBySubscription = new Map<string, JsonObject[]>();
  for (const file of amendmentFiles) {
    for (const amendment of await downloadZuoraQueryFile(site, file, transport)) {
      const subscriptionId = String(amendment.SubscriptionId ?? "");
      if (!subscriptionId) continue;
      const list = amendmentsBySubscription.get(subscriptionId) ?? [];
      list.push(amendment);
      amendmentsBySubscription.set(subscriptionId, list);
    }
  }
  for (const sub of history.subscriptions) {
    const amendments = (amendmentsBySubscription.get(sub.externalId) ?? [])
      .map((row) => mapZuoraAmendment({
        type: String(row.Type ?? ""),
        effectiveDate: String(row.EffectiveDate ?? ""),
        productRatePlanChargeId: row.ProductRatePlanChargeId == null ? null : String(row.ProductRatePlanChargeId),
        productRatePlanId: row.ProductRatePlanId == null ? null : String(row.ProductRatePlanId),
        quantity: typeof row.Quantity === "number" ? row.Quantity : null,
        sequence: typeof row.Sequence === "number" ? row.Sequence : 0,
      }))
      .filter((change): change is NonNullable<typeof change> => change !== null)
      .sort((a, b) => (a.effectiveOn < b.effectiveOn ? -1 : a.effectiveOn > b.effectiveOn ? 1 : a.seq - b.seq));
    sub.changes = amendments.map((change, index) => ({ ...change, seq: index }));
  }
  for (const row of await listAllZuora(site, "/v1/invoices", {}, transport)) {
    history.invoices.push(mapZuoraInvoice(row));
  }
  for (const row of await listAllZuora(site, "/v1/creditmemos", {}, transport)) {
    history.creditNotes.push(mapZuoraCreditMemo(row));
  }
  for (const row of await listAllZuora(site, "/v1/payments", {}, transport)) {
    const payment = mapZuoraPayment(row);
    if (payment) history.payments.push(payment);
  }
  const usageFiles = await pollZuoraQuery(site, usageJob.id, transport);
  for (const file of usageFiles) {
    for (const usage of await downloadZuoraQueryFile(site, file, transport)) {
      history.usage.push(mapZuoraUsage({
        id: String(usage.Id ?? ""),
        subscriptionId: String(usage.SubscriptionId ?? ""),
        quantity: String(usage.Quantity ?? "0"),
        unitOfMeasure: usage.UnitOfMeasure == null ? null : String(usage.UnitOfMeasure),
        startDateTime: String(usage.StartDateTime ?? ""),
        updatedDate: usage.UpdatedDate == null ? null : String(usage.UpdatedDate),
      }));
    }
  }
  for (const row of await listAllZuora(site, "/v1/revenue-schedules", {}, transport)) {
    history.revenueSchedules.push(mapZuoraRevenueSchedule(row));
  }
  return history;
}

interface PersistContext {
  orgId: string;
  actorId: string;
  provider: BillingHistoryProvider;
  externalAccount: string;
  mode: "post_historical" | "opening_balances";
  cutoverOn: string | null;
  earliestOn: string | null;
  incomeAccountId: string | null;
  clearingAccountId: string | null;
  taxCodeId: string | null;
  planMap: Record<string, string>;
  customerMap: Record<string, string>;
  advancedOn: boolean;
  counts: BillingImportCounts;
  refusals: BillingImportRefusal[];
  partyByExternal: Map<string, string>;
  planByExternal: Map<string, string>;
  invoiceByExternal: Map<string, string>;
}

function addRefusal(ctx: PersistContext, objectType: string, externalId: string, error: unknown): void {
  if (error instanceof BillingHistoryError) {
    ctx.refusals.push({ objectType, externalId, code: error.code, message: error.message, remedy: error.remedy });
    return;
  }
  ctx.refusals.push({
    objectType,
    externalId,
    code: "billing_import_unexpected",
    message: error instanceof Error ? error.message : "The object could not be imported.",
    remedy: "Fix the underlying error and run the import again — completed objects replay idempotently.",
  });
}

function afterCutover(cutoverOn: string | null, date: string): boolean {
  return cutoverOn !== null && date > cutoverOn;
}

function beforeEarliest(earliestOn: string | null, date: string): boolean {
  return earliestOn !== null && date < earliestOn;
}

async function writeAudit(orgId: string, actorId: string, table: string, rowId: string, action: string, changes: unknown): Promise<void> {
  const done = await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
  `);
  if ((done.rowCount ?? 0) === 0) {
    refuse("billing_import_audit_failed", `The audit write for ${table} ${rowId} matched no row.`, "Run the import again — completed objects replay idempotently.");
  }
}

async function ensureCustomerParty(ctx: PersistContext, customer: { externalId: string; name: string; email: string | null; currency: string | null }): Promise<string | null> {
  const mapped = ctx.customerMap[customer.externalId];
  if (mapped) {
    const found = await (db.execute<{ id: string }>(sql`
      select id from parties where id = ${mapped} and org_id = ${ctx.orgId} and kind = 'customer'
    `));
    if (!found.rows[0]) {
      refuse("billing_import_customer_missing", `Mapped customer ${customer.externalId} is not an OpenBooks customer.`, "Map the customer to an existing OpenBooks customer on the preflight list, then run the import again.");
    }
    ctx.partyByExternal.set(customer.externalId, mapped);
    return mapped;
  }
  const linked = await findBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "customer", customer.externalId);
  if (linked) {
    ctx.partyByExternal.set(customer.externalId, linked);
    return linked;
  }
  const inserted = await (db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name, is_active, email, custom)
    values (${ctx.orgId}, 'customer', ${customer.name}, true, ${customer.email},
            ${JSON.stringify({ billingImport: { provider: ctx.provider, account: ctx.externalAccount, externalId: customer.externalId } })}::jsonb)
    returning id
  `));
  const partyId = inserted.rows[0]?.id;
  if (!partyId) {
    refuse("billing_import_customer_failed", `Customer ${customer.externalId} could not be created.`, "Run the import again — completed objects replay idempotently.");
  }
  // A re-run meets its own role row: refresh the currency in place. The
  // conflict-target WHERE keeps the write on this tenant's role row.
  const role = await (db.execute(sql`
    insert into customer_roles (org_id, party_id, currency, is_active)
    values (${ctx.orgId}, ${partyId}, ${customer.currency}, true)
    on conflict (party_id) do update set currency = excluded.currency
     where customer_roles.org_id = ${ctx.orgId}
  `));
  if ((role.rowCount ?? 0) === 0) {
    refuse("billing_import_customer_failed", `Customer ${customer.externalId} could not be given a customer role.`, "Run the import again — completed objects replay idempotently.");
  }
  await recordBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "customer", customer.externalId, "parties", partyId, null);
  ctx.partyByExternal.set(customer.externalId, partyId);
  return partyId;
}

async function ensureNativePlan(
  ctx: PersistContext,
  plan: CanonicalPlan,
): Promise<string | null> {
  const mapped = ctx.planMap[plan.externalId];
  if (mapped) {
    const found = await (db.execute<{ id: string }>(sql`
      select id from subscription_plans where id = ${mapped} and org_id = ${ctx.orgId}
    `));
    if (!found.rows[0]) {
      refuse("billing_import_plan_missing", `Mapped plan ${plan.externalId} is not an OpenBooks plan.`, "Map the plan to an existing OpenBooks plan on the preflight list, then run the import again.");
    }
    ctx.planByExternal.set(plan.externalId, mapped);
    return mapped;
  }
  const linked = await findBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "price", plan.externalId);
  if (linked) {
    // Price links point at the plan version; recover the plan through it.
    const owner = await (db.execute<{ plan_id: string }>(sql`
      select plan_id from subscription_plan_versions where id = ${linked} and org_id = ${ctx.orgId}
    `));
    if (owner.rows[0]) {
      ctx.planByExternal.set(plan.externalId, owner.rows[0].plan_id);
      return owner.rows[0].plan_id;
    }
  }
  // A re-run — or an operator who created the plan by hand — meets the
  // same-named plan instead of duplicating the catalog. Either path ends
  // with a published version, because activation needs one.
  const sameName = await (db.execute<{ id: string }>(sql`
    select id from subscription_plans where org_id = ${ctx.orgId} and name = ${plan.name} limit 1
  `));
  if (sameName.rows[0]) {
    const planId = sameName.rows[0].id;
    ctx.planByExternal.set(plan.externalId, planId);
    await ensurePlanVersion(ctx, planId, plan);
    return planId;
  }
  const created = await (db.execute<{ id: string }>(sql`
    insert into subscription_plans (org_id, name, description, amount, currency_code, interval,
                                    interval_count, income_account_id, tax_code_id, created_by, updated_by)
    values (${ctx.orgId}, ${plan.name}, ${`Imported from ${ctx.provider} plan ${plan.externalId}`}, ${plan.amountMajor},
            ${plan.currency}, ${plan.interval}, ${plan.intervalCount},
            ${ctx.incomeAccountId}, ${ctx.taxCodeId}, ${ctx.actorId}, ${ctx.actorId})
    returning id
  `));
  const planId = created.rows[0]?.id;
  if (!planId) {
    refuse("billing_import_plan_failed", `Plan ${plan.externalId} could not be created.`, "Run the import again — completed objects replay idempotently.");
  }
  await writeAudit(ctx.orgId, ctx.actorId, "subscription_plans", planId, "insert", {
    after: { id: planId, name: plan.name },
    source: { provider: ctx.provider, externalId: plan.externalId },
  });
  ctx.planByExternal.set(plan.externalId, planId);
  if (!ctx.advancedOn) return planId;
  await ensurePlanVersion(ctx, planId, plan);
  return planId;
}

async function ensurePlanVersion(
  ctx: PersistContext,
  planId: string,
  plan: CanonicalPlan,
): Promise<void> {
  if (await lifecycleVersionId(ctx, planId)) return;
  const versionId = await createPlanVersion(ctx.orgId, ctx.actorId, {
    planId,
    effectiveFrom: "1970-01-01",
    name: plan.name,
    currency: plan.currency,
    interval: plan.interval,
    intervalCount: plan.intervalCount,
    changeSummary: `Imported from ${ctx.provider} plan ${plan.externalId}`,
    components: [{
      componentKey: "base",
      name: plan.name,
      quantity: "1",
      unitPrice: plan.amountMajor,
      incomeAccountId: ctx.incomeAccountId,
      taxCodeId: ctx.taxCodeId,
    }],
  }, null);
  await publishPlanVersion(ctx.orgId, ctx.actorId, versionId, null);
  await recordBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "price", plan.externalId, "usage_rating_plan_versions", versionId, null);
}

async function lifecycleVersionId(ctx: PersistContext, planId: string): Promise<string | null> {
  const found = await (db.execute<{ id: string }>(sql`
    select id from subscription_plan_versions
     where org_id = ${ctx.orgId} and plan_id = ${planId} and status = 'published'
     order by effective_from desc limit 1
  `));
  return found.rows[0]?.id ?? null;
}

/** Live provider pull with the sealed credential bundle, incremental by the run cursor. */
export async function pullBillingHistory(
  provider: BillingHistoryProvider,
  externalAccount: string,
  sealedCredentials: string,
  orgId: string,
  cursor: Record<string, string>,
  transport?: ConnectorTransport,
): Promise<CanonicalBillingHistory> {
  const credentials = unsealBillingCredentials(orgId, sealedCredentials);
  switch (provider) {
    case "chargebee": return pullChargebee(externalAccount, credentials, cursor, transport);
    case "recurly": return pullRecurly(credentials, cursor, transport);
    case "maxio": return pullMaxio(externalAccount, credentials, cursor, transport);
    case "zuora": return pullZuora(credentials, cursor, transport);
  }
}

async function importSubscription(ctx: PersistContext, sub: CanonicalSubscription): Promise<void> {
  const partyId = ctx.partyByExternal.get(sub.customerExternalId);
  if (!partyId) {
    refuse("billing_import_customer_missing", `Subscription ${sub.externalId} names customer ${sub.customerExternalId}, which was not imported.`, "Widen the history pull to include the missing customer, then run the import again.");
  }
  const planId = ctx.planByExternal.get(sub.planExternalId);
  if (!planId) {
    refuse("billing_import_plan_missing", `Subscription ${sub.externalId} names plan ${sub.planExternalId}, which was not imported.`, "Map the plan on the preflight list, then run the import again.");
  }
  const linked = await findBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "subscription", sub.externalId);
  if (linked) return;
  const anchorDay = Number(sub.startOn.slice(8, 10));
  // Historical subscriptions never auto-bill on import: their invoices arrive
  // as history below, so the scheduler must not invent a new charge.
  const created = await (db.execute<{ id: string }>(sql`
    insert into subscriptions (org_id, customer_id, plan_id, quantity, price_override, start_on,
                               next_bill_on, current_period_start, auto_post, memo, anchor_day, created_by, updated_by)
    values (${ctx.orgId}, ${partyId}, ${planId}, ${sub.quantity},
            ${sub.unitAmountMajor},
            ${sub.startOn}, ${sub.currentTermEndOn ?? sub.startOn}, ${sub.startOn}, false,
            ${`Imported from ${ctx.provider} subscription ${sub.externalId}`}, ${anchorDay}, ${ctx.actorId}, ${ctx.actorId})
    returning id
  `));
  const subscriptionId = created.rows[0]?.id;
  if (!subscriptionId) {
    refuse("billing_import_subscription_failed", `Subscription ${sub.externalId} could not be created.`, "Run the import again — completed objects replay idempotently.");
  }
  await writeAudit(ctx.orgId, ctx.actorId, "subscriptions", subscriptionId, "insert", {
    after: { id: subscriptionId, planId },
    source: { provider: ctx.provider, externalId: sub.externalId },
  });
  await recordBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "subscription", sub.externalId, "subscriptions", subscriptionId, sub.updatedAt);
  if (!ctx.advancedOn) {
    if (sub.changes.length) {
      addRefusal(ctx, "subscription", sub.externalId, new BillingHistoryError(
        "billing_import_advanced_off",
        `Subscription ${sub.externalId} has ${sub.changes.length} historical change(s) that need amendment history.`,
        "Enable Advanced subscriptions in Company Settings → Features, then run the import again to reconstruct them.",
        409,
      ));
    }
    await applyTerminalStatus(ctx, subscriptionId, sub);
    return;
  }
  const versionId = await lifecycleVersionId(ctx, planId);
  if (!versionId) {
    refuse("billing_import_plan_version_missing", `Plan ${sub.planExternalId} has no published version to activate.`, "Publish a version of the plan, then run the import again.");
  }
  await activateLifecycle(ctx.orgId, ctx.actorId, {
    subscriptionId,
    planVersionId: versionId,
    termStartsOn: sub.startOn,
    termEndsOn: sub.currentTermEndOn,
    trialEndsOn: sub.trialEndOn,
    billFromUnbilledBoundary: true,
  }, null);
  const ordered = [...sub.changes].sort((a, b) => (a.effectiveOn < b.effectiveOn ? -1 : a.effectiveOn > b.effectiveOn ? 1 : a.seq - b.seq));
  for (const [index, change] of ordered.entries()) {
    try {
      await applySubscriptionChange(ctx, subscriptionId, sub, change, index);
      ctx.counts.amendments += 1;
    } catch (error) {
      addRefusal(ctx, "subscription_change", `${sub.externalId}#${index}`, error);
    }
  }
  await applyTerminalStatus(ctx, subscriptionId, sub);
}

async function applyTerminalStatus(
  ctx: PersistContext,
  subscriptionId: string,
  sub: CanonicalSubscription,
): Promise<void> {
  const status = sub.status === "trial" ? "active" : sub.status;
  const done = await (db.execute(sql`
    update subscriptions set status = ${status}, canceled_on = ${sub.status === "canceled" ? sub.canceledOn : null},
           updated_at = now(), updated_by = ${ctx.actorId}
     where id = ${subscriptionId} and org_id = ${ctx.orgId}
  `));
  if ((done.rowCount ?? 0) === 0) {
    refuse("billing_import_subscription_failed", `Subscription ${sub.externalId} could not be finalized.`, "Run the import again — completed objects replay idempotently.");
  }
}

async function applySubscriptionChange(
  ctx: PersistContext,
  subscriptionId: string,
  sub: CanonicalSubscription,
  change: CanonicalSubscription["changes"][number],
  index: number,
): Promise<void> {
  const idempotencyKey = `billing-import:${ctx.provider}:${ctx.externalAccount}:${sub.externalId}:${index}`;
  switch (change.kind) {
    case "plan_change":
    case "quantity_change": {
      const planId = change.planExternalId ? ctx.planByExternal.get(change.planExternalId) : null;
      const unitPrice = change.unitAmountMajor
        ?? (planId ? await nativePlanAmount(ctx, planId) : null)
        ?? sub.unitAmountMajor;
      await applyAmendment(ctx.orgId, ctx.actorId, {
        subscriptionId,
        type: "change_component",
        effectiveOn: change.effectiveOn,
        idempotencyKey,
        reason: `Billing history import from ${ctx.provider} (${change.kind})`,
        componentKey: "base",
        quantity: change.quantity ?? undefined,
        unitPrice: unitPrice ?? undefined,
      });
      if (planId) {
        const moved = await (db.execute(sql`
          update subscriptions set plan_id = ${planId}, updated_at = now(), updated_by = ${ctx.actorId}
           where id = ${subscriptionId} and org_id = ${ctx.orgId}
        `));
        if ((moved.rowCount ?? 0) === 0) {
          refuse("billing_import_subscription_failed", `Subscription ${sub.externalId} could not follow its plan change.`, "Run the import again — completed objects replay idempotently.");
        }
      }
      return;
    }
    case "pause":
    case "resume": {
      const done = await (db.execute(sql`
        update subscriptions set status = ${change.kind === "pause" ? "paused" : "active"}, updated_at = now(), updated_by = ${ctx.actorId}
         where id = ${subscriptionId} and org_id = ${ctx.orgId}
      `));
      if ((done.rowCount ?? 0) === 0) {
        refuse("billing_import_subscription_failed", `Subscription ${sub.externalId} could not record its ${change.kind}.`, "Run the import again — completed objects replay idempotently.");
      }
      await writeAudit(ctx.orgId, ctx.actorId, "subscriptions", subscriptionId, "update", {
        after: { status: change.kind === "pause" ? "paused" : "active" },
        source: { provider: ctx.provider, externalId: sub.externalId, change: change.kind, effectiveOn: change.effectiveOn },
      });
      return;
    }
    case "cancel":
    case "renew":
    case "term_change": {
      // The terminal state lands once at the end (applyTerminalStatus); a
      // mid-history cancel followed by resume replays through the pause path.
      // Renewals and term changes with a stated term end move the lifecycle.
      if ((change.kind === "renew" || change.kind === "term_change") && sub.currentTermEndOn) {
        await applyAmendment(ctx.orgId, ctx.actorId, {
          subscriptionId,
          type: "change_term",
          effectiveOn: change.effectiveOn,
          idempotencyKey,
          reason: `Billing history import from ${ctx.provider} (${change.kind})`,
          termEndsOn: sub.currentTermEndOn,
        });
        return;
      }
      return;
    }
  }
}

async function nativePlanAmount(ctx: PersistContext, planId: string): Promise<string | null> {
  const found = await (db.execute<{ amount: string }>(sql`
    select amount::text as amount from subscription_plans where id = ${planId} and org_id = ${ctx.orgId}
  `));
  return found.rows[0]?.amount ?? null;
}

async function importInvoice(ctx: PersistContext, invoice: {
  externalId: string; number: string | null; customerExternalId: string; date: string; dueDate: string | null;
  currency: string; lines: { description: string; quantity: string; unitPriceMajor: string; amountMajor: string }[];
  totalMajor: string; balanceMajor: string; status: string; updatedAt: string | null;
  kind: "invoice" | "credit";
}): Promise<boolean> {
  if (afterCutover(ctx.cutoverOn, invoice.date) || beforeEarliest(ctx.earliestOn, invoice.date)) {
    ctx.counts.skipped += 1;
    return false;
  }
  // Opening balances carry only what is still owed: settled history stays
  // in the source platform, and the cut-over brings open items.
  if (ctx.mode === "opening_balances" && invoice.balanceMajor === "0.0000") {
    ctx.counts.skipped += 1;
    return false;
  }
  if (invoice.status === "void") {
    ctx.counts.skipped += 1;
    return false;
  }
  const linked = await findBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, invoice.kind === "invoice" ? "invoice" : "credit_note", invoice.externalId);
  if (linked) {
    ctx.invoiceByExternal.set(invoice.externalId, linked);
    return true;
  }
  const partyId = ctx.partyByExternal.get(invoice.customerExternalId);
  if (!partyId) {
    refuse("billing_import_customer_missing", `Historical ${invoice.kind} ${invoice.externalId} names customer ${invoice.customerExternalId}, which was not imported.`, "Widen the history pull to include the missing customer, then run the import again.");
  }
  if (!ctx.incomeAccountId) {
    refuse("billing_import_account_missing", `Historical ${invoice.kind} ${invoice.externalId} needs an income account.`, "Choose the income account for historical revenue in the import settings, then run the import again.");
  }
  const firstLine = invoice.lines[0];
  const result = await createSubscriptionInvoice({
    orgId: ctx.orgId,
    actorId: ctx.actorId,
    customerId: partyId,
    subsidiaryId: null,
    currency: invoice.currency,
    incomeAccountId: ctx.incomeAccountId,
    itemId: null,
    taxCodeId: ctx.taxCodeId,
    description: firstLine?.description ?? `${invoice.kind} ${invoice.externalId}`,
    quantity: firstLine?.quantity ?? "1",
    unitPrice: firstLine?.unitPriceMajor ?? "0.0000",
    memo: `Imported from ${ctx.provider} ${invoice.kind} ${invoice.number ?? invoice.externalId}`,
    invoiceDate: invoice.date,
    dueDate: invoice.dueDate,
    autoPost: ctx.mode === "post_historical",
    applyTax: true,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPriceMajor,
      amount: line.amountMajor,
      incomeAccountId: ctx.incomeAccountId,
      itemId: null,
      taxCodeId: ctx.taxCodeId,
    })),
    custom: { billingImport: { provider: ctx.provider, account: ctx.externalAccount, externalId: invoice.externalId } },
    postingAuditSource: `billing-import:${ctx.provider}:${ctx.externalAccount}`,
    documentKind: invoice.kind === "invoice" ? "customer_invoice" : "customer_credit",
  });
  await recordBillingLink(
    ctx.orgId, ctx.provider, ctx.externalAccount,
    invoice.kind === "invoice" ? "invoice" : "credit_note",
    invoice.externalId, "documents", result.invoiceId, invoice.updatedAt,
  );
  ctx.invoiceByExternal.set(invoice.externalId, result.invoiceId);
  return true;
}

async function importPayment(ctx: PersistContext, payment: {
  externalId: string; customerExternalId: string; date: string; currency: string;
  amountMajor: string; method: string | null;
  applications: { invoiceExternalId: string; amountMajor: string }[];
  updatedAt: string | null;
}): Promise<boolean> {
  if (afterCutover(ctx.cutoverOn, payment.date) || beforeEarliest(ctx.earliestOn, payment.date)) {
    ctx.counts.skipped += 1;
    return false;
  }
  const linked = await findBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "payment", payment.externalId);
  if (linked) return true;
  const partyId = ctx.partyByExternal.get(payment.customerExternalId);
  if (!partyId) {
    refuse("billing_import_customer_missing", `Historical payment ${payment.externalId} names customer ${payment.customerExternalId}, which was not imported.`, "Widen the history pull to include the missing customer, then run the import again.");
  }
  if (ctx.mode === "opening_balances") {
    // Opening cash rides draft receipts without applications: the open
    // invoices above already state what is still owed, and cut-over close
    // applies the cash. Posting applications against draft documents would
    // fake settled history as native settlement.
    const receipt = await createPaymentDocument({
      orgId: ctx.orgId,
      kind: "customer_payment",
      createdBy: ctx.actorId,
      allowedSubsidiaryIds: null,
      partyId,
      currency: payment.currency,
      documentDate: payment.date,
      memo: `Imported from ${ctx.provider} payment ${payment.externalId}`,
    });
    await recordBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "payment", payment.externalId, "documents", receipt.id, payment.updatedAt);
    return true;
  }
  if (!ctx.clearingAccountId) {
    refuse("billing_import_account_missing", `Historical payment ${payment.externalId} needs a clearing account to post against.`, "Choose the clearing account for historical collections in the import settings, then run the import again.");
  }
  const receipt = await createPaymentDocument({
    orgId: ctx.orgId,
    kind: "customer_payment",
    createdBy: ctx.actorId,
    allowedSubsidiaryIds: null,
    partyId,
    bankAccountId: ctx.clearingAccountId,
    currency: payment.currency,
    documentDate: payment.date,
    memo: `Imported from ${ctx.provider} payment ${payment.externalId}`,
  });
  // Receipt lines settle through the payment module's own allocation
  // contract — no second settlement writer.
  const allocations: AllocationInput[] = [];
  for (const application of payment.applications) {
    const invoiceId = ctx.invoiceByExternal.get(application.invoiceExternalId);
    if (!invoiceId) continue;
    const line = await (db.execute<{ id: string }>(sql`
      select jl.id from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${ctx.orgId} and je.source_document_id = ${invoiceId}
         -- Live entries only: receipts allocate only to live open items; a reversed invoice authorizes no allocation
         and je.status = 'posted' and jl.is_open_item
       limit 1
    `));
    if (!line.rows[0]) continue;
    allocations.push(sameCurrencyAllocation(line.rows[0].id, application.amountMajor));
  }
  await updateDraftPayment(receipt.id, {
    bankAccountId: ctx.clearingAccountId,
    allocations,
  }, ctx.actorId, ctx.orgId, { allowedSubsidiaryIds: null });
  await postPaymentWithApplications(receipt.id, allocations, ctx.actorId, "api");
  await recordBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "payment", payment.externalId, "documents", receipt.id, payment.updatedAt);
  return true;
}

async function importUsageRecord(ctx: PersistContext, usage: {
  externalId: string; subscriptionExternalId: string; meterKey: string; quantityMajor: string; date: string; updatedAt: string | null;
}): Promise<boolean> {
  if (afterCutover(ctx.cutoverOn, usage.date) || beforeEarliest(ctx.earliestOn, usage.date)) {
    ctx.counts.skipped += 1;
    return false;
  }
  const meter = await (db.execute<{ id: string; is_active: boolean }>(sql`
    select id, is_active from usage_meters where org_id = ${ctx.orgId} and key = ${usage.meterKey}
  `));
  if (!meter.rows[0]) {
    refuse("billing_import_meter_missing", `Usage ${usage.externalId} names meter "${usage.meterKey}", which does not exist.`, "Create the usage meter first, or map the source metric to an existing meter key, then run the import again.");
  }
  if (!meter.rows[0].is_active) {
    refuse("billing_import_meter_inactive", `Usage ${usage.externalId} names meter "${usage.meterKey}", which is deactivated.`, "Reactivate the meter or map the source metric to an active meter key, then run the import again.");
  }
  const subscriptionLink = await findBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "subscription", usage.subscriptionExternalId);
  const subscription = subscriptionLink
    ? await (db.execute<{ customer_id: string }>(sql`
        select customer_id from subscriptions where id = ${subscriptionLink} and org_id = ${ctx.orgId}
      `))
    : null;
  const customerId = subscription?.rows[0]?.customer_id;
  if (!customerId) {
    refuse("billing_import_subscription_missing", `Usage ${usage.externalId} names subscription ${usage.subscriptionExternalId}, which was not imported.`, "Import the subscription first, then run the import again.");
  }
  try {
    await ingestUsageRecords(ctx.orgId, ctx.actorId, [{
      meterKey: usage.meterKey,
      customerId,
      subscriptionId: subscriptionLink,
      occurredOn: usage.date,
      quantity: usage.quantityMajor,
      source: "import",
      sourceRef: usage.externalId,
      idempotencyKey: `billing-import:${ctx.provider}:${ctx.externalAccount}:${usage.externalId}`,
    }], null);
  } catch (error) {
    // Usage deduplicates on its idempotency key: a replayed record is a
    // completed write, not a failure.
    if (error instanceof Error && /duplicate|already exists|idempoten/i.test(error.message)) return true;
    throw error;
  }
  return true;
}

/** Fixed 4-decimal major spelling → bigint minor units through the currency exponent. */
function couponAmountMinor(amountMajor: string, currency: string): string {
  const units = BigInt(amountMajor.replace(".", ""));
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return String(units / 10000n);
  if (THREE_DECIMAL_CURRENCIES.has(code)) return String(units / 10n);
  return String(units / 100n);
}

async function importCoupon(ctx: PersistContext, coupon: {
  externalId: string; code: string; name: string; kind: "percent" | "amount";
  percentValue: string | null; amountMajor: string | null; currency: string | null;
  durationMonths: number | null; active: boolean; updatedAt: string | null;
}): Promise<boolean> {
  const linked = await findBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "coupon", coupon.externalId);
  if (linked) return true;
  const created = await createPromotion(db, ctx.orgId, ctx.actorId, {
    code: coupon.code,
    name: coupon.name,
    description: `Imported from ${ctx.provider} coupon ${coupon.externalId}`,
    kind: coupon.kind,
    percentValue: coupon.percentValue,
    amountMinor: coupon.amountMajor == null || coupon.currency == null ? null : couponAmountMinor(coupon.amountMajor, coupon.currency),
    currency: coupon.currency,
    startsAt: null,
    endsAt: null,
    channelScopeId: null,
    usageLimit: null,
    discountAccountId: null,
  });
  if (coupon.active) {
    await setPromotionStatus(db, ctx.orgId, ctx.actorId, created.id, "active");
  }
  await recordBillingLink(ctx.orgId, ctx.provider, ctx.externalAccount, "coupon", coupon.externalId, "promotions", created.id, coupon.updatedAt);
  return true;
}

// --- Native-side reconciliation readers -------------------------------------------
// The OpenBooks side of the reconciliation is re-derived from native rows —
// never from the pulled history — so the report compares what is actually
// stored, not what was sent.

interface NativeAmendmentRow extends Record<string, unknown> {
  amendment_type: string;
  effective_on: string;
  request: { quantity?: string; unitPrice?: string; componentKey?: string };
  after_snapshot: { components?: { componentKey?: string; component_key?: string; quantity?: string; unitPrice?: string; unit_price?: string; effectiveFrom?: string; effective_from?: string }[] };
}

/** Native subscriptions rebuilt as canonical timelines from components, amendments and pause/resume audit evidence. */
async function readNativeSubscriptionStates(
  orgId: string,
  provider: BillingHistoryProvider,
  externalAccount: string,
): Promise<{ subscriptions: CanonicalSubscription[]; plans: Map<string, PricedPlan> }> {
  const subs = await (db.execute<{
    external_id: string; id: string; status: string; start_on: string; canceled_on: string | null;
    plan_id: string; quantity: string; price_override: string | null;
  }>(sql`
    select l.external_id, s.id, s.status, s.start_on::text as start_on, s.canceled_on::text as canceled_on,
           s.plan_id, s.quantity::text as quantity, s.price_override::text as price_override
      from external_links l join subscriptions s on s.org_id = l.org_id and s.id = l.native_id
     where l.org_id = ${orgId} and l.provider = ${provider} and l.external_account = ${externalAccount}
       and l.native_table = 'subscriptions' and l.object_type = 'subscription'
  `));
  const planRows = await (db.execute<{
    id: string; amount: string; interval: string; interval_count: number;
  }>(sql`
    select id, amount::text as amount, interval, interval_count from subscription_plans where org_id = ${orgId}
  `));
  const plans = new Map(planRows.rows.map((row) => [row.id, {
    amountMajor: row.amount,
    interval: row.interval as CanonicalPlan["interval"],
    intervalCount: row.interval_count,
  }]));
  const subscriptions: CanonicalSubscription[] = [];
  for (const sub of subs.rows) {
    const components = await (db.execute<{
      quantity: string; unit_price: string; effective_from: string; effective_to: string | null;
    }>(sql`
      select quantity::text as quantity, unit_price::text as unit_price,
             effective_from::text as effective_from, effective_to::text as effective_to
        from subscription_components where org_id = ${orgId} and subscription_id = ${sub.id}
       order by effective_from
    `));
    const amendments = await (db.execute<NativeAmendmentRow>(sql`
      select amendment_type, effective_on::text as effective_on, request, after_snapshot
        from subscription_amendments where org_id = ${orgId} and subscription_id = ${sub.id}
       order by amendment_number
    `));
    const pauses = await (db.execute<{ effective_on: string; status: string }>(sql`
      select changes->'source'->>'effectiveOn' as effective_on,
             changes->'after'->>'status' as status
        from audit_log
       where org_id = ${orgId} and table_name = 'subscriptions' and row_id = ${sub.id}
         and changes->'source'->>'provider' = ${provider}
         and changes->'source'->>'change' in ('pause', 'resume')
       order by changes->'source'->>'effectiveOn'
    `));
    const changes: CanonicalSubscription["changes"] = [];
    let seq = 0;
    for (const amendment of amendments.rows) {
      const after = (amendment.after_snapshot?.components ?? []).find((component) =>
        (component.componentKey ?? component.component_key) === (amendment.request?.componentKey ?? "base")
        && (component.effectiveFrom ?? component.effective_from) === amendment.effective_on,
      );
      if (amendment.amendment_type === "change_component") {
        changes.push({
          seq: seq++,
          effectiveOn: amendment.effective_on,
          kind: "plan_change",
          planExternalId: null,
          quantity: after?.quantity ?? amendment.request?.quantity ?? null,
          unitAmountMajor: after?.unitPrice ?? after?.unit_price ?? amendment.request?.unitPrice ?? null,
          derived: false,
        });
      } else if (amendment.amendment_type === "remove_component") {
        changes.push({ seq: seq++, effectiveOn: amendment.effective_on, kind: "quantity_change", planExternalId: null, quantity: "0", unitAmountMajor: null, derived: false });
      } else if (amendment.amendment_type === "change_term" || amendment.amendment_type === "renew" || amendment.amendment_type === "coterm") {
        changes.push({ seq: seq++, effectiveOn: amendment.effective_on, kind: "renew", planExternalId: null, quantity: null, unitAmountMajor: null, derived: false });
      }
    }
    for (const pause of pauses.rows) {
      if (!pause.effective_on) continue;
      changes.push({
        seq: seq++,
        effectiveOn: pause.effective_on,
        kind: pause.status === "paused" ? "pause" : "resume",
        planExternalId: null,
        quantity: null,
        unitAmountMajor: null,
        derived: false,
      });
    }
    const firstWindow = components.rows[0];
    subscriptions.push({
      externalId: sub.external_id,
      customerExternalId: "",
      planExternalId: sub.plan_id,
      quantity: firstWindow?.quantity ?? sub.quantity,
      unitAmountMajor: firstWindow?.unit_price ?? sub.price_override,
      currency: "",
      status: sub.status as CanonicalSubscription["status"],
      startOn: sub.start_on,
      canceledOn: sub.canceled_on,
      trialEndOn: null,
      currentTermEndOn: null,
      updatedAt: null,
      changes,
    });
  }
  return { subscriptions, plans };
}

/** Native open AR by source customer: posted open balances plus draft opening totals, net of credits. */
async function readNativeOpenAr(
  orgId: string,
  provider: BillingHistoryProvider,
  externalAccount: string,
): Promise<Map<string, string>> {
  const rows = await (db.execute<{
    customer_external_id: string; object_type: string; status: string; total: string; open_balance: string | null;
  }>(sql`
    with customer_map as (
      select l.external_id as customer_external_id, l.native_id as party_id
        from external_links l
       where l.org_id = ${orgId} and l.provider = ${provider} and l.external_account = ${externalAccount}
         and l.native_table = 'parties' and l.object_type = 'customer'
    )
    select cm.customer_external_id, l.object_type, d.status,
           d.total::text as total, d.open_balance::text as open_balance
      from external_links l
      join documents d on d.org_id = l.org_id and d.id = l.native_id
      join customer_map cm on cm.party_id = d.party_id
     where l.org_id = ${orgId} and l.provider = ${provider} and l.external_account = ${externalAccount}
       and l.native_table = 'documents' and l.object_type in ('invoice', 'credit_note')
       and d.status <> 'voided'
  `));
  const open = new Map<string, string>();
  const add = (customer: string, amount: string) => open.set(customer, addCanonical(open.get(customer) ?? "0.0000", amount));
  const sub = (customer: string, amount: string) => open.set(customer, subCanonical(open.get(customer) ?? "0.0000", amount));
  for (const row of rows.rows) {
    // Posted documents carry live open balances; draft opening documents
    // carry their totals until cut-over close posts them.
    const amount = row.status === "posted" ? (row.open_balance ?? "0.0000") : row.total;
    if (row.object_type === "invoice") add(row.customer_external_id, amount);
    else sub(row.customer_external_id, amount);
  }
  return open;
}

function addCanonical(left: string, right: string): string {
  const [lw = "0", lf = ""] = left.split(".");
  const [rw = "0", rf = ""] = right.split(".");
  const sum = BigInt(lw + lf.padEnd(4, "0")) + BigInt(rw + rf.padEnd(4, "0"));
  const negative = sum < 0n;
  const abs = negative ? -sum : sum;
  return `${negative ? "-" : ""}${abs / 10000n}.${String(abs % 10000n).padStart(4, "0")}`;
}

function subCanonical(left: string, right: string): string {
  const [lw = "0", lf = ""] = left.split(".");
  const [rw = "0", rf = ""] = right.split(".");
  const diff = BigInt(lw + lf.padEnd(4, "0")) - BigInt(rw + rf.padEnd(4, "0"));
  const negative = diff < 0n;
  const abs = negative ? -diff : diff;
  return `${negative ? "-" : ""}${abs / 10000n}.${String(abs % 10000n).padStart(4, "0")}`;
}

/**
 * Native contracted backlog at cut-over: for each active subscription whose
 * term runs past cut-over, the whole months remaining priced at the current
 * component rate. An estimate on both sides — the source schedules are the
 * platform's own version of it — and exact when terms align.
 */
async function readNativeDeferred(orgId: string, cutoverOn: string): Promise<string> {
  const afterMonth = cutoverOn.slice(0, 7);
  const rows = await (db.execute<{
    term_ends_on: string; unit_price: string; quantity: string; interval: string; interval_count: number;
  }>(sql`
    select l.term_ends_on::text as term_ends_on, c.unit_price::text as unit_price, c.quantity::text as quantity,
           p.interval, p.interval_count
      from subscription_lifecycles l
      join subscriptions s on s.org_id = l.org_id and s.id = l.subscription_id
      join subscription_plans p on p.org_id = l.org_id and p.id = s.plan_id
      join lateral (
        select unit_price, quantity from subscription_components
         where org_id = l.org_id and subscription_id = l.subscription_id
         order by effective_from desc limit 1
      ) c on true
     where l.org_id = ${orgId} and s.status = 'active' and l.term_ends_on > ${cutoverOn}::date
  `));
  let total = "0.0000";
  for (const row of rows.rows) {
    // Whole months strictly after the cut-over month through the term-end
    // month; a term ending inside the cut-over month leaves no backlog.
    if (row.term_ends_on.slice(0, 7) <= afterMonth) continue;
    const months = monthRange(nextMonth(afterMonth), row.term_ends_on.slice(0, 7));
    const monthly = monthlyRecurringRevenue(row.unit_price, row.interval as CanonicalPlan["interval"], row.interval_count, row.quantity);
    for (const _month of months) {
      total = addCanonical(total, monthly);
    }
  }
  return total;
}

function nextMonth(month: string): string {
  return addMonthsClamped(`${month}-01`, 1).slice(0, 7);
}

// --- Run rows ----------------------------------------------------------------------

export interface BillingRunRecord {
  id: string;
  provider: BillingHistoryProvider;
  externalAccount: string;
  status: string;
  config: BillingImportConfig;
  cursor: Record<string, string>;
}

function defaultConfig(): BillingImportConfig {
  return {
    mode: "post_historical",
    cutoverOn: null,
    historyDepthMonths: null,
    incomeAccountId: null,
    clearingAccountId: null,
    taxCodeId: null,
    planMap: {},
    customerMap: {},
    autoSync: false,
    sealedCredentials: null,
  };
}

function configFromRow(row: { config: unknown }): BillingImportConfig {
  const raw = (row.config ?? {}) as Partial<BillingImportConfig>;
  return {
    mode: raw.mode === "opening_balances" ? "opening_balances" : "post_historical",
    cutoverOn: typeof raw.cutoverOn === "string" ? raw.cutoverOn : null,
    historyDepthMonths: typeof raw.historyDepthMonths === "number" ? raw.historyDepthMonths : null,
    incomeAccountId: typeof raw.incomeAccountId === "string" ? raw.incomeAccountId : null,
    clearingAccountId: typeof raw.clearingAccountId === "string" ? raw.clearingAccountId : null,
    taxCodeId: typeof raw.taxCodeId === "string" ? raw.taxCodeId : null,
    planMap: raw.planMap && typeof raw.planMap === "object" ? raw.planMap as Record<string, string> : {},
    customerMap: raw.customerMap && typeof raw.customerMap === "object" ? raw.customerMap as Record<string, string> : {},
    autoSync: raw.autoSync === true,
    sealedCredentials: typeof raw.sealedCredentials === "string" ? raw.sealedCredentials : null,
  };
}

async function insertRunRow(
  orgId: string,
  actorId: string,
  provider: BillingHistoryProvider,
  externalAccount: string,
  status: string,
  config: BillingImportConfig,
): Promise<string> {
  const inserted = await (db.execute<{ id: string }>(sql`
    insert into billing_import_runs (org_id, provider, external_account, status, mode, cutover_on, config, created_by, updated_by)
    values (${orgId}, ${provider}, ${externalAccount}, ${status}, ${config.mode}, ${config.cutoverOn},
            ${JSON.stringify(config)}::jsonb, ${actorId}, ${actorId})
    returning id
  `));
  const id = inserted.rows[0]?.id;
  if (!id) {
    refuse("billing_import_run_failed", "The import run could not be recorded.", "Run the import again.");
  }
  return id;
}

async function updateRunRow(
  orgId: string,
  runId: string,
  patch: { status?: string; config?: unknown; counts?: unknown; cursor?: unknown; reconciliation?: unknown; lastError?: string | null; finished?: boolean },
): Promise<void> {
  const done = await (db.execute(sql`
    update billing_import_runs
       set status = coalesce(${patch.status ?? null}, status),
           config = coalesce(${patch.config === undefined ? null : JSON.stringify(patch.config)}::jsonb, config),
           counts = coalesce(${patch.counts === undefined ? null : JSON.stringify(patch.counts)}::jsonb, counts),
           cursor = coalesce(${patch.cursor === undefined ? null : JSON.stringify(patch.cursor)}::jsonb, cursor),
           reconciliation = coalesce(${patch.reconciliation === undefined ? null : JSON.stringify(patch.reconciliation)}::jsonb, reconciliation),
           last_error = ${patch.lastError === undefined ? sql`last_error` : patch.lastError},
           finished_at = ${patch.finished ? sql`now()` : sql`finished_at`},
           updated_at = now()
     where id = ${runId} and org_id = ${orgId}
  `));
  if ((done.rowCount ?? 0) === 0) {
    refuse("billing_import_run_failed", "The import run row could not be updated.", "Run the import again — completed objects replay idempotently.");
  }
}

async function loadRunRow(orgId: string, runId: string): Promise<BillingRunRecord> {
  const found = await (db.execute<{
    id: string; provider: string; external_account: string; status: string; config: unknown; cursor: unknown;
  }>(sql`
    select id, provider, external_account, status, config, cursor
      from billing_import_runs where id = ${runId} and org_id = ${orgId}
  `));
  const row = found.rows[0];
  if (!row || (row.provider !== "chargebee" && row.provider !== "recurly" && row.provider !== "maxio" && row.provider !== "zuora")) {
    refuse("billing_import_run_missing", "The import run does not exist in this organization.", "Start a new import from the billing history console.");
  }
  return {
    id: row.id,
    provider: row.provider,
    externalAccount: row.external_account,
    status: row.status,
    config: configFromRow({ config: row.config }),
    cursor: (row.cursor ?? {}) as Record<string, string>,
  };
}

export interface BillingRunSummary extends BillingRunRecord {
  mode: "post_historical" | "opening_balances";
  counts: BillingImportCounts | null;
  lastError: string | null;
  updatedAt: string;
}

export async function listBillingImportRuns(orgId: string, provider?: BillingHistoryProvider): Promise<BillingRunSummary[]> {
  const found = await (db.execute<{
    id: string; provider: string; external_account: string; mode: string; status: string;
    config: unknown; cursor: unknown; counts: unknown; last_error: string | null; updated_at: Date;
  }>(sql`
    select id, provider, external_account, mode, status, config, cursor, counts, last_error, updated_at
      from billing_import_runs where org_id = ${orgId}
       ${provider ? sql`and provider = ${provider}` : sql``}
      order by created_at desc limit 50
  `));
  return found.rows.map((row) => ({
    id: row.id,
    provider: row.provider as BillingHistoryProvider,
    externalAccount: row.external_account,
    status: row.status,
    config: configFromRow({ config: row.config }),
    cursor: (row.cursor ?? {}) as Record<string, string>,
    mode: row.mode === "opening_balances" ? "opening_balances" : "post_historical",
    counts: (row.counts ?? null) as BillingImportCounts | null,
    lastError: row.last_error,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }));
}

// --- Preflight -----------------------------------------------------------------------

async function loadPreflightCatalog(orgId: string, taxCodeId: string | null): Promise<PreflightCatalog> {
  const org = await (db.execute<{ base_currency: string }>(sql`
    select base_currency from orgs where id = ${orgId}
  `));
  const baseCurrency = org.rows[0]?.base_currency ?? "USD";
  const multiCurrency = await (orgFeatureEnabled(orgId, "multiCurrency"));
  const plans = await (db.execute<{
    id: string; name: string; amount: string; currency: string | null; interval: string;
  }>(sql`
    select id, name, amount::text as amount, currency_code as currency, interval
      from subscription_plans where org_id = ${orgId} and is_active
  `));
  const taxCode = taxCodeId
    ? await (db.execute<{ id: string; name: string }>(sql`
        select id, name from tax_codes where id = ${taxCodeId} and org_id = ${orgId}
      `))
    : null;
  return {
    plans: plans.rows.map((row) => ({
      id: row.id,
      name: row.name,
      amountMajor: row.amount,
      currency: row.currency,
      interval: row.interval as CanonicalPlan["interval"],
    })),
    baseCurrency,
    multiCurrency,
    defaultTaxCode: taxCode?.rows[0] ? { id: taxCode.rows[0].id, name: taxCode.rows[0].name } : null,
  };
}

export interface BillingPreflightResult {
  runId: string;
  preflight: BillingPreflight;
}

/**
 * Connect (seal credentials), pull, and preflight: counts per object plus the
 * Needs-attention list with suggested mappings. Nothing is persisted except
 * the run row itself.
 */
export async function runBillingPreflight(
  orgId: string,
  actorId: string,
  provider: BillingHistoryProvider,
  externalAccount: string,
  credentials: Record<string, string>,
  config: Partial<BillingImportConfig>,
  transport?: ConnectorTransport,
): Promise<BillingPreflightResult> {
  if (!externalAccount.trim()) {
    refuse("billing_import_account_invalid", "The billing account name is empty.", "Enter the provider account or site name, then try again.");
  }
  const full: BillingImportConfig = {
    ...defaultConfig(),
    ...config,
    planMap: config.planMap ?? {},
    customerMap: config.customerMap ?? {},
    sealedCredentials: sealBillingCredentials(orgId, credentials),
  };
  const runId = await withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, FEATURE))) {
      refuse("billing_import_feature_off", "Billing history import is turned off for this organization.", FEATURE_REMEDY, 409);
    }
    return insertRunRow(orgId, actorId, provider, externalAccount.trim(), "preflight", full);
  });
  try {
    const history = await pullBillingHistory(provider, externalAccount.trim(), full.sealedCredentials!, orgId, {}, transport);
    const catalog = await loadPreflightCatalog(orgId, full.taxCodeId);
    const preflight = planBillingPreflight(history, catalog);
    await updateRunRow(orgId, runId, { status: "preflight", counts: preflight.counts });
    return { runId, preflight };
  } catch (error) {
    await updateRunRow(orgId, runId, {
      status: "failed",
      lastError: error instanceof Error ? error.message : "Preflight failed",
      finished: true,
    });
    throw error;
  }
}

// --- Main runner -----------------------------------------------------------------------

function validCutover(value: string | null | undefined, label: string): string | null {
  if (value == null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    refuse("billing_import_cutover_invalid", `The ${label} ${value} is not a valid date.`, "Enter the cut-over as YYYY-MM-DD, then run the import again.");
  }
  return value;
}

/** The pulled history narrowed to what this run imports: in-window, in-scope, comparable. */
function filterHistoryForRecon(
  history: CanonicalBillingHistory,
  ctx: { cutoverOn: string | null; earliestOn: string | null; mode: string },
): CanonicalBillingHistory {
  const inScope = (date: string) => !afterCutover(ctx.cutoverOn, date) && !beforeEarliest(ctx.earliestOn, date);
  return {
    customers: history.customers,
    plans: history.plans,
    subscriptions: history.subscriptions,
    invoices: history.invoices.filter((invoice) =>
      inScope(invoice.date) && invoice.status !== "void"
      && (ctx.mode === "post_historical" || invoice.balanceMajor !== "0.0000"),
    ),
    creditNotes: history.creditNotes.filter((note) =>
      inScope(note.date) && (ctx.mode === "post_historical" || note.balanceMajor !== "0.0000"),
    ),
    payments: history.payments.filter((payment) => inScope(payment.date)),
    usage: history.usage.filter((usage) => inScope(usage.date)),
    coupons: history.coupons,
    revenueSchedules: history.revenueSchedules,
  };
}

function reconMonths(history: CanonicalBillingHistory, cutoverOn: string | null): string[] {
  const starts = history.subscriptions.map((sub) => sub.startOn).sort();
  if (!starts.length) return [];
  const fromMonth = starts[0]!.slice(0, 7);
  const ends = [
    ...history.invoices.map((invoice) => invoice.date),
    ...history.subscriptions.map((sub) => sub.canceledOn ?? sub.startOn),
  ].sort();
  const lastMonth = (cutoverOn ?? ends[ends.length - 1] ?? `${fromMonth}-01`).slice(0, 7);
  if (lastMonth < fromMonth) return [];
  return monthRange(fromMonth, lastMonth);
}

function normalizeMrr(amount: string, interval: CanonicalPlan["interval"], intervalCount: number, quantity: string): string {
  return monthlyRecurringRevenue(amount, interval, intervalCount, quantity);
}

export async function runBillingHistoryImport(
  source: BillingHistorySource,
  opts: BillingImportOptions & { runId?: string },
): Promise<BillingImportResult> {
  const { orgId, actorId } = opts;
  const cutoverOn = validCutover(opts.cutoverOn, "cut-over date");
  if (opts.historyDepthMonths !== undefined && opts.historyDepthMonths !== null
    && (!Number.isSafeInteger(opts.historyDepthMonths) || opts.historyDepthMonths <= 0)) {
    refuse("billing_import_depth_invalid", "The history depth must be a positive whole number of months.", "Enter a positive history depth, then run the import again.");
  }
  let runId = opts.runId ?? null;
  let config: BillingImportConfig;
  if (runId) {
    const existing = await loadRunRow(orgId, runId);
    if (existing.provider !== source.provider || existing.externalAccount !== source.externalAccount) {
      refuse("billing_import_run_mismatch", "The import run belongs to a different billing connection.", "Start a new import for this connection.");
    }
    config = {
      ...existing.config,
      mode: opts.mode,
      cutoverOn: cutoverOn ?? existing.config.cutoverOn,
      historyDepthMonths: opts.historyDepthMonths ?? existing.config.historyDepthMonths,
      incomeAccountId: opts.incomeAccountId ?? existing.config.incomeAccountId,
      clearingAccountId: opts.clearingAccountId ?? existing.config.clearingAccountId,
      taxCodeId: opts.taxCodeId ?? existing.config.taxCodeId,
      planMap: { ...existing.config.planMap, ...(opts.planMap ?? {}) },
      customerMap: { ...existing.config.customerMap, ...(opts.customerMap ?? {}) },
      autoSync: opts.autoSync ?? existing.config.autoSync,
    };
    await updateRunRow(orgId, runId, { status: "running", config });
  } else {
    config = {
      mode: opts.mode,
      cutoverOn,
      historyDepthMonths: opts.historyDepthMonths ?? null,
      incomeAccountId: opts.incomeAccountId ?? null,
      clearingAccountId: opts.clearingAccountId ?? null,
      taxCodeId: opts.taxCodeId ?? null,
      planMap: opts.planMap ?? {},
      customerMap: opts.customerMap ?? {},
      autoSync: opts.autoSync ?? false,
      sealedCredentials: null,
    };
    runId = await insertRunRow(orgId, actorId, source.provider, source.externalAccount, "running", config);
  }
  const counts: BillingImportResult["counts"] = {
    customers: 0,
    plans: 0,
    subscriptions: 0,
    invoices: 0,
    creditNotes: 0,
    payments: 0,
    usage: 0,
    coupons: 0,
    revenueSchedules: 0,
    amendments: 0,
    skipped: 0,
  };
  const refusals: BillingImportRefusal[] = [];
  try {
    const result = await withOrg(orgId, async () => {
      await acquireOrgFeatureGateLock(db, orgId);
      if (!(await lockAndCheckOrgFeature(db, orgId, FEATURE))) {
        refuse("billing_import_feature_off", "Billing history import is turned off for this organization.", FEATURE_REMEDY, 409);
      }
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"billing-import:" + orgId + ":" + source.provider + ":" + source.externalAccount}, 0))`);
      const effectiveCutover = config.cutoverOn ?? await businessToday(orgId);
      const earliestOn = config.historyDepthMonths && effectiveCutover
        ? addMonthsClamped(`${effectiveCutover.slice(0, 7)}-01`, -config.historyDepthMonths)
        : null;
      const previous = runId ? await loadRunRow(orgId, runId) : null;
      const history = await source.pull(previous && Object.keys(previous.cursor).length ? maxCursor(previous.cursor) : null);
      const ctx: PersistContext = {
        orgId,
        actorId,
        provider: source.provider,
        externalAccount: source.externalAccount,
        mode: config.mode,
        cutoverOn: effectiveCutover,
        earliestOn,
        incomeAccountId: config.incomeAccountId,
        clearingAccountId: config.clearingAccountId,
        taxCodeId: config.taxCodeId,
        planMap: config.planMap,
        customerMap: config.customerMap,
        advancedOn: await lockAndCheckOrgFeature(db, orgId, "advancedSubscriptions"),
        counts,
        refusals,
        partyByExternal: new Map(),
        planByExternal: new Map(),
        invoiceByExternal: new Map(),
      };
      const promotionsOn = await lockAndCheckOrgFeature(db, orgId, "promotions");
      const usageOn = await lockAndCheckOrgFeature(db, orgId, "usageBilling");
      for (const customer of history.customers) {
        try {
          const id = await ensureCustomerParty(ctx, customer);
          if (id) counts.customers += 1;
        } catch (error) {
          addRefusal(ctx, "customer", customer.externalId, error);
        }
      }
      for (const plan of history.plans) {
        try {
          const id = await ensureNativePlan(ctx, plan);
          if (id) counts.plans += 1;
        } catch (error) {
          addRefusal(ctx, "plan", plan.externalId, error);
        }
      }
      for (const sub of history.subscriptions) {
        try {
          await importSubscription(ctx, sub);
          counts.subscriptions += 1;
        } catch (error) {
          addRefusal(ctx, "subscription", sub.externalId, error);
        }
      }
      for (const invoice of history.invoices) {
        try {
          if (await importInvoice(ctx, { ...invoice, kind: "invoice" })) counts.invoices += 1;
        } catch (error) {
          addRefusal(ctx, "invoice", invoice.externalId, error);
        }
      }
      for (const note of history.creditNotes) {
        try {
          if (await importInvoice(ctx, {
            externalId: note.externalId,
            number: note.number,
            customerExternalId: note.customerExternalId,
            date: note.date,
            dueDate: null,
            currency: note.currency,
            lines: [{
              description: note.reason ?? note.number ?? note.externalId,
              quantity: "1",
              unitPriceMajor: note.totalMajor,
              amountMajor: note.totalMajor,
            }],
            totalMajor: note.totalMajor,
            balanceMajor: note.balanceMajor,
            status: "open",
            updatedAt: note.updatedAt,
            kind: "credit",
          })) counts.creditNotes += 1;
        } catch (error) {
          addRefusal(ctx, "credit_note", note.externalId, error);
        }
      }
      for (const payment of history.payments) {
        try {
          if (await importPayment(ctx, payment)) counts.payments += 1;
        } catch (error) {
          addRefusal(ctx, "payment", payment.externalId, error);
        }
      }
      if (usageOn) {
        for (const usage of history.usage) {
          try {
            if (await importUsageRecord(ctx, usage)) counts.usage += 1;
          } catch (error) {
            addRefusal(ctx, "usage", usage.externalId, error);
          }
        }
      } else if (history.usage.length) {
        addRefusal(ctx, "usage", history.usage[0]!.externalId, new BillingHistoryError(
          "billing_import_usage_off",
          `${history.usage.length} usage record(s) need Usage Billing.`,
          "Enable Usage Billing in Company Settings → Features, then run the import again.",
          409,
        ));
      }
      if (promotionsOn) {
        for (const coupon of history.coupons) {
          try {
            if (await importCoupon(ctx, coupon)) counts.coupons += 1;
          } catch (error) {
            addRefusal(ctx, "coupon", coupon.externalId, error);
          }
        }
      } else if (history.coupons.length) {
        addRefusal(ctx, "coupon", history.coupons[0]!.externalId, new BillingHistoryError(
          "billing_import_promotions_off",
          `${history.coupons.length} coupon(s) need Promotions.`,
          "Turn on Promotions in Company Settings → Features, then run the import again.",
          409,
        ));
      }
      const cursor: Record<string, string> = {};
      for (const customer of history.customers) {
        if (customer.updatedAt) cursor.customers = maxDay(cursor.customers, customer.updatedAt);
      }
      for (const sub of history.subscriptions) {
        if (sub.updatedAt) cursor.subscriptions = maxDay(cursor.subscriptions, sub.updatedAt);
      }
      for (const invoice of history.invoices) {
        if (invoice.updatedAt) cursor.invoices = maxDay(cursor.invoices, invoice.updatedAt);
      }
      for (const payment of history.payments) {
        if (payment.updatedAt) cursor.payments = maxDay(cursor.payments, payment.updatedAt);
      }
      for (const usage of history.usage) {
        if (usage.updatedAt) cursor.usage = maxDay(cursor.usage, usage.updatedAt);
      }
      const scoped = filterHistoryForRecon(history, { cutoverOn: effectiveCutover, earliestOn, mode: config.mode });
      const native = await readNativeSubscriptionStates(orgId, source.provider, source.externalAccount);
      const reconciliation = reconcileBillingHistory(
        scoped,
        {
          subscriptions: native.subscriptions,
          plans: native.plans,
          openArByCustomer: await readNativeOpenAr(orgId, source.provider, source.externalAccount),
          deferredMajor: await readNativeDeferred(orgId, effectiveCutover),
        },
        reconMonths(scoped, effectiveCutover),
        normalizeMrr,
      );
      return { reconciliation, cursor };
    });
    await updateRunRow(orgId, runId, {
      status: "complete",
      counts: { ...counts, refusals: refusals.slice(0, 200) },
      cursor: result.cursor,
      reconciliation: result.reconciliation,
      finished: true,
    });
    return { runId, counts, refusals, reconciliation: result.reconciliation };
  } catch (error) {
    await updateRunRow(orgId, runId, {
      status: "failed",
      lastError: error instanceof Error ? error.message : "Import failed",
      finished: true,
    });
    throw error;
  }
}

function maxDay(current: string | undefined, candidate: string): string {
  return !current || candidate > current ? candidate : current;
}

function maxCursor(cursor: Record<string, string>): string | null {
  const days = Object.values(cursor).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort();
  return days.length ? days[days.length - 1]! : null;
}

/**
 * Accept the preflight configuration: the operator's plan, customer and
 * ledger mappings. Every reference is validated by name — a mapping to a
 * record that does not exist refuses instead of importing against nothing.
 */
export async function acceptBillingImportRun(
  orgId: string,
  actorId: string,
  runId: string,
  config: Partial<BillingImportConfig>,
): Promise<{ runId: string; status: string }> {
  const existing = await loadRunRow(orgId, runId);
  if (!["preflight", "ready", "failed"].includes(existing.status)) {
    refuse("billing_import_run_state", `Import run ${runId} is ${existing.status} and cannot accept mappings.`, "Start a new import from the billing history console.", 409);
  }
  const merged: BillingImportConfig = {
    ...existing.config,
    ...config,
    mode: config.mode ?? existing.config.mode,
    planMap: config.planMap ?? existing.config.planMap,
    customerMap: config.customerMap ?? existing.config.customerMap,
  };
  if (merged.cutoverOn) validCutover(merged.cutoverOn, "cut-over date");
  await withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, FEATURE))) {
      refuse("billing_import_feature_off", "Billing history import is turned off for this organization.", FEATURE_REMEDY, 409);
    }
    for (const [externalId, planId] of Object.entries(merged.planMap)) {
      const found = await db.execute(sql`select 1 from subscription_plans where id = ${planId} and org_id = ${orgId}`);
      if (!found.rows.length) {
        refuse("billing_import_plan_missing", `Plan mapping for ${externalId} names an OpenBooks plan that does not exist.`, "Map the plan to an existing OpenBooks plan on the preflight list, then accept again.");
      }
    }
    for (const [externalId, partyId] of Object.entries(merged.customerMap)) {
      const found = await db.execute(sql`select 1 from parties where id = ${partyId} and org_id = ${orgId} and kind = 'customer'`);
      if (!found.rows.length) {
        refuse("billing_import_customer_missing", `Customer mapping for ${externalId} names an OpenBooks customer that does not exist.`, "Map the customer to an existing OpenBooks customer on the preflight list, then accept again.");
      }
    }
    for (const [label, table, id] of [
      ["income account", "accounts", merged.incomeAccountId],
      ["clearing account", "accounts", merged.clearingAccountId],
      ["tax code", "tax_codes", merged.taxCodeId],
    ] as const) {
      if (!id) continue;
      const found = await db.execute(sql`select 1 from ${sql.identifier(table)} where id = ${id} and org_id = ${orgId}`);
      if (!found.rows.length) {
        refuse("billing_import_account_missing", `The mapped ${label} does not exist in this organization.`, "Choose an existing record in the import settings, then accept again.");
      }
    }
  });
  await updateRunRow(orgId, runId, { status: "ready", config: { ...merged, updatedBy: actorId } });
  return { runId, status: "ready" };
}

/** Atomically claim a run for execution: only one worker runs a connection at a time. */
async function claimRunRow(orgId: string, runId: string): Promise<void> {
  const done = await db.execute(sql`
    update billing_import_runs set status = 'running', updated_at = now()
     where id = ${runId} and org_id = ${orgId} and status in ('ready', 'failed', 'preflight')
  `);
  if ((done.rowCount ?? 0) === 0) {
    refuse("billing_import_run_busy", "The import run is already running or has completed.", "Wait for the running import, or start a new run from the billing history console.", 409);
  }
}

/**
 * Run an accepted import by id with its sealed credentials — the API and the
 * scheduler share this entry point, so interactive and scheduled runs persist
 * identically.
 */
export async function runBillingImportById(
  orgId: string,
  actorId: string,
  runId: string,
  transport?: ConnectorTransport,
): Promise<BillingImportResult> {
  const existing = await loadRunRow(orgId, runId);
  if (!existing.config.sealedCredentials) {
    refuse("billing_import_credentials_missing", "The import run has no stored credential.", "Reconnect the billing platform from the billing history console, then run the import again.");
  }
  await withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await claimRunRow(orgId, runId);
  });
  const sealed = existing.config.sealedCredentials!;
  const cursor = existing.cursor;
  const source: BillingHistorySource = {
    provider: existing.provider,
    externalAccount: existing.externalAccount,
    pull: () => pullBillingHistory(existing.provider, existing.externalAccount, sealed, orgId, cursor, transport),
  };
  return runBillingHistoryImport(source, {
    orgId,
    actorId,
    mode: existing.config.mode,
    runId,
  });
}

// --- Scheduler -----------------------------------------------------------------------
// The `billing_import_sync` scan replays every connection whose operator left
// auto-sync on: incremental by updated_at until cut-over, idempotent by
// external link on every object. One connection's failure never blocks the
// others; each run row carries its own error.

export interface BillingSyncScanResult {
  runs: { runId: string; orgId: string; provider: BillingHistoryProvider; externalAccount: string; completed: boolean; error: string | null }[];
}

export async function runDueBillingImports(
  transport?: ConnectorTransport,
): Promise<BillingSyncScanResult> {
  const due = await db.execute<{
    id: string; org_id: string; provider: string; external_account: string; config: unknown; cursor: unknown;
  }>(sql`
    select id, org_id, provider, external_account, config, cursor
      from billing_import_runs
     where status = 'ready'
       and (config->>'autoSync')::boolean is true
     order by updated_at limit 20
  `);
  const runs: BillingSyncScanResult["runs"] = [];
  for (const row of due.rows) {
    const provider = row.provider as BillingHistoryProvider;
    const runConfig = configFromRow({ config: row.config });
    if (!runConfig.sealedCredentials) {
      runs.push({ runId: row.id, orgId: row.org_id, provider, externalAccount: row.external_account, completed: false, error: "No stored credential" });
      continue;
    }
    try {
      const users = await db.execute<{ id: string }>(sql`
        select created_by as id from billing_import_runs where id = ${row.id}
      `);
      const actorId = users.rows[0]?.id;
      if (!actorId) {
        runs.push({ runId: row.id, orgId: row.org_id, provider, externalAccount: row.external_account, completed: false, error: "No recorded operator" });
        continue;
      }
      const result = await runBillingImportById(row.org_id, actorId, row.id, transport);
      runs.push({
        runId: result.runId,
        orgId: row.org_id,
        provider,
        externalAccount: row.external_account,
        completed: result.reconciliation.ties,
        error: result.reconciliation.ties ? null : `${result.reconciliation.differences.length} difference(s) need review`,
      });
    } catch (error) {
      runs.push({
        runId: row.id,
        orgId: row.org_id,
        provider,
        externalAccount: row.external_account,
        completed: false,
        error: error instanceof Error ? error.message : "Import failed",
      });
    }
  }
  return { runs };
}

import { sql } from "drizzle-orm";
import { STRIPE_BILLING_LINK_TYPES } from "@openbooks/schema";
import {
  createUsageMeter,
  ingestUsageRecords,
  type UsageAggregation,
} from "../billing/usage/records.ts";
import {
  createSubscriptionUsageLink,
  createUsageRatingPlan,
  createUsageRatingPlanVersion,
  replaceUsageRatingBands,
  type UsageRatingBandInput,
} from "../billing/usage/rating-plans.ts";
import { UsageBillingError } from "../billing/usage/errors.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { parseMoney, parseRate } from "../money/brands.ts";
import { fromMinorUnits, THREE_DECIMAL_CURRENCIES, ZERO_DECIMAL_CURRENCIES } from "../payments/acceptance.ts";
import { loadPaymentProviderConfig } from "../payments/payment-link-session-expiry.ts";
import { db, withOrg, withOrgContext } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";

type StripeLinkType = (typeof STRIPE_BILLING_LINK_TYPES)[number];
type StripeObject = Record<string, unknown>;

export type StripeBillingFetch = (url: string, init: {
  method: "GET";
  headers: Record<string, string>;
  redirect: "error";
}) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface StripeBillingTransport {
  fetch?: StripeBillingFetch;
}

export interface StripeBillingWindow {
  since: string;
  until: string;
}

export interface StripeBillingImportReport {
  runId: string;
  stripeAccount: string;
  meters: { seen: number; created: number; unchanged: number };
  prices: { seen: number; draftsCreated: number; awaitingPublication: Array<{ stripeId: string; versionId: string }> };
  customers: { seen: number; linked: number; unlinked: Array<{ stripeId: string; emailMatch: boolean; suggestedCustomerId: string | null }> };
  subscriptions: { seen: number; itemsLinked: number };
  usage: { summariesSeen: number; recordsCreated: number; recordsReplayed: number };
  refusals: Array<{ objectType: string; stripeId: string; code: string; message: string; remedy: string; field: string | null; status: 422 | 409 }>;
  invoices: string;
}

export interface StripeBillingImportResult {
  runId: string;
  counts: {
    meters: StripeBillingImportReport["meters"];
    prices: { seen: number; draftsCreated: number };
    customers: { seen: number; linked: number; unlinked: number };
    subscriptions: StripeBillingImportReport["subscriptions"];
    usage: StripeBillingImportReport["usage"];
  };
  refusals: Array<{ objectType: string; stripeId: string; code: string; message: string; remedy: string }>;
  unlinkedCustomers: StripeBillingImportReport["customers"]["unlinked"];
  draftVersionsAwaitingPublish: StripeBillingImportReport["prices"]["awaitingPublication"];
}

interface StripeConfigRow extends Record<string, unknown> {
  is_enabled: boolean;
  secrets: string | null;
}

interface StripeLinkRow extends Record<string, unknown> {
  id: string;
  openbooks_id: string;
}

const CONNECT_REMEDY = "Connect Stripe under Setup → Payment providers.";
const INVOICE_NOTE = "Stripe invoices were not imported or posted; bill through an OpenBooks AR invoice or bring AR history through a migration connector.";

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new UsageBillingError(code, message, remedy, { field, status });
}

function object(value: unknown): StripeObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as StripeObject
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function requiredString(value: unknown, label: string, code = "stripe_object_invalid"): string {
  const result = stringValue(value);
  if (!result) refuse(code, `Stripe ${label} is missing or invalid.`, `Correct ${label} in Stripe and run the import again.`, label);
  return result;
}

function exactIntegerText(value: unknown, label: string): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  refuse("stripe_integer_invalid", `Stripe ${label} must be a non-negative exact integer.`, `Correct ${label} in Stripe and run the import again.`, label);
}

function usageAggregation(value: unknown, meterId: string): UsageAggregation {
  if (value === "sum" || value === "count" || value === "last") return value;
  refuse(
    "stripe_meter_aggregation_unsupported",
    `Stripe meter ${meterId} uses aggregation ${String(value)}, which OpenBooks cannot reproduce.`,
    "Use a Stripe sum, count, or last aggregation, or define a different OpenBooks meter.",
    "default_aggregation.formula",
  );
}

function currencyExponent(currency: string): 0 | 2 | 3 {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/** Convert a Stripe minor-unit decimal spelling into an exact major-unit spelling. */
function minorToMajor(value: unknown, currency: string, maxScale: number, label: string): string {
  const source = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  const canonical = canonicalDecimal(source, 12);
  if (canonical === null || canonical.startsWith("-")) {
    refuse("stripe_price_amount_invalid", `Stripe ${label} is not a non-negative exact decimal.`, "Correct the price amount in Stripe and run the import again.", label);
  }
  if (/^\d+$/.test(canonical)) {
    const exactAmount = canonicalDecimal(fromMinorUnits(BigInt(canonical), currency), maxScale);
    if (exactAmount === null) {
      refuse(
        "stripe_price_precision_unsupported",
        `Stripe ${label} has more precision than the OpenBooks ${maxScale}-decimal pricing field supports.`,
        "Round the price in Stripe or define the band manually.",
        label,
      );
    }
    return exactAmount;
  }
  const exponent = currencyExponent(currency);
  const [whole = "0", fraction = ""] = canonical.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const scale = fraction.length + exponent;
  const padded = digits.padStart(scale + 1, "0");
  const split = padded.length - scale;
  const majorWhole = padded.slice(0, split) || "0";
  const majorFraction = padded.slice(split).replace(/0+$/, "");
  const major = majorFraction ? `${majorWhole}.${majorFraction}` : majorWhole;
  if (canonicalDecimal(major, maxScale) === null) {
    refuse(
      "stripe_price_precision_unsupported",
      `Stripe ${label} has more precision than the OpenBooks ${maxScale}-decimal pricing field supports.`,
      "Round the price in Stripe or define the band manually.",
      label,
    );
  }
  return canonicalDecimal(major, maxScale)!;
}

function bandsForStripePrice(price: StripeObject, meterId: string): UsageRatingBandInput[] {
  const currency = requiredString(price.currency, "price currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    refuse("stripe_price_currency_invalid", `Stripe price ${String(price.id)} has an invalid currency.`, "Correct the Stripe price currency and run the import again.", "currency");
  }
  const billingScheme = price.billing_scheme;
  const tiersMode = price.tiers_mode;
  const transform = object(price.transform_quantity);
  const rawTiers = Array.isArray(price.tiers) ? price.tiers.map(object) : [];
  const amounts = (row: StripeObject, index: number) => ({
    unitPrice: parseRate(minorToMajor(row.unit_amount_decimal ?? row.unit_amount, currency, 8, `tiers[${index}].unit_amount_decimal`)),
    flatAmount: parseMoney(minorToMajor(row.flat_amount_decimal ?? row.flat_amount ?? "0", currency, 4, `tiers[${index}].flat_amount_decimal`)),
  });
  if (billingScheme === "per_unit") {
    const amount = amounts(price, 0);
    if (transform) {
      const size = exactIntegerText(transform.divide_by, "transform_quantity.divide_by");
      const rounding = transform.round;
      if (BigInt(size) <= 0n || (rounding !== "up" && rounding !== "down")) {
        refuse("stripe_price_transform_invalid", `Stripe price ${String(price.id)} has unsupported transform_quantity terms.`, "Set a positive divide_by and choose up or down in Stripe.", "transform_quantity");
      }
      return [{ meterId, kind: "package", seq: 1, upToQty: null, unitPrice: amount.unitPrice, flatAmount: amount.flatAmount, packageSize: size, packageRounding: rounding }];
    }
    return [{ meterId, kind: "graduated", seq: 1, upToQty: null, ...amount }];
  }
  if (billingScheme !== "tiered" || transform || (tiersMode !== "graduated" && tiersMode !== "volume") || rawTiers.length === 0 || rawTiers.some((tier) => tier === null)) {
    refuse("stripe_price_model_unsupported", `Stripe price ${String(price.id)} uses a pricing model OpenBooks cannot reproduce.`, "Change the Stripe price to per_unit or supported graduated/volume tiers, or define the band manually.", "billing_scheme");
  }
  return rawTiers.map((tier, index) => {
    const tierRow = tier!;
    const upTo = tierRow.up_to == null ? null : exactIntegerText(tierRow.up_to, `tiers[${index}].up_to`);
    const amount = amounts(tierRow, index);
    return {
      meterId,
      kind: tiersMode,
      seq: index + 1,
      upToQty: upTo,
      ...amount,
    };
  });
}

const defaultFetch: StripeBillingFetch = (url, init) => fetch(url, init);

async function stripeJson(
  apiKey: string,
  url: string,
  fetchFn: StripeBillingFetch,
): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    refuse("stripe_endpoint_invalid", "The Stripe API endpoint is invalid.", CONNECT_REMEDY);
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "api.stripe.com" || parsed.username || parsed.password || parsed.port) {
    refuse("stripe_endpoint_invalid", "The Stripe API endpoint is outside the allowed Stripe host.", CONNECT_REMEDY);
  }
  let response: { status: number; json: () => Promise<unknown> };
  try {
    response = await fetchFn(parsed.toString(), {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`, accept: "application/json" },
    });
  } catch {
    refuse("stripe_transport_failed", "The Stripe Billing request could not be completed.", "Check the Stripe connection under Setup → Payment providers and retry.");
  }
  if (response.status < 200 || response.status >= 300) {
    refuse("stripe_api_refused", `Stripe returned HTTP ${response.status} for a Billing import request.`, "Resolve the Stripe API issue under Setup → Payment providers and retry.");
  }
  try {
    return await response.json();
  } catch {
    refuse("stripe_response_invalid", "Stripe returned a response that could not be read as JSON.", "Check the Stripe connection under Setup → Payment providers and retry.");
  }
}

async function paginatedStripeList(
  apiKey: string,
  path: string,
  params: URLSearchParams,
  fetchFn: StripeBillingFetch,
): Promise<StripeObject[]> {
  const rows: StripeObject[] = [];
  const cursors = new Set<string>();
  for (;;) {
    const query = new URLSearchParams(params);
    query.set("limit", "100");
    const cursor = rows.length ? stringValue(rows.at(-1)?.id) : null;
    if (cursor) query.set("starting_after", cursor);
    const envelope = object(await stripeJson(apiKey, `https://api.stripe.com${path}?${query}`, fetchFn));
    const data = envelope && Array.isArray(envelope.data) ? envelope.data : null;
    if (!data || typeof envelope?.has_more !== "boolean") {
      refuse("stripe_list_response_invalid", `Stripe returned an invalid list response for ${path}.`, "Retry after checking the Stripe connection under Setup → Payment providers.");
    }
    for (const row of data) {
      const item = object(row);
      if (!item) refuse("stripe_list_item_invalid", `Stripe returned an invalid object in ${path}.`, "Correct the Stripe object and retry the import.");
      rows.push(item);
    }
    if (!envelope.has_more) return rows;
    const next = stringValue(data.length ? object(data.at(-1))?.id : null);
    if (!next || cursors.has(next)) {
      refuse("stripe_cursor_invalid", `Stripe pagination for ${path} did not advance.`, "Retry the import after checking the Stripe API response.");
    }
    cursors.add(next);
  }
}

async function listStripeMeters(apiKey: string, fetchFn: StripeBillingFetch): Promise<StripeObject[]> {
  return paginatedStripeList(apiKey, "/v1/billing/meters", new URLSearchParams(), fetchFn);
}

async function listStripePrices(apiKey: string, fetchFn: StripeBillingFetch): Promise<StripeObject[]> {
  return paginatedStripeList(apiKey, "/v1/prices", new URLSearchParams([
    ["type", "recurring"], ["recurring[usage_type]", "metered"], ["expand[]", "data.tiers"],
  ]), fetchFn);
}

async function listStripeCustomers(apiKey: string, fetchFn: StripeBillingFetch): Promise<StripeObject[]> {
  return paginatedStripeList(apiKey, "/v1/customers", new URLSearchParams(), fetchFn);
}

async function listStripeSubscriptions(apiKey: string, fetchFn: StripeBillingFetch): Promise<StripeObject[]> {
  return paginatedStripeList(apiKey, "/v1/subscriptions", new URLSearchParams([
    ["status", "all"], ["expand[]", "data.items.data.price"],
  ]), fetchFn);
}

async function listStripeMeterEventSummaries(
  apiKey: string,
  meterId: string,
  customerId: string,
  startTime: number,
  endTime: number,
  fetchFn: StripeBillingFetch,
): Promise<StripeObject[]> {
  const path = `/v1/billing/meters/${encodeURIComponent(meterId)}/event_summaries`;
  return paginatedStripeList(apiKey, path, new URLSearchParams([
    ["customer", customerId], ["start_time", String(startTime)], ["end_time", String(endTime)],
  ]), fetchFn);
}

async function stripeAccount(
  orgId: string,
  transport: StripeBillingTransport,
): Promise<{ id: string; apiKey: string; fetchFn: StripeBillingFetch }> {
  const config = await withOrgContext(orgId, () => loadPaymentProviderConfig<StripeConfigRow>(orgId, "stripe"));
  if (!config?.is_enabled || !config.secrets) {
    refuse("stripe_not_configured", "Stripe is not connected for this organization.", CONNECT_REMEDY);
  }
  let credentials: { apiKey?: unknown };
  try {
    credentials = unsealJson<{ apiKey?: unknown }>(config.secrets, { orgId, purpose: "payment.provider.secrets" });
  } catch {
    refuse("stripe_credentials_unavailable", "The Stripe credentials could not be opened.", CONNECT_REMEDY);
  }
  const apiKey = stringValue(credentials.apiKey);
  if (!apiKey) refuse("stripe_not_configured", "Stripe has no API key configured for this organization.", CONNECT_REMEDY);
  const fetchFn = transport.fetch ?? defaultFetch;
  const account = object(await stripeJson(apiKey, "https://api.stripe.com/v1/account", fetchFn));
  return { id: requiredString(account?.id, "account id"), apiKey, fetchFn };
}

function linkType(value: string): StripeLinkType {
  if ((STRIPE_BILLING_LINK_TYPES as readonly string[]).includes(value)) return value as StripeLinkType;
  throw new Error(`Unsupported Stripe link type ${value}`);
}

async function findStripeLink(
  orgId: string,
  stripeAccountId: string,
  objectType: StripeLinkType,
  stripeId: string,
): Promise<StripeLinkRow | null> {
  const row = (await db.execute<StripeLinkRow>(sql`
    select id, openbooks_id from stripe_billing_links
     where org_id = ${orgId} and stripe_account = ${stripeAccountId}
       and object_type = ${objectType} and stripe_id = ${stripeId}`)).rows[0];
  return row ?? null;
}

async function saveStripeLink(
  orgId: string,
  actor: string,
  stripeAccountId: string,
  objectTypeValue: string,
  stripeId: string,
  openbooksId: string,
): Promise<void> {
  const objectType = linkType(objectTypeValue);
  await withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "usageBilling"))) {
      refuse("feature_off", "Usage billing is turned off for this organization.", "Enable Usage Billing in Company Settings → Features.");
    }
    const existing = await findStripeLink(orgId, stripeAccountId, objectType, stripeId);
    if (existing) {
      if (existing.openbooks_id !== openbooksId) {
        refuse("stripe_link_conflict", `Stripe ${objectType} ${stripeId} is already linked to a different OpenBooks record.`, "Review the existing link before changing the Stripe mapping.", objectType, 409);
      }
      return;
    }
    try {
      // A retry for the same external object is an expected unique-key collision; re-read below to verify its target.
      const inserted = await db.execute<{ id: string }>(sql`
        insert into stripe_billing_links
          (org_id, object_type, stripe_id, openbooks_id, stripe_account, created_by, updated_by)
        values (${orgId}, ${objectType}, ${stripeId}, ${openbooksId}, ${stripeAccountId}, ${actor}, ${actor})
        on conflict (org_id, stripe_account, object_type, stripe_id) do nothing
        returning id`);
      if (inserted.rows.length === 1) return;
      if (inserted.rows.length !== 0) throw new Error("Stripe link insert returned an unexpected row count");
    } catch (error) {
      if (error instanceof UsageBillingError) throw error;
      const candidate = error as { code?: unknown; constraint?: unknown };
      if (candidate.code !== "23505" || candidate.constraint !== "stripe_billing_links_native_unique") throw error;
      refuse("stripe_link_target_in_use", `OpenBooks record ${openbooksId} is already linked to another Stripe ${objectType}.`, "Review the existing Stripe link and choose the correct OpenBooks record.", objectType, 409);
    }
    const raced = await findStripeLink(orgId, stripeAccountId, objectType, stripeId);
    if (!raced || raced.openbooks_id !== openbooksId) {
      refuse("stripe_link_conflict", `Stripe ${objectType} ${stripeId} was linked concurrently to a different OpenBooks record.`, "Review the existing link before retrying.", objectType, 409);
    }
  });
}

async function requireUsageFeature(orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, "usageBilling"))) {
    refuse("feature_off", "Usage billing is turned off for this organization.", "Enable Usage Billing in Company Settings → Features.");
  }
}

/** Explicit customer mapping; exact-email suggestions never create this link automatically. */
export async function linkStripeCustomer(
  orgId: string,
  actor: string,
  stripeCustomerId: string,
  customerId: string,
  transport: StripeBillingTransport = {},
): Promise<void> {
  await requireUsageFeature(orgId);
  const stripe = await stripeAccount(orgId, transport);
  const customer = (await withOrgContext(orgId, () => db.execute<{ id: string }>(sql`
    select p.id from parties p
     where p.org_id = ${orgId} and p.id = ${customerId} and p.kind = 'customer'`))).rows[0];
  if (!customer) refuse("stripe_customer_unavailable", "The OpenBooks customer does not belong to this organization.", "Choose a customer in this organization.", "customer_id");
  await saveStripeLink(orgId, actor, stripe.id, "customer", requiredString(stripeCustomerId, "customer id"), customer.id);
}

/** Explicit subscription mapping; its identity is separate from item-level usage links. */
export async function linkStripeSubscription(
  orgId: string,
  actor: string,
  stripeSubscriptionId: string,
  subscriptionId: string,
  transport: StripeBillingTransport = {},
): Promise<void> {
  await requireUsageFeature(orgId);
  const stripe = await stripeAccount(orgId, transport);
  const subscription = (await withOrgContext(orgId, () => db.execute<{ id: string }>(sql`
    select id from subscriptions where org_id = ${orgId} and id = ${subscriptionId}`))).rows[0];
  if (!subscription) refuse("stripe_subscription_unavailable", "The OpenBooks subscription does not belong to this organization.", "Choose a subscription in this organization.", "subscription_id");
  await saveStripeLink(orgId, actor, stripe.id, "subscription", requiredString(stripeSubscriptionId, "subscription id"), subscription.id);
}

function validWindow(window: StripeBillingWindow): { since: string; until: string; start: number; end: number } {
  const validDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (!validDate(window?.since) || !validDate(window?.until) || window.since > window.until) {
    refuse("stripe_import_window_invalid", "The Stripe usage import window must be a valid inclusive date range.", "Choose valid since and until dates with since on or before until.", "window");
  }
  return {
    since: window.since,
    until: window.until,
    start: Date.parse(`${window.since}T00:00:00.000Z`),
    end: Date.parse(`${window.until}T00:00:00.000Z`),
  };
}

async function beginRun(orgId: string, actor: string): Promise<string> {
  return withOrg(orgId, async () => {
    const inserted = await db.execute<{ id: string }>(sql`
      insert into sync_runs (org_id, source, kind, status, connection_id, triggered_by, stats, progress)
      values (${orgId}, 'stripe', 'stripe_billing', 'running', null, 'ui', ${JSON.stringify({ actor })}::jsonb, ${JSON.stringify({ phase: "starting" })}::jsonb)
      returning id`);
    if (inserted.rows.length !== 1) throw new Error("Stripe Billing sync run insert returned an unexpected row count");
    return inserted.rows[0]!.id;
  });
}

async function finishRun(
  orgId: string,
  runId: string,
  status: "ok" | "ok_with_errors" | "failed",
  report: StripeBillingImportReport,
  errorMessage: string | null = null,
): Promise<void> {
  await withOrg(orgId, async () => {
    const updated = await db.execute(sql`
      update sync_runs set status = ${status}, finished_at = now(), stats = ${JSON.stringify(report)}::jsonb,
        progress = ${JSON.stringify({ phase: "complete", message: "Stripe Billing import finished" })}::jsonb,
        error_message = ${errorMessage}
       where id = ${runId} and org_id = ${orgId} and status = 'running'`);
    if (updated.rowCount !== 1) throw new Error("Stripe Billing sync run could not be finalized");
  });
}

function emptyReport(runId: string, window: StripeBillingWindow): StripeBillingImportReport {
  return {
    runId,
    stripeAccount: "",
    meters: { seen: 0, created: 0, unchanged: 0 },
    prices: { seen: 0, draftsCreated: 0, awaitingPublication: [] },
    customers: { seen: 0, linked: 0, unlinked: [] },
    subscriptions: { seen: 0, itemsLinked: 0 },
    usage: { summariesSeen: 0, recordsCreated: 0, recordsReplayed: 0 },
    refusals: [],
    invoices: `${INVOICE_NOTE} Import window: ${window.since} through ${window.until}.`,
  };
}

function importResult(report: StripeBillingImportReport): StripeBillingImportResult {
  return {
    runId: report.runId,
    counts: {
      meters: report.meters,
      prices: { seen: report.prices.seen, draftsCreated: report.prices.draftsCreated },
      customers: {
        seen: report.customers.seen,
        linked: report.customers.linked,
        unlinked: report.customers.unlinked.length,
      },
      subscriptions: report.subscriptions,
      usage: report.usage,
    },
    refusals: report.refusals.map(({ objectType, stripeId, code, message, remedy }) => ({
      objectType, stripeId, code, message, remedy,
    })),
    unlinkedCustomers: report.customers.unlinked,
    draftVersionsAwaitingPublish: report.prices.awaitingPublication,
  };
}

function addRefusal(report: StripeBillingImportReport, objectType: string, stripeId: string, error: UsageBillingError): void {
  if (report.refusals.some((row) => row.objectType === objectType && row.stripeId === stripeId && row.code === error.code)) return;
  report.refusals.push({ objectType, stripeId, code: error.code, message: error.message, remedy: error.remedy, field: error.field, status: error.status });
}

async function attemptObject<T>(
  report: StripeBillingImportReport,
  objectType: string,
  stripeId: string,
  work: () => Promise<T>,
): Promise<T | null> {
  await db.execute(sql`savepoint stripe_billing_object`);
  try {
    const result = await work();
    await db.execute(sql`release savepoint stripe_billing_object`);
    return result;
  } catch (error) {
    if (error instanceof UsageBillingError) {
      await db.execute(sql`rollback to savepoint stripe_billing_object`);
      await db.execute(sql`release savepoint stripe_billing_object`);
      addRefusal(report, objectType, stripeId, error);
      return null;
    }
    throw error;
  }
}

async function customerEmailSuggestions(orgId: string): Promise<Map<string, string[]>> {
  const rows = (await db.execute<{ id: string; email: string | null }>(sql`
    select p.id, lower(btrim(p.email)) as email from parties p
     where p.org_id = ${orgId} and p.kind = 'customer'
       and p.email is not null and btrim(p.email) <> ''`)).rows;
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const ids = map.get(row.email!) ?? [];
    ids.push(row.id);
    map.set(row.email!, ids);
  }
  return map;
}

async function importMeters(
  orgId: string,
  actor: string,
  stripeAccountId: string,
  apiKey: string,
  fetchFn: StripeBillingFetch,
  report: StripeBillingImportReport,
): Promise<Map<string, string>> {
  const meterIds = new Map<string, string>();
  const meters = await listStripeMeters(apiKey, fetchFn);
  for (const stripeMeter of meters) {
    const stripeId = stringValue(stripeMeter.id) ?? "(missing id)";
    report.meters.seen += 1;
    await attemptObject(report, "meter", stripeId, async () => {
      const validStripeId = requiredString(stripeMeter.id, "meter id");
      const eventName = requiredString(stripeMeter.event_name, `meter ${validStripeId} event name`);
      const aggregation = usageAggregation(object(stripeMeter.default_aggregation)?.formula, validStripeId);
      const existing = await findStripeLink(orgId, stripeAccountId, linkType("meter"), validStripeId);
      if (existing) {
        const local = (await db.execute<{ id: string; key: string; aggregation: string }>(sql`
          select id, key, aggregation from usage_meters where org_id = ${orgId} and id = ${existing.openbooks_id}`)).rows[0];
        if (!local || local.key !== eventName || local.aggregation !== aggregation) {
          refuse("stripe_meter_mapping_changed", `Stripe meter ${validStripeId} no longer matches its immutable OpenBooks meter mapping.`, "Review the existing meter and create a new Stripe or OpenBooks meter for changed aggregation terms.", "meter_id", 409);
        }
        meterIds.set(validStripeId, local.id);
        report.meters.unchanged += 1;
        return;
      }
      const meter = await createUsageMeter(orgId, actor, {
        key: eventName,
        name: stringValue(stripeMeter.display_name) ?? eventName,
        unit: eventName,
        aggregation,
      });
      await saveStripeLink(orgId, actor, stripeAccountId, "meter", validStripeId, meter.id);
      meterIds.set(validStripeId, meter.id);
      report.meters.created += 1;
    });
  }
  return meterIds;
}

async function planForProductCurrency(orgId: string, actor: string, product: string, currency: string): Promise<string> {
  const name = `Stripe ${product} ${currency}`;
  const existing = (await db.execute<{ id: string }>(sql`
    select id from usage_rating_plans where org_id = ${orgId} and name = ${name}`)).rows[0];
  if (existing) return existing.id;
  return (await createUsageRatingPlan(orgId, actor, { name, currency })).id;
}

async function importPrices(
  orgId: string,
  actor: string,
  stripeAccountId: string,
  apiKey: string,
  fetchFn: StripeBillingFetch,
  meterIds: Map<string, string>,
  report: StripeBillingImportReport,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const prices = await listStripePrices(apiKey, fetchFn);
  const metered = prices.filter((price) => object(price.recurring)?.usage_type === "metered");
  for (const price of metered) {
    const stripeId = stringValue(price.id) ?? "(missing id)";
    report.prices.seen += 1;
    const imported = await attemptObject(report, "price", stripeId, async () => {
      const validStripeId = requiredString(price.id, "price id");
      const recurring = object(price.recurring)!;
      const stripeMeterId = stringValue(recurring.meter) ?? stringValue(object(recurring.meter)?.id);
      if (!stripeMeterId) refuse("stripe_price_meter_missing", `Stripe metered price ${validStripeId} has no meter reference.`, "Attach a Stripe meter to the price or define the OpenBooks rating bands manually.", "recurring.meter");
      const meterId = meterIds.get(stripeMeterId);
      if (!meterId) refuse("stripe_price_meter_unlinked", `Stripe price ${validStripeId} refers to meter ${stripeMeterId}, which has no OpenBooks mapping.`, "Import or map the Stripe meter before importing this price.", "recurring.meter");
      const currency = requiredString(price.currency, `price ${validStripeId} currency`).toUpperCase();
      const product = stringValue(price.product) ?? stringValue(object(price.product)?.id);
      if (!product) refuse("stripe_price_product_missing", `Stripe price ${validStripeId} has no product identity.`, "Assign the Stripe price to a product and retry the import.", "product");
      const bands = bandsForStripePrice(price, meterId);
      const existing = await findStripeLink(orgId, stripeAccountId, linkType("price"), validStripeId);
      if (existing) {
        const status = (await db.execute<{ status: string }>(sql`
          select status from usage_rating_plan_versions where org_id = ${orgId} and id = ${existing.openbooks_id}`)).rows[0]?.status;
        if (!status) refuse("stripe_price_mapping_missing_local", `Stripe price ${validStripeId} maps to a missing OpenBooks rating-plan version.`, "Restore or recreate the OpenBooks draft version before importing this price again.", "plan_version_id", 409);
        versions.set(validStripeId, existing.openbooks_id);
        if (status === "draft") report.prices.awaitingPublication.push({ stripeId: validStripeId, versionId: existing.openbooks_id });
        return existing.openbooks_id;
      }
      const planId = await planForProductCurrency(orgId, actor, product, currency);
      const created = Number.isSafeInteger(price.created) && (price.created as number) >= 0
        ? new Date((price.created as number) * 1000).toISOString().slice(0, 10)
        : reportWindowDate(price);
      const version = await createUsageRatingPlanVersion(orgId, actor, { planId, effectiveFrom: created });
      await replaceUsageRatingBands(orgId, actor, version.id, bands);
      await saveStripeLink(orgId, actor, stripeAccountId, "price", validStripeId, version.id);
      versions.set(validStripeId, version.id);
      report.prices.draftsCreated += 1;
      report.prices.awaitingPublication.push({ stripeId: validStripeId, versionId: version.id });
      return version.id;
    });
    if (!imported) continue;
    if (stripeId !== "(missing id)") versions.set(stripeId, imported);
  }
  return versions;
}

function reportWindowDate(price: StripeObject): string {
  const date = stringValue(price.created);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  refuse("stripe_price_created_invalid", `Stripe price ${String(price.id)} has no usable creation date.`, "Correct the Stripe price metadata or define its effective date in OpenBooks.", "created");
}

async function importCustomers(
  orgId: string,
  stripeAccountId: string,
  apiKey: string,
  fetchFn: StripeBillingFetch,
  report: StripeBillingImportReport,
): Promise<Map<string, string>> {
  const linked = new Map<string, string>();
  const suggestions = await customerEmailSuggestions(orgId);
  for (const customer of await listStripeCustomers(apiKey, fetchFn)) {
    const stripeId = stringValue(customer.id) ?? "(missing id)";
    report.customers.seen += 1;
    await attemptObject(report, "customer", stripeId, async () => {
      const validStripeId = requiredString(customer.id, "customer id");
      const existing = await findStripeLink(orgId, stripeAccountId, linkType("customer"), validStripeId);
      if (existing) {
        const local = (await db.execute<{ id: string }>(sql`
          select p.id from parties p
           where p.org_id=${orgId} and p.id=${existing.openbooks_id} and p.kind='customer'`)).rows[0];
        if (!local) {
          refuse(
            "stripe_customer_mapping_missing_local",
            `Stripe customer ${validStripeId} maps to a missing OpenBooks customer.`,
            "Restore the OpenBooks customer or explicitly link this Stripe customer to a valid customer.",
            "customer_id",
            409,
          );
        }
        linked.set(validStripeId, existing.openbooks_id);
        report.customers.linked += 1;
        return;
      }
      const email = stringValue(customer.email);
      const matches = email ? suggestions.get(email.toLowerCase()) ?? [] : [];
      report.customers.unlinked.push({
        stripeId: validStripeId,
        emailMatch: matches.length === 1,
        suggestedCustomerId: matches.length === 1 ? matches[0]! : null,
      });
      refuse(
        "stripe_customer_unlinked",
        `Stripe customer ${validStripeId} is not linked to an OpenBooks customer${matches.length > 1 ? "; its email matches more than one OpenBooks customer" : ""}.`,
        "Review the exact-email suggestion and explicitly link the customer with linkStripeCustomer.",
        "customer_id",
      );
    });
  }
  return linked;
}

async function subscriptionItems(subscription: StripeObject): Promise<StripeObject[]> {
  const items = object(subscription.items);
  if (!items || !Array.isArray(items.data)) {
    refuse("stripe_subscription_items_invalid", `Stripe subscription ${String(subscription.id)} has no item list.`, "Correct the subscription in Stripe and retry the import.", "items");
  }
  if (items.has_more === true) {
    refuse("stripe_subscription_items_incomplete", `Stripe subscription ${String(subscription.id)} has additional items outside the returned page.`, "Reduce the subscription to the returned item set or use the Stripe subscription item review path.", "items");
  }
  return items.data.map((row) => {
    const item = object(row);
    if (!item) refuse("stripe_subscription_item_invalid", `Stripe subscription ${String(subscription.id)} contains an invalid item.`, "Correct the subscription item in Stripe and retry the import.", "items");
    return item;
  });
}

async function importSubscriptions(
  orgId: string,
  actor: string,
  stripeAccountId: string,
  apiKey: string,
  fetchFn: StripeBillingFetch,
  customerLinks: Map<string, string>,
  priceVersions: Map<string, string>,
  report: StripeBillingImportReport,
): Promise<void> {
  const subscriptions = await listStripeSubscriptions(apiKey, fetchFn);
  report.subscriptions.seen = subscriptions.length;
  for (const subscription of subscriptions) {
    const stripeSubscriptionId = stringValue(subscription.id) ?? "(missing id)";
    const imported = await attemptObject(report, "subscription", stripeSubscriptionId, async () => {
      const validStripeSubscriptionId = requiredString(subscription.id, "subscription id");
      const stripeCustomerId = stringValue(subscription.customer) ?? stringValue(object(subscription.customer)?.id);
      if (!stripeCustomerId) {
        refuse("stripe_subscription_customer_missing", `Stripe subscription ${validStripeSubscriptionId} has no customer identity.`, "Correct the subscription customer in Stripe before importing its usage.", "customer");
      }
      const subscriptionLink = await findStripeLink(orgId, stripeAccountId, linkType("subscription"), validStripeSubscriptionId);
      const items = await subscriptionItems(subscription);
      return {
        stripeSubscriptionId: validStripeSubscriptionId,
        stripeCustomerId,
        customerId: customerLinks.get(stripeCustomerId) ?? null,
        subscriptionLink,
        items,
      };
    });
    if (!imported) continue;
    for (const item of imported.items) {
      const price = object(item.price);
      const stripePriceId = stringValue(item.price) ?? stringValue(price?.id);
      const recurring = object(price?.recurring);
      const stripeItemId = stringValue(item.id) ?? "(missing id)";
      if (!stripePriceId) {
        await attemptObject(report, "subscription_item", stripeItemId, async () => {
          requiredString(item.id, `subscription ${imported.stripeSubscriptionId} item id`);
          refuse("stripe_subscription_item_price_missing", `Stripe subscription item ${stripeItemId} has no expanded price identity.`, "Retry after Stripe returns the item's price reference, or correct the subscription item in Stripe.", "price");
        });
        continue;
      }
      if (recurring?.usage_type !== "metered" && !priceVersions.has(stripePriceId)) continue;
      await attemptObject(report, "subscription_item", stripeItemId, async () => {
        const validStripeItemId = requiredString(item.id, `subscription ${imported.stripeSubscriptionId} item id`);
        if (!imported.customerId) refuse("stripe_subscription_customer_unlinked", `Stripe subscription ${imported.stripeSubscriptionId} belongs to unlinked customer ${imported.stripeCustomerId}.`, "Link the Stripe customer to its OpenBooks customer with linkStripeCustomer.", "customer_id");
        if (!imported.subscriptionLink) refuse("stripe_subscription_unlinked", `Stripe subscription ${imported.stripeSubscriptionId} has no OpenBooks subscription mapping.`, "Identify the OpenBooks subscription with linkStripeSubscription.", "subscription_id");
        const versionId = priceVersions.get(stripePriceId) ?? (await findStripeLink(orgId, stripeAccountId, linkType("price"), stripePriceId))?.openbooks_id;
        if (!versionId) refuse("stripe_subscription_price_unlinked", `Stripe subscription item ${validStripeItemId} refers to price ${stripePriceId}, which has no imported version.`, "Import the metered Stripe price before linking its subscription item.", "price");
        const version = (await db.execute<{ status: string }>(sql`
          select status from usage_rating_plan_versions where org_id = ${orgId} and id = ${versionId}`)).rows[0];
        if (!version || version.status !== "published") {
          refuse("stripe_subscription_price_unpublished", `Stripe price ${stripePriceId} is still an unpublished OpenBooks draft.`, "Review and publish the imported usage rating-plan version before linking this subscription item.", "plan_version_id", 409);
        }
        const prior = await findStripeLink(orgId, stripeAccountId, linkType("subscription_item"), validStripeItemId);
        if (prior) {
          const local = (await db.execute<{ id: string }>(sql`
            select id from subscription_usage_links where org_id = ${orgId} and id = ${prior.openbooks_id}`)).rows[0];
          if (!local) refuse("stripe_subscription_item_mapping_missing_local", `Stripe subscription item ${validStripeItemId} maps to a missing OpenBooks usage link.`, "Restore or recreate the usage link before importing this subscription item again.", "subscription_item", 409);
          return;
        }
        const bands = (await db.execute<{ meterId: string }>(sql`
          select distinct meter_id as "meterId" from usage_rating_bands
           where org_id = ${orgId} and plan_version_id = ${versionId} order by meter_id`)).rows;
        if (bands.length === 0) refuse("stripe_subscription_price_bands_missing", `Published Stripe price ${stripePriceId} has no OpenBooks rating bands.`, "Define and publish the price's usage bands before linking the subscription item.", "plan_version_id");
        const periodStart = exactIntegerText(subscription.current_period_start ?? subscription.start_date, "subscription.current_period_start");
        const effectiveFrom = new Date(Number(periodStart) * 1000).toISOString().slice(0, 10);
        const link = await createSubscriptionUsageLink(orgId, actor, {
          subscriptionId: imported.subscriptionLink.openbooks_id,
          customerId: imported.customerId,
          planVersionId: versionId,
          meterIds: bands.map((band) => band.meterId),
          effectiveFrom,
        });
        await saveStripeLink(orgId, actor, stripeAccountId, "subscription_item", validStripeItemId, link.id);
        report.subscriptions.itemsLinked += 1;
      });
    }
  }
}

function dateEpoch(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1000);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

function quantityText(value: unknown, summaryId: string): string {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  const quantity = text === null ? null : canonicalDecimal(text, 8);
  if (quantity === null || quantity.startsWith("-") || /^0(?:\.0*)?$/.test(quantity)) {
    refuse("stripe_usage_quantity_invalid", `Stripe usage summary ${summaryId} has an unsupported quantity.`, "Correct the Stripe meter event data or use a positive exact quantity with no more than 8 decimal places.", "aggregated_value");
  }
  return quantity;
}

async function importUsage(
  orgId: string,
  actor: string,
  stripeAccountId: string,
  apiKey: string,
  fetchFn: StripeBillingFetch,
  window: { since: string; until: string; start: number; end: number },
  report: StripeBillingImportReport,
): Promise<void> {
  const meters = (await db.execute<{ stripeId: string; openbooksId: string }>(sql`
    select stripe_id as "stripeId", openbooks_id as "openbooksId"
      from stripe_billing_links where org_id = ${orgId} and stripe_account = ${stripeAccountId} and object_type = 'meter'
      order by stripe_id`)).rows;
  const customers = (await db.execute<{ stripeId: string; openbooksId: string }>(sql`
    select stripe_id as "stripeId", openbooks_id as "openbooksId"
      from stripe_billing_links where org_id = ${orgId} and stripe_account = ${stripeAccountId} and object_type = 'customer'
      order by stripe_id`)).rows;
  for (const meter of meters) {
    const localMeter = (await db.execute<{ key: string }>(sql`
      select key from usage_meters where org_id = ${orgId} and id = ${meter.openbooksId}`)).rows[0];
    if (!localMeter) {
      addRefusal(report, "meter", meter.stripeId, new UsageBillingError(
        "stripe_meter_mapping_missing_local",
        `Stripe meter ${meter.stripeId} maps to a missing OpenBooks meter.`,
        "Restore or recreate the OpenBooks meter before importing its usage.",
        { field: "meter_id", status: 409 },
      ));
      continue;
    }
    for (const customer of customers) {
      for (let day = window.since; day <= window.until; day = nextDay(day)) {
        const summaries = await listStripeMeterEventSummaries(
          apiKey, meter.stripeId, customer.stripeId, dateEpoch(day), dateEpoch(nextDay(day)), fetchFn,
        );
        for (const summary of summaries) {
          const summaryId = stringValue(summary.id) ?? "(missing id)";
          report.usage.summariesSeen += 1;
          await attemptObject(report, "meter_event_summary", summaryId, async () => {
            const validSummaryId = requiredString(summary.id, "meter event summary id");
            const existed = (await db.execute<{ id: string }>(sql`
              select id from usage_records where org_id = ${orgId} and meter_id = ${meter.openbooksId}
                and idempotency_key = ${`stripe:${validSummaryId}`}`)).rows[0];
            const occurredOn = Number.isSafeInteger(summary.start_time)
              ? new Date((summary.start_time as number) * 1000).toISOString().slice(0, 10)
              : day;
            await ingestUsageRecords(orgId, actor, [{
              meterKey: localMeter.key,
              customerId: customer.openbooksId,
              occurredOn,
              quantity: quantityText(summary.aggregated_value, validSummaryId),
              source: "connector_stripe",
              sourceRef: validSummaryId,
              idempotencyKey: `stripe:${validSummaryId}`,
            }]);
            if (existed) report.usage.recordsReplayed += 1;
            else report.usage.recordsCreated += 1;
          });
        }
      }
    }
  }
}

/** Import Stripe Billing meters, metered prices and usage without posting invoices. */
export async function importStripeBilling(
  orgId: string,
  actor: string,
  windowInput: StripeBillingWindow,
  transport: StripeBillingTransport = {},
): Promise<StripeBillingImportResult> {
  const window = validWindow(windowInput);
  const runId = await beginRun(orgId, actor);
  const report = emptyReport(runId, window);
  try {
    await requireUsageFeature(orgId);
    const stripe = await stripeAccount(orgId, transport);
    report.stripeAccount = stripe.id;
    await withOrg(orgId, async () => {
      await acquireOrgFeatureGateLock(db, orgId);
      if (!(await lockAndCheckOrgFeature(db, orgId, "usageBilling"))) {
        refuse("feature_off", "Usage billing is turned off for this organization.", "Enable Usage Billing in Company Settings → Features.");
      }
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stripe-billing:${orgId}:${stripe.id}`}, 0))`);
      const meterIds = await importMeters(orgId, actor, stripe.id, stripe.apiKey, stripe.fetchFn, report);
      const priceVersions = await importPrices(orgId, actor, stripe.id, stripe.apiKey, stripe.fetchFn, meterIds, report);
      const customerLinks = await importCustomers(orgId, stripe.id, stripe.apiKey, stripe.fetchFn, report);
      await importSubscriptions(orgId, actor, stripe.id, stripe.apiKey, stripe.fetchFn, customerLinks, priceVersions, report);
      await importUsage(orgId, actor, stripe.id, stripe.apiKey, stripe.fetchFn, window, report);
    });
    const errorMessage = report.refusals.length
      ? `Stripe Billing import completed with ${report.refusals.length} refused object(s); review the run details.`
      : null;
    await finishRun(orgId, runId, report.refusals.length ? "ok_with_errors" : "ok", report, errorMessage);
  } catch (error) {
    if (error instanceof UsageBillingError) addRefusal(report, "import", "stripe_billing", error);
    await finishRun(orgId, runId, "failed", report, error instanceof Error ? error.message : "Stripe Billing import failed");
    throw error;
  }
  return importResult(report);
}

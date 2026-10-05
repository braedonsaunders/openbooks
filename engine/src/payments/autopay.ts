import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext, withOrg } from "../platform/db.ts";
import { paymentLinkTokenHash } from "./payment-link-seal.ts";
import { addCalendarDays, businessToday } from "../platform/business-date.ts";
import { cmp, fromUnits, toUnits } from "../money/money.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import {
  ACCEPTANCE_ADAPTERS,
  configSecrets,
  defaultFetch,
  resolveAcceptanceProviderApiBase,
  type AcceptanceProvider,
  type FetchFn,
  type OffSessionChargeOutcome,
  type OffSessionChargeRequest,
  type ProviderConfigRow,
  type WebhookEvent,
} from "./acceptance.ts";
import { loadPaymentProviderConfig } from "./payment-link-session-expiry.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { openItemsForParty } from "./payment-queries.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { sameCurrencyAllocation } from "./settlement-policy.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";

/**
 * Autopay — stored payment methods and automatic collection of due invoices.
 *
 * A customer (or one subscription) enrolls with a default stored method. The
 * `autopay_collection` scheduler scan charges due invoices off-session: one
 * collection attempt per (invoice, retry position), so a retried tick reuses
 * the attempt instead of charging twice. Success posts a customer_payment
 * receipt through the same draft → apply → post path hosted payment links
 * use, so application to the invoice is identical. Soft declines retry on the
 * dunning policy's offsets; hard declines stop; exhausting the schedule runs
 * the policy's final action (suspend or cancel the subscription), and a later
 * success reactivates.
 *
 * No card numbers are ever stored — only provider customer/method tokens
 * plus brand, last four and expiry for display.
 */

export class AutopayError extends Error {}

export type AutopayProvider = AcceptanceProvider;

export type ChargeFn = (
  provider: AcceptanceProvider,
  req: OffSessionChargeRequest,
) => Promise<OffSessionChargeOutcome>;

/** Default charge path: the provider adapter behind the org's PSP config. */
async function adapterCharge(
  orgId: string,
  provider: AcceptanceProvider,
  req: OffSessionChargeRequest,
): Promise<OffSessionChargeOutcome> {
  const config = await loadPaymentProviderConfig<ProviderConfigRow>(orgId, provider);
  if (!config || !config.is_enabled || !config.acceptance_enabled) {
    throw new AutopayError(`${provider} is not enabled for automatic collection; enable it in provider settings first`);
  }
  const adapter = ACCEPTANCE_ADAPTERS[provider];
  return adapter.chargeOffSession(configSecrets(config, orgId), {
    providerCustomerId: req.providerCustomerId,
    providerMethodId: req.providerMethodId,
    amount: req.amount,
    currency: req.currency,
    description: req.description,
    idempotencyKey: req.idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// Decline classification (pure)
// ---------------------------------------------------------------------------

export type DeclineClass = "hard" | "soft" | "insufficient_funds" | "needs_authentication";

/**
 * Compare provider decline codes across naming habits: Stripe sends
 * snake_case (`authentication_required`), Adyen sends titled phrases
 * (`Authentication Required`), so classification strips case and every
 * non-alphanumeric before matching. Pure.
 */
export function normalizeDeclineCode(declineCode: string): string {
  return declineCode.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Provider decline codes that must never retry: the instrument is gone
 * (stolen/lost/expired card, closed account) or the mandate is dead, so
 * another charge can only fail the same way and the customer must supply
 * new payment details. Entries are normalized (see normalizeDeclineCode).
 */
const HARD_DECLINE_CODES: ReadonlySet<string> = new Set([
  // Stripe card errors that never clear on retry.
  "lostcard",
  "stolencard",
  "expiredcard",
  "cardclosed",
  "pickupcard",
  "restrictedcard",
  "accountclosed",
  "invalidaccount",
  "incorrectnumber",
  "invalidexpirymonth",
  "invalidexpiryyear",
  "revocationofauthorization",
  "revocationofallauthorizations",
  "fraudulent",
  // GoCardless bank-debit terminal states.
  "closedaccount",
  "invalidaccountholdername",
  "invalidbankaccount",
  "directdebitnotenabled",
  "mandatecancelled",
  "mandateexpired",
  "mandatefailed",
  "cancelled",
  "customerapprovaldenied",
  // Adyen refusal reasons that never clear on retry.
  "cancelorrefund",
  "blockedcard",
  "stolencard",
  "lostcard",
  "expiredcard",
  "invalidcardnumber",
  "invalidaccount",
  "closedaccount",
  "noaccount",
  "referral",
  "fraud",
  // Autopay's own terminal markers (missing linkage, not a provider retry).
  "missingshopperreference",
]);

/**
 * Declines that clear when money arrives: the instrument is fine but empty.
 * These retry near typical paydays instead of on the generic cadence.
 */
const INSUFFICIENT_FUNDS_CODES: ReadonlySet<string> = new Set([
  "insufficientfunds",
  "balanceinsufficient",
  "notenoughbalance",
]);

/**
 * Declines that clear when the customer proves it is them: 3DS and
 * issuer-mandated authentication. These never retry automatically — the
 * customer gets an authentication link instead.
 */
const NEEDS_AUTHENTICATION_CODES: ReadonlySet<string> = new Set([
  "authenticationrequired",
  "authenticationfailed",
  "threedsrequired",
]);

/**
 * Classify a provider decline code, or null when nothing declined. Pure.
 * Everything unrecognized retries as soft — a new code fails open toward
 * collection, and the schedule bounds the attempts.
 */
export function classifyDecline(declineCode: string | null | undefined): DeclineClass | null {
  if (declineCode == null || declineCode === "") return null;
  const code = normalizeDeclineCode(declineCode);
  if (HARD_DECLINE_CODES.has(code)) return "hard";
  if (INSUFFICIENT_FUNDS_CODES.has(code)) return "insufficient_funds";
  if (NEEDS_AUTHENTICATION_CODES.has(code)) return "needs_authentication";
  return "soft";
}

// ---------------------------------------------------------------------------
// Retry schedule + policy resolution (pure validation, policy read)
// ---------------------------------------------------------------------------

export type AutopayFinalAction = "none" | "suspend" | "cancel";

export interface AutopayPolicy {
  policyId: string;
  policyName: string;
  retryOffsetsDays: number[];
  insufficientFundsOffsetsDays: number[];
  finalAction: AutopayFinalAction;
  gracePeriodDays: number;
  expiryNoticeDays: number;
}

/**
 * The retry ladder a decline class runs on: soft declines use the generic
 * cadence, insufficient-funds declines use the payday-adjacent ladder, and
 * hard or authentication-required declines run no ladder at all — the first
 * waits for new payment details, the second for the customer. Pure.
 */
export function retryLadderForClass(policy: AutopayPolicy, declineClass: DeclineClass): number[] {
  switch (declineClass) {
    case "soft":
      return policy.retryOffsetsDays;
    case "insufficient_funds":
      return policy.insufficientFundsOffsetsDays;
    case "hard":
    case "needs_authentication":
      return [];
  }
}

/**
 * Validate retry offsets from the dunning policy write boundary: whole days,
 * each at least a day out, bounded so a misconfigured ladder cannot spin a
 * charge loop. Pure — throws AutopayError naming the fix.
 */
export function parseRetryOffsetsDays(value: unknown): number[] {
  if (!Array.isArray(value)) throw new AutopayError("retry offsets must be a list of whole days, e.g. [1, 3, 7]");
  if (value.length > 8) throw new AutopayError("retry offsets hold at most 8 entries; shorten the schedule in Setup → Collections");
  const offsets: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1 || entry > 90) {
      throw new AutopayError(`retry offset ${JSON.stringify(entry)} is not a whole day between 1 and 90; fix it in Setup → Collections`);
    }
    offsets.push(entry);
  }
  return offsets;
}

export function parseFinalAction(value: unknown): AutopayFinalAction {
  if (value === "none" || value === "suspend" || value === "cancel") return value;
  throw new AutopayError(`final action ${JSON.stringify(value)} is not one of none, suspend or cancel; fix it in Setup → Collections`);
}

/**
 * Validate the pre-expiry outreach window from the policy write boundary:
 * whole days, at least a day out, bounded so a misconfigured window cannot
 * notify a year ahead. Pure — throws AutopayError naming the fix.
 */
export function parseExpiryNoticeDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 90) {
    throw new AutopayError(`pre-expiry notice window ${JSON.stringify(value)} is not a whole day between 1 and 90; fix it in Setup → Collections`);
  }
  return value;
}

/**
 * The autopay policy for an org: the latest-updated active customer-invoice
 * dunning policy, which is also where the operator edits the retry schedule.
 * Refuses by name when no active policy exists — retrying without a schedule
 * would charge on an invisible timetable.
 */
export async function resolveAutopayPolicy(orgId: string): Promise<AutopayPolicy> {
  const rows = (await db.execute<{
    policyId: string;
    policyName: string;
    retryOffsets: unknown;
    insufficientFundsOffsets: unknown;
    finalAction: unknown;
    gracePeriodDays: number;
    expiryNoticeDays: unknown;
  }>(sql`
    select id as "policyId", name as "policyName",
           autopay_retry_offsets_days as "retryOffsets",
           autopay_insufficient_funds_offsets_days as "insufficientFundsOffsets",
           autopay_final_action as "finalAction",
           grace_period_days as "gracePeriodDays",
           autopay_expiry_notice_days as "expiryNoticeDays"
      from dunning_policies
     where org_id = ${orgId} and is_active and applies_to_kind = 'customer_invoice'
     order by updated_at desc limit 1
  `)).rows;
  const policy = rows[0];
  if (!policy) {
    throw new AutopayError("no active collection policy for customer invoices; activate one in Setup → Collections before enrolling customers in autopay");
  }
  return {
    policyId: policy.policyId,
    policyName: policy.policyName,
    retryOffsetsDays: parseRetryOffsetsDays(policy.retryOffsets),
    insufficientFundsOffsetsDays: parseRetryOffsetsDays(policy.insufficientFundsOffsets),
    finalAction: parseFinalAction(policy.finalAction),
    gracePeriodDays: policy.gracePeriodDays,
    expiryNoticeDays: parseExpiryNoticeDays(policy.expiryNoticeDays),
  };
}

/** Fail closed when the autopay surface is off: hidden means refused, never charged. */
async function requireAutopayFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "autopay"))) {
    throw new AutopayError("Autopay is disabled; enable it in Company Settings → Features before changing payment methods or enrollments");
  }
}

function auditAutopay(
  orgId: string,
  table: string,
  rowId: string,
  changes: Record<string, unknown>,
  actorId: string | null,
) {
  return db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, 'update', ${JSON.stringify(changes)}::jsonb, ${actorId})
  `);
}

// ---------------------------------------------------------------------------
// Stored payment methods
// ---------------------------------------------------------------------------

export interface StoredPaymentMethod {
  id: string;
  partyId: string;
  provider: AcceptanceProvider;
  providerCustomerId: string | null;
  providerMethodId: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  mandateReference: string | null;
  isDefault: boolean;
  status: string;
}

async function rowToMethod(row: Record<string, unknown>): Promise<StoredPaymentMethod> {
  return {
    id: String(row.id),
    partyId: String(row.party_id),
    provider: row.provider as AcceptanceProvider,
    providerCustomerId: (row.provider_customer_id as string | null) ?? null,
    providerMethodId: (row.provider_method_id as string | null) ?? null,
    brand: (row.brand as string | null) ?? null,
    last4: (row.last4 as string | null) ?? null,
    expMonth: (row.exp_month as number | null) ?? null,
    expYear: (row.exp_year as number | null) ?? null,
    mandateReference: (row.mandate_reference as string | null) ?? null,
    isDefault: row.is_default === true,
    status: String(row.status),
  };
}

/** Stored methods on file for a customer, default first. */
export async function listPaymentMethods(orgId: string, partyId: string): Promise<StoredPaymentMethod[]> {
  const rows = (await db.execute(sql`
    select * from customer_payment_methods
     where org_id = ${orgId} and party_id = ${partyId} and status <> 'removed'
     order by is_default desc, created_at desc
  `)).rows;
  return Promise.all(rows.map(rowToMethod));
}

/**
 * Start a hosted setup session for a customer ("Send setup link"). Opens a
 * pending method row holding the provider setup id, then mints the provider
 * session against it — completion (return-URL verification or the setup
 * webhook) replaces the setup id with the real method token.
 */
export async function startMethodSetup(
  orgId: string,
  input: { partyId: string; provider: AcceptanceProvider; currency: string; returnUrl: string; setupToken: string; actorId?: string | null },
  fetchFn?: FetchFn,
): Promise<{ methodId: string; setupToken: string; redirectUrl: string }> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const party = (await db.execute<{ id: string }>(sql`
      select id from parties where id = ${input.partyId} and org_id = ${orgId} limit 1
    `)).rows[0];
    if (!party) throw new AutopayError("customer not found; pick a customer from Customers first");
    const config = await loadPaymentProviderConfig<ProviderConfigRow>(orgId, input.provider);
    if (!config || !config.is_enabled || !config.acceptance_enabled) {
      throw new AutopayError(`${input.provider} is not enabled for online payments; enable it in provider settings first`);
    }
    const defaultMethod = (await db.execute<{ provider_customer_id: string | null }>(sql`
      select provider_customer_id from customer_payment_methods
       where org_id = ${orgId} and party_id = ${input.partyId} and status = 'active' and provider_customer_id is not null
       order by is_default desc limit 1
    `)).rows[0];
    // The setup token is the customer's Bearer [REDACTED] the hosted setup page: same
    // token handling as payment links (random token, sha256 in storage). The
    // caller mints it so the return URL can carry it to the return page.
    const setupToken = input.setupToken;
    if (!/^[0-9a-f]{32,128}$/i.test(setupToken)) {
      throw new AutopayError("setup token is malformed; generate a fresh setup link");
    }
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into customer_payment_methods (org_id, party_id, provider, status, token_hash, created_by, updated_by)
      values (${orgId}, ${input.partyId}, ${input.provider}, 'pending',
              ${paymentLinkTokenHash(setupToken)}, ${input.actorId ?? null}, ${input.actorId ?? null})
      returning id
    `));
    const methodId = inserted.rows[0]?.id;
    if (!methodId) throw new AutopayError("payment method could not be started; try again");
    const adapter = ACCEPTANCE_ADAPTERS[input.provider];
    let session;
    try {
      session = await adapter.createSetupSession(
        configSecrets(config as Parameters<typeof configSecrets>[0], orgId),
        {
          linkToken: methodId,
          description: "Autopay payment method",
          currency: input.currency,
          returnUrl: input.returnUrl,
          providerCustomerId: defaultMethod?.provider_customer_id ?? null,
        },
        fetchFn,
      );
    } catch (error) {
      // The provider refused before any customer action: drop the pending
      // row so a dead setup can never complete later.
      await db.execute(sql`
        delete from customer_payment_methods where id = ${methodId} and org_id = ${orgId} and status = 'pending'
      `);
      throw error;
    }
    const claimed = (await db.execute<{ id: string }>(sql`
      update customer_payment_methods
         set provider_method_id = ${session.externalRef},
             provider_customer_id = coalesce(provider_customer_id, ${session.providerCustomerId ?? null}),
             setup_redirect_url = ${session.redirectUrl},
             updated_at = now(), updated_by = ${input.actorId ?? null}
       where id = ${methodId} and org_id = ${orgId} and status = 'pending'
       returning id
    `));
    if (!claimed.rows[0]) throw new AutopayError("payment method setup was superseded; start a new setup link");
    await auditAutopay(orgId, "customer_payment_methods", methodId, {
      event: "setup_started",
      after: { provider: input.provider, setupRef: session.externalRef },
      reason: "Operator sent a setup link; the method activates when the provider confirms it.",
    }, input.actorId ?? null);
    return { methodId, setupToken, redirectUrl: session.redirectUrl };
  });
}

/** Resolve a hosted setup token to its org (public page + return handler). */
export async function setupTokenOrgId(setupToken: string): Promise<string | null> {
  if (!setupToken || setupToken.length < 16) return null;
  return withBypassContext(async () => {
    const row = (await db.execute<{ org_id: string }>(sql`
      select org_id from customer_payment_methods
       where token_hash = ${paymentLinkTokenHash(setupToken)} limit 1
    `)).rows[0];
    return row?.org_id ?? null;
  });
}

export interface PublicSetupPage {
  orgId: string;
  orgName: string;
  partyName: string;
  provider: AcceptanceProvider;
  status: string;
  brand: string | null;
  last4: string | null;
}

/**
 * Public hosted setup page data: what the customer is saving, and for whom.
 * Refuses when the gate is off or the link is unknown — an unknown token is
 * a 404, never a hint about which tokens exist.
 */
export async function publicSetupPage(setupToken: string): Promise<PublicSetupPage> {
  if (!setupToken || setupToken.length < 16) throw new AutopayError("this setup link is not valid; ask for a new one");
  return withBypassContext(async () => {
    const row = (await db.execute<{
      org_id: string;
      org_name: string;
      party_name: string;
      provider: AcceptanceProvider;
      status: string;
      brand: string | null;
      last4: string | null;
    }>(sql`
      select m.org_id, o.name as "org_name", p.display_name as "party_name",
             m.provider, m.status, m.brand, m.last4
        from customer_payment_methods m
        join orgs o on o.id = m.org_id
        join parties p on p.id = m.party_id and p.org_id = m.org_id
       where m.token_hash = ${paymentLinkTokenHash(setupToken)} limit 1
    `)).rows[0];
    if (!row) throw new AutopayError("this setup link is not valid; ask for a new one");
    if (!(await orgFeatureEnabled(row.org_id, "autopay"))) {
      throw new AutopayError("automatic payments are not available right now; contact us for another way to pay");
    }
    return {
      orgId: row.org_id,
      orgName: row.org_name,
      partyName: row.party_name,
      provider: row.provider,
      status: row.status,
      brand: row.brand,
      last4: row.last4,
    };
  });
}

/** The stored provider URL the customer continues to (minted at setup start). */
export async function setupContinueUrl(setupToken: string): Promise<string> {
  const page = await publicSetupPage(setupToken);
  if (page.status !== "pending") {
    throw new AutopayError(
      page.status === "active"
        ? "this method is already saved; there is nothing left to do"
        : "this setup link was withdrawn; ask for a new one",
    );
  }
  const url = await withBypassContext(async () => {
    return (await db.execute<{ setup_redirect_url: string | null }>(sql`
      select setup_redirect_url from customer_payment_methods
       where token_hash = ${paymentLinkTokenHash(setupToken)} limit 1
    `)).rows[0]?.setup_redirect_url ?? null;
  });
  if (!url) throw new AutopayError("this setup link expired before use; ask for a new one");
  return url;
}

/** Complete a setup from the hosted return page (token-authenticated). */
export async function completeSetupByToken(setupToken: string, fetchFn?: FetchFn): Promise<StoredPaymentMethod> {
  const page = await publicSetupPage(setupToken);
  const methodId = await withBypassContext(async () => {
    return (await db.execute<{ id: string }>(sql`
      select id from customer_payment_methods
       where token_hash = ${paymentLinkTokenHash(setupToken)} limit 1
    `)).rows[0]?.id ?? null;
  });
  if (!methodId) throw new AutopayError("this setup link is not valid; ask for a new one");
  return completeMethodSetup(page.orgId, methodId, null, fetchFn);
}

/** Provider method detail read off a completed setup (brand/last4/expiry). */
export interface CompletedMethodDetail {
  providerCustomerId: string | null;
  providerMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  mandateReference: string | null;
}

async function stripeGet(path: string, apiKey: string, base: string, fetchFn: FetchFn): Promise<Record<string, unknown>> {
  const res = await fetchFn(`${base}${path}`, {
    method: "GET",
    redirect: "error",
    headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
  });
  if (res.status >= 400) throw new AutopayError("the provider could not confirm the setup; ask the customer to finish the setup checkout first");
  return jsonRecord(await res.json().catch(() => null));
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Complete a pending setup: verify with the provider, then flip the row
 * active with the real method token. Called from the hosted return page and
 * from the setup webhook — whichever confirms first wins, the other reuses
 * the active row. Refusals name the customer-facing remedy.
 */
export async function completeMethodSetup(
  orgId: string,
  methodId: string,
  actorId: string | null = null,
  fetchFn?: FetchFn,
  setupEvent?: WebhookEvent,
): Promise<StoredPaymentMethod> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const locked = (await db.execute(sql`
      select * from customer_payment_methods
       where id = ${methodId} and org_id = ${orgId}
       for update
    `)).rows[0];
    if (!locked) throw new AutopayError("payment method not found");
    if (locked.status === "active") return rowToMethod(locked);
    if (locked.status !== "pending") throw new AutopayError("this payment method was removed; send a new setup link instead");
    const provider = locked.provider as AcceptanceProvider;
    const config = await loadPaymentProviderConfig<ProviderConfigRow>(orgId, provider);
    if (!config?.is_enabled || !config.acceptance_enabled) {
      throw new AutopayError(`${provider} is not enabled; enable it in provider settings first`);
    }
    const secrets = configSecrets(config, orgId);
    if (!secrets.apiKey) throw new AutopayError(`${provider} has no API key configured; add it in provider settings first`);
    const httpFetch = fetchFn ?? defaultFetch;
    const detail = await readCompletedSetup(provider, String(locked.provider_method_id ?? ""), secrets, httpFetch, setupEvent);
    const updated = (await db.execute(sql`
      update customer_payment_methods
         set provider_customer_id = coalesce(${detail.providerCustomerId}, provider_customer_id),
             provider_method_id = ${detail.providerMethodId},
             brand = ${detail.brand}, last4 = ${detail.last4},
             exp_month = ${detail.expMonth}, exp_year = ${detail.expYear},
             mandate_reference = coalesce(${detail.mandateReference}, mandate_reference),
             status = 'active', updated_at = now(), updated_by = ${actorId}
       where id = ${methodId} and org_id = ${orgId} and status = 'pending'
       returning *
    `));
    if (!updated.rows[0]) throw new AutopayError("payment method setup was superseded; start a new setup link");
    await auditAutopay(orgId, "customer_payment_methods", methodId, {
      event: "setup_completed",
      after: { brand: detail.brand, last4: detail.last4 ? `•••• ${detail.last4}` : null },
      reason: "Provider confirmed the stored method.",
    }, actorId);
    return rowToMethod(updated.rows[0]);
  });
}

/** Read the stored method off the provider after a completed setup. */
async function readCompletedSetup(
  provider: AcceptanceProvider,
  setupRef: string,
  secrets: { apiKey?: string; merchantAccount?: string; apiBase?: string },
  fetchFn: FetchFn,
  setupEvent?: WebhookEvent,
): Promise<CompletedMethodDetail> {
  if (!setupRef) throw new AutopayError("this setup never reached the provider; send a new setup link instead");
  if (provider === "stripe") {
    const base = resolveAcceptanceProviderApiBase("stripe", secrets.apiBase);
    const session = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(setupRef)}`, secrets.apiKey!, base, fetchFn);
    if (session.mode !== "setup" || session.payment_status === "unpaid" || !session.setup_intent) {
      throw new AutopayError("the setup checkout is not complete; ask the customer to finish it first");
    }
    const intent = await stripeGet(`/v1/setup_intents/${encodeURIComponent(String(session.setup_intent))}`, secrets.apiKey!, base, fetchFn);
    if (!intent.payment_method) throw new AutopayError("the setup has no payment method yet; ask the customer to finish it first");
    const method = await stripeGet(`/v1/payment_methods/${encodeURIComponent(String(intent.payment_method))}`, secrets.apiKey!, base, fetchFn);
    const card = jsonRecord(method.card);
    const expMonth = typeof card.exp_month === "number" ? card.exp_month : null;
    const expYear = typeof card.exp_year === "number" ? card.exp_year : null;
    return {
      providerCustomerId: typeof intent.customer === "string" ? intent.customer : typeof session.customer === "string" ? session.customer : null,
      providerMethodId: String(intent.payment_method),
      brand: typeof card.brand === "string" ? card.brand : typeof method.type === "string" ? method.type : null,
      last4: typeof card.last4 === "string" ? card.last4 : null,
      expMonth,
      expYear,
      mandateReference: null,
    };
  }
  if (provider === "gocardless") {
    const base = resolveAcceptanceProviderApiBase("gocardless", secrets.apiBase);
    const headers = { authorization: `Bearer ${secrets.apiKey}`, "content-type": "application/json", "GoCardless-Version": "2015-07-06" };
    const get = async (path: string) => {
      const res = await fetchFn(`${base}${path}`, { method: "GET", redirect: "error", headers });
      if (res.status >= 400) throw new AutopayError("the mandate is not authorised yet; ask the customer to finish the setup first");
      return jsonRecord(await res.json().catch(() => null));
    };
    const br = jsonRecord((await get(`/billing_requests/${encodeURIComponent(setupRef)}`)).billing_requests);
    const links = jsonRecord(br.links);
    const mandateId = links.mandate;
    if (typeof mandateId !== "string" || !mandateId) {
      throw new AutopayError("the mandate is not authorised yet; ask the customer to finish the setup first");
    }
    const mandate = jsonRecord((await get(`/mandates/${encodeURIComponent(mandateId)}`)).mandates);
    const mandateLinks = jsonRecord(mandate.links);
    let last4: string | null = null;
    if (typeof mandateLinks.customer_bank_account === "string") {
      const account = jsonRecord((await get(`/customer_bank_accounts/${encodeURIComponent(mandateLinks.customer_bank_account)}`)).customer_bank_accounts);
      last4 = typeof account.account_ending === "string" ? account.account_ending : null;
    }
    return {
      providerCustomerId: typeof mandateLinks.customer === "string" ? mandateLinks.customer : null,
      providerMethodId: mandateId,
      brand: typeof mandate.scheme === "string" ? mandate.scheme : "bank_debit",
      last4,
      expMonth: null,
      expYear: null,
      mandateReference: typeof mandate.reference === "string" ? mandate.reference : mandateId,
    };
  }
  // Adyen: the RECURRING_CONTRACT webhook carries the stored detail — the
  // payment link itself never names it, so without the event there is
  // nothing exact to read and the row stays pending for the webhook.
  if (!setupEvent?.setupRef) {
    throw new AutopayError("the provider has not confirmed the stored method yet; it activates when the confirmation webhook arrives");
  }
  return {
    providerCustomerId: setupEvent.setupCustomerRef ?? null,
    providerMethodId: setupEvent.setupRef,
    brand: "adyen",
    last4: null,
    expMonth: null,
    expYear: null,
    mandateReference: null,
  };
}

/** Make one active method the customer's default charge target. */
export async function setDefaultMethod(orgId: string, methodId: string, actorId: string | null = null): Promise<void> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const locked = (await db.execute<{ party_id: string; status: string }>(sql`
      select party_id, status from customer_payment_methods
       where id = ${methodId} and org_id = ${orgId}
       for update
    `)).rows[0];
    if (!locked) throw new AutopayError("payment method not found");
    if (locked.status !== "active") throw new AutopayError("only an active method can be the default; finish its setup first");
    await db.execute(sql`
      update customer_payment_methods set is_default = false, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and party_id = ${locked.party_id} and is_default and id <> ${methodId}
    `);
    const flipped = (await db.execute<{ id: string }>(sql`
      update customer_payment_methods set is_default = true, updated_at = now(), updated_by = ${actorId}
       where id = ${methodId} and org_id = ${orgId} and status = 'active'
       returning id
    `));
    if (!flipped.rows[0]) throw new AutopayError("payment method is no longer active; finish its setup first");
    await auditAutopay(orgId, "customer_payment_methods", methodId, {
      event: "default_changed",
      reason: "Operator chose the default autopay method.",
    }, actorId);
  });
}

/**
 * Remove a stored method: detach at the provider, then flip the row. A
 * provider-side miss (already detached) still removes locally — removal is
 * idempotent — but any other provider failure refuses with the provider's
 * message so a method is never shown as removed while still chargeable.
 */
export async function removeMethod(
  orgId: string,
  methodId: string,
  actorId: string | null = null,
  fetchFn?: FetchFn,
): Promise<void> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const locked = (await db.execute<{
      provider: AcceptanceProvider;
      provider_customer_id: string | null;
      provider_method_id: string | null;
      status: string;
      is_default: boolean;
    }>(sql`
      select provider, provider_customer_id, provider_method_id, status, is_default as "is_default"
        from customer_payment_methods
       where id = ${methodId} and org_id = ${orgId}
       for update
    `)).rows[0];
    if (!locked) throw new AutopayError("payment method not found");
    if (locked.status === "removed") return;
    if (locked.status === "active" && locked.provider_method_id) {
      const config = await loadPaymentProviderConfig<ProviderConfigRow>(orgId, locked.provider);
      if (!config?.is_enabled || !config.acceptance_enabled) {
        throw new AutopayError(`${locked.provider} is not enabled; re-enable it in provider settings before removing the method`);
      }
      await ACCEPTANCE_ADAPTERS[locked.provider].detachMethod(
        configSecrets(config, orgId),
        { providerCustomerId: locked.provider_customer_id, providerMethodId: locked.provider_method_id },
        fetchFn,
      );
    }
    const flipped = (await db.execute<{ id: string }>(sql`
      update customer_payment_methods
         set status = 'removed', is_default = false, updated_at = now(), updated_by = ${actorId}
       where id = ${methodId} and org_id = ${orgId} and status <> 'removed'
       returning id
    `));
    if (!flipped.rows[0]) throw new AutopayError("payment method was already removed");
    await auditAutopay(orgId, "customer_payment_methods", methodId, {
      event: "removed",
      after: { wasDefault: locked.is_default },
      reason: locked.is_default
        ? "Default method removed — link another method or autopay stops collecting for this customer."
        : "Operator removed the stored method.",
    }, actorId);
  });
}

// ---------------------------------------------------------------------------
// Autopay enrollments
// ---------------------------------------------------------------------------

export interface AutopayEnrollment {
  id: string;
  partyId: string;
  subscriptionId: string | null;
  paymentMethodId: string | null;
  status: string;
  chargeOnIssue: boolean;
}

/**
 * Enroll a customer — or one subscription — in autopay. The method defaults
 * to the customer's default; subscription scope additionally requires the
 * method to belong to the subscription's customer, so one subscription can
 * never charge another customer's card.
 */
export async function enrollAutopay(
  orgId: string,
  input: { partyId: string; subscriptionId?: string | null; paymentMethodId?: string | null; chargeOnIssue?: boolean; actorId?: string | null },
): Promise<AutopayEnrollment> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    if (input.subscriptionId) {
      const sub = (await db.execute<{ customer_id: string; status: string }>(sql`
        select customer_id, status from subscriptions
         where id = ${input.subscriptionId} and org_id = ${orgId} limit 1
      `)).rows[0];
      if (!sub) throw new AutopayError("subscription not found");
      if (sub.status === "canceled") throw new AutopayError("a canceled subscription cannot enroll in autopay; reactivate it first");
      if (sub.customer_id !== input.partyId) {
        throw new AutopayError("the subscription belongs to a different customer; enroll that customer instead");
      }
    } else {
      const party = (await db.execute<{ id: string }>(sql`
        select id from parties where id = ${input.partyId} and org_id = ${orgId} limit 1
      `)).rows[0];
      if (!party) throw new AutopayError("customer not found; pick a customer from Customers first");
    }
    let methodId = input.paymentMethodId ?? null;
    if (methodId) {
      const method = (await db.execute<{ party_id: string; status: string }>(sql`
        select party_id, status from customer_payment_methods
         where id = ${methodId} and org_id = ${orgId} limit 1
      `)).rows[0];
      if (!method || method.status !== "active") throw new AutopayError("that payment method is not active; finish its setup first");
      if (method.party_id !== input.partyId) {
        throw new AutopayError("that method belongs to a different customer; use one of this customer's methods");
      }
    } else {
      methodId = (await db.execute<{ id: string }>(sql`
        select id from customer_payment_methods
         where org_id = ${orgId} and party_id = ${input.partyId} and status = 'active' and is_default
         limit 1
      `)).rows[0]?.id ?? null;
    }
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into autopay_enrollments (org_id, party_id, subscription_id, payment_method_id, status, charge_on_issue, created_by, updated_by)
      values (${orgId}, ${input.partyId}, ${input.subscriptionId ?? null}, ${methodId},
              'active', ${input.chargeOnIssue ?? false}, ${input.actorId ?? null}, ${input.actorId ?? null})
      returning id
    `)).rows[0];
    if (!inserted) throw new AutopayError("enrollment could not be created; try again");
    await auditAutopay(orgId, "autopay_enrollments", inserted.id, {
      event: "enrolled",
      after: { subscriptionId: input.subscriptionId ?? null, chargeOnIssue: input.chargeOnIssue ?? false },
      reason: input.subscriptionId
        ? "Subscription enrolled in autopay; due invoices charge automatically."
        : "Customer enrolled in autopay; due invoices charge automatically.",
    }, input.actorId ?? null);
    return {
      id: inserted.id,
      partyId: input.partyId,
      subscriptionId: input.subscriptionId ?? null,
      paymentMethodId: methodId,
      status: "active",
      chargeOnIssue: input.chargeOnIssue ?? false,
    };
  }).catch((error: unknown) => {
    // A live duplicate enrollment means this exact scope is already covered:
    // report the existing coverage instead of a constraint code. The pg code
    // rides on the driver's cause — DrizzleQueryError itself carries none.
    const pgCode = (error as { code?: string }).code
      ?? ((error as { cause?: { code?: string } }).cause?.code);
    if (pgCode === "23505") {
      throw new AutopayError(
        input.subscriptionId
          ? "this subscription is already enrolled in autopay"
          : "this customer is already enrolled in autopay; pause or cancel the existing enrollment first",
      );
    }
    throw error;
  });
}

async function setEnrollmentStatus(
  orgId: string,
  enrollmentId: string,
  status: "active" | "paused" | "canceled",
  actorId: string | null,
  reason: string,
): Promise<void> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const flipped = (await db.execute<{ id: string }>(sql`
      update autopay_enrollments set status = ${status}, updated_at = now(), updated_by = ${actorId}
       where id = ${enrollmentId} and org_id = ${orgId} and status <> ${status}
       returning id
    `));
    if (!flipped.rows[0]) throw new AutopayError("enrollment not found or already in that state");
    await auditAutopay(orgId, "autopay_enrollments", enrollmentId, { event: `enrollment_${status}`, reason }, actorId);
  });
}

export async function pauseEnrollment(orgId: string, enrollmentId: string, actorId: string | null = null): Promise<void> {
  return setEnrollmentStatus(orgId, enrollmentId, "paused", actorId, "Operator paused autopay; due invoices stay manual until resumed.");
}

export async function resumeEnrollment(orgId: string, enrollmentId: string, actorId: string | null = null): Promise<void> {
  return setEnrollmentStatus(orgId, enrollmentId, "active", actorId, "Operator resumed autopay.");
}

export async function cancelEnrollment(orgId: string, enrollmentId: string, actorId: string | null = null): Promise<void> {
  return setEnrollmentStatus(orgId, enrollmentId, "canceled", actorId, "Operator canceled autopay; the customer returns to manual payment.");
}

/**
 * Save the autopay retry schedule and final action on a dunning policy. The
 * schedule runs from the policy the scan reads, so the write validates
 * exactly what the scan will execute.
 */
export async function saveAutopayPolicy(
  orgId: string,
  input: { policyId: string; retryOffsetsDays: unknown; insufficientFundsOffsetsDays?: unknown; expiryNoticeDays?: unknown; finalAction: unknown; actorId?: string | null },
): Promise<AutopayPolicy> {
  const offsets = parseRetryOffsetsDays(input.retryOffsetsDays);
  const insufficientOffsets = input.insufficientFundsOffsetsDays === undefined
    ? null
    : parseRetryOffsetsDays(input.insufficientFundsOffsetsDays);
  const expiryNoticeDays = input.expiryNoticeDays === undefined ? null : parseExpiryNoticeDays(input.expiryNoticeDays);
  const finalAction = parseFinalAction(input.finalAction);
  const offsetsList = (list: number[]) => list.length > 0
    ? sql`ARRAY[${sql.join(list.map((offset) => sql`${offset}`), sql`, `)}]`
    : sql`'{}'::integer[]`;
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const updated = (await db.execute<{ id: string; name: string; grace_period_days: number; insufficient_funds_offsets: unknown; expiry_notice_days: number }>(sql`
      update dunning_policies
         set autopay_retry_offsets_days = ${offsetsList(offsets)},
             autopay_insufficient_funds_offsets_days = coalesce(${insufficientOffsets === null ? sql`null::integer[]` : offsetsList(insufficientOffsets)}, autopay_insufficient_funds_offsets_days),
             autopay_expiry_notice_days = coalesce(${expiryNoticeDays}, autopay_expiry_notice_days),
             autopay_final_action = ${finalAction},
             updated_at = now(), updated_by = ${input.actorId ?? null}
       where id = ${input.policyId} and org_id = ${orgId}
       returning id, name, grace_period_days as "grace_period_days",
                 autopay_insufficient_funds_offsets_days as "insufficient_funds_offsets",
                 autopay_expiry_notice_days as "expiry_notice_days"
    `));
    const row = updated.rows[0];
    if (!row) throw new AutopayError("collection policy not found");
    const resolvedInsufficient = insufficientOffsets ?? parseRetryOffsetsDays(row.insufficient_funds_offsets);
    const resolvedExpiry = expiryNoticeDays ?? parseExpiryNoticeDays(row.expiry_notice_days);
    await auditAutopay(orgId, "dunning_policies", row.id, {
      event: "autopay_policy_saved",
      after: { retryOffsetsDays: offsets, insufficientFundsOffsetsDays: resolvedInsufficient, expiryNoticeDays: resolvedExpiry, finalAction },
      reason: "Operator changed the autopay retry schedule or final action.",
    }, input.actorId ?? null);
    return { policyId: row.id, policyName: row.name, retryOffsetsDays: offsets, insufficientFundsOffsetsDays: resolvedInsufficient, finalAction, gracePeriodDays: row.grace_period_days, expiryNoticeDays: resolvedExpiry };
  });
}

// ---------------------------------------------------------------------------
// Collection scan
// ---------------------------------------------------------------------------

export interface AutopayRunResult {
  scanned: number;
  charged: number;
  succeeded: number;
  failed: number;
  retried: number;
  suspended: number;
  canceled: number;
  reactivated: number;
  skipped: number;
  notices: { invoiceId: string; attemptId: string | null; status: string; detail: string }[];
  orgErrors: { orgId: string; error: string }[];
}

function emptyRunResult(): AutopayRunResult {
  return { scanned: 0, charged: 0, succeeded: 0, failed: 0, retried: 0, suspended: 0, canceled: 0, reactivated: 0, skipped: 0, notices: [], orgErrors: [] };
}

/**
 * Scheduler entry point: every production org with a live enrollment gets
 * one org-scoped run. Feature-off orgs keep their data and are skipped —
 * off means hidden and refused, never charged.
 */
export async function runAutopayCollection(asOf?: string): Promise<AutopayRunResult> {
  const orgRows = (
    // bypass: scheduler-tick — the unscoped run lists every production organization with a live autopay enrollment.
    await withBypass(async () => {
      return (await db.execute<{ orgId: string }>(sql`
        select distinct enrollment.org_id as "orgId"
          from autopay_enrollments enrollment
          join orgs organization on organization.id = enrollment.org_id
         where enrollment.status = 'active' and organization.env_kind = 'production'
      `));
    })
  ).rows;
  const result = emptyRunResult();
  for (const { orgId } of orgRows) {
    const one = await runAutopayCollectionForOrg(orgId, asOf ? { asOf } : undefined).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[autopay] org ${orgId} collection failed: ${message}`);
      return { ...emptyRunResult(), orgErrors: [{ orgId, error: message.slice(0, 1000) }] };
    });
    result.scanned += one.scanned;
    result.charged += one.charged;
    result.succeeded += one.succeeded;
    result.failed += one.failed;
    result.retried += one.retried;
    result.suspended += one.suspended;
    result.canceled += one.canceled;
    result.reactivated += one.reactivated;
    result.skipped += one.skipped;
    result.notices.push(...one.notices);
    result.orgErrors.push(...one.orgErrors);
  }
  return result;
}

export async function runAutopayCollectionForOrg(
  orgId: string,
  opts?: { asOf?: string; charge?: ChargeFn },
): Promise<AutopayRunResult> {
  if (!orgId.trim()) throw new AutopayError("orgId is required for an org-scoped collection run");
  const result = emptyRunResult();
  return withOrg(orgId, async () => {
    if (!(await orgFeatureEnabled(orgId, "autopay"))) return result;
    const today = opts?.asOf ?? (await businessToday(orgId));
    const charge = opts?.charge ?? ((provider, req) => adapterCharge(orgId, provider, req));

    await reconcileProcessingAttempts(orgId, result);
    const policy = await resolveAutopayPolicy(orgId).catch((error: unknown) => {
      result.orgErrors.push({ orgId, error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (!policy) return result;

    // Initial charges: due invoices (or issued ones for charge-on-issue
    // enrollments) with a live enrollment and method, and no attempt yet.
    const initials = (await db.execute<CollectionCandidate>(sql`
      select d.id as "invoiceId", d.document_number as "documentNumber",
             d.open_balance as "openBalance", d.currency,
             d.party_id as "partyId", d.subsidiary_id as "subsidiaryId",
             d.document_date::text as "documentDate", d.due_date::text as "dueDate",
             e.id as "enrollmentId", e.subscription_id as "subscriptionId",
             m.id as "methodId", m.provider, m.provider_customer_id as "providerCustomerId",
             m.provider_method_id as "providerMethodId"
        from documents d
        join autopay_enrollments e
          on e.org_id = d.org_id and e.party_id = d.party_id and e.status = 'active'
        join customer_payment_methods m
          on m.id = coalesce(e.payment_method_id,
                       (select id from customer_payment_methods dd
                         where dd.org_id = e.org_id and dd.party_id = e.party_id
                           and dd.status = 'active' and dd.is_default limit 1))
         and m.org_id = e.org_id and m.status = 'active'
        left join subscription_period_invoices spi
          on spi.org_id = e.org_id and spi.subscription_id = e.subscription_id and spi.invoice_id = d.id
       where d.org_id = ${orgId} and d.kind = 'customer_invoice'
         and (e.subscription_id is null or spi.invoice_id is not null)
         and (d.due_date <= ${today}::date or (e.charge_on_issue and d.document_date <= ${today}::date))
         and not exists (
           select 1 from collection_attempts a
            where a.org_id = d.org_id and a.invoice_id = d.id and a.retry_position = 0
         )
       order by d.id
    `)).rows;
    for (const candidate of initials) {
      result.scanned += 1;
      await collectCandidate(orgId, candidate, 0, today, policy, charge, result).catch((error: unknown) => {
        result.failed += 1;
        result.notices.push({
          invoiceId: candidate.invoiceId,
          attemptId: null,
          status: "failed",
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
      });
    }

    // Consolidated invoices: the header names the payer, so a payer-level
    // enrollment matches above — but a subscription enrollment (anchored on
    // the service party) does not. A subscription behind any of the
    // invoice's source drafts authorizes collection; the charge still hits
    // the header payer, on the enrollment's method when it belongs to the
    // payer, else the payer's default method. Invoices an above enrollment
    // already covers stay out, so one invoice never collects twice.
    const consolidated = (await db.execute<CollectionCandidate>(sql`
      select d.id as "invoiceId", d.document_number as "documentNumber",
             d.open_balance as "openBalance", d.currency,
             d.party_id as "partyId", d.subsidiary_id as "subsidiaryId",
             d.document_date::text as "documentDate", d.due_date::text as "dueDate",
             e.id as "enrollmentId", e.subscription_id as "subscriptionId",
             m.id as "methodId", m.provider, m.provider_customer_id as "providerCustomerId",
             m.provider_method_id as "providerMethodId"
        from documents d
        join subscription_period_invoices spi
          on spi.org_id = d.org_id
         and spi.invoice_id = any(
               select (jsonb_array_elements_text(d.custom -> 'sourceDraftIds'))::uuid)
        join autopay_enrollments e
          on e.org_id = d.org_id and e.subscription_id = spi.subscription_id and e.status = 'active'
        join customer_payment_methods m
          on m.id = coalesce(
               (select mm.id from customer_payment_methods mm
                 where mm.id = e.payment_method_id and mm.org_id = e.org_id
                   and mm.party_id = d.party_id and mm.status = 'active'),
               (select dd.id from customer_payment_methods dd
                 where dd.org_id = e.org_id and dd.party_id = d.party_id
                   and dd.status = 'active' and dd.is_default limit 1))
         and m.org_id = e.org_id and m.status = 'active'
       where d.org_id = ${orgId} and d.kind = 'customer_invoice'
         and d.custom ->> 'consolidationStatus' = 'consolidated'
         and (d.due_date <= ${today}::date or (e.charge_on_issue and d.document_date <= ${today}::date))
         and not exists (
           select 1 from collection_attempts a
            where a.org_id = d.org_id and a.invoice_id = d.id and a.retry_position = 0
         )
         and not exists (
           select 1 from autopay_enrollments e0
            where e0.org_id = d.org_id and e0.party_id = d.party_id and e0.status = 'active'
              and coalesce(e0.payment_method_id,
                    (select dd.id from customer_payment_methods dd
                      where dd.org_id = e0.org_id and dd.party_id = e0.party_id
                        and dd.status = 'active' and dd.is_default limit 1)) is not null
         )
       order by d.id
    `)).rows;
    for (const candidate of consolidated) {
      result.scanned += 1;
      await collectCandidate(orgId, candidate, 0, today, policy, charge, result).catch((error: unknown) => {
        result.failed += 1;
        result.notices.push({
          invoiceId: candidate.invoiceId,
          attemptId: null,
          status: "failed",
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
      });
    }

    // Enrolled consolidated invoices with no usable payer method stay
    // uncollected by name: the operator adds a payment method for the payer
    // instead of discovering the gap from an unpaid invoice.
    const methodless = (await db.execute<{ invoiceId: string; documentNumber: string; payerId: string }>(sql`
      select d.id as "invoiceId", d.document_number as "documentNumber", d.party_id as "payerId"
        from documents d
       where d.org_id = ${orgId} and d.kind = 'customer_invoice'
         and d.custom ->> 'consolidationStatus' = 'consolidated'
         and (d.due_date is null or d.due_date <= ${today}::date)
         and not exists (
           select 1 from collection_attempts a
            where a.org_id = d.org_id and a.invoice_id = d.id and a.retry_position = 0
         )
         and exists (
           select 1 from subscription_period_invoices spi
             join autopay_enrollments e
               on e.org_id = spi.org_id and e.subscription_id = spi.subscription_id and e.status = 'active'
            where spi.org_id = d.org_id
              and spi.invoice_id = any(
                    select (jsonb_array_elements_text(d.custom -> 'sourceDraftIds'))::uuid)
         )
         and not exists (
           select 1 from customer_payment_methods m
            where m.org_id = d.org_id and m.party_id = d.party_id and m.status = 'active'
         )
       order by d.id
    `)).rows;
    for (const row of methodless) {
      result.skipped += 1;
      result.notices.push({
        invoiceId: row.invoiceId,
        attemptId: null,
        status: "skipped",
        detail:
          `consolidated invoice ${row.documentNumber} has an enrolled subscription but its payer has no active payment method; add one for the payer before autopay can collect`,
      });
    }

    // Retries: soft-declined attempts whose next retry day arrived.
    const retries = (await db.execute<CollectionCandidate>(sql`
      select d.id as "invoiceId", d.document_number as "documentNumber",
             d.open_balance as "openBalance", d.currency,
             d.party_id as "partyId", d.subsidiary_id as "subsidiaryId",
             d.document_date::text as "documentDate", d.due_date::text as "dueDate",
             e.id as "enrollmentId", e.subscription_id as "subscriptionId",
             m.id as "methodId", m.provider, m.provider_customer_id as "providerCustomerId",
             m.provider_method_id as "providerMethodId",
             a.retry_position as "failedPosition", a.decline_code as "declineCode"
        from collection_attempts a
        join documents d on d.id = a.invoice_id and d.org_id = a.org_id
        join autopay_enrollments e on e.id = a.enrollment_id and e.org_id = a.org_id and e.status = 'active'
        join customer_payment_methods m on m.id = a.payment_method_id and m.org_id = a.org_id and m.status = 'active'
       where a.org_id = ${orgId} and a.status = 'failed' and a.decline_kind in ('soft', 'insufficient_funds')
         and a.next_retry_on is not null and a.next_retry_on <= ${today}::date
         and not exists (
           select 1 from collection_attempts later
            where later.org_id = a.org_id and later.invoice_id = a.invoice_id
              and later.retry_position = a.retry_position + 1
         )
       order by a.invoice_id
    `)).rows;
    for (const candidate of retries) {
      result.scanned += 1;
      const position = (candidate.failedPosition ?? 0) + 1;
      await collectCandidate(orgId, candidate, position, today, policy, charge, result).catch((error: unknown) => {
        result.failed += 1;
        result.notices.push({
          invoiceId: candidate.invoiceId,
          attemptId: null,
          status: "failed",
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
      });
    }
    return result;
  });
}

// A type alias (not an interface): SQL row types need the implicit index
// signature only object-literal types carry, or db.execute<T> refuses them.
type CollectionCandidate = {
  invoiceId: string;
  documentNumber: string;
  openBalance: string;
  currency: string;
  partyId: string;
  subsidiaryId: string | null;
  documentDate: string | null;
  dueDate: string | null;
  enrollmentId: string;
  subscriptionId: string | null;
  methodId: string;
  provider: AcceptanceProvider;
  providerCustomerId: string | null;
  providerMethodId: string | null;
  failedPosition?: number | null;
  declineCode?: string | null;
};

function collectionLockKey(orgId: string, invoiceId: string): string {
  return `autopay-collection:${orgId}:${invoiceId}`;
}

/**
 * Charge one invoice at one schedule position. The invoice is re-read under
 * the row lock: anything paid, voided, disputed or credited since selection
 * refuses the charge instead of taking money no longer owed.
 */
async function collectCandidate(
  orgId: string,
  candidate: CollectionCandidate,
  position: number,
  today: string,
  policy: AutopayPolicy,
  charge: ChargeFn,
  result: AutopayRunResult,
  actorId: string | null = null,
): Promise<void> {
  await db.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${collectionLockKey(orgId, candidate.invoiceId)}, 0))
  `);
  const invoice = (await db.execute<{
    status: string;
    open_balance: string;
    currency: string;
    document_number: string;
    subsidiary_id: string | null;
  }>(sql`
    select status, open_balance, currency, document_number as "document_number", subsidiary_id
      from documents where id = ${candidate.invoiceId} and org_id = ${orgId}
     for update
  `)).rows[0];
  if (!invoice) {
    result.skipped += 1;
    result.notices.push({ invoiceId: candidate.invoiceId, attemptId: null, status: "skipped", detail: "invoice is gone; nothing to collect" });
    return;
  }
  const skipReason = await uncollectibleReason(orgId, candidate.invoiceId, invoice.status, invoice.open_balance);
  if (skipReason) {
    result.skipped += 1;
    result.notices.push({ invoiceId: candidate.invoiceId, attemptId: null, status: "skipped", detail: skipReason });
    return;
  }
  // The enrollment and method were live at selection; recheck under the lock
  // — a removed method or paused enrollment must refuse with its remedy.
  const live = (await db.execute<{ enrollmentId: string; methodId: string }>(sql`
    select e.id as "enrollmentId", m.id as "methodId"
      from autopay_enrollments e
      join customer_payment_methods m on m.id = coalesce(e.payment_method_id,
        (select id from customer_payment_methods dd
          where dd.org_id = e.org_id and dd.party_id = e.party_id
            and dd.status = 'active' and dd.is_default limit 1))
     where e.id = ${candidate.enrollmentId} and e.org_id = ${orgId} and e.status = 'active'
       and m.org_id = ${orgId} and m.status = 'active'
  `)).rows[0];
  if (!live) {
    result.skipped += 1;
    result.notices.push({
      invoiceId: candidate.invoiceId,
      attemptId: null,
      status: "skipped",
      detail: "enrollment paused or no active method; link a payment method or resume autopay first",
    });
    return;
  }
  const amount = invoice.open_balance;
  // Backup methods, ordered after the enrollment method: the default first,
  // then the customer's other active methods by fallback priority. At most
  // three backups charge per tick — a customer with more simply keeps the
  // rest for the next retry, so one invoice can never fan out into a charge
  // storm.
  const backups = (await db.execute<{
    methodId: string;
    provider: AcceptanceProvider;
    providerCustomerId: string | null;
    providerMethodId: string | null;
  }>(sql`
    select id as "methodId", provider,
           provider_customer_id as "providerCustomerId",
           provider_method_id as "providerMethodId"
      from customer_payment_methods
     where org_id = ${orgId} and party_id = ${candidate.partyId}
       and status = 'active' and id <> ${candidate.methodId}
     order by fallback_priority asc, created_at asc
     limit 3
  `)).rows;
  const chain = [{
    methodId: candidate.methodId,
    provider: candidate.provider,
    providerCustomerId: candidate.providerCustomerId,
    providerMethodId: candidate.providerMethodId,
    fallbackOf: null as string | null,
  }, ...backups.map((backup) => ({ ...backup, fallbackOf: candidate.methodId as string | null }))];
  let fallbackPosition = position;
  for (const link of chain) {
    if (!link.providerMethodId) {
      result.skipped += 1;
      result.notices.push({
        invoiceId: candidate.invoiceId,
        attemptId: null,
        status: "skipped",
        detail: "a backup method has no provider token yet; finish its setup first",
      });
      continue;
    }
    // Idempotent per (invoice, schedule position): a concurrent tick that
    // won the race owns the charge, so this tick stands down. The conflict
    // is expected under concurrency and benign — exactly one attempt
    // charges. Fallback rows consume later positions, so the retry ladder
    // keeps bounding total attempts.
    const attemptId = await insertCollectionAttempt(
      orgId, candidate, link.methodId, link.provider, link.fallbackOf,
      amount, invoice.currency, fallbackPosition, actorId,
    );
    if (!attemptId) {
      result.skipped += 1;
      result.notices.push({ invoiceId: candidate.invoiceId, attemptId: null, status: "skipped", detail: "another tick is already collecting this position" });
      return;
    }
    result.charged += 1;
    const outcome = await charge(link.provider, {
      providerCustomerId: link.providerCustomerId,
      providerMethodId: link.providerMethodId,
      amount,
      currency: invoice.currency,
      description: `Autopay — invoice ${invoice.document_number}`,
      idempotencyKey: attemptId,
    });
    if (outcome.status === "succeeded") {
      await db.execute(sql`
        update collection_attempts set provider_ref = ${outcome.providerRef}, updated_at = now()
         where id = ${attemptId} and org_id = ${orgId}
      `);
      await postCollectionReceipt(orgId, attemptId);
      result.succeeded += 1;
      result.reactivated += await reactivateScopeSubscriptions(orgId, candidate, null);
      result.notices.push({
        invoiceId: candidate.invoiceId,
        attemptId,
        status: "succeeded",
        detail: link.fallbackOf
          ? `collected ${amount} ${invoice.currency} on the backup method after the primary declined`
          : `collected ${amount} ${invoice.currency}`,
      });
      return;
    }
    if (outcome.status === "processing") {
      await db.execute(sql`
        update collection_attempts
           set status = 'processing', provider_ref = ${outcome.providerRef}, updated_at = now()
         where id = ${attemptId} and org_id = ${orgId}
      `);
      result.notices.push({ invoiceId: candidate.invoiceId, attemptId, status: "processing", detail: "provider is still collecting; the webhook settles this attempt" });
      return;
    }
    if (outcome.status === "requires_action") {
      await recordDecline(orgId, candidate, attemptId, fallbackPosition, today, policy,
        outcome.declineCode ?? "authentication_required", result, { authUrl: outcome.authUrl });
      return;
    }
    const kind = classifyDecline(outcome.declineCode) ?? "soft";
    const lastLink = link === chain[chain.length - 1];
    if (kind === "hard" && !lastLink) {
      // The primary is dead but a backup is on file: park this row as a
      // hard failure without running the final action, and charge the next
      // method immediately. The final action runs only when every method on
      // file has declined hard.
      const parked = (await db.execute<{ id: string }>(sql`
        update collection_attempts
           set status = 'failed', decline_code = ${outcome.declineCode}, decline_kind = 'hard',
               next_retry_on = null, updated_at = now()
         where id = ${attemptId} and org_id = ${orgId} and status = 'initiated'
         returning id
      `));
      if (!parked.rows[0]) throw new AutopayError("collection attempt changed underfoot; refusing to record over it");
      result.failed += 1;
      result.notices.push({
        invoiceId: candidate.invoiceId,
        attemptId,
        status: "failed",
        detail: `primary method declined (${outcome.declineCode ?? "unknown reason"}); trying the backup method`,
      });
      fallbackPosition += 1;
      continue;
    }
    await recordDecline(orgId, candidate, attemptId, fallbackPosition, today, policy, outcome.declineCode ?? null, result);
    return;
  }
}

/**
 * Insert one collection attempt row, returning its id — or null when a
 * concurrent tick already owns this (invoice, position). The conflict is
 * expected under concurrency and benign.
 */
async function insertCollectionAttempt(
  orgId: string,
  candidate: CollectionCandidate,
  methodId: string,
  provider: AcceptanceProvider,
  fallbackOf: string | null,
  amount: string,
  currency: string,
  retryPosition: number,
  actorId: string | null,
): Promise<string | null> {
  const attempt = (await db.execute<{ id: string }>(sql`
    insert into collection_attempts
      (org_id, invoice_id, enrollment_id, payment_method_id, fallback_method_id, amount, currency,
       provider, status, retry_position, created_by, updated_by)
    values (${orgId}, ${candidate.invoiceId}, ${candidate.enrollmentId}, ${methodId}, ${fallbackOf},
            ${amount}, ${currency}, ${provider}, 'initiated', ${retryPosition}, ${actorId}, ${actorId})
    on conflict (org_id, invoice_id, retry_position) do nothing
    returning id
  `));
  return attempt.rows[0]?.id ?? null;
}

/**
 * Operator "retry now": an immediate charge outside the schedule for a
 * soft-declined attempt (the customer just updated the method, the operator
 * does not wait for tomorrow). Hard declines refuse — they never clear on
 * retry. A success reactivates exactly like a scheduled one.
 */
export async function retryAttemptNow(
  orgId: string,
  attemptId: string,
  actorId: string | null = null,
  chargeFn?: ChargeFn,
): Promise<AutopayRunResult> {
  const result = emptyRunResult();
  await withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const attempt = (await db.execute<{
      invoice_id: string;
      enrollment_id: string;
      method_id: string;
      retry_position: number;
      decline_kind: string | null;
    }>(sql`
      select a.invoice_id, a.enrollment_id, a.payment_method_id as "method_id",
             a.retry_position, a.decline_kind
        from collection_attempts a
       where a.id = ${attemptId} and a.org_id = ${orgId} and a.status = 'failed'
       limit 1
    `)).rows[0];
    if (!attempt) throw new AutopayError("only a failed attempt can be retried; this one already settled or never failed");
    if (attempt.decline_kind === "hard") {
      throw new AutopayError("this decline will not clear on retry; ask the customer to update the payment method instead");
    }
    const candidate = (await db.execute<CollectionCandidate>(sql`
      select d.id as "invoiceId", d.document_number as "documentNumber",
             d.open_balance as "openBalance", d.currency,
             d.party_id as "partyId", d.subsidiary_id as "subsidiaryId",
             d.document_date::text as "documentDate", d.due_date::text as "dueDate",
             e.id as "enrollmentId", e.subscription_id as "subscriptionId",
             m.id as "methodId", m.provider, m.provider_customer_id as "providerCustomerId",
             m.provider_method_id as "providerMethodId"
        from documents d
        join autopay_enrollments e on e.id = ${attempt.enrollment_id} and e.org_id = ${orgId} and e.status = 'active'
        join customer_payment_methods m on m.id = ${attempt.method_id} and m.org_id = ${orgId} and m.status = 'active'
       where d.id = ${attempt.invoice_id} and d.org_id = ${orgId}
    `)).rows[0];
    if (!candidate) {
      throw new AutopayError("the enrollment or method is no longer active; link a payment method first");
    }
    const today = await businessToday(orgId);
    const policy = await resolveAutopayPolicy(orgId);
    const charge = chargeFn ?? ((provider, req) => adapterCharge(orgId, provider, req));
    result.scanned += 1;
    await collectCandidate(orgId, candidate, attempt.retry_position + 1, today, policy, charge, result, actorId);
    await auditAutopay(orgId, "collection_attempts", attemptId, {
      event: "retry_now",
      reason: "Operator retried the collection immediately instead of waiting for the schedule.",
    }, actorId);
  });
  return result;
}

/** Why an invoice must not be charged right now, or null when collectible. */
async function uncollectibleReason(
  orgId: string,
  invoiceId: string,
  status: string,
  openBalance: string,
): Promise<string | null> {
  if (status !== "posted") return `invoice is ${status}; only posted invoices are collected automatically`;
  if (cmp(openBalance, "0") <= 0) return "invoice no longer owes anything; nothing to collect";
  // Disputed: an unresolved provider chargeback against this invoice's money.
  // Voluntary refunds do not block — the open balance already reflects them.
  const disputed = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from payment_attempts a
     join payment_links l on l.id = a.link_id and l.org_id = a.org_id
    where l.org_id = ${orgId} and l.document_id = ${invoiceId}
      and a.status = 'refunded' and (a.event_payload->>'dispute') = 'true'
      and not exists (
        select 1 from payment_attempts later
         join payment_links ll on ll.id = later.link_id and ll.org_id = later.org_id
        where ll.org_id = ${orgId} and ll.document_id = ${invoiceId}
          and later.status = 'succeeded' and later.created_at > a.created_at
      )
  `)).rows[0]?.n;
  if (disputed !== "0") return "invoice is under a provider dispute; resolve the dispute before collecting";
  // Disputed autopay money: an unconsumed chargeback marker parked by the
  // collection webhook against this invoice's own provider charge.
  const clawback = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from collection_attempts ca
     join payment_pending_clawbacks pc
       on pc.org_id = ca.org_id and pc.provider = ca.provider
      and pc.intent_ref = ca.provider_ref and pc.consumed_at is null
    where ca.org_id = ${orgId} and ca.invoice_id = ${invoiceId}
  `)).rows[0]?.n;
  if (clawback !== "0") return "a chargeback was reported against this collection; reverse the receipt via payments if funds were clawed back";
  return null;
}

/**
 * The operator-facing remedy for a terminal decline: hard declines need new
 * payment details, authentication-required declines need the customer to
 * verify, and an exhausted ladder has nothing left to try. Pure.
 */
export function terminalDeclineDetail(kind: DeclineClass, declineCode: string | null): string {
  if (kind === "hard") {
    return `declined (${declineCode ?? "unknown reason"}) — no retry; ask the customer to update the payment method`;
  }
  if (kind === "needs_authentication") {
    return `declined (${declineCode ?? "unknown reason"}) — send the customer the authentication link to verify the payment`;
  }
  return `final retry declined${declineCode ? ` (${declineCode})` : ""}`;
}

/** Record a provider decline: schedule the next retry or run the final action. */
async function recordDecline(
  orgId: string,
  candidate: CollectionCandidate,
  attemptId: string,
  position: number,
  today: string,
  policy: AutopayPolicy,
  declineCode: string | null,
  result: AutopayRunResult,
  opts?: { authUrl?: string | null },
): Promise<void> {
  const kind = classifyDecline(declineCode) ?? "soft";
  const ladder = retryLadderForClass(policy, kind);
  const authUrl = opts?.authUrl ?? null;
  if (position < ladder.length) {
    const nextRetryOn = addCalendarDays(today, ladder[position]!);
    const updated = (await db.execute<{ id: string }>(sql`
      update collection_attempts
         set status = 'failed', decline_code = ${declineCode}, decline_kind = ${kind},
             next_retry_on = ${nextRetryOn}::date, auth_url = ${authUrl}, updated_at = now()
       where id = ${attemptId} and org_id = ${orgId} and status = 'initiated'
       returning id
    `));
    if (!updated.rows[0]) throw new AutopayError("collection attempt changed underfoot; refusing to record over it");
    result.failed += 1;
    result.retried += 1;
    result.notices.push({
      invoiceId: candidate.invoiceId,
      attemptId,
      status: "failed",
      detail: kind === "insufficient_funds"
        ? `declined for insufficient funds${declineCode ? ` (${declineCode})` : ""}; retrying ${nextRetryOn} near payday`
        : `declined${declineCode ? ` (${declineCode})` : ""}; retrying ${nextRetryOn}`,
    });
    return;
  }
  const updated = (await db.execute<{ id: string }>(sql`
    update collection_attempts
       set status = 'failed', decline_code = ${declineCode}, decline_kind = ${kind},
           next_retry_on = null, auth_url = ${authUrl}, updated_at = now()
     where id = ${attemptId} and org_id = ${orgId} and status = 'initiated'
     returning id
  `));
  if (!updated.rows[0]) throw new AutopayError("collection attempt changed underfoot; refusing to record over it");
  result.failed += 1;
  result.notices.push({
    invoiceId: candidate.invoiceId,
    attemptId,
    status: "failed",
    detail: terminalDeclineDetail(kind, declineCode),
  });
  const acted = await applyFinalAction(orgId, candidate, policy, null);
  result.suspended += acted.suspended;
  result.canceled += acted.canceled;
}

// ---------------------------------------------------------------------------
// Revenue recovery: card updater, pre-expiry outreach, fallback order, metrics
// ---------------------------------------------------------------------------

export interface CardUpdaterDetail {
  providerMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * Refresh a stored method off a card account updater event: the network
 * reissued or corrected the card, so brand/last4/expiry move without any
 * customer action. Unknown methods stay unknown (the provider retries an
 * informational event harmlessly); an unchanged card still stamps the
 * refresh time as proof the updater sees it. Moving the expiry clears the
 * pre-expiry outreach guard so the new date notifies on its own.
 */
export async function recordCardUpdaterEvent(
  orgId: string,
  provider: AcceptanceProvider,
  detail: CardUpdaterDetail,
): Promise<"card_refreshed" | "card_unchanged" | "unknown_method"> {
  if (detail.expMonth != null && (detail.expMonth < 1 || detail.expMonth > 12)) {
    throw new AutopayError("the card updater reported an impossible expiry month; the event is quarantined until the provider resends it");
  }
  if (detail.expYear != null && (detail.expYear < 2000 || detail.expYear > 2100)) {
    throw new AutopayError("the card updater reported an impossible expiry year; the event is quarantined until the provider resends it");
  }
  return withOrg(orgId, async () => {
    const locked = (await db.execute<{
      id: string;
      brand: string | null;
      last4: string | null;
      exp_month: number | null;
      exp_year: number | null;
    }>(sql`
      select id, brand, last4, exp_month, exp_year from customer_payment_methods
       where org_id = ${orgId} and provider = ${provider}
         and provider_method_id = ${detail.providerMethodId} and status = 'active'
       for update
    `)).rows[0];
    if (!locked) return "unknown_method";
    const expiryMoved = (locked.exp_month ?? null) !== detail.expMonth || (locked.exp_year ?? null) !== detail.expYear;
    const updated = (await db.execute<{ id: string }>(sql`
      update customer_payment_methods
         set brand = ${detail.brand}, last4 = ${detail.last4},
             exp_month = ${detail.expMonth}, exp_year = ${detail.expYear},
             last_updater_refresh_at = now(),
             expiry_notified_on = case when ${expiryMoved} then null else expiry_notified_on end,
             updated_at = now()
       where id = ${locked.id} and org_id = ${orgId}
       returning id
    `));
    if (!updated.rows[0]) throw new AutopayError("payment method changed underfoot; refusing to record over it");
    const changed = (locked.brand ?? null) !== detail.brand || (locked.last4 ?? null) !== detail.last4 || expiryMoved;
    if (!changed) return "card_unchanged";
    await auditAutopay(orgId, "customer_payment_methods", locked.id, {
      event: "card_updater_refresh",
      before: { brand: locked.brand, last4: locked.last4 ? `•••• ${locked.last4}` : null },
      after: { brand: detail.brand, last4: detail.last4 ? `•••• ${detail.last4}` : null },
      reason: "The card network refreshed the stored card; the method stays collectible without customer action.",
    }, null);
    return "card_refreshed";
  });
}

export interface ExpiringCard {
  methodId: string;
  partyId: string;
  partyName: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number;
  expYear: number;
  /** End-of-month expiry date (civil). */
  expiresOn: string;
}

/**
 * Cards whose end-of-month expiry falls inside the outreach window — from
 * today through today + the policy's notice days — that have not been
 * notified yet. The queue feeds pre-expiry outreach: the operator sends each
 * customer a setup link to replace the card before it declines.
 */
export async function findCardsExpiringSoon(
  orgId: string,
  opts?: { asOf?: string; withinDays?: number },
): Promise<ExpiringCard[]> {
  return withOrg(orgId, async () => {
    const asOf = opts?.asOf ?? (await businessToday(orgId));
    const withinDays = opts?.withinDays === undefined
      ? (await resolveAutopayPolicy(orgId)).expiryNoticeDays
      : parseExpiryNoticeDays(opts.withinDays);
    const rows = (await db.execute<{
      methodId: string;
      partyId: string;
      partyName: string | null;
      brand: string | null;
      last4: string | null;
      expMonth: number;
      expYear: number;
      expiresOn: string;
    }>(sql`
      select m.id as "methodId", m.party_id as "partyId", p.display_name as "partyName",
             m.brand, m.last4, m.exp_month as "expMonth", m.exp_year as "expYear",
             ((make_date(m.exp_year, m.exp_month, 1) + interval '1 month' - interval '1 day')::date)::text as "expiresOn"
        from customer_payment_methods m
        join parties p on p.id = m.party_id and p.org_id = m.org_id
       where m.org_id = ${orgId} and m.status = 'active'
         and m.exp_month is not null and m.exp_year is not null
         and m.expiry_notified_on is null
         and (make_date(m.exp_year, m.exp_month, 1) + interval '1 month' - interval '1 day')::date
             between ${asOf}::date and (${asOf}::date + ${withinDays}::integer)
       order by (make_date(m.exp_year, m.exp_month, 1) + interval '1 month' - interval '1 day')::date, p.display_name
    `)).rows;
    return rows.map((row) => ({
      methodId: row.methodId,
      partyId: row.partyId,
      partyName: row.partyName,
      brand: row.brand,
      last4: row.last4,
      expMonth: row.expMonth,
      expYear: row.expYear,
      expiresOn: row.expiresOn,
    }));
  });
}

/**
 * Stamp outreach as sent for the given cards. Every id must still be an
 * active, un-notified method — a short count means cards left the queue
 * (removed or already notified) and the operator refreshes it instead of
 * recording outreach nobody can act on.
 */
export async function markExpiryOutreachSent(
  orgId: string,
  methodIds: string[],
  sentOn: string,
  actorId: string | null = null,
): Promise<void> {
  if (methodIds.length === 0) throw new AutopayError("no cards were selected; pick the expiring cards first");
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    let stamped = 0;
    for (const methodId of methodIds) {
      const row = (await db.execute<{ id: string }>(sql`
        update customer_payment_methods
           set expiry_notified_on = ${sentOn}::date, updated_at = now(), updated_by = ${actorId}
         where id = ${methodId} and org_id = ${orgId} and status = 'active' and expiry_notified_on is null
         returning id
      `));
      stamped += row.rows.length;
    }
    if (stamped !== methodIds.length) {
      throw new AutopayError("some cards left the queue before outreach went out (removed or already notified); refresh the expiring-cards queue and retry");
    }
  });
}

/**
 * Order one stored method in the backup chain: lower priority charges
 * earlier once the default has declined hard. The default method itself
 * needs no order — it always charges first.
 */
export async function setMethodFallbackPriority(
  orgId: string,
  methodId: string,
  priority: number,
  actorId: string | null = null,
): Promise<void> {
  if (!Number.isInteger(priority) || priority < 0 || priority > 999) {
    throw new AutopayError(`backup order ${JSON.stringify(priority)} is not a whole number between 0 and 999; fix it on the payment method`);
  }
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const locked = (await db.execute<{ status: string; is_default: boolean }>(sql`
      select status, is_default from customer_payment_methods
       where id = ${methodId} and org_id = ${orgId}
       for update
    `)).rows[0];
    if (!locked) throw new AutopayError("payment method not found");
    if (locked.status !== "active") throw new AutopayError("only an active method can join the backup chain; finish its setup first");
    const flipped = (await db.execute<{ id: string }>(sql`
      update customer_payment_methods
         set fallback_priority = ${priority}, updated_at = now(), updated_by = ${actorId}
       where id = ${methodId} and org_id = ${orgId} and status = 'active'
       returning id
    `));
    if (!flipped.rows[0]) throw new AutopayError("payment method is no longer active; finish its setup first");
    await auditAutopay(orgId, "customer_payment_methods", methodId, {
      event: "fallback_order_changed",
      after: { fallbackPriority: priority, wasDefault: locked.is_default },
      reason: locked.is_default
        ? "The default method always charges first; its backup order applies if it ever stops being the default."
        : "Operator ordered this method in the backup chain.",
    }, actorId);
  });
}

export interface RecoverySliceMetrics {
  failedAttempts: number;
  invoices: number;
  recoveredInvoices: number;
  recoveredAmount: string;
  recoveryRate: number | null;
}

export interface RecoveryMetrics {
  attempts: number;
  invoicesWithFailures: number;
  recoveredInvoices: number;
  recoveredAmount: string;
  recoveryRate: number | null;
  byDeclineClass: (RecoverySliceMetrics & { declineClass: string })[];
  byProvider: (RecoverySliceMetrics & { provider: string })[];
  churnPrevented: number;
  awaitingAuthentication: number;
}

function recoveryRate(recoveredInvoices: number, invoices: number): number | null {
  return invoices === 0 ? null : recoveredInvoices / invoices;
}

/**
 * Recovery facts for a window, read off stored attempts — never sampled or
 * extrapolated. `from` is inclusive, `to` exclusive. A failure counts in the
 * window it happened in; its recovery is a success at a later schedule
 * position, whenever it lands, so crossing recoveries are not lost at the
 * boundary. Positions — not timestamps — carry the causal order, because
 * attempts charged in one tick share the transaction's clock. Involuntary
 * churn prevented counts subscriptions the engine reactivated after a
 * collection succeeded.
 */
export async function getRecoveryMetrics(
  orgId: string,
  window: { from: string; to: string },
): Promise<RecoveryMetrics> {
  return withOrg(orgId, async () => {
    const totals = (await db.execute<{
      attempts: number;
      invoices: number;
      recovered: number;
      amount: string | null;
    }>(sql`
      with failed as (
        select distinct on (a.invoice_id) a.invoice_id, a.retry_position as failed_position
          from collection_attempts a
         where a.org_id = ${orgId} and a.status = 'failed'
           and a.created_at >= ${window.from}::timestamptz and a.created_at < ${window.to}::timestamptz
         order by a.invoice_id, a.retry_position
      ),
      recovered as (
        select distinct on (a.invoice_id) a.invoice_id, a.amount
          from collection_attempts a
          join failed f on f.invoice_id = a.invoice_id
         where a.org_id = ${orgId} and a.status = 'succeeded' and a.retry_position > f.failed_position
         order by a.invoice_id, a.retry_position
      )
      select (select count(*)::integer from collection_attempts
               where org_id = ${orgId}
                 and created_at >= ${window.from}::timestamptz and created_at < ${window.to}::timestamptz) as attempts,
             (select count(*)::integer from failed) as invoices,
             (select count(*)::integer from recovered) as recovered,
             (select coalesce(sum(amount), 0)::text from recovered) as amount
    `)).rows[0];
    if (!totals) throw new AutopayError("recovery metrics could not be read; try again");
    const byClass = (await db.execute<{
      declineClass: string;
      failedAttempts: number;
      invoices: number;
      recovered: number;
      amount: string | null;
    }>(sql`
      with failed as (
        select distinct on (a.invoice_id) a.invoice_id, a.retry_position as failed_position,
               coalesce(a.decline_kind, 'soft') as decline_kind
          from collection_attempts a
         where a.org_id = ${orgId} and a.status = 'failed'
           and a.created_at >= ${window.from}::timestamptz and a.created_at < ${window.to}::timestamptz
         order by a.invoice_id, a.retry_position
      ),
      recovered as (
        select distinct on (a.invoice_id) a.invoice_id, a.amount
          from collection_attempts a
          join failed f on f.invoice_id = a.invoice_id
         where a.org_id = ${orgId} and a.status = 'succeeded' and a.retry_position > f.failed_position
         order by a.invoice_id, a.retry_position
      )
      select f.decline_kind as "declineClass",
             count(*)::integer as "failedAttempts",
             count(distinct f.invoice_id)::integer as invoices,
             count(r.invoice_id)::integer as recovered,
             coalesce(sum(r.amount), 0)::text as amount
        from failed f
        left join recovered r on r.invoice_id = f.invoice_id
       group by f.decline_kind
       order by f.decline_kind
    `)).rows;
    const byProvider = (await db.execute<{
      provider: string;
      failedAttempts: number;
      invoices: number;
      recovered: number;
      amount: string | null;
    }>(sql`
      with failed as (
        select distinct on (a.invoice_id) a.invoice_id, a.retry_position as failed_position, a.provider
          from collection_attempts a
         where a.org_id = ${orgId} and a.status = 'failed'
           and a.created_at >= ${window.from}::timestamptz and a.created_at < ${window.to}::timestamptz
         order by a.invoice_id, a.retry_position
      ),
      recovered as (
        select distinct on (a.invoice_id) a.invoice_id, a.amount
          from collection_attempts a
          join failed f on f.invoice_id = a.invoice_id
         where a.org_id = ${orgId} and a.status = 'succeeded' and a.retry_position > f.failed_position
         order by a.invoice_id, a.retry_position
      )
      select f.provider,
             count(*)::integer as "failedAttempts",
             count(distinct f.invoice_id)::integer as invoices,
             count(r.invoice_id)::integer as recovered,
             coalesce(sum(r.amount), 0)::text as amount
        from failed f
        left join recovered r on r.invoice_id = f.invoice_id
       group by f.provider
       order by f.provider
    `)).rows;
    const churn = (await db.execute<{ n: number }>(sql`
      select count(*)::integer as n from audit_log
       where org_id = ${orgId} and table_name = 'subscriptions'
         and changes ->> 'event' = 'autopay_reactivated'
         and at >= ${window.from}::timestamptz and at < ${window.to}::timestamptz
    `)).rows[0]?.n ?? 0;
    const awaiting = (await db.execute<{ n: number }>(sql`
      select count(*)::integer as n from collection_attempts
       where org_id = ${orgId} and status = 'failed'
         and decline_kind = 'needs_authentication' and next_retry_on is null
    `)).rows[0]?.n ?? 0;
    return {
      attempts: totals.attempts,
      invoicesWithFailures: totals.invoices,
      recoveredInvoices: totals.recovered,
      recoveredAmount: totals.amount ?? "0",
      recoveryRate: recoveryRate(totals.recovered, totals.invoices),
      byDeclineClass: byClass.map((row) => ({
        declineClass: row.declineClass,
        failedAttempts: row.failedAttempts,
        invoices: row.invoices,
        recoveredInvoices: row.recovered,
        recoveredAmount: row.amount ?? "0",
        recoveryRate: recoveryRate(row.recovered, row.invoices),
      })),
      byProvider: byProvider.map((row) => ({
        provider: row.provider,
        failedAttempts: row.failedAttempts,
        invoices: row.invoices,
        recoveredInvoices: row.recovered,
        recoveredAmount: row.amount ?? "0",
        recoveryRate: recoveryRate(row.recovered, row.invoices),
      })),
      churnPrevented: churn,
      awaitingAuthentication: awaiting,
    };
  });
}

// ---------------------------------------------------------------------------
// Receipt (the same receipt path hosted payment links use)
// ---------------------------------------------------------------------------

function attemptReference(attemptId: string): string {
  return `autopay:${attemptId}`;
}

/**
 * Post the customer_payment receipt for a collected attempt: draft with the
 * invoice application, submit through approvals, post with applications.
 * Crash recovery: a receipt already posted under this attempt's reference
 * (the post committed but the attempt update never did) is adopted instead
 * of minting a second receipt for the same collection.
 */
export async function postCollectionReceipt(orgId: string, attemptId: string): Promise<string> {
  const rows = (await db.execute<{
    attempt_id: string;
    invoice_id: string;
    party_id: string;
    subsidiary_id: string | null;
    currency: string;
    amount: string;
    bank_account_id: string | null;
    document_number: string;
    open_balance: string;
    receipt_id: string | null;
  }>(sql`
    select a.id as "attempt_id", d.id as "invoice_id", d.party_id,
           d.subsidiary_id, d.currency, a.amount, c.default_bank_account_id as "bank_account_id",
           d.document_number, d.open_balance, a.receipt_document_id as "receipt_id"
      from collection_attempts a
      join documents d on d.id = a.invoice_id and d.org_id = a.org_id
      join customer_payment_methods m on m.id = a.payment_method_id and m.org_id = a.org_id
      join psp_provider_configs c on c.org_id = a.org_id and c.provider = a.provider
     where a.id = ${attemptId} and a.org_id = ${orgId}
     for update of a
  `)).rows;
  const a = rows[0];
  if (!a) throw new AutopayError("collection attempt not found");
  if (a.receipt_id) {
    const existing = (await db.execute<{ status: string }>(sql`
      select status from documents where id = ${a.receipt_id} and org_id = ${orgId}
    `)).rows[0];
    if (existing?.status === "posted") {
      await db.execute(sql`
        update collection_attempts set status = 'succeeded', updated_at = now()
         where id = ${attemptId} and org_id = ${orgId} and status <> 'succeeded'
      `);
      return a.receipt_id;
    }
  } else {
    // Adopt a receipt the interrupted tick posted but never linked.
    const adopted = (await db.execute<{ id: string }>(sql`
      select id from documents
       where org_id = ${orgId} and kind = 'customer_payment'
         and reference_number = ${attemptReference(attemptId)} and status = 'posted'
       limit 1
    `)).rows[0];
    if (adopted) {
      await db.execute(sql`
        update collection_attempts
           set status = 'succeeded', receipt_document_id = ${adopted.id}, updated_at = now()
         where id = ${attemptId} and org_id = ${orgId}
      `);
      return adopted.id;
    }
  }
  if (!a.bank_account_id) {
    throw new AutopayError("the provider has no default bank account; set one in provider settings so autopay receipts can post");
  }
  const bank = (await db.execute<{ id: string }>(sql`
    select id from accounts
     where org_id = ${orgId} and id = ${a.bank_account_id}
       and type = 'asset_bank' and is_active and not is_summary
     limit 1
  `)).rows[0];
  if (!bank) throw new AutopayError("the provider bank account is not an active bank account; fix it in provider settings first");
  // Autopay collects the invoice amount only — off-session surcharging is
  // restricted, so unlike hosted checkout there is no fee leg.
  const collected = a.amount;
  const openItems = await openItemsForParty(a.party_id, "ar", orgId);
  const item = openItems.find((i) => i.documentId === a.invoice_id);
  const invoicePortion = item ? (cmp(collected, a.open_balance) < 0 ? collected : a.open_balance) : "0";
  if (cmp(invoicePortion, "0") <= 0) {
    throw new AutopayError(`invoice ${a.document_number} no longer owes anything; the collection needs operator review before a receipt can post`);
  }
  const onAccountAmount = fromUnits(toUnits(collected) - toUnits(invoicePortion));
  const allocations = [sameCurrencyAllocation(item!.lineId, invoicePortion)];
  const payment = await createPaymentDocument({
    orgId,
    kind: "customer_payment",
    createdBy: null,
    allowedSubsidiaryIds: null,
    partyId: a.party_id,
    bankAccountId: a.bank_account_id,
    documentDate: await businessToday(orgId),
    memo: `Autopay — ${a.document_number}`,
    subsidiaryId: a.subsidiary_id,
    currency: a.currency,
  });
  await db.execute(sql`
    update collection_attempts set receipt_document_id = ${payment.id}, updated_at = now()
     where id = ${attemptId} and org_id = ${orgId}
  `);
  await updateDraftPayment(
    payment.id,
    {
      allocations,
      referenceNumber: attemptReference(attemptId),
      feeAmount: "0",
      feeIncomeAccountId: null,
      onAccountAmount,
    },
    null,
    orgId,
  );
  const submission = await submitAndReleaseIfUngated("customer_payment", payment.id, null);
  if (submission.flowError) {
    throw new AutopayError(`receipt approval could not be routed: ${submission.flowError}`);
  }
  if (submission.gated) {
    await db.execute(sql`
      update collection_attempts set status = 'processing', updated_at = now()
       where id = ${attemptId} and org_id = ${orgId}
    `);
    return payment.id;
  }
  await postPaymentWithApplications(payment.id, allocations, undefined);
  const closed = (await db.execute<{ id: string }>(sql`
    update collection_attempts
       set status = 'succeeded', updated_at = now()
     where id = ${attemptId} and org_id = ${orgId} and status <> 'succeeded'
     returning id
  `));
  if (!closed.rows[0]) throw new AutopayError("collection attempt changed underfoot; refusing to close over it");
  return payment.id;
}

/**
 * Reconcile in-flight attempts at tick start: a gated receipt that posted
 * since (approval flow posts later) closes its attempt and reactivates.
 */
async function reconcileProcessingAttempts(orgId: string, result: AutopayRunResult): Promise<void> {
  const rows = (await db.execute<{ id: string; invoice_id: string }>(sql`
    select a.id, a.invoice_id
      from collection_attempts a
      join documents payment on payment.id = a.receipt_document_id and payment.org_id = a.org_id
     where a.org_id = ${orgId} and a.status = 'processing'
       and a.receipt_document_id is not null and payment.status = 'posted'
  `)).rows;
  for (const row of rows) {
    await db.execute(sql`
      update collection_attempts set status = 'succeeded', updated_at = now()
       where id = ${row.id} and org_id = ${orgId} and status = 'processing'
    `);
    result.succeeded += 1;
    result.notices.push({ invoiceId: row.invoice_id, attemptId: row.id, status: "succeeded", detail: "approved receipt posted; collection closed" });
  }
}

// ---------------------------------------------------------------------------
// Final action + reactivation
// ---------------------------------------------------------------------------

async function scopeSubscriptionIds(
  orgId: string,
  candidate: Pick<CollectionCandidate, "partyId" | "subscriptionId">,
): Promise<string[]> {
  if (candidate.subscriptionId) return [candidate.subscriptionId];
  return (await db.execute<{ id: string }>(sql`
    select id from subscriptions
     where org_id = ${orgId} and customer_id = ${candidate.partyId} and status = 'active'
  `)).rows.map((r) => r.id);
}

/**
 * Run the policy's final action after the schedule runs out: suspend (stop
 * billing, keep the contract for reactivation) or cancel. Audited per
 * subscription with before/after state. `none` leaves billing untouched.
 */
export async function applyFinalAction(
  orgId: string,
  candidate: Pick<CollectionCandidate, "partyId" | "subscriptionId" | "invoiceId">,
  policy: AutopayPolicy,
  actorId: string | null,
): Promise<{ suspended: number; canceled: number }> {
  const outcome = { suspended: 0, canceled: 0 };
  if (policy.finalAction === "none") return outcome;
  const today = await businessToday(orgId);
  const targets = await scopeSubscriptionIds(orgId, candidate);
  for (const subscriptionId of targets) {
    if (policy.finalAction === "suspend") {
      const flipped = (await db.execute<{ id: string }>(sql`
        update subscriptions set status = 'suspended', updated_at = now(), updated_by = ${actorId}
         where id = ${subscriptionId} and org_id = ${orgId} and status = 'active'
         returning id
      `));
      if (!flipped.rows[0]) continue;
      outcome.suspended += 1;
      await auditAutopay(orgId, "subscriptions", subscriptionId, {
        event: "autopay_suspended",
        before: { status: "active" },
        after: { status: "suspended" },
        reason: `Automatic collection failed every retry under policy "${policy.policyName}"; billing stops until a payment succeeds.`,
      }, actorId);
    } else {
      const flipped = (await db.execute<{ id: string }>(sql`
        update subscriptions set status = 'canceled', canceled_on = ${today}::date,
               updated_at = now(), updated_by = ${actorId}
         where id = ${subscriptionId} and org_id = ${orgId} and status in ('active', 'suspended')
         returning id
      `));
      if (!flipped.rows[0]) continue;
      outcome.canceled += 1;
      await auditAutopay(orgId, "subscriptions", subscriptionId, {
        event: "autopay_canceled",
        after: { status: "canceled" },
        reason: `Automatic collection failed every retry under policy "${policy.policyName}".`,
      }, actorId);
    }
  }
  return outcome;
}

/**
 * Reactivate subscriptions the final action suspended, once money moves
 * again. Only `suspended` flips — `canceled` stays terminal for the operator,
 * and `paused` stays the operator's own control.
 */
export async function reactivateScopeSubscriptions(
  orgId: string,
  candidate: Pick<CollectionCandidate, "partyId" | "subscriptionId">,
  actorId: string | null,
): Promise<number> {
  let count = 0;
  const targets = candidate.subscriptionId
    ? [candidate.subscriptionId]
    : (await db.execute<{ id: string }>(sql`
        select id from subscriptions
         where org_id = ${orgId} and customer_id = ${candidate.partyId} and status = 'suspended'
      `)).rows.map((r) => r.id);
  for (const subscriptionId of targets) {
    const flipped = (await db.execute<{ id: string }>(sql`
      update subscriptions set status = 'active', updated_at = now(), updated_by = ${actorId}
       where id = ${subscriptionId} and org_id = ${orgId} and status = 'suspended'
       returning id
    `));
    if (!flipped.rows[0]) continue;
    count += 1;
    await auditAutopay(orgId, "subscriptions", subscriptionId, {
      event: "autopay_reactivated",
      before: { status: "suspended" },
      after: { status: "active" },
      reason: "A collection succeeded; billing resumes.",
    }, actorId);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Provider webhook handlers (called from acceptance.ts, same module)
// ---------------------------------------------------------------------------

/**
 * Claim a stored-method setup event: resolve the pending row by the client
 * reference (our row id) or by the stored setup id, then complete it. A
 * mandate event naming a mandate nobody started (no pending row) stays
 * unknown — the return-URL verification completes those against the billing
 * request it does know.
 */
export async function recordProviderSetupMethod(
  orgId: string,
  provider: AcceptanceProvider,
  event: WebhookEvent,
): Promise<"setup_stored" | "unknown_setup"> {
  return withOrg(orgId, async () => {
    let methodId: string | null = null;
    // The client reference is our own row id — anything else-shaped is a
    // foreign token and stays unknown rather than throwing a uuid parse.
    if (event.linkToken && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.linkToken)) {
      methodId = (await db.execute<{ id: string }>(sql`
        select id from customer_payment_methods
         where id = ${event.linkToken} and org_id = ${orgId}
           and provider = ${provider} and status = 'pending'
         limit 1
      `)).rows[0]?.id ?? null;
    }
    if (!methodId && event.externalRef) {
      methodId = (await db.execute<{ id: string }>(sql`
        select id from customer_payment_methods
         where provider_method_id = ${event.externalRef} and org_id = ${orgId}
           and provider = ${provider} and status = 'pending'
         limit 1
      `)).rows[0]?.id ?? null;
    }
    if (!methodId) return "unknown_setup";
    await completeMethodSetup(orgId, methodId, null, undefined, event);
    return "setup_stored";
  });
}

/**
 * Settle a provider payment event against a collection attempt (async bank
 * debit arriving days later, or a card result delivered by webhook instead
 * of the synchronous charge call). Returns null when no collection attempt
 * claims the event, so the hosted-checkout path runs as before.
 */
export async function settleCollectionAttemptEvent(
  orgId: string,
  provider: AcceptanceProvider,
  event: WebhookEvent,
): Promise<string | null> {
  return withOrg(orgId, async () => {
    const alternateRef = event.alternateExternalRef ?? null;
    const found = (await db.execute<{
      id: string;
      invoice_id: string;
      status: string;
      party_id: string;
      subscription_id: string | null;
    }>(sql`
      select a.id, a.invoice_id, a.status, e.party_id, e.subscription_id
        from collection_attempts a
        join autopay_enrollments e on e.id = a.enrollment_id and e.org_id = a.org_id
       where a.org_id = ${orgId} and a.provider = ${provider}
         and (a.provider_ref = ${event.externalRef}
              or (${alternateRef}::text is not null and a.provider_ref = ${alternateRef}))
       order by a.created_at desc limit 1
    `)).rows[0];
    if (!found) return null;
    if (event.status === "succeeded") {
      const claimed = (await db.execute<{ id: string }>(sql`
        update collection_attempts set status = 'processing', provider_ref = ${event.externalRef}, updated_at = now()
         where id = ${found.id} and org_id = ${orgId} and status in ('initiated', 'processing')
         returning id
      `));
      if (!claimed.rows[0]) return "duplicate";
      await postCollectionReceipt(orgId, found.id);
      await reactivateScopeSubscriptions(orgId, { partyId: found.party_id, subscriptionId: found.subscription_id }, null);
      return "settled";
    }
    if (event.status === "processing") {
      await db.execute(sql`
        update collection_attempts set status = 'processing', provider_ref = ${event.externalRef}, updated_at = now()
         where id = ${found.id} and org_id = ${orgId} and status = 'initiated'
      `);
      return "processing";
    }
    if (event.status === "failed") {
      // Webhook failures on an already-settled attempt are stale duplicates.
      const current = (await db.execute<{ status: string }>(sql`
        select status from collection_attempts where id = ${found.id} and org_id = ${orgId}
      `)).rows[0];
      if (!current || (current.status !== "initiated" && current.status !== "processing")) return "duplicate";
      const policy = await resolveAutopayPolicy(orgId);
      const today = await businessToday(orgId);
      const position = (await db.execute<{ retry_position: number }>(sql`
        select retry_position from collection_attempts where id = ${found.id} and org_id = ${orgId}
      `)).rows[0]?.retry_position ?? 0;
      const candidate = {
        invoiceId: found.invoice_id,
        partyId: found.party_id,
        subscriptionId: found.subscription_id,
      };
      const kind = classifyDecline((event.raw as Record<string, unknown> | undefined)?.declineCode as string | null) ?? "soft";
      const ladder = retryLadderForClass(policy, kind);
      if (position < ladder.length) {
        const nextRetryOn = addCalendarDays(today, ladder[position]!);
        await db.execute(sql`
          update collection_attempts
             set status = 'failed', decline_code = 'provider_reported', decline_kind = ${kind},
                 next_retry_on = ${nextRetryOn}::date, provider_ref = ${event.externalRef}, updated_at = now()
           where id = ${found.id} and org_id = ${orgId}
        `);
        return "failed_retry_scheduled";
      }
      await db.execute(sql`
        update collection_attempts
           set status = 'failed', decline_code = 'provider_reported', decline_kind = ${kind},
               next_retry_on = null, provider_ref = ${event.externalRef}, updated_at = now()
         where id = ${found.id} and org_id = ${orgId}
      `);
      await applyFinalAction(orgId, candidate, policy, null);
      return "failed_terminal";
    }
    if (event.status === "refunded" || event.status === "disputed") {
      // A chargeback parks a marker so the scan refuses the invoice until
      // finance reviews; a voluntary refund only needs the controller note.
      // Disputed events always carry the dispute flag, so they take the
      // chargeback arm with the provider dispute id attached.
      if (event.dispute && event.intentRef) {
        await db.execute(sql`
          insert into payment_pending_clawbacks
            (org_id, provider, intent_ref, event_status, event_payload, last_seen_at)
          values (${orgId}, ${provider}, ${event.intentRef}, 'refunded',
                  ${JSON.stringify({ externalRef: event.externalRef, collectionAttemptId: found.id })}::jsonb, now())
          on conflict (org_id, provider, intent_ref)
          do update set event_status = excluded.event_status,
            event_payload = excluded.event_payload,
            last_seen_at = now()
        `);
      }
      await auditAutopay(orgId, "collection_attempts", found.id, {
        event: event.dispute ? "dispute_reported" : "refund_reported",
        reason: event.dispute
          ? "Provider reported a chargeback against this collection; reverse the receipt via payments if funds were clawed back."
          : "Provider reported a refund against this collection; the invoice balance already reflects it.",
      }, null);
      return "refunded_noted";
    }
    return null;
  });
}



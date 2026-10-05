import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "../platform/db.ts";
import { addCalendarDays, businessToday } from "../platform/business-date.ts";
import { cmp, fromUnits, toUnits } from "../money/money.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import {
  ACCEPTANCE_ADAPTERS,
  configSecrets,
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

/**
 * Provider decline codes that must never retry: the instrument is gone
 * (stolen/lost card, closed account) or the mandate is dead, so another
 * charge can only fail the same way. Everything unrecognized retries as
 * soft — a new code fails open toward collection, and the schedule bounds
 * the attempts.
 */
const HARD_DECLINE_CODES: ReadonlySet<string> = new Set([
  // Stripe card errors that never clear on retry.
  "lost_card",
  "stolen_card",
  "card_closed",
  "account_closed",
  "invalid_account",
  "revocation_of_authorization",
  "fraudulent",
  // GoCardless bank-debit terminal states.
  "closed_account",
  "invalid_account_holder_name",
  "invalid_bank_account",
  "direct_debit_not_enabled",
  "mandate_cancelled",
  "mandate_expired",
  "mandate_failed",
  "cancelled",
  // Adyen refusal reasons that never clear on retry.
  "CancelOrRefund",
  "Blocked Card",
  "Stolen Card",
  "Lost Card",
  "Invalid Card Number",
  "Invalid Account",
  "Closed Account",
  "No Account",
  "Referral",
  "Fraud",
  // Autopay's own terminal markers (missing linkage, not a provider retry).
  "missing_shopper_reference",
]);

/** Classify a provider decline code, or null when nothing declined. Pure. */
export function classifyDecline(declineCode: string | null | undefined): "hard" | "soft" | null {
  if (declineCode == null || declineCode === "") return null;
  return HARD_DECLINE_CODES.has(declineCode) ? "hard" : "soft";
}

// ---------------------------------------------------------------------------
// Retry schedule + policy resolution (pure validation, policy read)
// ---------------------------------------------------------------------------

export type AutopayFinalAction = "none" | "suspend" | "cancel";

export interface AutopayPolicy {
  policyId: string;
  policyName: string;
  retryOffsetsDays: number[];
  finalAction: AutopayFinalAction;
  gracePeriodDays: number;
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
    finalAction: unknown;
    gracePeriodDays: number;
  }>(sql`
    select id as "policyId", name as "policyName",
           autopay_retry_offsets_days as "retryOffsets",
           autopay_final_action as "finalAction",
           grace_period_days as "gracePeriodDays"
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
    finalAction: parseFinalAction(policy.finalAction),
    gracePeriodDays: policy.gracePeriodDays,
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
  input: { partyId: string; provider: AcceptanceProvider; currency: string; returnUrl: string; actorId?: string | null },
  fetchFn?: FetchFn,
): Promise<{ methodId: string; redirectUrl: string }> {
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
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into customer_payment_methods (org_id, party_id, provider, status, created_by, updated_by)
      values (${orgId}, ${input.partyId}, ${input.provider}, 'pending', ${input.actorId ?? null}, ${input.actorId ?? null})
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
    return { methodId, redirectUrl: session.redirectUrl };
  });
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
    const fetch = fetchFn ?? ((url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: "error" }) => fetch(url, init));
    const detail = await readCompletedSetup(provider, String(locked.provider_method_id ?? ""), secrets, fetch, setupEvent);
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
  input: { policyId: string; retryOffsetsDays: unknown; finalAction: unknown; actorId?: string | null },
): Promise<AutopayPolicy> {
  const offsets = parseRetryOffsetsDays(input.retryOffsetsDays);
  const finalAction = parseFinalAction(input.finalAction);
  const offsetsList = offsets.length > 0
    ? sql`ARRAY[${sql.join(offsets.map((offset) => sql`${offset}`), sql`, `)}]`
    : sql`'{}'::integer[]`;
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const updated = (await db.execute<{ id: string; name: string; grace_period_days: number }>(sql`
      update dunning_policies
         set autopay_retry_offsets_days = ${offsetsList},
             autopay_final_action = ${finalAction},
             updated_at = now(), updated_by = ${input.actorId ?? null}
       where id = ${input.policyId} and org_id = ${orgId}
       returning id, name, grace_period_days as "grace_period_days"
    `));
    const row = updated.rows[0];
    if (!row) throw new AutopayError("collection policy not found");
    await auditAutopay(orgId, "dunning_policies", row.id, {
      event: "autopay_policy_saved",
      after: { retryOffsetsDays: offsets, finalAction },
      reason: "Operator changed the autopay retry schedule or final action.",
    }, input.actorId ?? null);
    return { policyId: row.id, policyName: row.name, retryOffsetsDays: offsets, finalAction, gracePeriodDays: row.grace_period_days };
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
       where a.org_id = ${orgId} and a.status = 'failed' and a.decline_kind = 'soft'
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

interface CollectionCandidate {
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
}

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
  // Idempotent per (invoice, schedule position): a concurrent tick that won
  // the race owns the charge, so this tick stands down. The conflict is
  // expected under concurrency and benign — exactly one attempt charges.
  const attempt = (await db.execute<{ id: string }>(sql`
    insert into collection_attempts
      (org_id, invoice_id, enrollment_id, payment_method_id, amount, currency,
       provider, status, retry_position, created_by, updated_by)
    values (${orgId}, ${candidate.invoiceId}, ${candidate.enrollmentId}, ${candidate.methodId},
            ${amount}, ${invoice.currency}, ${candidate.provider}, 'initiated', ${position}, null, null)
    on conflict (org_id, invoice_id, retry_position) do nothing
    returning id
  `));
  const attemptId = attempt.rows[0]?.id;
  if (!attemptId) {
    result.skipped += 1;
    result.notices.push({ invoiceId: candidate.invoiceId, attemptId: null, status: "skipped", detail: "another tick is already collecting this position" });
    return;
  }
  result.charged += 1;
  const outcome = await charge(candidate.provider, {
    providerCustomerId: candidate.providerCustomerId,
    providerMethodId: candidate.providerMethodId!,
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
    result.notices.push({ invoiceId: candidate.invoiceId, attemptId, status: "succeeded", detail: `collected ${amount} ${invoice.currency}` });
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
  await recordDecline(orgId, candidate, attemptId, position, today, policy, outcome.declineCode ?? null, result);
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
): Promise<void> {
  const kind = classifyDecline(declineCode) ?? "soft";
  if (kind === "soft" && position < policy.retryOffsetsDays.length) {
    const nextRetryOn = addCalendarDays(today, policy.retryOffsetsDays[position]!);
    const updated = (await db.execute<{ id: string }>(sql`
      update collection_attempts
         set status = 'failed', decline_code = ${declineCode}, decline_kind = 'soft',
             next_retry_on = ${nextRetryOn}::date, updated_at = now()
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
      detail: `declined${declineCode ? ` (${declineCode})` : ""}; retrying ${nextRetryOn}`,
    });
    return;
  }
  const updated = (await db.execute<{ id: string }>(sql`
    update collection_attempts
       set status = 'failed', decline_code = ${declineCode}, decline_kind = ${kind},
           next_retry_on = null, updated_at = now()
     where id = ${attemptId} and org_id = ${orgId} and status = 'initiated'
     returning id
  `));
  if (!updated.rows[0]) throw new AutopayError("collection attempt changed underfoot; refusing to record over it");
  result.failed += 1;
  result.notices.push({
    invoiceId: candidate.invoiceId,
    attemptId,
    status: "failed",
    detail: kind === "hard"
      ? `declined (${declineCode ?? "unknown reason"}) — no retry; update the payment method`
      : `final retry declined${declineCode ? ` (${declineCode})` : ""}`,
  });
  if (position >= policy.retryOffsetsDays.length || kind === "hard") {
    const acted = await applyFinalAction(orgId, candidate, policy, null);
    result.suspended += acted.suspended;
    result.canceled += acted.canceled;
  }
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
  await postPaymentWithApplications(payment.id, allocations, null);
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
      if (kind === "soft" && position < policy.retryOffsetsDays.length) {
        const nextRetryOn = addCalendarDays(today, policy.retryOffsetsDays[position]!);
        await db.execute(sql`
          update collection_attempts
             set status = 'failed', decline_code = 'provider_reported', decline_kind = 'soft',
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



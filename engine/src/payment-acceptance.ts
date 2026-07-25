import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "./db.ts";
import { add, cmp, fromUnits, mulPercent, toUnits } from "./money.ts";
import { sealJson, unsealJson } from "./secrets.ts";
import {
  createPaymentDocument,
  openItemsForParty,
  postPaymentWithApplications,
  sameCurrencyAllocation,
  updateDraftPayment,
  type AllocationInput,
} from "./payments.ts";

/**
 * Customer payment acceptance — hosted checkout links on posted invoices.
 *
 * One provider framework (Stripe / Adyen / GoCardless ACH-debit) behind the
 * same `psp_provider_configs` row the settlement importer uses: acceptance
 * brings the money in (this module), settlement import reconciles the payout
 * and fees (psp-settlement.ts). Secrets are AES-256-GCM sealed; webhooks are
 * HMAC-verified per provider before any org context is resolved; processing
 * is idempotent on (org, provider, external_ref).
 *
 * The receipt itself rides the standard open-item engine: a customer_payment
 * document auto-applied to the invoice, with the surcharge as a fee-income
 * leg (see the customer_payment posting rule).
 */

export type AcceptanceProvider = "stripe" | "adyen" | "gocardless";

export class PaymentAcceptanceError extends Error {}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

export interface ProviderSecrets {
  apiKey?: string;
  webhookSecret?: string;
  publishableKey?: string;
  /** Adyen: merchant account code. GoCardless: creditor id (optional). */
  merchantAccount?: string;
  /** Adyen: base URL override (defaults to checkout-test; set live URL in prod). */
  apiBase?: string;
}

export interface CheckoutRequest {
  linkToken: string;
  description: string;
  /** Major-unit money strings, exact 4dp. */
  invoiceAmount: string;
  surchargeAmount: string;
  currency: string;
  /** Absolute URL the provider returns the customer to (our /pay/{token} page). */
  returnUrl: string;
}

export interface CheckoutSession {
  redirectUrl: string;
  externalRef: string;
}

export interface WebhookEvent {
  /** Provider object id (session / pspReference / payment id). */
  externalRef: string;
  /** Some providers key events by our reference instead of their object id. */
  linkToken?: string | null;
  status: "succeeded" | "failed" | "cancelled" | "refunded";
  paidAmount?: string | null;
  raw: Record<string, unknown>;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: () => Promise<any> }>;

const defaultFetch: FetchFn = (url, init) => fetch(url, init);

/** Currencies with no minor unit (provider amount = major units as-is). */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

/** Major-unit money string → provider minor units (exact; rejects sub-minor precision). */
export function toMinorUnits(amount: string, currency: string): string {
  const units = toUnits(amount); // 1e4 scale
  if (ZERO_DECIMAL.has(currency.toUpperCase())) {
    if (units % 10_000n !== 0n) throw new PaymentAcceptanceError(`${currency} amounts must be whole units`);
    return (units / 10_000n).toString();
  }
  if (units % 100n !== 0n) throw new PaymentAcceptanceError(`amount ${amount} has sub-cent precision`);
  return (units / 100n).toString();
}

function hmacSha256Hex(secret: string | Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface PaymentProviderAdapter {
  key: AcceptanceProvider;
  createCheckout(secrets: ProviderSecrets, req: CheckoutRequest, fetchFn?: FetchFn): Promise<CheckoutSession>;
  /** Verify the provider signature and normalize the event; null = invalid signature. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, secrets: ProviderSecrets): WebhookEvent | null;
}

// --- Stripe ---------------------------------------------------------------

const stripeAdapter: PaymentProviderAdapter = {
  key: "stripe",
  async createCheckout(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("stripe secret key is not configured");
    const total = add(req.invoiceAmount, req.surchargeAmount);
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("success_url", `${req.returnUrl}?checkout=success`);
    params.set("cancel_url", req.returnUrl);
    params.set("client_reference_id", req.linkToken);
    params.set("metadata[link_token]", req.linkToken);
    params.set("payment_intent_data[metadata][link_token]", req.linkToken);
    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", req.currency.toLowerCase());
    params.set("line_items[0][price_data][unit_amount]", toMinorUnits(total, req.currency));
    params.set("line_items[0][price_data][product_data][name]", req.description.slice(0, 250));
    const res = await fetchFn("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${secrets.apiKey}:`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const json = await res.json();
    if (res.status >= 400) throw new PaymentAcceptanceError(`stripe checkout failed: ${json?.error?.message ?? res.status}`);
    if (!json?.id || !json?.url) throw new PaymentAcceptanceError("stripe checkout returned no session url");
    return { redirectUrl: json.url, externalRef: json.id };
  },
  verifyWebhook(headers, rawBody, secrets) {
    if (!secrets.webhookSecret) return null;
    const sigHeader = headers["stripe-signature"];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!sig) return null;
    const parts = Object.fromEntries(sig.split(",").map((kv) => kv.split("=", 2) as [string, string]));
    if (!parts.t || !parts.v1) return null;
    const expected = hmacSha256Hex(secrets.webhookSecret, `${parts.t}.${rawBody}`);
    if (!safeEqual(expected, parts.v1)) return null;
    // Replay window: reject events older than 5 minutes (Stripe guidance).
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return null;
    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const obj = event?.data?.object ?? {};
    if (event?.type === "checkout.session.completed") {
      return {
        externalRef: String(obj.id ?? ""),
        linkToken: obj.client_reference_id ?? obj.metadata?.link_token ?? null,
        status: "succeeded",
        paidAmount: obj.amount_total != null ? fromUnits(BigInt(obj.amount_total) * 100n) : null,
        raw: event,
      };
    }
    if (event?.type === "checkout.session.expired") {
      return { externalRef: String(obj.id ?? ""), linkToken: obj.client_reference_id ?? null, status: "cancelled", raw: event };
    }
    if (event?.type === "charge.refunded") {
      return { externalRef: String(obj.payment_intent ?? obj.id ?? ""), status: "refunded", raw: event };
    }
    return null;
  },
};

// --- Adyen ----------------------------------------------------------------

const adyenAdapter: PaymentProviderAdapter = {
  key: "adyen",
  async createCheckout(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("adyen API key is not configured");
    if (!secrets.merchantAccount) throw new PaymentAcceptanceError("adyen merchant account is not configured");
    const total = add(req.invoiceAmount, req.surchargeAmount);
    const base = secrets.apiBase ?? "https://checkout-test.adyen.com/v71";
    const res = await fetchFn(`${base}/sessions`, {
      method: "POST",
      headers: { "x-api-key": secrets.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        merchantAccount: secrets.merchantAccount,
        reference: req.linkToken,
        amount: { currency: req.currency.toUpperCase(), value: Number(toMinorUnits(total, req.currency)) },
        returnUrl: req.returnUrl,
        description: req.description.slice(0, 250),
        mode: "hosted",
      }),
    });
    const json = await res.json();
    if (res.status >= 400) throw new PaymentAcceptanceError(`adyen session failed: ${json?.message ?? res.status}`);
    if (!json?.id || !json?.url) throw new PaymentAcceptanceError("adyen returned no session url");
    return { redirectUrl: json.url, externalRef: json.id };
  },
  verifyWebhook(headers, rawBody, secrets) {
    if (!secrets.webhookSecret) return null; // webhookSecret = base64 HMAC key
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const item = payload?.notificationItems?.[0]?.NotificationRequestItem;
    if (!item) return null;
    // Adyen signs the concatenation of these fields with HMAC-SHA256 → base64.
    const message = [
      item.pspReference ?? "",
      item.originalReference ?? "",
      item.merchantAccountCode ?? "",
      item.merchantReference ?? "",
      item.amount?.value ?? "",
      item.amount?.currency ?? "",
      item.eventCode ?? "",
      item.success ?? "",
    ].join(":");
    const keyBytes = Buffer.from(secrets.webhookSecret, "base64");
    const expected = createHmac("sha256", keyBytes).update(message, "utf8").digest("base64");
    const provided = item.additionalData?.["metadata.hmacSignature"] ?? item.additionalData?.hmacSignature;
    if (!provided || !safeEqual(expected, String(provided))) return null;
    if (item.eventCode === "AUTHORISATION" && item.success === "true") {
      return {
        externalRef: String(item.pspReference ?? ""),
        linkToken: item.merchantReference ?? null,
        status: "succeeded",
        paidAmount: item.amount?.value != null ? fromUnits(BigInt(item.amount.value) * 100n) : null,
        raw: payload,
      };
    }
    if (item.eventCode === "AUTHORISATION" && item.success !== "true") {
      return { externalRef: String(item.pspReference ?? ""), linkToken: item.merchantReference ?? null, status: "failed", raw: payload };
    }
    if (item.eventCode === "CANCELLATION" || item.eventCode === "CANCEL_OR_REFUND") {
      return { externalRef: String(item.pspReference ?? ""), linkToken: item.merchantReference ?? null, status: "refunded", raw: payload };
    }
    return null;
  },
};

// --- GoCardless (bank debit / ACH) -----------------------------------------

const gocardlessAdapter: PaymentProviderAdapter = {
  key: "gocardless",
  async createCheckout(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("gocardless access token is not configured");
    const total = add(req.invoiceAmount, req.surchargeAmount);
    const base = secrets.apiBase ?? "https://api-sandbox.gocardless.com";
    // Billing request → payment → billing request flow (hosted pages).
    const brRes = await fetchFn(`${base}/billing_requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${secrets.apiKey}`, "content-type": "application/json", "GoCardless-Version": "2015-07-06" },
      body: JSON.stringify({
        billing_requests: {
          payment_request: {
            amount: toMinorUnits(total, req.currency),
            currency: req.currency.toUpperCase(),
            description: req.description.slice(0, 250),
            reference: req.linkToken,
          },
        },
      }),
    });
    const br = await brRes.json();
    const brId = br?.billing_requests?.id;
    if (brRes.status >= 400 || !brId) throw new PaymentAcceptanceError(`gocardless billing request failed: ${br?.error?.message ?? brRes.status}`);
    const flowRes = await fetchFn(`${base}/billing_request_flows`, {
      method: "POST",
      headers: { authorization: `Bearer ${secrets.apiKey}`, "content-type": "application/json", "GoCardless-Version": "2015-07-06" },
      body: JSON.stringify({
        billing_request_flows: {
          redirect_uri: req.returnUrl,
          exit_uri: req.returnUrl,
          links: { billing_request: brId },
        },
      }),
    });
    const flow = await flowRes.json();
    const url = flow?.billing_request_flows?.authorisation_url;
    if (flowRes.status >= 400 || !url) throw new PaymentAcceptanceError(`gocardless flow failed: ${flow?.error?.message ?? flowRes.status}`);
    return { redirectUrl: url, externalRef: brId };
  },
  verifyWebhook(headers, rawBody, secrets) {
    if (!secrets.webhookSecret) return null;
    const sigHeader = headers["webhook-signature"];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!sig) return null;
    const expected = hmacSha256Hex(secrets.webhookSecret, rawBody);
    if (!safeEqual(expected, sig)) return null;
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const event = payload?.events?.[0];
    if (!event) return null;
    const brId = event.links?.billing_request ?? null;
    const paymentId = event.links?.payment ?? event.links?.billing_request ?? "";
    if (event.resource_type === "payments" && (event.action === "confirmed" || event.action === "paid_out")) {
      return { externalRef: String(paymentId), linkToken: null, status: "succeeded", raw: payload };
    }
    if (event.resource_type === "payments" && (event.action === "failed" || event.action === "charged_back")) {
      return { externalRef: String(paymentId), linkToken: null, status: event.action === "failed" ? "failed" : "refunded", raw: payload };
    }
    if (event.resource_type === "billing_requests" && event.action === "cancelled") {
      return { externalRef: String(brId ?? paymentId), linkToken: null, status: "cancelled", raw: payload };
    }
    return null;
  },
};

export const ACCEPTANCE_ADAPTERS: Record<AcceptanceProvider, PaymentProviderAdapter> = {
  stripe: stripeAdapter,
  adyen: adyenAdapter,
  gocardless: gocardlessAdapter,
};

// ---------------------------------------------------------------------------
// Config + surcharge resolution
// ---------------------------------------------------------------------------

interface ProviderConfigRow {
  id: string;
  provider: string;
  display_name: string;
  is_enabled: boolean;
  acceptance_enabled: boolean;
  default_bank_account_id: string | null;
  publishable_key: string | null;
  settings: Record<string, unknown>;
  surcharge_rule_id: string | null;
  secrets: string | null;
}

async function loadProviderConfig(orgId: string, provider: AcceptanceProvider): Promise<ProviderConfigRow | null> {
  const r = (await db.execute(sql`
    select id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id,
           publishable_key, settings, surcharge_rule_id, secrets
      from psp_provider_configs
     where org_id = ${orgId} and provider = ${provider}
     limit 1
  `)) as unknown as { rows: ProviderConfigRow[] };
  return r.rows[0] ?? null;
}

export function configSecrets(config: ProviderConfigRow): ProviderSecrets {
  const sealed = unsealJson<{ apiKey?: string; webhookSecret?: string }>(config.secrets);
  return {
    apiKey: sealed?.apiKey,
    webhookSecret: sealed?.webhookSecret,
    publishableKey: config.publishable_key ?? undefined,
    merchantAccount: typeof config.settings?.merchantAccount === "string" ? config.settings.merchantAccount : undefined,
    apiBase: typeof config.settings?.apiBase === "string" ? config.settings.apiBase : undefined,
  };
}

export interface SurchargeResolution {
  amount: string;
  ruleId: string | null;
  feeIncomeAccountId: string | null;
}

/** Pure surcharge math: percent / fixed / percent+fixed, optional cap. */
export function computeSurcharge(
  baseAmount: string,
  rule: { calculation: string; percent: string | null; fixed_amount: string | null; cap_amount: string | null },
): string {
  let fee = "0";
  if (rule.calculation === "percent" || rule.calculation === "percent_plus_fixed") {
    fee = add(fee, mulPercent(baseAmount, rule.percent ?? "0", 4));
  }
  if (rule.calculation === "fixed" || rule.calculation === "percent_plus_fixed") {
    fee = add(fee, rule.fixed_amount ?? "0");
  }
  if (rule.cap_amount && cmp(fee, rule.cap_amount) > 0) fee = rule.cap_amount;
  return fee;
}

/** Effective-dated surcharge resolution: the provider-configured rule first,
 *  else the most specific active rule covering the date/provider. */
export async function resolveSurcharge(
  orgId: string,
  opts: { provider: AcceptanceProvider; amount: string; onDate: string; configuredRuleId?: string | null },
): Promise<SurchargeResolution> {
  const r = (await db.execute(sql`
    select id, calculation, percent, fixed_amount, cap_amount, fee_income_account_id
      from payment_surcharge_rules
     where org_id = ${orgId} and is_active
       and effective_from <= ${opts.onDate}
       and (effective_to is null or effective_to >= ${opts.onDate})
       and (provider is null or provider = ${opts.provider})
     order by case when ${opts.configuredRuleId ?? null}::uuid is not null and id = ${opts.configuredRuleId ?? null}::uuid then 0
                   when provider = ${opts.provider} then 1 else 2 end,
              effective_from desc
     limit 1
  `)) as unknown as {
    rows: { id: string; calculation: string; percent: string | null; fixed_amount: string | null; cap_amount: string | null; fee_income_account_id: string }[];
  };
  const rule = r.rows[0];
  if (!rule) return { amount: "0", ruleId: null, feeIncomeAccountId: null };
  return { amount: computeSurcharge(opts.amount, rule), ruleId: rule.id, feeIncomeAccountId: rule.fee_income_account_id };
}

// ---------------------------------------------------------------------------
// Payment links
// ---------------------------------------------------------------------------

export interface PaymentLinkView {
  id: string;
  token: string;
  documentId: string;
  provider: AcceptanceProvider;
  amount: string;
  surchargeAmount: string;
  currency: string;
  status: string;
  expiresOn: string | null;
  memo: string | null;
  paidPaymentDocumentId: string | null;
  createdAt: string;
}

export async function listPaymentLinks(orgId: string, documentId: string): Promise<PaymentLinkView[]> {
  const r = (await db.execute(sql`
    select id, token, document_id as "documentId", provider, amount, surcharge_amount as "surchargeAmount",
           currency, status, expires_on::text as "expiresOn", memo,
           paid_payment_document_id as "paidPaymentDocumentId", created_at as "createdAt"
      from payment_links
     where org_id = ${orgId} and document_id = ${documentId}
     order by created_at desc
  `)) as unknown as { rows: PaymentLinkView[] };
  return r.rows;
}

export async function createPaymentLink(
  orgId: string,
  actorId: string,
  input: { documentId: string; provider: AcceptanceProvider; bankAccountId?: string | null; expiresOn?: string | null; memo?: string | null },
): Promise<PaymentLinkView> {
  return await withOrg(orgId, async () => {
    const docs = (await db.execute(sql`
      select id, kind, status, party_id, subsidiary_id, currency, document_number, open_balance
        from documents where id = ${input.documentId} and org_id = ${orgId}
    `)) as unknown as {
      rows: { id: string; kind: string; status: string; party_id: string | null; subsidiary_id: string; currency: string; document_number: string; open_balance: string }[];
    };
    const doc = docs.rows[0];
    if (!doc) throw new PaymentAcceptanceError("invoice not found");
    if (doc.kind !== "customer_invoice") throw new PaymentAcceptanceError("payment links attach to customer invoices");
    if (doc.status !== "posted") throw new PaymentAcceptanceError("invoice is not posted");
    if (!doc.party_id) throw new PaymentAcceptanceError("invoice has no customer");
    if (cmp(doc.open_balance, "0.005") <= 0) throw new PaymentAcceptanceError("invoice has no open balance");

    const config = await loadProviderConfig(orgId, input.provider);
    if (!config?.is_enabled || !config.acceptance_enabled) {
      throw new PaymentAcceptanceError(`${input.provider} payment acceptance is not configured`);
    }
    const bankAccountId = input.bankAccountId ?? config.default_bank_account_id;
    if (!bankAccountId) throw new PaymentAcceptanceError("no receipt bank account configured for this provider");

    const surcharge = await resolveSurcharge(orgId, {
      provider: input.provider,
      amount: doc.open_balance,
      onDate: new Date().toISOString().slice(0, 10),
      configuredRuleId: config.surcharge_rule_id,
    });

    const token = randomBytes(24).toString("base64url");
    const id = (await db.execute(sql`
      insert into payment_links
        (org_id, token, document_id, party_id, subsidiary_id, provider, bank_account_id,
         amount, surcharge_amount, currency, status, expires_on, memo, created_by, updated_by)
      values (${orgId}, ${token}, ${doc.id}, ${doc.party_id}, ${doc.subsidiary_id}, ${input.provider}, ${bankAccountId},
              ${doc.open_balance}, ${surcharge.amount}, ${doc.currency}, 'active', ${input.expiresOn ?? null},
              ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id
    `)) as unknown as { rows: { id: string }[] };
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_links', ${id.rows[0].id}, 'insert',
              ${JSON.stringify({ after: { documentId: doc.id, documentNumber: doc.document_number, provider: input.provider, amount: doc.open_balance, surcharge: surcharge.amount } })}::jsonb,
              ${actorId})
    `);
    const links = await listPaymentLinks(orgId, doc.id);
    return links.find((l) => l.id === id.rows[0].id)!;
  });
}

export async function voidPaymentLink(orgId: string, actorId: string, linkId: string): Promise<void> {
  await withOrg(orgId, async () => {
    const r = (await db.execute(sql`
      update payment_links set status = 'void', updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${linkId} and status = 'active'
       returning id
    `)) as unknown as { rows: { id: string }[] };
    if (!r.rows[0]) throw new PaymentAcceptanceError("payment link not found or not active");
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_links', ${linkId}, 'void', ${JSON.stringify({ before: { status: "active" }, after: { status: "void" } })}::jsonb, ${actorId})
    `);
  });
}

// ---------------------------------------------------------------------------
// Public checkout flow (token-authenticated, no session)
// ---------------------------------------------------------------------------

interface LinkWithContext {
  id: string;
  orgId: string;
  token: string;
  documentId: string;
  partyId: string;
  subsidiaryId: string;
  provider: AcceptanceProvider;
  bankAccountId: string;
  currency: string;
  status: string;
  expiresOn: string | null;
}

async function loadLinkByToken(token: string): Promise<LinkWithContext | null> {
  // Token lookup must span orgs (public surface); all subsequent work is
  // org-scoped via withOrg once the token resolves.
  const r = await withBypassContext(async () =>
    db.execute(sql`
      select id, org_id as "orgId", token, document_id as "documentId", party_id as "partyId",
             subsidiary_id as "subsidiaryId", provider, bank_account_id as "bankAccountId",
             currency, status, expires_on::text as "expiresOn"
        from payment_links where token = ${token} limit 1
    `)) as unknown as { rows: LinkWithContext[] };
  return r.rows[0] ?? null;
}

export interface PublicPaymentPage {
  orgName: string;
  documentNumber: string;
  partyName: string;
  invoiceAmount: string;
  surchargeAmount: string;
  totalAmount: string;
  currency: string;
  status: string;
  provider: AcceptanceProvider;
  publishableKey: string | null;
}

/** Load the public, token-scoped view of a payment link (amounts re-derived). */
export async function publicPaymentPage(token: string): Promise<PublicPaymentPage | null> {
  const link = await loadLinkByToken(token);
  if (!link) return null;
  if (link.status !== "active") return null;
  return await withOrg(link.orgId, async () => {
    if (link.expiresOn && link.expiresOn < new Date().toISOString().slice(0, 10)) {
      await db.execute(sql`update payment_links set status = 'expired', updated_at = now() where id = ${link.id} and status = 'active'`);
      return null;
    }
    const ctx = (await db.execute(sql`
      select o.name as "orgName", d.document_number as "documentNumber", p.name as "partyName",
             d.open_balance as "openBalance"
        from orgs o, documents d, parties p
       where o.id = ${link.orgId} and d.id = ${link.documentId} and d.org_id = ${link.orgId}
         and p.id = ${link.partyId} and p.org_id = ${link.orgId}
    `)) as unknown as { rows: { orgName: string; documentNumber: string; partyName: string; openBalance: string }[] };
    const row = ctx.rows[0];
    if (!row) return null;
    const config = await loadProviderConfig(link.orgId, link.provider);
    const surcharge = await resolveSurcharge(link.orgId, {
      provider: link.provider,
      amount: row.openBalance,
      onDate: new Date().toISOString().slice(0, 10),
      configuredRuleId: config?.surcharge_rule_id ?? null,
    });
    return {
      orgName: row.orgName,
      documentNumber: row.documentNumber,
      partyName: row.partyName,
      invoiceAmount: row.openBalance,
      surchargeAmount: surcharge.amount,
      totalAmount: add(row.openBalance, surcharge.amount),
      currency: link.currency,
      status: cmp(row.openBalance, "0.005") <= 0 ? "paid" : "active",
      provider: link.provider,
      publishableKey: config?.publishable_key ?? null,
    };
  });
}

/** Create (or reuse an open) provider checkout session for a link. */
export async function createCheckoutSession(
  token: string,
  returnUrl: string,
  fetchFn?: FetchFn,
): Promise<{ redirectUrl: string }> {
  const link = await loadLinkByToken(token);
  if (!link) throw new PaymentAcceptanceError("payment link not found");
  if (link.status !== "active") throw new PaymentAcceptanceError(`payment link is ${link.status}`);
  return await withOrg(link.orgId, async () => {
    const doc = (await db.execute(sql`
      select document_number, open_balance from documents where id = ${link.documentId} and org_id = ${link.orgId}
    `)) as unknown as { rows: { document_number: string; open_balance: string }[] };
    if (!doc.rows[0]) throw new PaymentAcceptanceError("invoice not found");
    const openBalance = doc.rows[0].open_balance;
    if (cmp(openBalance, "0.005") <= 0) throw new PaymentAcceptanceError("invoice is already paid");

    const config = await loadProviderConfig(link.orgId, link.provider);
    if (!config?.is_enabled || !config.acceptance_enabled) throw new PaymentAcceptanceError("provider is not configured");
    const surcharge = await resolveSurcharge(link.orgId, {
      provider: link.provider,
      amount: openBalance,
      onDate: new Date().toISOString().slice(0, 10),
      configuredRuleId: config.surcharge_rule_id,
    });

    // Reuse a live initiated attempt (same provider object) when amounts match.
    const existing = (await db.execute(sql`
      select id, external_ref, event_payload from payment_attempts
       where org_id = ${link.orgId} and link_id = ${link.id} and provider = ${link.provider} and status = 'initiated'
       order by created_at desc limit 1
    `)) as unknown as { rows: { id: string; external_ref: string; event_payload: { redirectUrl?: string; invoiceAmount?: string; surchargeAmount?: string } | null }[] };
    const open = existing.rows[0];
    if (open?.event_payload?.redirectUrl && open.event_payload.invoiceAmount === openBalance && open.event_payload.surchargeAmount === surcharge.amount) {
      return { redirectUrl: open.event_payload.redirectUrl };
    }

    const adapter = ACCEPTANCE_ADAPTERS[link.provider];
    const session = await adapter.createCheckout(
      configSecrets(config),
      {
        linkToken: link.token,
        description: `Invoice ${doc.rows[0].document_number}`,
        invoiceAmount: openBalance,
        surchargeAmount: surcharge.amount,
        currency: link.currency,
        returnUrl,
      },
      fetchFn,
    );
    await db.execute(sql`
      insert into payment_attempts
        (org_id, link_id, provider, external_ref, status, amount, surcharge_amount, event_payload, created_by, updated_by)
      values (${link.orgId}, ${link.id}, ${link.provider}, ${session.externalRef}, 'initiated',
              ${openBalance}, ${surcharge.amount},
              ${JSON.stringify({ redirectUrl: session.redirectUrl, invoiceAmount: openBalance, surchargeAmount: surcharge.amount, feeIncomeAccountId: surcharge.feeIncomeAccountId })}::jsonb,
              null, null)
      on conflict (org_id, provider, external_ref) do nothing
    `);
    return { redirectUrl: session.redirectUrl };
  });
}

// ---------------------------------------------------------------------------
// Webhook ingestion + settlement
// ---------------------------------------------------------------------------

/**
 * Verify and route a provider webhook. The provider signature is checked
 * against every org configured for acceptance with this provider — the first
 * secret that verifies owns the event (per-org webhook secrets without
 * org-scoped URLs). Returns the org that accepted it, or null when no
 * signature verifies.
 */
export async function handleProviderWebhook(
  provider: AcceptanceProvider,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
): Promise<{ orgId: string; status: string } | null> {
  const configs = await withBypassContext(async () =>
    db.execute(sql`
      select id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id,
             publishable_key, settings, surcharge_rule_id, secrets, org_id
        from psp_provider_configs
       where provider = ${provider} and is_enabled and acceptance_enabled
    `)) as unknown as { rows: (ProviderConfigRow & { org_id: string })[] };
  const adapter = ACCEPTANCE_ADAPTERS[provider];
  for (const config of configs.rows) {
    const event = adapter.verifyWebhook(headers, rawBody, configSecrets(config));
    if (!event) continue;
    const orgId = config.org_id;
    const status = await withOrg(orgId, () => processWebhookEvent(orgId, provider, event));
    return { orgId, status };
  }
  return null;
}

async function processWebhookEvent(
  orgId: string,
  provider: AcceptanceProvider,
  event: WebhookEvent,
): Promise<string> {
  // Resolve the attempt: by provider object id first, then by link token.
  let attempt = (await db.execute(sql`
    select id, link_id, status from payment_attempts
     where org_id = ${orgId} and provider = ${provider} and external_ref = ${event.externalRef}
     order by created_at desc limit 1
  `)) as unknown as { rows: { id: string; link_id: string; status: string }[] };
  if (!attempt.rows[0] && event.linkToken) {
    attempt = (await db.execute(sql`
      select a.id, a.link_id, a.status from payment_attempts a
        join payment_links l on l.id = a.link_id and l.org_id = a.org_id
       where a.org_id = ${orgId} and a.provider = ${provider} and l.token = ${event.linkToken}
         and a.status = 'initiated'
       order by a.created_at desc limit 1
    `)) as unknown as { rows: { id: string; link_id: string; status: string }[] };
  }
  const found = attempt.rows[0];
  if (!found) return "unknown_attempt";

  // Atomic claim: exactly one concurrent delivery transitions the attempt.
  let claim: { rows: { id: string }[] };
  try {
    claim = (await db.execute(sql`
      update payment_attempts
         set status = ${event.status === "succeeded" ? "initiated" : event.status},
             external_ref = ${event.externalRef},
             event_payload = coalesce(event_payload, '{}'::jsonb) || ${JSON.stringify({ webhook: true, status: event.status })}::jsonb,
             updated_at = now()
       where id = ${found.id} and status = 'initiated'
       returning id
    `)) as unknown as { rows: { id: string }[] };
  } catch (err) {
    // Re-keying to the provider object id hit an already-processed delivery.
    if ((err as { code?: string }).code === "23505") return "duplicate";
    throw err;
  }
  if (!claim.rows[0]) return "duplicate";

  if (event.status === "succeeded") {
    await settleAttempt(orgId, found.id);
    return "settled";
  }
  if (event.status === "refunded") {
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_attempts', ${found.id}, 'update',
              ${JSON.stringify({ after: { status: "refunded", note: "refund/chargeback reported by provider; reverse the receipt via payments if funds were clawed back" } })}::jsonb, null)
    `);
    return "refunded_noted";
  }
  return event.status;
}

/**
 * Convert a paid attempt into a posted customer receipt: create the payment
 * document, auto-apply it to the link's invoice (capped at the current open
 * balance; any remainder stays on-account), attach the surcharge fee leg,
 * and post through the kernel. Idempotent via the attempt claim above.
 */
async function settleAttempt(orgId: string, attemptId: string): Promise<void> {
  const rows = (await db.execute(sql`
    select a.id, a.amount, a.surcharge_amount, a.event_payload,
           l.id as link_id, l.document_id, l.party_id, l.subsidiary_id, l.bank_account_id, l.currency, l.created_by as link_created_by
      from payment_attempts a
      join payment_links l on l.id = a.link_id and l.org_id = a.org_id
     where a.org_id = ${orgId} and a.id = ${attemptId}
  `)) as unknown as {
    rows: {
      id: string; amount: string | null; surcharge_amount: string | null;
      event_payload: { feeIncomeAccountId?: string } | null;
      link_id: string; document_id: string; party_id: string; subsidiary_id: string; bank_account_id: string; currency: string;
      link_created_by: string | null;
    }[];
  };
  const a = rows.rows[0];
  if (!a) throw new PaymentAcceptanceError("attempt not found");

  const doc = (await db.execute(sql`
    select id, document_number, open_balance from documents where id = ${a.document_id} and org_id = ${orgId}
  `)) as unknown as { rows: { id: string; document_number: string; open_balance: string }[] };
  const invoice = doc.rows[0];
  if (!invoice) throw new PaymentAcceptanceError("invoice not found");
  if (cmp(invoice.open_balance, "0.005") <= 0) {
    // Paid through another channel meanwhile — nothing to settle.
    await db.execute(sql`
      update payment_attempts set status = 'succeeded', updated_at = now() where id = ${attemptId}
    `);
    await db.execute(sql`
      update payment_links set status = 'paid', paid_at = now(), updated_at = now()
       where id = ${a.link_id} and status = 'active'
    `);
    return;
  }

  // Auto-apply to the invoice's open-item line, capped at its open balance.
  const openItems = await openItemsForParty(a.party_id, "ar");
  const item = openItems.find((i) => i.documentId === invoice.id);
  if (!item) throw new PaymentAcceptanceError("invoice open item not found");
  const invoicePortion = cmp(a.amount ?? invoice.open_balance, invoice.open_balance) < 0 ? (a.amount ?? invoice.open_balance) : invoice.open_balance;
  const allocations: AllocationInput[] = [sameCurrencyAllocation(item.lineId, invoicePortion)];

  const actorId = a.link_created_by as string; // receipts attribute to the link creator
  const payment = await createPaymentDocument({
    orgId,
    kind: "customer_payment",
    createdBy: actorId,
    partyId: a.party_id,
    bankAccountId: a.bank_account_id,
    documentDate: new Date().toISOString().slice(0, 10),
    memo: `Online payment — ${invoice.document_number}`,
    subsidiaryId: a.subsidiary_id,
    currency: a.currency,
  });
  const feeAmount = a.surcharge_amount ?? "0";
  const feeIncomeAccountId = a.event_payload?.feeIncomeAccountId ?? null;
  await updateDraftPayment(
    payment.id,
    {
      allocations,
      referenceNumber: `link:${a.link_id.slice(0, 8)}`,
      feeAmount,
      feeIncomeAccountId,
    },
    actorId,
  );
  const { entryId } = await postPaymentWithApplications(payment.id, allocations, actorId);

  await db.execute(sql`
    update payment_attempts
       set status = 'succeeded', payment_document_id = ${payment.id}, journal_entry_id = ${entryId}, updated_at = now()
     where id = ${attemptId}
  `);
  const remaining = (await db.execute(sql`
    select open_balance from documents where id = ${invoice.id}
  `)) as unknown as { rows: { open_balance: string }[] };
  if (cmp(remaining.rows[0]?.open_balance ?? "0", "0.005") <= 0) {
    await db.execute(sql`
      update payment_links
         set status = 'paid', paid_payment_document_id = ${payment.id}, paid_at = now(), updated_at = now()
       where id = ${a.link_id} and status = 'active'
    `);
  }
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'payment_attempts', ${attemptId}, 'post',
            ${JSON.stringify({ after: { paymentDocumentId: payment.id, journalEntryId: entryId, invoice: invoice.document_number, allocated: invoicePortion, fee: feeAmount } })}::jsonb, null)
  `);
}

// ---------------------------------------------------------------------------
// Provider config writes (admin)
// ---------------------------------------------------------------------------

/** Lightweight credential check against the provider's API (no side effects). */
export async function testAcceptanceConnection(
  provider: AcceptanceProvider,
  secrets: ProviderSecrets,
  fetchFn: FetchFn = defaultFetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    if (provider === "stripe") {
      if (!secrets.apiKey) return { ok: false, detail: "no API key configured" };
      const res = await fetchFn("https://api.stripe.com/v1/account", {
        method: "GET",
        headers: { authorization: `Basic ${Buffer.from(`${secrets.apiKey}:`).toString("base64")}` },
      });
      const json = await res.json();
      return res.status < 400
        ? { ok: true, detail: `connected${json?.business_profile?.name ? ` — ${json.business_profile.name}` : ""}` }
        : { ok: false, detail: json?.error?.message ?? `HTTP ${res.status}` };
    }
    if (provider === "adyen") {
      if (!secrets.apiKey || !secrets.merchantAccount) return { ok: false, detail: "API key and merchant account are required" };
      const base = secrets.apiBase ?? "https://checkout-test.adyen.com/v71";
      const res = await fetchFn(`${base}/paymentMethods`, {
        method: "POST",
        headers: { "x-api-key": secrets.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ merchantAccount: secrets.merchantAccount }),
      });
      const json = await res.json();
      return res.status < 400
        ? { ok: true, detail: `connected — ${Array.isArray(json?.paymentMethods) ? json.paymentMethods.length : 0} payment methods` }
        : { ok: false, detail: json?.message ?? `HTTP ${res.status}` };
    }
    // gocardless
    if (!secrets.apiKey) return { ok: false, detail: "no access token configured" };
    const base = secrets.apiBase ?? "https://api-sandbox.gocardless.com";
    const res = await fetchFn(`${base}/billing_requests?limit=1`, {
      method: "GET",
      headers: { authorization: `Bearer ${secrets.apiKey}`, "GoCardless-Version": "2015-07-06" },
    });
    return res.status < 400
      ? { ok: true, detail: "connected" }
      : { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveAcceptanceConfig(
  orgId: string,
  actorId: string,
  input: {
    provider: AcceptanceProvider;
    displayName?: string;
    isEnabled: boolean;
    acceptanceEnabled: boolean;
    defaultBankAccountId?: string | null;
    publishableKey?: string | null;
    surchargeRuleId?: string | null;
    settings?: Record<string, unknown>;
    apiKey?: string | null;
    webhookSecret?: string | null;
  },
): Promise<void> {
  let secrets: string | null = null;
  if (input.apiKey || input.webhookSecret) {
    // Merge with any existing sealed secrets so one field can rotate alone.
    const existing = await loadProviderConfig(orgId, input.provider);
    const prior = unsealJson<{ apiKey?: string; webhookSecret?: string }>(existing?.secrets ?? null) ?? {};
    secrets = await sealJson({
      apiKey: input.apiKey ?? prior.apiKey,
      webhookSecret: input.webhookSecret ?? prior.webhookSecret,
    });
  }
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id,
       publishable_key, surcharge_rule_id, settings, secrets, created_by, updated_by)
    values (${orgId}, ${input.provider}, ${input.displayName ?? input.provider}, ${input.isEnabled},
            ${input.acceptanceEnabled}, ${input.defaultBankAccountId ?? null},
            ${input.publishableKey ?? null}, ${input.surchargeRuleId ?? null},
            ${JSON.stringify(input.settings ?? {})}::jsonb, ${secrets}, ${actorId}, ${actorId})
    on conflict (org_id, provider) do update set
      display_name = excluded.display_name,
      is_enabled = excluded.is_enabled,
      acceptance_enabled = excluded.acceptance_enabled,
      default_bank_account_id = excluded.default_bank_account_id,
      publishable_key = excluded.publishable_key,
      surcharge_rule_id = excluded.surcharge_rule_id,
      settings = excluded.settings,
      secrets = coalesce(excluded.secrets, psp_provider_configs.secrets),
      updated_at = now(), updated_by = ${actorId}
  `);
  const saved = await loadProviderConfig(orgId, input.provider);
  if (!saved) throw new PaymentAcceptanceError("provider config failed to persist");
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'psp_provider_configs', ${saved.id}, 'update',
            ${JSON.stringify({ after: { isEnabled: input.isEnabled, acceptanceEnabled: input.acceptanceEnabled, hasApiKey: !!input.apiKey, hasWebhookSecret: !!input.webhookSecret } })}::jsonb,
            ${actorId})
  `);
}

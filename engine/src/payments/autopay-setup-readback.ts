import {
  resolveAcceptanceProviderApiBase,
  type AcceptanceProvider,
  type FetchFn,
  type WebhookEvent,
} from "./acceptance.ts";
import { AutopayError } from "./autopay-policy.ts";

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

async function stripeGet(
  path: string,
  apiKey: string,
  base: string,
  fetchFn: FetchFn,
): Promise<Record<string, unknown>> {
  const res = await fetchFn(`${base}${path}`, {
    method: "GET",
    redirect: "error",
    headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
  });
  if (res.status >= 400)
    throw new AutopayError(
      "the provider could not confirm the setup; ask the customer to finish the setup checkout first",
    );
  return jsonRecord(await res.json().catch(() => null));
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read the stored method off the provider after a completed setup. */
export async function readCompletedSetup(
  provider: AcceptanceProvider,
  setupRef: string,
  secrets: { apiKey?: string; merchantAccount?: string; apiBase?: string },
  fetchFn: FetchFn,
  setupEvent?: WebhookEvent,
): Promise<CompletedMethodDetail> {
  if (!setupRef)
    throw new AutopayError("this setup never reached the provider; send a new setup link instead");
  if (provider === "stripe") {
    const base = resolveAcceptanceProviderApiBase("stripe", secrets.apiBase);
    const session = await stripeGet(
      `/v1/checkout/sessions/${encodeURIComponent(setupRef)}`,
      secrets.apiKey!,
      base,
      fetchFn,
    );
    if (session.mode !== "setup" || session.payment_status === "unpaid" || !session.setup_intent) {
      throw new AutopayError(
        "the setup checkout is not complete; ask the customer to finish it first",
      );
    }
    const intent = await stripeGet(
      `/v1/setup_intents/${encodeURIComponent(String(session.setup_intent))}`,
      secrets.apiKey!,
      base,
      fetchFn,
    );
    if (!intent.payment_method)
      throw new AutopayError(
        "the setup has no payment method yet; ask the customer to finish it first",
      );
    const method = await stripeGet(
      `/v1/payment_methods/${encodeURIComponent(String(intent.payment_method))}`,
      secrets.apiKey!,
      base,
      fetchFn,
    );
    const card = jsonRecord(method.card);
    const expMonth = typeof card.exp_month === "number" ? card.exp_month : null;
    const expYear = typeof card.exp_year === "number" ? card.exp_year : null;
    return {
      providerCustomerId:
        typeof intent.customer === "string"
          ? intent.customer
          : typeof session.customer === "string"
            ? session.customer
            : null,
      providerMethodId: String(intent.payment_method),
      brand:
        typeof card.brand === "string"
          ? card.brand
          : typeof method.type === "string"
            ? method.type
            : null,
      last4: typeof card.last4 === "string" ? card.last4 : null,
      expMonth,
      expYear,
      mandateReference: null,
    };
  }
  if (provider === "gocardless") {
    const base = resolveAcceptanceProviderApiBase("gocardless", secrets.apiBase);
    const headers = {
      authorization: `Bearer ${secrets.apiKey}`,
      "content-type": "application/json",
      "GoCardless-Version": "2015-07-06",
    };
    const get = async (path: string) => {
      const res = await fetchFn(`${base}${path}`, { method: "GET", redirect: "error", headers });
      if (res.status >= 400)
        throw new AutopayError(
          "the mandate is not authorised yet; ask the customer to finish the setup first",
        );
      return jsonRecord(await res.json().catch(() => null));
    };
    const br = jsonRecord(
      (await get(`/billing_requests/${encodeURIComponent(setupRef)}`)).billing_requests,
    );
    const links = jsonRecord(br.links);
    const mandateId = links.mandate;
    if (typeof mandateId !== "string" || !mandateId) {
      throw new AutopayError(
        "the mandate is not authorised yet; ask the customer to finish the setup first",
      );
    }
    const mandate = jsonRecord((await get(`/mandates/${encodeURIComponent(mandateId)}`)).mandates);
    const mandateLinks = jsonRecord(mandate.links);
    let last4: string | null = null;
    if (typeof mandateLinks.customer_bank_account === "string") {
      const account = jsonRecord(
        (
          await get(
            `/customer_bank_accounts/${encodeURIComponent(mandateLinks.customer_bank_account)}`,
          )
        ).customer_bank_accounts,
      );
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
    throw new AutopayError(
      "the provider has not confirmed the stored method yet; it activates when the confirmation webhook arrives",
    );
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

/** Stripe acceptance adapter: hosted checkout and webhook verification. */
import { add } from "../money/money.ts";
import {
  defaultFetch,
  fetchJsonBody,
  hmacSha256Hex,
  invalidWebhook,
  isJsonRecord,
  jsonObject,
  logPaymentWebhookItemMalformed,
  resolveAcceptanceProviderApiBase,
  safeEqual,
  stringLinkToken,
  toMinorUnits,
  verifiedWebhook,
} from "./acceptance-provider-utils.ts";
import {
  PaymentAcceptanceError,
  type PaymentProviderAdapter,
  type ProviderSecrets,
  type WebhookEvent,
  type WebhookVerification,
} from "./acceptance-types.ts";
import { fromMinorUnits } from "./minor-units.ts";

/** Normalize one signature-verified Stripe event into an actionable event, or
 *  null when acceptance does not act on its type. Same exactness contract as
 *  the Adyen item normalizer: un-normalizable fields throw to the caller's
 *  quarantine instead of settling on coerced data. */
export function normalizeStripeNotification(event: unknown): WebhookEvent | null {
  const root = isJsonRecord(event) ? event : {};
  const data = isJsonRecord(root.data) ? root.data : {};
  const obj = isJsonRecord(data.object) ? data.object : {};
  const metadata = isJsonRecord(obj.metadata) ? obj.metadata.link_token : undefined;
  const linkToken = stringLinkToken(obj.client_reference_id) ?? stringLinkToken(metadata);
  const type = root.type;
  if (type === "checkout.session.completed" && obj.mode === "setup") {
    // A stored-method setup checkout completed: no money moved. The autopay
    // engine claims it by the client reference (our pending method row id)
    // and reads the method off the setup intent.
    return {
      externalRef: String(obj.id ?? ""),
      setupCompleted: true,
      setupRef: obj.setup_intent ? String(obj.setup_intent) : null,
      setupCustomerRef: obj.customer ? String(obj.customer) : null,
      linkToken,
      status: "succeeded",
      raw: root,
    };
  }
  if (
    type === "checkout.session.completed" ||
    type === "checkout.session.async_payment_succeeded"
  ) {
    // Async methods (ACH/SEPA) complete with payment_status "unpaid" first;
    // settling on that would post a receipt for money not yet collected.
    const paymentStatus = obj.payment_status == null ? "paid" : String(obj.payment_status);
    const settled =
      type === "checkout.session.async_payment_succeeded" ||
      paymentStatus === "paid" ||
      paymentStatus === "no_payment_required";
    const currency = typeof obj.currency === "string" ? obj.currency.toUpperCase() : null;
    return {
      externalRef: String(obj.id ?? ""),
      intentRef: obj.payment_intent ? String(obj.payment_intent) : null,
      linkToken,
      status: settled ? "succeeded" : "processing",
      // Stripe's amount_total is expressed in the currency's smallest unit.
      // Zero-decimal currencies (for example JPY) therefore arrive as whole
      // major units, while two-decimal currencies arrive as cents. Convert
      // both forms into OpenBooks' four-decimal money scale exactly.
      // The assertion is compile-time only: the value flows into BigInt
      // unchanged, so its SyntaxError/RangeError branches (pinned by the
      // quarantine tests) still classify un-normalizable amounts.
      paidAmount:
        settled && obj.amount_total != null
          ? fromMinorUnits(
              BigInt(obj.amount_total as string | number | bigint | boolean),
              currency ?? "USD",
            )
          : null,
      paidCurrency: settled ? currency : null,
      raw: root,
    };
  }
  if (type === "checkout.session.async_payment_failed") {
    return {
      externalRef: String(obj.id ?? ""),
      intentRef: obj.payment_intent ? String(obj.payment_intent) : null,
      linkToken,
      status: "failed",
      raw: root,
    };
  }
  if (type === "payment_method.automatically_updated") {
    // The card network reissued or corrected the stored card: refresh the
    // stored display detail off exactly what the provider reports. A missing
    // method id or a non-numeric expiry cannot be normalized exactly and is
    // quarantined by the caller instead of settling on coerced data.
    if (typeof obj.id !== "string" || obj.id === "") {
      throw new PaymentAcceptanceError("card updater event carries no payment method id");
    }
    const card = isJsonRecord(obj.card) ? obj.card : {};
    for (const key of ["exp_month", "exp_year"] as const) {
      if (card[key] != null && typeof card[key] !== "number") {
        throw new PaymentAcceptanceError("card updater event carries a non-numeric card expiry");
      }
    }
    return {
      externalRef: obj.id,
      status: "succeeded",
      cardUpdaterRefresh: {
        providerMethodId: obj.id,
        brand: typeof card.brand === "string" ? card.brand : null,
        last4: typeof card.last4 === "string" ? card.last4 : null,
        expMonth: typeof card.exp_month === "number" ? card.exp_month : null,
        expYear: typeof card.exp_year === "number" ? card.exp_year : null,
      },
      raw: root,
    };
  }
  if (type === "checkout.session.expired") {
    // No metadata fallback here: expired sessions only ever resolved on the
    // direct client reference.
    return {
      externalRef: String(obj.id ?? ""),
      linkToken: stringLinkToken(obj.client_reference_id),
      status: "cancelled",
      raw: root,
    };
  }
  if (type === "charge.refunded" || type === "charge.refund.updated") {
    // Checkout stores the session id as external_ref and persists
    // payment_intent onto event_payload. Refund/dispute objects are keyed
    // by the intent, so both refs must be set: externalRef for a later
    // re-key, intentRef so resolution matches event_payload.paymentIntent.
    // The refunded amount rides the event so the automation can tell a full
    // refund from a partial one without guessing.
    const intent = obj.payment_intent ? String(obj.payment_intent) : null;
    const refundCurrency = typeof obj.currency === "string" ? obj.currency.toUpperCase() : null;
    const refundedRaw = type === "charge.refunded" ? obj.amount_refunded : obj.amount;
    return {
      externalRef: String(obj.payment_intent ?? obj.id ?? ""),
      intentRef: intent,
      linkToken,
      status: "refunded",
      // A voluntary refund is not a dispute — but the flag rides every
      // return so autopay never has to guess which one this is.
      dispute: false,
      providerEventId: typeof root.id === "string" ? root.id : null,
      refundedAmount:
        refundedRaw != null && refundCurrency
          ? fromMinorUnits(
              BigInt(refundedRaw as string | number | bigint | boolean),
              refundCurrency,
            )
          : null,
      refundCurrency,
      refundAmountBasis: "cumulative",
      providerRefundId:
        type === "charge.refunded" && typeof obj.id === "string" && refundedRaw != null
          ? `${obj.id}:${String(refundedRaw)}`
          : null,
      refundObservation: type === "charge.refund.updated",
      raw: root,
    };
  }
  if (
    type === "charge.dispute.created" ||
    type === "charge.dispute.updated" ||
    type === "charge.dispute.closed"
  ) {
    const intent = obj.payment_intent ? String(obj.payment_intent) : null;
    const disputeCurrency = typeof obj.currency === "string" ? obj.currency.toUpperCase() : null;
    const closedStatus = String((obj as Record<string, unknown>).status ?? "");
    const state =
      type === "charge.dispute.closed" ? (closedStatus === "lost" ? "lost" : "won") : "opened";
    return {
      externalRef: String(obj.payment_intent ?? obj.id ?? ""),
      intentRef: intent,
      linkToken,
      status: "disputed",
      providerEventId: typeof root.id === "string" ? root.id : null,
      // A dispute is not a voluntary refund: autopay must never auto-charge
      // an invoice whose collection is under dispute.
      dispute: true,
      disputeDetail: {
        id: String(obj.id ?? ""),
        amount:
          obj.amount != null && disputeCurrency
            ? fromMinorUnits(
                BigInt(obj.amount as string | number | bigint | boolean),
                disputeCurrency,
              )
            : "0",
        currency: disputeCurrency ?? "",
        reason: typeof obj.reason === "string" ? obj.reason : null,
        state,
      },
      raw: root,
    };
  }
  return null;
}

export function verifyStripeWebhookDelivery(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secrets: ProviderSecrets,
): WebhookVerification {
  if (!secrets.webhookSecret) return invalidWebhook();
  const sigHeader = headers["stripe-signature"];
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  if (!sig) return invalidWebhook();
  // During a secret roll Stripe sends several v1 signatures (one per active
  // secret). Keeping only one — e.g. via a last-wins map — 401s every valid
  // delivery signed with the other secret, so every v1 is collected and the
  // delivery verifies if ANY of them matches (each compared timing-safe).
  const entries = sig.split(",").map((kv) => kv.split("=", 2) as [string, (string | undefined)?]);
  const timestamp = entries.find(([key]) => key === "t")?.[1];
  const signatures = entries
    .filter(([key]) => key === "v1")
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (!timestamp || signatures.length === 0) return invalidWebhook();
  const expected = hmacSha256Hex(secrets.webhookSecret, `${timestamp}.${rawBody}`);
  if (!signatures.some((candidate) => safeEqual(expected, candidate))) return invalidWebhook();
  // Replay window: far-future timestamps are rejected outright, but retries
  // up to 24h old are accepted — during a provider outage every older
  // delivery would otherwise 401 forever and the settlement would be
  // silently lost. Old-event acceptance is safe because the attempt claim
  // (below) makes processing idempotent.
  const skew = Date.now() / 1000 - Number(timestamp);
  if (skew < -300 || skew > 86_400) return invalidWebhook();
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return verifiedWebhook([]);
  }
  const body = isJsonRecord(event) ? event : {};
  // Authenticated content may still be un-normalizable; that quarantines the
  // delivery's single item exactly like an unparseable body does above.
  try {
    const normalized = normalizeStripeNotification(event);
    return normalized ? verifiedWebhook([normalized]) : verifiedWebhook([]);
  } catch (error) {
    const data = isJsonRecord(body.data) ? body.data : {};
    const object = isJsonRecord(data.object) ? data.object : {};
    logPaymentWebhookItemMalformed(
      "stripe",
      String(object.id ?? ""),
      String(body.type ?? ""),
      error,
    );
    return verifiedWebhook([]);
  }
}

export const stripeAdapter: PaymentProviderAdapter = {
  key: "stripe",
  async createCheckout(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("stripe secret key is not configured");
    const base = resolveAcceptanceProviderApiBase("stripe", secrets.apiBase);
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
    const res = await fetchFn(`${base}/v1/checkout/sessions`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Basic ${Buffer.from(`${secrets.apiKey}:`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const json = await fetchJsonBody(res);
    if (res.status >= 400)
      throw new PaymentAcceptanceError(
        `stripe checkout failed: ${jsonObject(json.error).message ?? res.status}`,
      );
    if (
      typeof json.id !== "string" ||
      json.id === "" ||
      typeof json.url !== "string" ||
      json.url === ""
    ) {
      throw new PaymentAcceptanceError("stripe checkout returned no session url");
    }
    return { redirectUrl: json.url, externalRef: json.id };
  },
  async createSetupSession(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("stripe secret key is not configured");
    const base = resolveAcceptanceProviderApiBase("stripe", secrets.apiBase);
    const auth = {
      authorization: `Basic ${Buffer.from(`${secrets.apiKey}:`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    };
    let customerId = req.providerCustomerId ?? null;
    if (!customerId) {
      const customerParams = new URLSearchParams();
      customerParams.set("description", req.description.slice(0, 250));
      customerParams.set("metadata[link_token]", req.linkToken);
      const customerRes = await fetchFn(`${base}/v1/customers`, {
        method: "POST",
        redirect: "error",
        headers: auth,
        body: customerParams.toString(),
      });
      const customer = await fetchJsonBody(customerRes);
      if (customerRes.status >= 400 || typeof customer.id !== "string" || !customer.id) {
        throw new PaymentAcceptanceError(
          `stripe customer create failed: ${jsonObject(customer.error).message ?? customerRes.status}`,
        );
      }
      customerId = customer.id;
    }
    const params = new URLSearchParams();
    params.set("mode", "setup");
    params.set("customer", customerId);
    params.set("success_url", `${req.returnUrl}?setup=success`);
    params.set("cancel_url", req.returnUrl);
    params.set("client_reference_id", req.linkToken);
    params.set("metadata[link_token]", req.linkToken);
    const res = await fetchFn(`${base}/v1/checkout/sessions`, {
      method: "POST",
      redirect: "error",
      headers: auth,
      body: params.toString(),
    });
    const json = await fetchJsonBody(res);
    if (res.status >= 400)
      throw new PaymentAcceptanceError(
        `stripe setup session failed: ${jsonObject(json.error).message ?? res.status}`,
      );
    if (
      typeof json.id !== "string" ||
      json.id === "" ||
      typeof json.url !== "string" ||
      json.url === ""
    ) {
      throw new PaymentAcceptanceError("stripe setup session returned no url");
    }
    return { redirectUrl: json.url, externalRef: json.id, providerCustomerId: customerId };
  },
  async chargeOffSession(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("stripe secret key is not configured");
    const base = resolveAcceptanceProviderApiBase("stripe", secrets.apiBase);
    const params = new URLSearchParams();
    params.set("amount", toMinorUnits(req.amount, req.currency));
    params.set("currency", req.currency.toLowerCase());
    if (req.providerCustomerId) params.set("customer", req.providerCustomerId);
    params.set("payment_method", req.providerMethodId);
    params.set("off_session", "true");
    params.set("confirm", "true");
    params.set("description", req.description.slice(0, 250));
    const res = await fetchFn(`${base}/v1/payment_intents`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Basic ${Buffer.from(`${secrets.apiKey}:`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        "Idempotency-Key": req.idempotencyKey,
      },
      body: params.toString(),
    });
    const json = await fetchJsonBody(res);
    if (res.status >= 400) {
      const err = jsonObject(json.error);
      const code =
        typeof err.decline_code === "string"
          ? err.decline_code
          : typeof err.code === "string"
            ? err.code
            : null;
      return {
        status: "failed",
        providerRef: typeof json.id === "string" ? json.id : null,
        declineCode: code,
      };
    }
    const id = typeof json.id === "string" ? json.id : "";
    if (json.status === "succeeded") return { status: "succeeded", providerRef: id };
    if (json.status === "processing") return { status: "processing", providerRef: id };
    const lastError = jsonObject(json.last_payment_error);
    const code =
      typeof lastError.decline_code === "string"
        ? lastError.decline_code
        : typeof lastError.code === "string"
          ? lastError.code
          : "payment_intent_requires_action";
    if (json.status === "requires_action") {
      // The issuer wants the customer, not another blind charge: hand back
      // the hosted verification URL when Stripe offers one (redirect-based
      // flows) so the attempt can keep an actionable link.
      const nextAction = jsonObject(json.next_action);
      const redirect = jsonObject(nextAction.redirect_to_url);
      const authUrl = typeof redirect.url === "string" && redirect.url !== "" ? redirect.url : null;
      return { status: "requires_action", providerRef: id || null, authUrl, declineCode: code };
    }
    return { status: "failed", providerRef: id || null, declineCode: code };
  },
  async detachMethod(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("stripe secret key is not configured");
    const base = resolveAcceptanceProviderApiBase("stripe", secrets.apiBase);
    const res = await fetchFn(
      `${base}/v1/payment_methods/${encodeURIComponent(req.providerMethodId)}/detach`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Basic ${Buffer.from(`${secrets.apiKey}:`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
      },
    );
    if (res.status === 404) return; // already detached: removal stays idempotent
    const json = await fetchJsonBody(res);
    if (res.status >= 400)
      throw new PaymentAcceptanceError(
        `stripe detach failed: ${jsonObject(json.error).message ?? res.status}`,
      );
  },
  verifyWebhookDelivery: verifyStripeWebhookDelivery,
  verifyWebhook(headers, rawBody, secrets) {
    return verifyStripeWebhookDelivery(headers, rawBody, secrets).events[0] ?? null;
  },
};

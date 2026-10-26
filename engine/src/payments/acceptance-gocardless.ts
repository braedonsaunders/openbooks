/** GoCardless acceptance adapter: bank-debit checkout and webhook verification. */
import { add } from "../money/money.ts";
import {
  defaultFetch,
  fetchJsonBody,
  hmacSha256Hex,
  invalidWebhook,
  jsonObject,
  resolveAcceptanceProviderApiBase,
  safeEqual,
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

export function verifyGoCardlessWebhookDelivery(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secrets: ProviderSecrets,
): WebhookVerification {
  if (!secrets.webhookSecret) return invalidWebhook();
  const sigHeader = headers["webhook-signature"];
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  if (!sig) return invalidWebhook();
  const expected = hmacSha256Hex(secrets.webhookSecret, rawBody);
  if (!safeEqual(expected, sig)) return invalidWebhook();
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return verifiedWebhook([]);
  }
  const providerEvents = Array.isArray(payload?.events) ? payload.events : [];
  const events: WebhookEvent[] = [];
  for (const event of providerEvents) {
    const brId = event?.links?.billing_request ?? null;
    const paymentId = event?.links?.payment ?? event?.links?.billing_request ?? "";
    // Checkout stores the billing request id as the attempt's external_ref,
    // while payment events reference the payment id — every payment event
    // carries the billing request so resolution can match either side.
    const alternateRef = brId && brId !== paymentId ? brId : null;
    if (
      event?.resource_type === "payments" &&
      (event.action === "confirmed" || event.action === "paid_out")
    ) {
      events.push({
        externalRef: String(paymentId),
        alternateExternalRef: alternateRef,
        linkToken: null,
        status: "succeeded",
        raw: payload,
      });
    } else if (
      event?.resource_type === "payments" &&
      (event.action === "failed" || event.action === "charged_back")
    ) {
      events.push({
        externalRef: String(paymentId),
        alternateExternalRef: alternateRef,
        linkToken: null,
        status: event.action === "failed" ? "failed" : "refunded",
        // A chargeback is a dispute, not a voluntary refund: autopay must
        // never auto-charge an invoice whose collection is under dispute.
        dispute: event.action === "charged_back",
        // Bank-debit returns carry no amount on the webhook: the automation
        // parks for review with the amount to confirm instead of guessing.
        providerEventId: typeof event?.id === "string" ? event.id : null,
        refundedAmount: null,
        refundCurrency: null,
        raw: payload,
      });
    } else if (
      event?.resource_type === "mandates" &&
      (event.action === "created" || event.action === "active")
    ) {
      // A bank-debit mandate was authorised: the stored method is ready. The
      // autopay engine claims it; mandate failures arrive as cancelled and
      // stay unhandled here.
      const mandateId = String(event?.links?.mandate ?? "");
      events.push({
        externalRef: mandateId,
        setupCompleted: true,
        setupRef: mandateId,
        setupCustomerRef: event?.links?.customer ? String(event.links.customer) : null,
        linkToken: null,
        status: "succeeded",
        raw: payload,
      });
    } else if (event?.resource_type === "billing_requests" && event.action === "fulfilled") {
      // A mandate-setup billing request completed: the pending row holds
      // this id, so completion verifies the mandate off the request itself.
      const setupBrId = String(event?.links?.billing_request ?? "");
      events.push({
        externalRef: setupBrId,
        setupCompleted: true,
        setupRef: setupBrId,
        setupCustomerRef: null,
        linkToken: null,
        status: "succeeded",
        raw: payload,
      });
    } else if (event?.resource_type === "billing_requests" && event.action === "cancelled") {
      events.push({
        externalRef: String(brId ?? paymentId),
        linkToken: null,
        status: "cancelled",
        raw: payload,
      });
    }
  }
  return verifiedWebhook(events);
}

export const gocardlessAdapter: PaymentProviderAdapter = {
  key: "gocardless",
  async createCheckout(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey)
      throw new PaymentAcceptanceError("gocardless access token is not configured");
    const total = add(req.invoiceAmount, req.surchargeAmount);
    const base = resolveAcceptanceProviderApiBase("gocardless", secrets.apiBase);
    // Billing request → payment → billing request flow (hosted pages).
    const brRes = await fetchFn(`${base}/billing_requests`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secrets.apiKey}`,
        "content-type": "application/json",
        "GoCardless-Version": "2015-07-06",
      },
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
    const br = await fetchJsonBody(brRes);
    const brId = jsonObject(br.billing_requests).id;
    if (brRes.status >= 400 || typeof brId !== "string" || !brId) {
      throw new PaymentAcceptanceError(
        `gocardless billing request failed: ${jsonObject(br.error).message ?? brRes.status}`,
      );
    }
    const flowRes = await fetchFn(`${base}/billing_request_flows`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secrets.apiKey}`,
        "content-type": "application/json",
        "GoCardless-Version": "2015-07-06",
      },
      body: JSON.stringify({
        billing_request_flows: {
          redirect_uri: req.returnUrl,
          exit_uri: req.returnUrl,
          links: { billing_request: brId },
        },
      }),
    });
    const flow = await fetchJsonBody(flowRes);
    const url = jsonObject(flow.billing_request_flows).authorisation_url;
    if (flowRes.status >= 400 || typeof url !== "string" || !url) {
      throw new PaymentAcceptanceError(
        `gocardless flow failed: ${jsonObject(flow.error).message ?? flowRes.status}`,
      );
    }
    return { redirectUrl: url, externalRef: brId };
  },
  async createSetupSession(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey)
      throw new PaymentAcceptanceError("gocardless access token is not configured");
    const base = resolveAcceptanceProviderApiBase("gocardless", secrets.apiBase);
    const headers = {
      authorization: `Bearer ${secrets.apiKey}`,
      "content-type": "application/json",
      "GoCardless-Version": "2015-07-06",
    };
    // Mandate-only billing request: the payer authorises direct debit without
    // any immediate charge. The pending method row holds the billing request
    // id until the mandate webhook (or the return-URL verification) replaces
    // it with the real mandate id.
    const brRes = await fetchFn(`${base}/billing_requests`, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({
        billing_requests: {
          mandate_request: { currency: req.currency.toUpperCase() },
          metadata: { link_token: req.linkToken },
        },
      }),
    });
    const br = await fetchJsonBody(brRes);
    const brId = jsonObject(br.billing_requests).id;
    if (brRes.status >= 400 || typeof brId !== "string" || !brId) {
      throw new PaymentAcceptanceError(
        `gocardless mandate request failed: ${jsonObject(br.error).message ?? brRes.status}`,
      );
    }
    const flowRes = await fetchFn(`${base}/billing_request_flows`, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({
        billing_request_flows: {
          redirect_uri: `${req.returnUrl}?setup=success`,
          exit_uri: req.returnUrl,
          links: { billing_request: brId },
        },
      }),
    });
    const flow = await fetchJsonBody(flowRes);
    const url = jsonObject(flow.billing_request_flows).authorisation_url;
    if (flowRes.status >= 400 || typeof url !== "string" || !url) {
      throw new PaymentAcceptanceError(
        `gocardless mandate flow failed: ${jsonObject(flow.error).message ?? flowRes.status}`,
      );
    }
    return { redirectUrl: url, externalRef: brId };
  },
  async chargeOffSession(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey)
      throw new PaymentAcceptanceError("gocardless access token is not configured");
    const base = resolveAcceptanceProviderApiBase("gocardless", secrets.apiBase);
    const res = await fetchFn(`${base}/payments`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secrets.apiKey}`,
        "content-type": "application/json",
        "GoCardless-Version": "2015-07-06",
        "Idempotency-Key": req.idempotencyKey,
      },
      body: JSON.stringify({
        payments: {
          amount: toMinorUnits(req.amount, req.currency),
          currency: req.currency.toUpperCase(),
          links: { mandate: req.providerMethodId },
          reference: req.description.slice(0, 10),
        },
      }),
    });
    const json = await fetchJsonBody(res);
    if (res.status >= 400) {
      const code = jsonObject(json.error).code;
      return {
        status: "failed",
        providerRef: null,
        declineCode: typeof code === "string" ? code : null,
      };
    }
    const payment = jsonObject(json.payments);
    const id = typeof payment.id === "string" ? payment.id : "";
    // Bank debit settles asynchronously: creation only starts the collection,
    // the payment webhook settles the attempt when funds arrive or fail.
    if (payment.status === "failed" || payment.status === "cancelled") {
      return {
        status: "failed",
        providerRef: id || null,
        declineCode: typeof payment.status === "string" ? payment.status : null,
      };
    }
    return { status: "processing", providerRef: id };
  },
  async detachMethod(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey)
      throw new PaymentAcceptanceError("gocardless access token is not configured");
    const base = resolveAcceptanceProviderApiBase("gocardless", secrets.apiBase);
    const res = await fetchFn(
      `${base}/mandates/${encodeURIComponent(req.providerMethodId)}/actions/cancel`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${secrets.apiKey}`,
          "content-type": "application/json",
          "GoCardless-Version": "2015-07-06",
        },
        body: JSON.stringify({}),
      },
    );
    if (res.status === 404) return; // already cancelled: removal stays idempotent
    const json = await fetchJsonBody(res);
    if (res.status >= 400)
      throw new PaymentAcceptanceError(
        `gocardless mandate cancel failed: ${jsonObject(json.error).message ?? res.status}`,
      );
  },
  verifyWebhookDelivery: verifyGoCardlessWebhookDelivery,
  verifyWebhook(headers, rawBody, secrets) {
    return verifyGoCardlessWebhookDelivery(headers, rawBody, secrets).events[0] ?? null;
  },
};

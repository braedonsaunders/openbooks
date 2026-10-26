/** Adyen acceptance adapter: hosted checkout and webhook verification. */
import { add } from "../money/money.ts";
import {
  defaultFetch,
  fetchJsonBody,
  fromAdyenMinorUnits,
  invalidWebhook,
  isJsonRecord,
  jsonObject,
  logPaymentWebhookItemMalformed,
  resolveAcceptanceProviderApiBase,
  resolveAdyenRecurringApiBase,
  safeEqual,
  stringLinkToken,
  toAdyenMinorUnits,
  verifiedWebhook,
} from "./acceptance-provider-utils.ts";
import {
  PaymentAcceptanceError,
  type PaymentProviderAdapter,
  type ProviderSecrets,
  type WebhookEvent,
  type WebhookVerification,
} from "./acceptance-types.ts";
import { createHmac } from "node:crypto";

/** Normalize one signature-verified notification item into an actionable
 *  event, or null when acceptance does not act on its event code. Fields are
 *  converted exactly or not at all: a value that cannot normalize (e.g. a
 *  fractional minor-unit amount) throws to the caller's per-item quarantine
 *  rather than settling on coerced data. */
export function normalizeAdyenSuccessFlag(value: unknown): "true" | "false" | null {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "false") return normalized as "true" | "false";
    return null;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return null;
}

export function adyenScalarString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let found: string | null = null;
    for (const entry of value) {
      if (typeof entry === "string") found = entry;
    }
    return found;
  }
  return null;
}

/** One Adyen NotificationRequestItem; every field is optional because the
 *  provider omits what does not apply to the event code. */
export interface AdyenNotificationItem extends Record<string, unknown> {
  pspReference?: unknown;
  originalReference?: unknown;
  merchantAccountCode?: unknown;
  merchantReference?: unknown;
  amount?: unknown;
  eventCode?: unknown;
  success?: unknown;
  paymentMethod?: unknown;
  additionalData?: unknown;
}

/**
 * Stored-card detail on a recurring-contract notification, present when the
 * merchant enables Adyen's "include card info for recurring contract"
 * additional setting. `cardSummary` is the last four digits,
 * `expiryDate` is month/year (`3/2030`, `03/2030`), and
 * `recurring.recurringDetailReference` is Adyen's stable id for the stored
 * card: unlike the notification's pspReference it does not change when the
 * account updater reissues the card, so refreshes and the disable call key
 * on it. Returns null when the notice names no stored detail; throws to the
 * caller's per-item quarantine when it names one with unreadable content,
 * because a coerced expiry would mistarget the stored method.
 */
export function adyenRecurringCardDetail(item: AdyenNotificationItem): {
  detailReference: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
} | null {
  const additionalData = isJsonRecord(item.additionalData) ? item.additionalData : null;
  if (!additionalData) return null;
  const detailReference = adyenScalarString(additionalData["recurring.recurringDetailReference"]);
  if (!detailReference) return null;
  const rawSummary = adyenScalarString(additionalData.cardSummary);
  const rawExpiry = adyenScalarString(additionalData.expiryDate);
  const rawBrand =
    adyenScalarString(additionalData.paymentMethodVariant) ?? adyenScalarString(item.paymentMethod);
  if (!rawSummary && !rawExpiry && !rawBrand) return null;
  let expMonth: number | null = null;
  let expYear: number | null = null;
  if (rawExpiry) {
    const match = /^(\d{1,2})\/(\d{4})$/.exec(rawExpiry.trim());
    const month = match ? Number(match[1]) : NaN;
    const year = match ? Number(match[2]) : NaN;
    if (
      !match ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      year < 2000 ||
      year > 2100
    ) {
      throw new PaymentAcceptanceError(
        `adyen card detail carries an unreadable expiry ${JSON.stringify(rawExpiry)}`,
      );
    }
    expMonth = month;
    expYear = year;
  }
  return { detailReference, brand: rawBrand, last4: rawSummary, expMonth, expYear };
}

export function normalizeAdyenNotificationItem(
  payload: Record<string, unknown>,
  item: AdyenNotificationItem,
): WebhookEvent | null {
  const eventCode = adyenScalarString(item.eventCode);
  const successFlag = normalizeAdyenSuccessFlag(adyenScalarString(item.success) ?? item.success);
  const linkToken = stringLinkToken(item.merchantReference);
  const amount = isJsonRecord(item.amount) ? item.amount : undefined;
  const amountValue = amount?.value;
  const amountCurrency = amount?.currency;
  if (eventCode === "RECURRING_CONTRACT") {
    // A stored payment detail was created from the setup link: the method is
    // ready for ContAuth charges. Claimed by the autopay engine. The same
    // notice carries the stored card's detail reference with fresh card
    // fields when the account updater reissued it ("card updated"), so the
    // notice doubles as the updater event and the router tries the refresh
    // before the setup claim.
    const shopperRef = isJsonRecord(item.additionalData)
      ? adyenScalarString((item.additionalData as Record<string, unknown>).shopperReference)
      : null;
    const card = adyenRecurringCardDetail(item);
    return {
      externalRef: String(item.pspReference ?? ""),
      setupCompleted: true,
      setupRef: card?.detailReference ?? String(item.pspReference ?? ""),
      setupCustomerRef: shopperRef,
      cardUpdaterRefresh: card
        ? {
            providerMethodId: card.detailReference,
            brand: card.brand,
            last4: card.last4,
            expMonth: card.expMonth,
            expYear: card.expYear,
          }
        : null,
      linkToken,
      status: "succeeded",
      raw: payload,
    };
  }
  if (eventCode === "AUTHORISATION" && successFlag === "true") {
    return {
      externalRef: String(item.pspReference ?? ""),
      linkToken,
      status: "succeeded",
      // The assertion is compile-time only: the value flows into BigInt
      // unchanged, so its SyntaxError/RangeError branches (pinned by the
      // quarantine tests) still classify un-normalizable amounts.
      paidAmount:
        amountValue != null && amountCurrency
          ? fromAdyenMinorUnits(
              BigInt(amountValue as string | number | bigint | boolean),
              String(amountCurrency),
            )
          : null,
      paidCurrency: typeof amountCurrency === "string" ? amountCurrency.toUpperCase() : null,
      raw: payload,
    };
  }
  if (eventCode === "AUTHORISATION") {
    return {
      externalRef: String(item.pspReference ?? ""),
      linkToken,
      status: "failed",
      raw: payload,
    };
  }
  if (eventCode === "CANCELLATION" || eventCode === "CANCEL_OR_REFUND") {
    const refundCurrency = typeof amountCurrency === "string" ? amountCurrency.toUpperCase() : null;
    return {
      externalRef: String(item.pspReference ?? ""),
      linkToken,
      status: "refunded",
      dispute: false,
      providerEventId: `${String(item.pspReference ?? "")}:${eventCode}`,
      refundedAmount:
        amountValue != null && amountCurrency
          ? fromAdyenMinorUnits(
              BigInt(amountValue as string | number | bigint | boolean),
              String(amountCurrency),
            )
          : null,
      refundCurrency,
      raw: payload,
    };
  }
  if (
    eventCode === "CHARGEBACK" ||
    eventCode === "CHARGEBACK_REVERSED" ||
    eventCode === "SECOND_CHARGEBACK"
  ) {
    const disputeCurrency = typeof amountCurrency === "string" ? amountCurrency.toUpperCase() : "";
    return {
      externalRef: String(item.originalReference ?? item.pspReference ?? ""),
      alternateExternalRef: String(item.pspReference ?? ""),
      linkToken,
      status: "disputed",
      providerEventId: `${String(item.pspReference ?? "")}:${eventCode}`,
      dispute: true,
      disputeDetail: {
        id: String(item.pspReference ?? ""),
        amount:
          amountValue != null && amountCurrency
            ? fromAdyenMinorUnits(
                BigInt(amountValue as string | number | bigint | boolean),
                String(amountCurrency),
              )
            : "0",
        currency: disputeCurrency,
        reason: eventCode,
        state:
          eventCode === "CHARGEBACK"
            ? "opened"
            : eventCode === "SECOND_CHARGEBACK"
              ? "lost"
              : "won",
      },
      raw: payload,
    };
  }
  return null;
}

export function verifyAdyenWebhookDelivery(
  _headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secrets: ProviderSecrets,
): WebhookVerification {
  if (!secrets.webhookSecret) return invalidWebhook(); // webhookSecret = base64 HMAC key
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return invalidWebhook();
  }
  const body = isJsonRecord(payload) ? payload : {};
  const items = Array.isArray(body.notificationItems)
    ? body.notificationItems
        .map((entry: unknown) => (isJsonRecord(entry) ? entry.NotificationRequestItem : undefined))
        .filter(Boolean)
    : [];
  if (items.length === 0) return invalidWebhook();
  const keyBytes = Buffer.from(secrets.webhookSecret, "base64");
  const events: WebhookEvent[] = [];
  for (const rawItem of items) {
    // Non-object items cannot carry a signature; project them to {} so the
    // delivery-wide authentication below fails exactly as it did when every
    // field read came back undefined.
    const item: AdyenNotificationItem = isJsonRecord(rawItem) ? rawItem : {};
    const amount = isJsonRecord(item.amount) ? item.amount : undefined;
    const additionalData = isJsonRecord(item.additionalData) ? item.additionalData : undefined;
    // Adyen signs the concatenation of these fields with HMAC-SHA256 → base64.
    const message = [
      item.pspReference ?? "",
      item.originalReference ?? "",
      item.merchantAccountCode ?? "",
      item.merchantReference ?? "",
      amount?.value ?? "",
      amount?.currency ?? "",
      item.eventCode ?? "",
      item.success ?? "",
    ].join(":");
    const expected = createHmac("sha256", keyBytes).update(message, "utf8").digest("base64");
    const provided = additionalData?.["metadata.hmacSignature"] ?? additionalData?.hmacSignature;
    // Authentication is delivery-wide: never process a valid item from a
    // payload that also contains an item whose signature cannot be verified.
    if (!provided || !safeEqual(expected, String(provided))) return invalidWebhook();
    // The item is genuinely Adyen's, but its fields may still fail exact
    // normalization. Quarantine that one item with structured evidence — it
    // must neither crash the delivery boundary nor starve its signed siblings,
    // and settlement never runs on best-effort-parsed amounts.
    try {
      const event = normalizeAdyenNotificationItem(body, item);
      if (event) events.push(event);
    } catch (error) {
      logPaymentWebhookItemMalformed(
        "adyen",
        String(item.pspReference ?? ""),
        String(item.eventCode ?? ""),
        error,
      );
    }
  }
  return verifiedWebhook(events);
}

export const adyenAdapter: PaymentProviderAdapter = {
  key: "adyen",
  async createCheckout(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("adyen API key is not configured");
    if (!secrets.merchantAccount)
      throw new PaymentAcceptanceError("adyen merchant account is not configured");
    const total = add(req.invoiceAmount, req.surchargeAmount);
    const amountValue = Number(toAdyenMinorUnits(total, req.currency));
    if (!Number.isSafeInteger(amountValue))
      throw new PaymentAcceptanceError("adyen amount exceeds the safe integer range");
    const base = resolveAcceptanceProviderApiBase("adyen", secrets.apiBase);
    const res = await fetchFn(`${base}/sessions`, {
      method: "POST",
      redirect: "error",
      headers: { "x-api-key": secrets.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        merchantAccount: secrets.merchantAccount,
        reference: req.linkToken,
        amount: { currency: req.currency.toUpperCase(), value: amountValue },
        returnUrl: req.returnUrl,
        description: req.description.slice(0, 250),
        mode: "hosted",
      }),
    });
    const json = await fetchJsonBody(res);
    if (res.status >= 400)
      throw new PaymentAcceptanceError(`adyen session failed: ${json.message ?? res.status}`);
    if (
      typeof json.id !== "string" ||
      json.id === "" ||
      typeof json.url !== "string" ||
      json.url === ""
    ) {
      throw new PaymentAcceptanceError("adyen returned no session url");
    }
    return { redirectUrl: json.url, externalRef: json.id };
  },
  async createSetupSession(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("adyen API key is not configured");
    if (!secrets.merchantAccount)
      throw new PaymentAcceptanceError("adyen merchant account is not configured");
    // Tokenization-only payment link (€0 authorisation): the shopper saves a
    // method without moving money, stored for later ContAuth charges.
    const base = resolveAcceptanceProviderApiBase("adyen", secrets.apiBase);
    const res = await fetchFn(`${base}/paymentLinks`, {
      method: "POST",
      redirect: "error",
      headers: { "x-api-key": secrets.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        merchantAccount: secrets.merchantAccount,
        reference: req.linkToken,
        amount: { currency: req.currency.toUpperCase(), value: 0 },
        description: req.description.slice(0, 250),
        shopperReference: req.providerCustomerId ?? req.linkToken,
        shopperInteraction: "ContAuth",
        recurringProcessingModel: "Subscription",
        storePaymentMethodMode: "enabled",
      }),
    });
    const json = await fetchJsonBody(res);
    if (res.status >= 400)
      throw new PaymentAcceptanceError(`adyen setup link failed: ${json.message ?? res.status}`);
    if (
      typeof json.id !== "string" ||
      json.id === "" ||
      typeof json.url !== "string" ||
      json.url === ""
    ) {
      throw new PaymentAcceptanceError("adyen setup link returned no url");
    }
    return {
      redirectUrl: json.url,
      externalRef: json.id,
      providerCustomerId: req.providerCustomerId ?? req.linkToken,
    };
  },
  async chargeOffSession(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("adyen API key is not configured");
    if (!secrets.merchantAccount)
      throw new PaymentAcceptanceError("adyen merchant account is not configured");
    if (!req.providerCustomerId) {
      return { status: "failed", providerRef: null, declineCode: "missing_shopper_reference" };
    }
    const amountValue = Number(toAdyenMinorUnits(req.amount, req.currency));
    if (!Number.isSafeInteger(amountValue))
      throw new PaymentAcceptanceError("adyen amount exceeds the safe integer range");
    const base = resolveAcceptanceProviderApiBase("adyen", secrets.apiBase);
    const res = await fetchFn(`${base}/payments`, {
      method: "POST",
      redirect: "error",
      headers: {
        "x-api-key": secrets.apiKey,
        "content-type": "application/json",
        "Idempotency-Key": req.idempotencyKey,
      },
      body: JSON.stringify({
        merchantAccount: secrets.merchantAccount,
        reference: req.idempotencyKey,
        amount: { currency: req.currency.toUpperCase(), value: amountValue },
        paymentMethod: { storedPaymentMethodId: req.providerMethodId },
        shopperReference: req.providerCustomerId,
        shopperInteraction: "ContAuth",
        recurringProcessingModel: "Subscription",
      }),
    });
    const json = await fetchJsonBody(res);
    if (res.status >= 400) {
      const message = typeof json.message === "string" ? json.message : null;
      return { status: "failed", providerRef: null, declineCode: message ?? `http_${res.status}` };
    }
    const pspReference = typeof json.pspReference === "string" ? json.pspReference : "";
    if (json.resultCode === "Authorised") return { status: "succeeded", providerRef: pspReference };
    if (json.resultCode === "Received" || json.resultCode === "Pending")
      return { status: "processing", providerRef: pspReference };
    const refusal =
      typeof json.refusalReason === "string"
        ? json.refusalReason
        : typeof json.resultCode === "string"
          ? json.resultCode
          : null;
    if (
      json.resultCode === "ChallengeShopper" ||
      json.resultCode === "IdentifyShopper" ||
      json.resultCode === "RedirectShopper" ||
      json.resultCode === "PresentToShopper"
    ) {
      // Adyen asks the shopper to verify through the action URL: same
      // treatment as Stripe's requires_action — keep the link, never retry.
      const action = jsonObject(json.action);
      const authUrl = typeof action.url === "string" && action.url !== "" ? action.url : null;
      return {
        status: "requires_action",
        providerRef: pspReference || null,
        authUrl,
        declineCode: refusal,
      };
    }
    return { status: "failed", providerRef: pspReference || null, declineCode: refusal };
  },
  async detachMethod(secrets, req, fetchFn = defaultFetch) {
    if (!secrets.apiKey) throw new PaymentAcceptanceError("adyen API key is not configured");
    if (!secrets.merchantAccount)
      throw new PaymentAcceptanceError("adyen merchant account is not configured");
    if (!req.providerCustomerId)
      throw new PaymentAcceptanceError(
        "adyen stored method has no shopper reference; remove it locally instead",
      );
    // Stored details disable through the Recurring API (a different host from
    // Checkout): an unknown detail reference means the method is already
    // gone, so removal stays idempotent.
    const res = await fetchFn(`${resolveAdyenRecurringApiBase(secrets.recurringApiBase)}/disable`, {
      method: "POST",
      redirect: "error",
      headers: { "x-api-key": secrets.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        merchantAccount: secrets.merchantAccount,
        shopperReference: req.providerCustomerId,
        recurringDetailReference: req.providerMethodId,
      }),
    });
    const json = await fetchJsonBody(res);
    if (res.status >= 400) {
      const message = typeof json.message === "string" ? json.message : null;
      if (res.status === 422 && message?.includes("Unknown")) return;
      throw new PaymentAcceptanceError(
        `adyen stored method disable failed: ${message ?? res.status}`,
      );
    }
  },
  verifyWebhookDelivery: verifyAdyenWebhookDelivery,
  verifyWebhook(headers, rawBody, secrets) {
    return verifyAdyenWebhookDelivery(headers, rawBody, secrets).events[0] ?? null;
  },
};

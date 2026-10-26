/** Provider endpoint resolution, payload narrowing, and minor-unit
 *  conversion helpers shared by the acceptance provider adapters. */
import { fromUnits, toUnits } from "../money/money.ts";
import {
  type AcceptanceProvider,
  type FetchFn,
  PaymentAcceptanceError,
  type WebhookEvent,
  type WebhookVerification,
} from "./acceptance-types.ts";
import { THREE_DECIMAL_CURRENCIES, ZERO_DECIMAL_CURRENCIES } from "./minor-units.ts";
import { createHmac, timingSafeEqual } from "node:crypto";

// Credential-bearing requests refuse redirects at the network boundary as
// well as in the provider request contract.
export const defaultFetch: FetchFn = (url, init) => fetch(url, { ...init, redirect: "error" });

export const DEFAULT_ACCEPTANCE_API_BASES = {
  stripe: "https://api.stripe.com",
  adyen: "https://checkout-test.adyen.com/v71",
  gocardless: "https://api-sandbox.gocardless.com",
} as const satisfies Record<AcceptanceProvider, string>;

/** Narrow an untrusted provider payload to a field bag. Anything that is
 *  not a JSON object projects to {} so every existing optional read keeps
 *  its missing-envelope meaning. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read our link token off an untrusted event object. A present-but-not-a-
 *  string reference fails closed to null instead of flowing a foreign type
 *  into attempt resolution. */
export function stringLinkToken(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Project an untrusted provider field onto a field bag ({} when absent). */
export function jsonObject(value: unknown): Record<string, unknown> {
  return isJsonRecord(value) ? value : {};
}

/** Read one provider JSON body as a field bag, consuming the response once.
 * The read is infallible by design: a non-JSON error body — a WAF's HTML
 * 502, an empty gateway response, a truncated proxy — must surface through
 * the caller's composed refusal, which names the provider and falls back to
 * the HTTP status, never as a SyntaxError thrown from this line that
 * displaces it. An unparseable body reads as an empty bag, so `?? res.status`
 * is what the operator sees. */
export async function fetchJsonBody(res: {
  json: () => Promise<unknown>;
}): Promise<Record<string, unknown>> {
  return jsonObject(await res.json().catch(() => null));
}

export function invalidProviderEndpoint(provider: AcceptanceProvider): PaymentAcceptanceError {
  return new PaymentAcceptanceError(`${provider} API endpoint is not allowlisted`);
}

/** Validate and canonicalize a provider API base before it can reach fetch.
 *  Adyen live Checkout hosts are merchant-specific, so their documented host
 *  shape is allowlisted in addition to the fixed test host. */
export function resolveAcceptanceProviderApiBase(
  provider: AcceptanceProvider,
  configuredApiBase?: string,
): string {
  const candidate = configuredApiBase ?? DEFAULT_ACCEPTANCE_API_BASES[provider];
  let endpoint: URL;
  try {
    endpoint = new URL(candidate);
  } catch {
    throw invalidProviderEndpoint(provider);
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.port !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw invalidProviderEndpoint(provider);
  }

  const host = endpoint.hostname.toLowerCase();
  const path = endpoint.pathname.replace(/\/+$/, "");
  if (provider === "stripe") {
    if (host !== "api.stripe.com" || path !== "") throw invalidProviderEndpoint(provider);
  } else if (provider === "gocardless") {
    if ((host !== "api.gocardless.com" && host !== "api-sandbox.gocardless.com") || path !== "") {
      throw invalidProviderEndpoint(provider);
    }
  } else {
    const testEndpoint = host === "checkout-test.adyen.com" && /^\/v\d+$/.test(path);
    const liveEndpoint =
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-checkout-live(?:-(?:au|us|apse))?\.adyenpayments\.com$/.test(
        host,
      ) && /^\/checkout\/v\d+$/.test(path);
    if (!testEndpoint && !liveEndpoint) throw invalidProviderEndpoint(provider);
  }
  return `${endpoint.origin}${path}`;
}

/** Apply endpoint policy when configuration enters the engine. The same
 *  resolver is called again by each adapter so legacy rows also fail closed. */
export function normalizeAcceptanceProviderSettings(
  provider: AcceptanceProvider,
  settings: Record<string, unknown> = {},
): Record<string, unknown> {
  const normalized = { ...settings };
  if (Object.prototype.hasOwnProperty.call(settings, "apiBase")) {
    if (typeof settings.apiBase !== "string" || settings.apiBase.trim() === "") {
      throw invalidProviderEndpoint(provider);
    }
    normalized.apiBase = resolveAcceptanceProviderApiBase(provider, settings.apiBase.trim());
  }
  if (provider === "adyen" && Object.prototype.hasOwnProperty.call(settings, "recurringApiBase")) {
    if (typeof settings.recurringApiBase !== "string" || settings.recurringApiBase.trim() === "") {
      throw invalidProviderEndpoint(provider);
    }
    normalized.recurringApiBase = resolveAdyenRecurringApiBase(settings.recurringApiBase.trim());
  }
  return normalized;
}

/** Adyen Recurring API base (stored-detail disable). The Checkout resolver
 *  above only admits checkout hosts, so this separate resolver admits the
 *  documented pal hosts in the same strict shape (https, no user/port/path). */
export function resolveAdyenRecurringApiBase(configuredApiBase?: string): string {
  const candidate = configuredApiBase ?? "https://pal-test.adyen.com/pal/servlet/Recurring/v68";
  let endpoint: URL;
  try {
    endpoint = new URL(candidate);
  } catch {
    throw invalidProviderEndpoint("adyen");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.port !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw invalidProviderEndpoint("adyen");
  }
  const host = endpoint.hostname.toLowerCase();
  const path = endpoint.pathname.replace(/\/+$/, "");
  const testEndpoint =
    host === "pal-test.adyen.com" && /^\/pal\/servlet\/Recurring\/v\d+$/.test(path);
  const liveEndpoint =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-pal-live\.adyenpayments\.com$/.test(host) &&
    /^\/pal\/servlet\/Recurring\/v\d+$/.test(path);
  if (!testEndpoint && !liveEndpoint) throw invalidProviderEndpoint("adyen");
  return `${endpoint.origin}${path}`;
}

/** Adyen's currency table differs from Stripe/ISO for CLP, CVE, IDR, and ISK. */
export const ADYEN_ZERO_DECIMAL = new Set([
  "CVE",
  "DJF",
  "GNF",
  "IDR",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

export const ADYEN_THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "OMR", "TND"]);

/** Major-unit money string → provider minor units (exact; rejects sub-minor precision). */
export function toMinorUnits(amount: string, currency: string): string {
  const units = toUnits(amount); // 1e4 scale
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) {
    if (units % 10_000n !== 0n)
      throw new PaymentAcceptanceError(`${currency} amounts must be whole units`);
    return (units / 10_000n).toString();
  }
  // Stripe supports three-decimal currencies (e.g. BHD in fils): converting
  // them at two decimals would misstate every amount 10x.
  if (THREE_DECIMAL_CURRENCIES.has(code)) {
    if (units % 10n !== 0n)
      throw new PaymentAcceptanceError(`amount ${amount} has sub-fils precision`);
    return (units / 10n).toString();
  }
  if (units % 100n !== 0n)
    throw new PaymentAcceptanceError(`amount ${amount} has sub-cent precision`);
  return (units / 100n).toString();
}

export function adyenMinorUnitDecimals(currency: string): 0 | 2 | 3 {
  const code = currency.toUpperCase();
  if (ADYEN_ZERO_DECIMAL.has(code)) return 0;
  if (ADYEN_THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export function toAdyenMinorUnits(amount: string, currency: string): string {
  const decimals = adyenMinorUnitDecimals(currency);
  const divisor = 10n ** BigInt(4 - decimals);
  const units = toUnits(amount);
  if (units % divisor !== 0n) {
    throw new PaymentAcceptanceError(
      `${currency} amounts cannot exceed ${decimals}-decimal minor-unit precision`,
    );
  }
  return (units / divisor).toString();
}

export function fromAdyenMinorUnits(amount: bigint, currency: string): string {
  const decimals = adyenMinorUnitDecimals(currency);
  return fromUnits(amount * 10n ** BigInt(4 - decimals));
}

export function hmacSha256Hex(secret: string | Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function invalidWebhook(): WebhookVerification {
  return { signatureValid: false, events: [] };
}

export function verifiedWebhook(events: WebhookEvent[]): WebhookVerification {
  return { signatureValid: true, events };
}

/** Stable structured-log key for an event whose tenant transaction rolled
 * back. The emission happens outside that transaction so poison evidence is
 * not lost with the accounting writes it protects. */
export const PAYMENT_WEBHOOK_EVENT_FAILURE_LOG_EVENT = "payment_webhook.event_failed";

export function logPaymentWebhookEventFailure(
  provider: AcceptanceProvider,
  orgId: string,
  event: WebhookEvent,
  error: unknown,
): void {
  console.error(
    JSON.stringify({
      event: PAYMENT_WEBHOOK_EVENT_FAILURE_LOG_EVENT,
      provider,
      orgId,
      externalRef: event.externalRef,
      eventStatus: event.status,
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    }),
  );
}

/**
 * Stable structured-log key for a signature-valid provider item whose fields
 * could not be normalized exactly. Quarantine happens during normalization —
 * before any tenant context exists — so the emission carries the item's own
 * identity rather than an orgId.
 */
export const PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT = "payment_webhook.item_malformed";

export function logPaymentWebhookItemMalformed(
  provider: AcceptanceProvider,
  externalRef: string,
  itemTypeOrCode: string,
  error: unknown,
): void {
  console.error(
    JSON.stringify({
      event: PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT,
      provider,
      externalRef,
      itemTypeOrCode,
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    }),
  );
}

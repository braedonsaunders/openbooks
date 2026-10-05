import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchWithConnectorRetry } from "./http-retry.ts";

/**
 * Channel-neutral carrier contract both aggregator adapters speak. The
 * adapters translate EasyPost and Shippo payloads into these shapes; posting
 * code never branches on a provider name. Amounts are exact decimal strings
 * in the quoted currency — minor-unit conversion happens in sales against
 * the tenant currencies table, never here, so this module stays dependency
 * free and safe to unit test without a database.
 */

export type ShippingProviderKey = "easypost" | "shippo";

export interface CarrierContext {
  apiKey: string;
  /** Overridden in tests to point at the fake provider server. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Test transport; production callers use the shared pinned guard. */
  transport?: typeof fetch;
}

export interface CarrierAddress {
  name: string | null;
  street1: string;
  street2: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string | null;
  email: string | null;
}

export interface CarrierParcel {
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
  /** Kilograms, exact decimal string. */
  weightKg: string;
}

export interface CarrierCustomsItem {
  description: string;
  quantity: number;
  /** Exact decimal string in `valueCurrency`. */
  valueAmount: string;
  valueCurrency: string;
  hsCode: string | null;
  originCountry: string | null;
}

export interface CarrierRateRequest {
  fromAddress: CarrierAddress;
  toAddress: CarrierAddress;
  parcels: CarrierParcel[];
  customsItems: CarrierCustomsItem[];
  customsContentsType: string | null;
  customsContentsExplanation: string | null;
  insuranceAmount: string | null;
  insuranceCurrency: string | null;
  signature: "none" | "direct" | "adult";
}

export interface CarrierRate {
  providerRateId: string;
  carrier: string;
  service: string;
  /** Exact decimal string in `currency`. */
  amount: string;
  currency: string;
  deliveryDate: string | null;
  deliveryDays: number | null;
}

/** One provider shipment's rates; EasyPost yields one per parcel, Shippo one per request. */
export interface CarrierRateOption {
  providerShipmentId: string;
  parcelIndexes: number[];
  rates: CarrierRate[];
}

export interface CarrierBoughtLabel {
  providerShipmentId: string;
  providerRateId: string;
  providerLabelId: string | null;
  labelUrl: string | null;
  trackingNumber: string | null;
  carrier: string;
  service: string;
  amount: string;
  currency: string;
}

export interface CarrierTrackerEvent {
  id: string | null;
  status: string;
  detail: string | null;
  occurredAt: string | null;
}

export interface CarrierTrackerState {
  status: string;
  events: CarrierTrackerEvent[];
}

export interface CarrierAddressSuggestion {
  valid: boolean;
  messages: string[];
  suggestion: CarrierAddress | null;
}

export interface CarrierTrackerRef {
  trackerId?: string;
  carrier?: string;
  trackingNumber?: string;
  providerShipmentId?: string;
}

export interface CarrierInboundEvent {
  eventId: string;
  tracker: CarrierTrackerRef;
}

export interface CarrierAdapter {
  readonly key: ShippingProviderKey;
  requestRates(ctx: CarrierContext, req: CarrierRateRequest): Promise<CarrierRateOption[]>;
  buyLabel(ctx: CarrierContext, providerShipmentId: string, providerRateId: string): Promise<CarrierBoughtLabel>;
  voidLabel(
    ctx: CarrierContext,
    ref: { providerShipmentId: string; providerLabelId: string | null },
  ): Promise<{ accepted: boolean; rawStatus: string }>;
  validateAddress(ctx: CarrierContext, address: CarrierAddress): Promise<CarrierAddressSuggestion>;
  getTracker(ctx: CarrierContext, ref: CarrierTrackerRef): Promise<CarrierTrackerState>;
  /** Normalize an inbound tracker delivery, or null when it is not one. Never throws on shape. */
  parseInboundEvent(raw: unknown): CarrierInboundEvent | null;
}

/** A provider call the hub refuses to treat as data. Names the provider, the call, and the remedy. */
export class CarrierError extends Error {
  readonly name = "CarrierError";

  constructor(
    message: string,
    readonly remedy = "Check the carrier account, then retry; if it persists, re-enter the API key in Warehouse → Shipping",
  ) {
    super(message);
  }
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function fail(what: string): never {
  throw new CarrierError(what);
}

/** Exact decimal string, no floats: "12.34" stays 12.34 through every conversion below. */
export function assertDecimal(value: string, what: string): string {
  if (typeof value !== "string" || !DECIMAL_RE.test(value.trim())) fail(`${what} must be a decimal number, got ${JSON.stringify(value)}`);
  const negative = value.trim().startsWith("-");
  const unsigned = value.trim().replace(/^-/, "").replace(/^0+(?=\d)/, "") || "0";
  return negative ? `-${unsigned}` : unsigned;
}

function splitDecimal(value: string): { neg: boolean; int: string; frac: string } {
  const cleaned = assertDecimal(value, "amount");
  const neg = cleaned.startsWith("-");
  const [int = "0", frac = ""] = (neg ? cleaned.slice(1) : cleaned).split(".");
  return { neg, int: int === "" ? "0" : int, frac };
}

/**
 * Exact decimal multiplication by a decimal factor, half-up to `places`.
 * Used for parcel unit conversion (cm→in, kg→oz): carrier rating rounds
 * measures, so the rounding is explicit here instead of hidden in floats.
 */
export function mulDecimal(value: string, factor: string, places: number): string {
  const a = splitDecimal(value);
  const b = splitDecimal(factor);
  if (a.neg || b.neg) fail("unit conversion needs non-negative measures");
  const product = BigInt(a.int + a.frac) * BigInt(b.int + b.frac);
  const scale = a.frac.length + b.frac.length;
  const target = 10n ** BigInt(places);
  const scaled = product * target;
  const divisor = 10n ** BigInt(scale);
  const rounded = (scaled + divisor / 2n) / divisor;
  const int = rounded / target;
  const frac = (rounded % target).toString().padStart(places, "0");
  return places === 0 ? int.toString() : `${int}.${frac}`;
}

/** Exact cm→in and kg→oz for provider payloads, half-up to 4 places. */
export const cmToIn = (cm: string): string => mulDecimal(cm, "0.393701", 4);
export const kgToOz = (kg: string): string => mulDecimal(kg, "35.273962", 4);

/**
 * Exact decimal → minor units for a currency exponent ("12.34", 2 → 1234n).
 * Extra precision rounds half-up; a non-decimal refuses instead of guessing.
 */
export function decimalToMinorUnits(amount: string, minorUnits: number): bigint {
  const { neg, int, frac } = splitDecimal(amount);
  if (minorUnits < 0 || minorUnits > 4 || !Number.isInteger(minorUnits)) fail(`unsupported currency precision ${minorUnits}`);
  const kept = frac.slice(0, minorUnits).padEnd(minorUnits, "0");
  let minor = BigInt(int === "" ? "0" : int) * 10n ** BigInt(minorUnits) + (kept === "" ? 0n : BigInt(kept));
  // Half-up on the discarded fraction: a first dropped digit of 5 or more rounds up.
  if ((frac.slice(minorUnits)[0] ?? "0") >= "5") minor += 1n;
  return neg ? -minor : minor;
}

/** Minor units → ledger decimal string (at most 4 places, never floats). */
export function minorUnitsToLedger(minor: bigint, minorUnits: number): string {
  if (minorUnits < 0 || minorUnits > 4 || !Number.isInteger(minorUnits)) fail(`unsupported currency precision ${minorUnits}`);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const base = 10n ** BigInt(minorUnits);
  const int = abs / base;
  const frac = abs % base;
  const text = minorUnits === 0 ? int.toString() : `${int}.${frac.toString().padStart(minorUnits, "0")}`;
  return negative ? `-${text}` : text;
}

/** Status FIRST, parse second: an error body never becomes a SyntaxError. */
export async function readProviderJson(res: Response, describe: string): Promise<unknown> {
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      detail = "";
    }
    fail(`${describe} refused with HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  try {
    return (await res.json()) as unknown;
  } catch {
    fail(`${describe} returned a body that is not JSON`);
  }
}

export function providerHeaders(ctx: CarrierContext, extra: Record<string, string>): Record<string, string> {
  if (!ctx.apiKey) fail("the carrier account has no API key");
  return extra;
}

export async function callProvider(
  adapter: string,
  ctx: CarrierContext,
  path: string,
  init: RequestInit,
  describe: string,
): Promise<unknown> {
  const base = (ctx.baseUrl ?? "").replace(/\/$/, "");
  if (!base) fail(`${adapter} has no endpoint configured`);
  const res = await fetchWithConnectorRetry(`${base}${path}`, init, {
    describe: `${adapter} ${describe}`,
    timeoutMs: ctx.timeoutMs,
    transport: ctx.transport,
  });
  return readProviderJson(res, `${adapter} ${describe}`);
}

/**
 * Relay-signature verification for inbound tracker deliveries, the same
 * `t.body` HMAC scheme the outbound webhook catalog signs with: the
 * timestamp binds the body against replay, and the comparison is
 * constant-time. Aggregator callbacks carry no provider signature, so every
 * delivery is ALSO confirmed by re-reading the tracker over the sealed API
 * key before any state changes — a signature alone never moves a parcel.
 */
export function verifyRelaySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((piece) => {
      const [k, ...rest] = piece.split("=");
      return [k?.trim(), rest.join("=").trim()];
    }),
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1 || !/^\d+$/.test(t)) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const a = Buffer.from(v1);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

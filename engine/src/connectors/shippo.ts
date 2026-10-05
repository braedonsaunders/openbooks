import {
  callProvider,
  type CarrierAddress,
  type CarrierAdapter,
  type CarrierAddressSuggestion,
  type CarrierBoughtLabel,
  type CarrierContext,
  CarrierError,
  type CarrierCustomsItem,
  type CarrierInboundEvent,
  type CarrierRate,
  type CarrierRateOption,
  type CarrierRateRequest,
  type CarrierTrackerRef,
  type CarrierTrackerState,
  providerHeaders,
} from "./shipping.ts";

/**
 * Shippo HTTP client (api.goshippo.com, ShippoToken scheme). One provider
 * shipment carries every parcel, so a multi-parcel rate request is a single
 * call. Responses are validated field by field like the EasyPost client —
 * an unexpected shape refuses by name instead of posting a guess.
 */

export const SHIPPO_DEFAULT_BASE_URL = "https://api.goshippo.com";

function base(ctx: CarrierContext): string {
  return (ctx.baseUrl ?? SHIPPO_DEFAULT_BASE_URL).replace(/\/$/, "");
}

function auth(ctx: CarrierContext): Record<string, string> {
  providerHeaders(ctx, {});
  return {
    Authorization: `ShippoToken ${ctx.apiKey}`,
    "Content-Type": "application/json",
  };
}

async function post(ctx: CarrierContext, path: string, body: unknown, describe: string): Promise<unknown> {
  return callProvider("Shippo", { ...ctx, baseUrl: base(ctx) }, path, {
    method: "POST",
    headers: auth(ctx),
    body: JSON.stringify(body),
  }, describe);
}

async function get(ctx: CarrierContext, path: string, describe: string): Promise<unknown> {
  return callProvider("Shippo", { ...ctx, baseUrl: base(ctx) }, path, {
    method: "GET",
    headers: auth(ctx),
  }, describe);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, field: string, what: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CarrierError(`Shippo ${what} is missing ${field}`);
  }
  return value;
}

function optStr(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function addressPayload(address: CarrierAddress): Record<string, unknown> {
  return {
    name: address.name,
    street1: address.street1,
    street2: address.street2,
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: address.country,
    phone: address.phone,
    email: address.email,
  };
}

function mapRate(raw: unknown): CarrierRate {
  if (!isRecord(raw)) throw new CarrierError("Shippo rate is not an object");
  const service = isRecord(raw["servicelevel"]) ? raw["servicelevel"] : null;
  const days = raw["estimated_days"];
  return {
    providerRateId: str(raw, "object_id", "rate"),
    carrier: optStr(raw, "provider") ?? "unknown",
    service: service ? (optStr(service, "name") ?? optStr(service, "token") ?? "unknown") : "unknown",
    amount: str(raw, "amount", "rate"),
    currency: optStr(raw, "currency") ?? "USD",
    deliveryDate: null,
    deliveryDays: typeof days === "number" && Number.isInteger(days) && days >= 0 ? days : null,
  };
}

/** Parse a created shipment: its id plus every quoted rate. */
export function parseShipmentRates(raw: unknown): { providerShipmentId: string; rates: CarrierRate[] } {
  if (!isRecord(raw)) throw new CarrierError("Shippo shipment is not an object");
  const status = optStr(raw, "status");
  if (status && status !== "SUCCESS" && status !== "QUEUED") {
    const messages = Array.isArray(raw["messages"]) ? raw["messages"] : [];
    const first = messages.filter(isRecord).map((message) => optStr(message, "text")).find(Boolean);
    throw new CarrierError(`Shippo rate shopping failed with status ${status}${first ? `: ${first}` : ""}`);
  }
  const rates = raw["rates"];
  if (!Array.isArray(rates)) throw new CarrierError("Shippo shipment carries no rates array");
  return { providerShipmentId: str(raw, "object_id", "shipment"), rates: rates.map(mapRate) };
}

/** Parse a bought transaction: outcome checked first, artefacts second. */
export function parseBoughtLabel(raw: unknown, providerRateId: string): CarrierBoughtLabel {
  if (!isRecord(raw)) throw new CarrierError("Shippo transaction is not an object");
  const status = optStr(raw, "status");
  if (status !== "SUCCESS" && status !== "QUEUED") {
    const messages = Array.isArray(raw["messages"]) ? raw["messages"] : [];
    const first = messages.filter(isRecord).map((message) => optStr(message, "text")).find(Boolean);
    throw new CarrierError(`Shippo label purchase failed with status ${status ?? "unknown"}${first ? `: ${first}` : ""}`);
  }
  return {
    providerShipmentId: optStr(raw, "shipment") ?? "",
    providerRateId,
    providerLabelId: optStr(raw, "object_id"),
    labelUrl: optStr(raw, "label_url"),
    trackingNumber: optStr(raw, "tracking_number"),
    carrier: optStr(raw, "provider") ?? "unknown",
    service: optStr(raw, "servicelevel_name") ?? "unknown",
    amount: optStr(raw, "rate") ?? "0",
    currency: optStr(raw, "currency") ?? "USD",
  };
}

/** Shippo tracking states onto the hub vocabulary. */
export function mapTrackerStatus(status: string): string {
  switch (status.toUpperCase()) {
    case "PRE_TRANSIT": return "pre_transit";
    case "TRANSIT": return "in_transit";
    case "DELIVERED": return "delivered";
    case "RETURNED": return "returned";
    case "FAILURE": return "exception";
    default: return "unknown";
  }
}

/** Parse a track lookup: status plus the full visible history. */
export function parseTracker(raw: unknown): CarrierTrackerState {
  if (!isRecord(raw)) throw new CarrierError("Shippo track answer is not an object");
  const current = isRecord(raw["tracking_status"]) ? raw["tracking_status"] : null;
  const history = Array.isArray(raw["tracking_history"]) ? raw["tracking_history"] : [];
  return {
    status: current ? mapTrackerStatus(optStr(current, "status") ?? "UNKNOWN") : "unknown",
    events: history.filter(isRecord).map((entry) => ({
      id: null,
      status: mapTrackerStatus(optStr(entry, "status") ?? "UNKNOWN"),
      detail: optStr(entry, "status_details") ?? optStr(entry, "location"),
      occurredAt: optStr(entry, "status_date"),
    })),
  };
}

/** Parse an address validation answer. */
export function parseAddressValidation(raw: unknown): CarrierAddressSuggestion {
  if (!isRecord(raw)) throw new CarrierError("Shippo address answer is not an object");
  const result = isRecord(raw["validation_results"]) ? raw["validation_results"] : null;
  if (!result) throw new CarrierError("Shippo address answer carries no validation results");
  const messages = Array.isArray(result["messages"]) ? result["messages"] : [];
  return {
    valid: result["is_valid"] === true,
    messages: messages.filter(isRecord).map((message) => optStr(message, "text") ?? "address error").slice(0, 10),
    suggestion: null,
  };
}

export const shippoAdapter: CarrierAdapter = {
  key: "shippo",

  async requestRates(ctx: CarrierContext, req: CarrierRateRequest): Promise<CarrierRateOption[]> {
    const body: Record<string, unknown> = {
      address_from: addressPayload(req.fromAddress),
      address_to: addressPayload(req.toAddress),
      parcels: req.parcels.map((parcel) => ({
        length: parcel.lengthCm,
        width: parcel.widthCm,
        height: parcel.heightCm,
        distance_unit: "cm",
        weight: parcel.weightKg,
        mass_unit: "kg",
      })),
      async: false,
    };
    if (req.customsItems.length > 0) {
      body["customs_declaration"] = {
        contents_type: req.customsContentsType ?? "MERCHANDISE",
        eel_pfc: "NOEEI_30_37_a",
        customs_items: req.customsItems.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          net_weight: item.netWeightKg ?? "0",
          mass_unit: "kg",
          value_amount: item.valueAmount,
          value_currency: item.valueCurrency,
          tariff_number: item.hsCode,
          origin_country: item.originCountry,
        })),
      };
    }
    const raw = await post(ctx, "/shipments/", body, "rate shopping");
    const parsed = parseShipmentRates(raw);
    return [{
      providerShipmentId: parsed.providerShipmentId,
      parcelIndexes: req.parcels.map((_, index) => index),
      rates: parsed.rates,
    }];
  },

  async buyLabel(ctx: CarrierContext, _providerShipmentId: string, providerRateId: string): Promise<CarrierBoughtLabel> {
    const raw = await post(ctx, "/transactions/", { rate: providerRateId, async: false }, "label purchase");
    return parseBoughtLabel(raw, providerRateId);
  },

  async voidLabel(
    ctx: CarrierContext,
    ref: { providerShipmentId: string; providerLabelId: string | null },
  ): Promise<{ accepted: boolean; rawStatus: string }> {
    if (!ref.providerLabelId) throw new CarrierError("Shippo refund needs the purchased transaction id");
    const raw = await post(ctx, "/refunds/", { transaction: ref.providerLabelId, async: false }, "label refund");
    const status = isRecord(raw) ? (optStr(raw, "status") ?? "unknown") : "unknown";
    return { accepted: status !== "ERROR", rawStatus: status };
  },

  async validateAddress(ctx: CarrierContext, address: CarrierAddress): Promise<CarrierAddressSuggestion> {
    const raw = await post(ctx, "/addresses/", { ...addressPayload(address), validate: true }, "address validation");
    return parseAddressValidation(raw);
  },

  async getTracker(ctx: CarrierContext, ref: CarrierTrackerRef): Promise<CarrierTrackerState> {
    if (ref.carrier && ref.trackingNumber) {
      return parseTracker(await get(
        ctx,
        `/tracks/${encodeURIComponent(ref.carrier)}/${encodeURIComponent(ref.trackingNumber)}/`,
        "tracker refresh",
      ));
    }
    throw new CarrierError("Shippo tracker refresh needs a carrier plus tracking number");
  },

  parseInboundEvent(raw: unknown): CarrierInboundEvent | null {
    if (!isRecord(raw)) return null;
    if (typeof raw["event"] !== "string" || !raw["event"].startsWith("track_")) return null;
    const eventId = optStr(raw, "id") ?? optStr(raw, "event_id");
    const data = isRecord(raw["data"]) ? raw["data"] : null;
    if (!eventId || !data) return null;
    const trackingNumber = optStr(data, "tracking_number");
    if (!trackingNumber) return null;
    return {
      eventId,
      tracker: {
        carrier: optStr(data, "carrier") ?? undefined,
        trackingNumber,
      },
    };
  },
};

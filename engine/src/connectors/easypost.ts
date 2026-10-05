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
  type CarrierParcel,
  type CarrierRate,
  type CarrierRateOption,
  type CarrierRateRequest,
  type CarrierTrackerRef,
  type CarrierTrackerState,
  cmToIn,
  kgToOz,
  providerHeaders,
} from "./shipping.ts";

/**
 * EasyPost HTTP client (api.easypost.com, key as the Basic username).
 * One provider shipment carries ONE parcel, so a multi-parcel rate request
 * becomes one shipment per parcel; the domain buys each parcel's rate and
 * keeps one label row per parcel. Every response is validated field by
 * field — an unexpected shape refuses by name instead of posting a guess.
 */

export const EASYPOST_DEFAULT_BASE_URL = "https://api.easypost.com";

function base(ctx: CarrierContext): string {
  return (ctx.baseUrl ?? EASYPOST_DEFAULT_BASE_URL).replace(/\/$/, "");
}

function auth(ctx: CarrierContext): Record<string, string> {
  providerHeaders(ctx, {});
  return {
    Authorization: `Basic ${Buffer.from(`${ctx.apiKey}:`, "utf8").toString("base64")}`,
    "Content-Type": "application/json",
  };
}

async function post(ctx: CarrierContext, path: string, body: unknown, describe: string): Promise<unknown> {
  return callProvider("EasyPost", { ...ctx, baseUrl: base(ctx) }, path, {
    method: "POST",
    headers: auth(ctx),
    body: JSON.stringify(body),
  }, describe);
}

async function get(ctx: CarrierContext, path: string, describe: string): Promise<unknown> {
  return callProvider("EasyPost", { ...ctx, baseUrl: base(ctx) }, path, {
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
    throw new CarrierError(`EasyPost ${what} is missing ${field}`);
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

function parcelPayload(parcel: CarrierParcel): Record<string, unknown> {
  const payload: Record<string, unknown> = { weight: kgToOz(parcel.weightKg) };
  if (parcel.lengthCm != null) payload["length"] = cmToIn(parcel.lengthCm);
  if (parcel.widthCm != null) payload["width"] = cmToIn(parcel.widthCm);
  if (parcel.heightCm != null) payload["height"] = cmToIn(parcel.heightCm);
  return payload;
}

function customsPayload(items: CarrierCustomsItem[], contentsType: string | null, explanation: string | null): Record<string, unknown> {
  return {
    contents_type: contentsType ?? "merchandise",
    contents_explanation: explanation ?? "goods",
    customs_items: items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      value: item.valueAmount,
      hs_tariff_number: item.hsCode,
      origin_country: item.originCountry,
    })),
  };
}

function mapRate(raw: unknown): CarrierRate {
  if (!isRecord(raw)) throw new CarrierError("EasyPost rate is not an object");
  const amount = optStr(raw, "rate");
  const currency = optStr(raw, "currency") ?? "USD";
  if (!amount) throw new CarrierError("EasyPost rate is missing its amount");
  const deliveryDate = optStr(raw, "delivery_date");
  const days = raw["delivery_days"];
  return {
    providerRateId: str(raw, "id", "rate"),
    carrier: optStr(raw, "carrier") ?? "unknown",
    service: optStr(raw, "service") ?? "unknown",
    amount,
    currency,
    deliveryDate: deliveryDate && /^\d{4}-\d{2}-\d{2}/.test(deliveryDate) ? deliveryDate.slice(0, 10) : null,
    deliveryDays: typeof days === "number" && Number.isInteger(days) && days >= 0 ? days : null,
  };
}

function mapTracker(raw: unknown): CarrierTrackerState {
  if (!isRecord(raw)) throw new CarrierError("EasyPost tracker is not an object");
  const status = (optStr(raw, "status") ?? "unknown").toLowerCase();
  const details = Array.isArray(raw["tracking_details"]) ? raw["tracking_details"] : [];
  return {
    status: mapTrackerStatus(status),
    events: details.filter(isRecord).map((detail) => ({
      id: null,
      status: mapTrackerStatus(String(detail["status"] ?? "unknown").toLowerCase()),
      detail: optStr(detail, "message"),
      occurredAt: optStr(detail, "datetime"),
    })),
  };
}

/** EasyPost tracker states onto the hub vocabulary. */
export function mapTrackerStatus(status: string): string {
  switch (status) {
    case "pre_transit": return "pre_transit";
    case "in_transit": return "in_transit";
    case "out_for_delivery": return "out_for_delivery";
    case "delivered": return "delivered";
    case "return_to_sender": return "returned";
    case "failure":
    case "error": return "exception";
    case "cancelled": return "cancelled";
    default: return "unknown";
  }
}

/** Parse one created shipment: its id plus every quoted rate. */
export function parseShipmentRates(raw: unknown): { providerShipmentId: string; rates: CarrierRate[] } {
  if (!isRecord(raw)) throw new CarrierError("EasyPost shipment is not an object");
  const rates = raw["rates"];
  if (!Array.isArray(rates)) throw new CarrierError("EasyPost shipment carries no rates array");
  return { providerShipmentId: str(raw, "id", "shipment"), rates: rates.map(mapRate) };
}

/** Parse a bought shipment: label artefacts plus the charged rate. */
export function parseBoughtLabel(raw: unknown, providerShipmentId: string, providerRateId: string): CarrierBoughtLabel {
  if (!isRecord(raw)) throw new CarrierError("EasyPost bought shipment is not an object");
  const label = isRecord(raw["postage_label"]) ? raw["postage_label"] : null;
  const selected = isRecord(raw["selected_rate"]) ? raw["selected_rate"] : null;
  return {
    providerShipmentId,
    providerRateId,
    providerLabelId: label ? optStr(label, "id") : null,
    labelUrl: label ? (optStr(label, "label_pdf_url") ?? optStr(label, "label_url")) : null,
    trackingNumber: optStr(raw, "tracking_code"),
    carrier: selected ? (optStr(selected, "carrier") ?? "unknown") : "unknown",
    service: selected ? (optStr(selected, "service") ?? "unknown") : "unknown",
    amount: selected ? (optStr(selected, "rate") ?? "0") : "0",
    currency: selected ? (optStr(selected, "currency") ?? "USD") : "USD",
  };
}

/** Parse an address verification answer without ever trusting it blindly. */
export function parseAddressVerification(raw: unknown): CarrierAddressSuggestion {
  if (!isRecord(raw)) throw new CarrierError("EasyPost address answer is not an object");
  const verifications = isRecord(raw["verifications"]) ? raw["verifications"] : null;
  const delivery = verifications && isRecord(verifications["delivery"]) ? verifications["delivery"] : null;
  if (!delivery) throw new CarrierError("EasyPost address answer carries no delivery verification");
  const success = delivery["success"] === true;
  const errors = Array.isArray(delivery["errors"]) ? delivery["errors"] : [];
  return {
    valid: success,
    messages: errors.filter(isRecord).map((error) => optStr(error, "message") ?? "address error").slice(0, 10),
    suggestion: null,
  };
}

export const easyPostAdapter: CarrierAdapter = {
  key: "easypost",

  async requestRates(ctx: CarrierContext, req: CarrierRateRequest): Promise<CarrierRateOption[]> {
    const options: CarrierRateOption[] = [];
    for (const [parcelIndex, parcel] of req.parcels.entries()) {
      const shipment: Record<string, unknown> = {
        to_address: addressPayload(req.toAddress),
        from_address: addressPayload(req.fromAddress),
        parcel: parcelPayload(parcel),
        options: { label_format: "PDF" },
      };
      if (req.customsItems.length > 0) {
        shipment["customs_info"] = customsPayload(req.customsItems, req.customsContentsType, req.customsContentsExplanation);
      }
      const raw = await post(ctx, "/v2/shipments", { shipment }, "rate shopping");
      const parsed = parseShipmentRates(raw);
      options.push({ providerShipmentId: parsed.providerShipmentId, parcelIndexes: [parcelIndex], rates: parsed.rates });
    }
    return options;
  },

  async buyLabel(ctx: CarrierContext, providerShipmentId: string, providerRateId: string): Promise<CarrierBoughtLabel> {
    const raw = await post(ctx, `/v2/shipments/${encodeURIComponent(providerShipmentId)}/buy`, {
      rate: { id: providerRateId },
    }, "label purchase");
    return parseBoughtLabel(raw, providerShipmentId, providerRateId);
  },

  async voidLabel(
    ctx: CarrierContext,
    ref: { providerShipmentId: string; providerLabelId: string | null },
  ): Promise<{ accepted: boolean; rawStatus: string }> {
    const raw = await post(ctx, `/v2/shipments/${encodeURIComponent(ref.providerShipmentId)}/refund`, {}, "label refund");
    const status = isRecord(raw) ? (optStr(raw, "status") ?? "unknown") : "unknown";
    return { accepted: status === "refunded" || status === "submitted", rawStatus: status };
  },

  async validateAddress(ctx: CarrierContext, address: CarrierAddress): Promise<CarrierAddressSuggestion> {
    const raw = await post(ctx, "/v2/addresses", {
      address: addressPayload(address),
      verify: ["delivery"],
    }, "address validation");
    return parseAddressVerification(raw);
  },

  async getTracker(ctx: CarrierContext, ref: CarrierTrackerRef): Promise<CarrierTrackerState> {
    if (ref.trackerId) {
      return mapTracker(await get(ctx, `/v2/trackers/${encodeURIComponent(ref.trackerId)}`, "tracker refresh"));
    }
    if (ref.carrier && ref.trackingNumber) {
      return mapTracker(await post(ctx, "/v2/trackers", {
        tracker: { tracking_code: ref.trackingNumber, carrier: ref.carrier },
      }, "tracker refresh"));
    }
    throw new CarrierError("EasyPost tracker refresh needs a tracker id or a carrier plus tracking number");
  },

  parseInboundEvent(raw: unknown): CarrierInboundEvent | null {
    if (!isRecord(raw)) return null;
    if (raw["object"] !== "Event" || typeof raw["description"] !== "string") return null;
    if (!raw["description"].startsWith("tracker.")) return null;
    const eventId = optStr(raw, "id");
    const result = isRecord(raw["result"]) ? raw["result"] : null;
    if (!eventId || !result) return null;
    return {
      eventId,
      tracker: {
        trackerId: optStr(result, "id") ?? undefined,
        carrier: optStr(result, "carrier") ?? undefined,
        trackingNumber: optStr(result, "tracking_code") ?? undefined,
        providerShipmentId: optStr(result, "shipment_id") ?? undefined,
      },
    };
  },
};

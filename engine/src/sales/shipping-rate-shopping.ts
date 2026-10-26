import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { assertPackedUnit } from "./handling-unit-state.ts";
import {
  type CarrierAddress,
  type CarrierCustomsItem,
  type CarrierParcel,
  type CarrierRateRequest,
} from "../connectors/shipping.ts";
import {
  assertShippingFeature,
  adapterFor,
  loadShippingAccount,
  ShippingRefusal,
  type Scope,
  type Tx,
} from "./shipping-accounts.ts";

const QUOTE_TTL_MINUTES = 30;

// --- Shipment loading -------------------------------------------------------

interface ShipmentForRating {
  id: string;
  documentNumber: string;
  subsidiaryId: string;
  warehouseId: string;
  currency: string;
  orderId: string | null;
  orderNumber: string | null;
  shipTo: CarrierAddress;
  from: CarrierAddress;
}

/** Lock a draft, open shipment with its warehouse and ship-to addresses. */
export async function lockShipmentForRating(
  tx: SqlExecutor,
  orgId: string,
  shipmentId: string,
  scope: Scope,
): Promise<Omit<ShipmentForRating, "shipTo" | "from"> & { shipToRaw: unknown }> {
  const row = (
    await tx.execute<{
      id: string;
      document_number: string;
      status: string;
      stage: string;
      subsidiary_id: string;
      warehouse_id: string;
      currency: string;
      order_id: string | null;
      order_number: string | null;
      ship_to_address: unknown;
    }>(
      sql`
    select d.id, d.document_number, d.status, fd.stage, d.subsidiary_id, fd.warehouse_id, d.currency,
           so.id as order_id, so.document_number as order_number, fd.ship_to_address
      from documents d
      join fulfillment_documents fd on fd.document_id = d.id and fd.org_id = d.org_id
      left join lateral (
        select up.id, up.document_number from document_links l
          join documents up on up.id = l.from_document_id and up.org_id = l.org_id
         where l.org_id = d.org_id and l.to_document_id = d.id and l.link_type in ('reserves', 'ships')
         limit 1) so on true
     where d.org_id = ${orgId} and d.id = ${shipmentId} and d.kind = 'shipment'`,
      "objects",
    )
  )[0];
  if (!row) throw new ShippingRefusal("Shipment not found", "not_found", 404);
  if (scope !== null && scope !== undefined && !scope.has(row.subsidiary_id)) {
    throw new ShippingRefusal("Shipment not found", "not_found", 404);
  }
  if (row.status !== "draft" || row.stage !== "open") {
    const state = row.stage === "done" ? "complete" : row.status;
    throw new ShippingRefusal(
      `${row.document_number} is ${state}; only a draft shipment can be rated or labelled`,
      "wrong_stage",
      409,
      "Rate and buy labels before completing the shipment",
    );
  }
  return {
    id: row.id,
    documentNumber: row.document_number,
    subsidiaryId: row.subsidiary_id,
    warehouseId: row.warehouse_id,
    currency: row.currency,
    orderId: row.order_id,
    orderNumber: row.order_number,
    shipToRaw: row.ship_to_address,
  };
}

function toCarrierAddress(raw: unknown, what: string, remedy: string): CarrierAddress {
  const address = (raw ?? {}) as Record<string, unknown>;
  const pick = (field: string): string | null => {
    const value = address[field];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  // Warehouse rows use address_line1; shipment snapshots use line1.
  const street1 = pick("line1") ?? pick("address_line1") ?? pick("street1");
  const street2 = pick("line2") ?? pick("address_line2") ?? pick("street2");
  const city = pick("city");
  const state = pick("region") ?? pick("state");
  const zip = pick("postalCode") ?? pick("postal_code") ?? pick("zip");
  const country = pick("country");
  const lacking = [
    street1 ? null : "street",
    city ? null : "city",
    state ? null : "state",
    zip ? null : "postal code",
    country ? null : "country",
  ].filter(Boolean) as string[];
  if (lacking.length > 0) {
    throw new ShippingRefusal(
      `${what} is missing ${lacking.join(", ")}`,
      "address_missing",
      422,
      remedy,
    );
  }
  return {
    name: pick("label") ?? pick("name"),
    street1: street1!,
    street2,
    city: city!,
    state: state!,
    zip: zip!,
    country: country!.toUpperCase(),
    phone: pick("phone"),
    email: pick("email"),
  };
}

async function warehouseAddress(
  tx: SqlExecutor,
  orgId: string,
  warehouseId: string,
  documentNumber: string,
): Promise<CarrierAddress> {
  const row = (
    await tx.execute<{
      address_line1: string | null;
      address_line2: string | null;
      city: string | null;
      region: string | null;
      postal_code: string | null;
      country: string | null;
      name: string;
    }>(
      sql`
    select address_line1, address_line2, city, region, postal_code, country, name
      from warehouses where org_id = ${orgId} and stock_location_id = ${warehouseId}`,
      "objects",
    )
  )[0];
  if (!row) {
    throw new ShippingRefusal(
      `${documentNumber} ships from a warehouse that no longer exists`,
      "address_missing",
      422,
      "Move the shipment to an active warehouse",
    );
  }
  return toCarrierAddress(
    {
      name: row.name,
      line1: row.address_line1,
      line2: row.address_line2,
      city: row.city,
      region: row.region,
      postalCode: row.postal_code,
      country: row.country,
    },
    `The ${row.name} warehouse address`,
    `Enter a full address on the warehouse in Warehouse → Warehouses`,
  );
}

interface ParcelLine {
  item_id: string;
  item_code: string | null;
  item_name: string;
  quantity: string;
  unit_price: string;
  weight: string | null;
  weight_unit: string | null;
  dimensions: {
    length: string | null;
    width: string | null;
    height: string | null;
    unit: "cm" | "in";
  } | null;
  hs_code: string | null;
  country_of_origin: string | null;
}

const WEIGHT_TO_KG: Record<string, string> = {
  g: "0.001",
  kg: "1",
  oz: "0.028349523125",
  lb: "0.45359237",
};

/** Exact decimal multiplication, half-up to 6 places — parcel measures never touch floats. */
function mulExact(a: string, b: string): string {
  const parse = (value: string): { digits: bigint; scale: number } => {
    const [int = "0", frac = ""] = value.split(".");
    return { digits: BigInt(`${int}${frac}`), scale: frac.length };
  };
  const left = parse(a);
  const right = parse(b);
  const product = left.digits * right.digits;
  const productScale = left.scale + right.scale;
  const target = 6;
  const shift = productScale - target;
  const rounded =
    shift <= 0
      ? product * 10n ** BigInt(-shift)
      : (product + 5n * 10n ** BigInt(shift - 1)) / 10n ** BigInt(shift);
  const whole = rounded / 1_000_000n;
  const rest = (rounded % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return rest === "" ? whole.toString() : `${whole}.${rest}`;
}

const IN_TO_CM = "2.54";

function weightToKg(weight: string, unit: string): string {
  const factor = WEIGHT_TO_KG[unit];
  if (!factor) throw new ShippingRefusal(`Unknown weight unit ${unit}`, "invalid_input", 422);
  return mulExact(weight, factor);
}

/** Unit weight times line quantity, exact. */
function mulQty(weightKg: string, quantity: string): string {
  return mulExact(weightKg, quantity);
}

/**
 * Build rating parcels from the shipment's lines. Item weights times line
 * quantities; a caller-chosen preset overrides per-item measures for the
 * whole shipment. An item with no weight refuses BY NAME — never zero.
 */
async function buildParcels(
  tx: SqlExecutor,
  orgId: string,
  shipment: { id: string; documentNumber: string },
  presetId: string | null | undefined,
  unitId?: string,
): Promise<{ parcels: CarrierParcel[]; lines: ParcelLine[] }> {
  const lines = await tx.execute<{
    item_id: string;
    item_code: string | null;
    item_name: string;
    quantity: string;
    unit_price: string;
    weight: string | null;
    weight_unit: string | null;
    dimensions: ParcelLine["dimensions"];
    hs_code: string | null;
    country_of_origin: string | null;
  }>(
    sql`
    select dl.item_id, i.code as item_code, i.name as item_name, dl.quantity::text as quantity,
           dl.unit_price::text as unit_price,
           i.weight::text as weight, i.weight_unit, i.dimensions, i.hs_code, i.country_of_origin
      from document_lines dl
      join items i on i.id = dl.item_id and i.org_id = dl.org_id
     where dl.org_id = ${orgId} and dl.document_id = ${shipment.id} and dl.item_id is not null
       ${
         unitId
           ? sql`and exists(select 1 from handling_unit_contents c where c.org_id=dl.org_id
         and c.shipment_line_id=dl.id and c.handling_unit_id=${unitId} and c.confirmed_at is not null)`
           : sql``
       }
     order by dl.line_number`,
    "objects",
  );
  if (lines.length === 0) {
    throw new ShippingRefusal(
      `${shipment.documentNumber} has no item lines to rate`,
      "invalid_input",
      422,
      "Add items to the shipment before getting rates",
    );
  }
  if (presetId) {
    const preset = (
      await tx.execute<{
        id: string;
        length: string | null;
        width: string | null;
        height: string | null;
        dim_unit: string;
        weight: string | null;
        weight_unit: string;
      }>(
        sql`
      select id, length::text, width::text, height::text, dim_unit, weight::text, weight_unit
        from package_presets where org_id = ${orgId} and id = ${presetId}`,
        "objects",
      )
    )[0];
    if (!preset) throw new ShippingRefusal("Package preset not found", "not_found", 404);
    if (!preset.weight || !preset.weight_unit) {
      throw new ShippingRefusal(
        "Package preset has no weight",
        "invalid_input",
        422,
        "Set a weight on the preset in Setup → Shipping",
      );
    }
    const parcels: CarrierParcel[] = (unitId ? [lines[0]!] : lines).map(() => ({
      lengthCm:
        preset.dim_unit === "in" && preset.length
          ? mulExact(preset.length, IN_TO_CM)
          : preset.length,
      widthCm:
        preset.dim_unit === "in" && preset.width ? mulExact(preset.width, IN_TO_CM) : preset.width,
      heightCm:
        preset.dim_unit === "in" && preset.height
          ? mulExact(preset.height, IN_TO_CM)
          : preset.height,
      weightKg: weightToKg(preset.weight!, preset.weight_unit),
    }));
    return { parcels, lines: lines.map((line) => ({ ...line, quantity: line.quantity })) };
  }
  if (unitId && lines.length > 1)
    throw new ShippingRefusal(
      "Choose a package preset for a carton containing multiple items",
      "invalid_input",
      422,
      "Set the packed carton dimensions and total shipping weight in Setup → Shipping, then select that preset",
    );
  const parcels: CarrierParcel[] = lines.map((line) => {
    if (!line.weight || !line.weight_unit) {
      const label = line.item_code ? `${line.item_code} (${line.item_name})` : line.item_name;
      throw new ShippingRefusal(
        `Set a weight on item ${label} or choose a package preset`,
        "weight_missing",
        422,
        `Enter the weight on ${label} in Items, or pick a package preset when getting rates`,
      );
    }
    const unitWeightKg = weightToKg(line.weight, line.weight_unit);
    const dims = line.dimensions && typeof line.dimensions === "object" ? line.dimensions : null;
    const toCm = (value: string | null): string | null => {
      if (value == null) return null;
      return dims?.unit === "in" ? mulExact(value, IN_TO_CM) : value;
    };
    return {
      lengthCm: toCm(dims?.length ?? null),
      widthCm: toCm(dims?.width ?? null),
      heightCm: toCm(dims?.height ?? null),
      weightKg: mulQty(unitWeightKg, line.quantity),
    };
  });
  return { parcels, lines };
}

export interface ShippingSettings {
  shippingExpenseAccountId: string | null;
  carrierPayableAccountId: string | null;
  defaultRateRule: string;
  markupBps: number;
  defaultInsurance: string;
  defaultSignature: string;
  customsContentsType: string | null;
  customsContentsExplanation: string | null;
}

export async function loadSettings(tx: SqlExecutor, orgId: string): Promise<ShippingSettings> {
  const row = (
    await tx.execute<{
      shipping_expense_account_id: string | null;
      carrier_payable_account_id: string | null;
      default_rate_rule: string;
      markup_bps: number;
      default_insurance: string;
      default_signature: string;
      customs_defaults: { contentsType?: string; contentsExplanation?: string } | null;
    }>(
      sql`
    select shipping_expense_account_id, carrier_payable_account_id, default_rate_rule,
           markup_bps, default_insurance, default_signature, customs_defaults
      from shipping_settings where org_id = ${orgId} limit 1`,
      "objects",
    )
  )[0];
  return {
    shippingExpenseAccountId: row?.shipping_expense_account_id ?? null,
    carrierPayableAccountId: row?.carrier_payable_account_id ?? null,
    defaultRateRule: row?.default_rate_rule ?? "cheapest",
    markupBps: row?.markup_bps ?? 0,
    defaultInsurance: row?.default_insurance ?? "none",
    defaultSignature: row?.default_signature ?? "none",
    customsContentsType: row?.customs_defaults?.contentsType ?? null,
    customsContentsExplanation: row?.customs_defaults?.contentsExplanation ?? null,
  };
}

export type ShippingRateBadge = "cheapest" | "fastest" | "best_value";

export interface RankedShippingRate {
  providerRateId: string;
  providerShipmentId: string;
  parcelIndexes: number[];
  carrier: string;
  service: string;
  /** Carrier amount, exact decimal in `currency`. */
  amount: string;
  currency: string;
  /** Amount with the org markup applied, for customer-facing quotes. */
  markedUpAmount: string;
  deliveryDate: string | null;
  deliveryDays: number | null;
  badges: ShippingRateBadge[];
}

export interface ShipmentRateQuote {
  shipmentId: string;
  documentNumber: string;
  accountId: string;
  accountName: string;
  cached: boolean;
  rates: RankedShippingRate[];
}

function canonicalRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** Compare exact decimal strings without floats: -1, 0, or 1. */
function cmpDecimal(a: string, b: string): number {
  const parse = (value: string): { neg: boolean; int: string; frac: string } => {
    const neg = value.startsWith("-");
    const [int = "0", frac = ""] = (neg ? value.slice(1) : value).split(".");
    return { neg, int: int.replace(/^0+(?=\d)/, ""), frac };
  };
  const left = parse(a);
  const right = parse(b);
  if (left.neg !== right.neg) return left.neg ? -1 : 1;
  const width = Math.max(left.frac.length, right.frac.length);
  const l = left.int + left.frac.padEnd(width, "0");
  const r = right.int + right.frac.padEnd(width, "0");
  const order = l.length !== r.length ? (l.length < r.length ? -1 : 1) : l < r ? -1 : l > r ? 1 : 0;
  return left.neg ? -order : order;
}

/** Landed comparison amount: carrier rate plus the org markup, exact. */
function markedUp(amount: string, markupBps: number): string {
  if (markupBps === 0) return amount;
  const bumped = mulExact(mulExact(amount, String(10000 + markupBps)), "0.0001");
  return bumped;
}

/** Rank one parcel's rates: cheapest, fastest, and best value badges. */
function rankRates(
  rates: {
    providerRateId: string;
    providerShipmentId: string;
    parcelIndexes: number[];
    carrier: string;
    service: string;
    amount: string;
    currency: string;
    deliveryDate: string | null;
    deliveryDays: number | null;
  }[],
  markupBps: number,
): RankedShippingRate[] {
  if (rates.length === 0) return [];
  const ranked = rates.map((rate) => ({
    ...rate,
    markedUpAmount: markedUp(rate.amount, markupBps),
    badges: [] as ShippingRateBadge[],
  }));
  ranked.sort(
    (a, b) => cmpDecimal(a.amount, b.amount) || (a.deliveryDays ?? 999) - (b.deliveryDays ?? 999),
  );
  ranked[0]!.badges.push("cheapest");
  const withDays = ranked.filter((rate) => rate.deliveryDays != null);
  if (withDays.length > 0) {
    const fastest = Math.min(...withDays.map((rate) => rate.deliveryDays!));
    const winners = withDays.filter((rate) => rate.deliveryDays === fastest);
    winners.sort((a, b) => cmpDecimal(a.amount, b.amount));
    if (!winners[0]!.badges.includes("cheapest") || winners.length > 1 || withDays.length > 1) {
      winners[0]!.badges.push("fastest");
    }
    // Best value: the cheapest rate within one day of the fastest arrival.
    const contenders = withDays.filter((rate) => rate.deliveryDays! <= fastest + 1);
    contenders.sort((a, b) => cmpDecimal(a.amount, b.amount));
    if (contenders[0] && !contenders[0].badges.includes("cheapest"))
      contenders[0].badges.push("best_value");
  }
  return ranked;
}

/**
 * Pick one rate under a buying rule. `cheapest_by_date` needs a promised
 * date: the cheapest rate arriving on time, or null when none can.
 */
export function selectRateByRule(
  rates: RankedShippingRate[],
  rule: string,
  promisedDate?: string | null,
): RankedShippingRate | null {
  if (rates.length === 0) return null;
  if (rule === "fastest") {
    const withDays = rates.filter((rate) => rate.deliveryDays != null);
    if (withDays.length === 0) return rates[0]!;
    const fastest = Math.min(...withDays.map((rate) => rate.deliveryDays!));
    return withDays
      .filter((rate) => rate.deliveryDays === fastest)
      .sort((a, b) => cmpDecimal(a.amount, b.amount))[0]!;
  }
  if (rule === "cheapest_by_date" && promisedDate) {
    const onTime = rates.filter(
      (rate) => rate.deliveryDate != null && rate.deliveryDate <= promisedDate,
    );
    if (onTime.length === 0) return null;
    return onTime.sort((a, b) => cmpDecimal(a.amount, b.amount))[0]!;
  }
  return rates[0]!;
}

function buildRateRequest(
  from: CarrierAddress,
  to: CarrierAddress,
  parcels: CarrierParcel[],
  lines: ParcelLine[],
  settings: ShippingSettings,
  direction: "outbound" | "return",
  currency: string,
): CarrierRateRequest {
  const international = from.country !== to.country;
  let customsItems: CarrierCustomsItem[] = [];
  if (international) {
    customsItems = lines.map((line) => {
      const label = line.item_code ? `${line.item_code} (${line.item_name})` : line.item_name;
      if (!line.hs_code || !line.country_of_origin) {
        throw new ShippingRefusal(
          `Enter an HS code and origin country on item ${label} to ship internationally`,
          "customs_missing",
          422,
          `Add the HS code and origin country on ${label} in Items`,
        );
      }
      // Quantities are exact decimal strings: the whole units cross the
      // border, and a fractional remainder still declares at least one.
      const wholeUnits = line.quantity.split(".")[0] ?? "0";
      const quantity = /^\d+$/.test(wholeUnits) && wholeUnits !== "0" ? Number(wholeUnits) : 1;
      return {
        description: line.item_name.slice(0, 200),
        quantity,
        valueAmount: line.unit_price,
        valueCurrency: currency,
        hsCode: line.hs_code,
        originCountry: line.country_of_origin.toUpperCase(),
      };
    });
  }
  const signature =
    settings.defaultSignature === "adult" || settings.defaultSignature === "direct"
      ? settings.defaultSignature
      : "none";
  const request: CarrierRateRequest = {
    fromAddress: direction === "return" ? to : from,
    toAddress: direction === "return" ? from : to,
    parcels,
    customsItems,
    customsContentsType: settings.customsContentsType,
    customsContentsExplanation: settings.customsContentsExplanation,
    insuranceAmount: null,
    insuranceCurrency: null,
    signature,
  };
  if (settings.defaultInsurance === "carrier_full") {
    const total = lines.reduce<string>(
      (sum, line) => addDecimal(sum, mulExact(line.unit_price, line.quantity)),
      "0",
    );
    request.insuranceAmount = total;
    request.insuranceCurrency = currency;
  }
  return request;
}

/** Exact decimal addition for goods-value totals. */
function addDecimal(a: string, b: string): string {
  const [aInt = "0", aFrac = ""] = a.split(".");
  const [bInt = "0", bFrac = ""] = b.split(".");
  const width = Math.max(aFrac.length, bFrac.length);
  const sum = BigInt(aInt + aFrac.padEnd(width, "0")) + BigInt(bInt + bFrac.padEnd(width, "0"));
  const negative = sum < 0n;
  const abs = (negative ? -sum : sum).toString().padStart(width + 1, "0");
  const int = abs.slice(0, abs.length - width) || "0";
  const frac = width === 0 ? "" : abs.slice(abs.length - width).replace(/0+$/, "");
  return `${negative ? "-" : ""}${int}${frac === "" ? "" : `.${frac}`}`;
}

export interface GetRatesInput {
  shipmentId: string;
  handlingUnitId?: string;
  accountId?: string | null;
  presetId?: string | null;
  direction?: "outbound" | "return";
  allowedSubsidiaryIds: Scope;
  transport?: typeof fetch;
  baseUrl?: string;
}

/**
 * Ranked live rates for a draft shipment, cached short-term by request hash.
 * Everyday path: Get rates → cheapest/fastest/best-value badges → Buy label.
 */
export async function getShipmentRates(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: GetRatesInput,
): Promise<ShipmentRateQuote> {
  await assertShippingFeature(tx, orgId);
  const shipment = await lockShipmentForRating(
    tx,
    orgId,
    input.shipmentId,
    input.allowedSubsidiaryIds,
  );
  await lockActorCommandAuthority(tx, orgId, actorId, shipment.subsidiaryId, "orders.fulfill");
  if (!input.handlingUnitId)
    throw new ShippingRefusal(
      "Select the packed handling unit to rate",
      "invalid_input",
      422,
      "Confirm carton contents in Packing first",
    );
  const unit = await assertPackedUnit(tx, orgId, shipment.id, input.handlingUnitId);
  const account = await loadShippingAccount(tx, orgId, input.accountId);
  const adapter = adapterFor(account.provider);
  const settings = await loadSettings(tx, orgId);
  const direction = input.direction ?? "outbound";
  const from = await warehouseAddress(tx, orgId, shipment.warehouseId, shipment.documentNumber);
  const shipTo = toCarrierAddress(
    shipment.shipToRaw,
    `Shipment ${shipment.documentNumber} has no ship-to address`,
    `Enter the ship-to address on ${shipment.documentNumber}`,
  );
  const { parcels, lines } = await buildParcels(tx, orgId, shipment, input.presetId, unit.id);
  const request = buildRateRequest(
    from,
    shipTo,
    parcels,
    lines,
    settings,
    direction,
    shipment.currency,
  );
  const hash = canonicalRequestHash({
    account: account.id,
    handlingUnitId: unit.id,
    handlingUnitVersion: unit.content_version,
    direction,
    from,
    to: direction === "return" ? from : shipTo,
    parcels,
    customs: request.customsItems,
    insurance: [request.insuranceAmount, request.insuranceCurrency],
    signature: request.signature,
  });
  const cached = (
    await tx.execute<{ rates: RankedShippingRate[] }>(
      sql`
    select rates from shipping_rate_quotes
     where org_id = ${orgId} and shipment_document_id = ${shipment.id}
       and account_id = ${account.id} and request_hash = ${hash} and expires_at > now()
     order by quoted_at desc limit 1`,
      "objects",
    )
  )[0];
  if (cached) {
    return {
      shipmentId: shipment.id,
      documentNumber: shipment.documentNumber,
      accountId: account.id,
      accountName: account.name,
      cached: true,
      rates: cached.rates as RankedShippingRate[],
    };
  }
  let options;
  try {
    options = await adapter.requestRates(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      request,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(
        `${account.name} rate shopping failed: ${error.message}`,
        "provider_failed",
        422,
        error.message,
      );
    }
    throw error;
  }
  const ranked = options.flatMap((option) =>
    rankRates(
      option.rates.map((rate) => ({
        providerRateId: rate.providerRateId,
        providerShipmentId: option.providerShipmentId,
        parcelIndexes: option.parcelIndexes,
        carrier: rate.carrier,
        service: rate.service,
        amount: rate.amount,
        currency: rate.currency,
        deliveryDate: rate.deliveryDate,
        deliveryDays: rate.deliveryDays,
      })),
      settings.markupBps,
    ),
  );
  if (ranked.length === 0) {
    throw new ShippingRefusal(
      `${account.name} returned no rates for ${shipment.documentNumber}`,
      "provider_failed",
      422,
      "Check the ship-to address and parcel weight, then try another carrier account",
    );
  }
  const stored = await tx.execute<{ id: string }>(
    sql`
    insert into shipping_rate_quotes
      (org_id, shipment_document_id, account_id, request_hash, rates, expires_at, created_by, updated_by,handling_unit_id,handling_unit_version,direction)
    values (${orgId}, ${shipment.id}, ${account.id}, ${hash},
            ${JSON.stringify(ranked)}::jsonb, now() + (${QUOTE_TTL_MINUTES} || ' minutes')::interval,
            ${actorId}, ${actorId},${unit.id},${unit.content_version}::bigint,${direction})
    returning id`,
    "objects",
  );
  if (stored.length === 0) throw new Error("rate quote was not recorded");
  return {
    shipmentId: shipment.id,
    documentNumber: shipment.documentNumber,
    accountId: account.id,
    accountName: account.name,
    cached: false,
    rates: ranked,
  };
}

/** A quoted rate still inside its short-lived window, for idempotent buying. */
export async function findQuotedRate(
  tx: SqlExecutor,
  orgId: string,
  shipmentId: string,
  accountId: string,
  providerRateId: string,
  unit?: { id: string; content_version: string; direction: string },
): Promise<RankedShippingRate> {
  const rows = await tx.execute<{ rates: RankedShippingRate[] }>(
    sql`
    select rates from shipping_rate_quotes
     where org_id = ${orgId} and shipment_document_id = ${shipmentId} and account_id = ${accountId}
       and expires_at > now()
       ${unit ? sql`and handling_unit_id=${unit.id} and handling_unit_version=${unit.content_version}::bigint and direction=${unit.direction}` : sql`and handling_unit_id is null`}
       order by quoted_at desc limit 5`,
    "objects",
  );
  for (const row of rows) {
    const found = (row.rates as RankedShippingRate[]).find(
      (rate) => rate.providerRateId === providerRateId,
    );
    if (found) return found;
  }
  throw new ShippingRefusal(
    "That rate is no longer quoted — rates expire after 30 minutes",
    "quote_expired",
    409,
    "Get fresh rates for the shipment, then buy the label",
  );
}

// --- Label purchase ---------------------------------------------------------

export async function validateShipmentAddress(
  tx: Tx,
  orgId: string,
  input: {
    shipmentId: string;
    accountId?: string | null;
    allowedSubsidiaryIds: Scope;
    transport?: typeof fetch;
    baseUrl?: string;
  },
): Promise<{ valid: boolean; messages: string[] }> {
  await assertShippingFeature(tx, orgId);
  const shipment = await lockShipmentForRating(
    tx,
    orgId,
    input.shipmentId,
    input.allowedSubsidiaryIds,
  );
  const account = await loadShippingAccount(tx, orgId, input.accountId);
  const adapter = adapterFor(account.provider);
  const shipTo = toCarrierAddress(
    shipment.shipToRaw,
    `Shipment ${shipment.documentNumber} has no ship-to address`,
    `Enter the ship-to address on ${shipment.documentNumber}`,
  );
  let answer;
  try {
    answer = await adapter.validateAddress(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      shipTo,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(
        `${account.name} address check failed: ${error.message}`,
        "provider_failed",
        422,
        error.message,
      );
    }
    throw error;
  }
  return { valid: answer.valid, messages: answer.messages };
}

// --- Reporting --------------------------------------------------------------------

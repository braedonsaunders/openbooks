import type { ChannelOrder, ChannelRefund } from "../contracts.ts";
import { CommerceError } from "../errors.ts";
import { THREE_DECIMAL_CURRENCIES, ZERO_DECIMAL_CURRENCIES } from "../../payments/acceptance.ts";

/**
 * Shopify order normalization: documented Admin REST order JSON into the
 * channel-neutral ChannelOrder. Pure — no database, no network — so the
 * unit test pins exact minor-unit arithmetic against a realistic payload.
 * Posting code reads the neutral type, never this shape: when the Shopify
 * adapter lands it calls these functions from its orders/* topic routing.
 */

function fail(message: string, remedy: string): never {
  throw new CommerceError("shopify_order_unreadable", message, remedy);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Decimal-string shop amount to exact minor units under the currency exponent. */
export function shopMinorUnits(amount: string, currency: string): bigint {
  const code = currency.toUpperCase();
  const exponent = ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : THREE_DECIMAL_CURRENCIES.has(code) ? 3 : 2;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) {
    fail(
      `Shopify amount "${amount}" is not a usable decimal.`,
      "Re-sync the order from Shopify so its amounts arrive as decimal strings, then replay it.",
    );
  }
  const frac = (match[2] ?? "").padEnd(exponent, "0");
  if (frac.length > exponent) {
    fail(
      `Shopify amount "${amount}" carries sub-minor precision for ${code}.`,
      "Re-sync the order from Shopify so its amounts fit the currency's minor unit, then replay it.",
    );
  }
  return BigInt(match[1]!) * 10n ** BigInt(exponent) + (frac === "" ? 0n : BigInt(frac));
}

/** Provider rate (0.0875) to exact percent string ("8.75") without float math. */
export function rateToPercent(rate: unknown): string | null {
  if (rate === null || rate === undefined) return null;
  const raw = typeof rate === "number" ? String(rate) : typeof rate === "string" ? rate.trim() : "";
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) return null;
  const frac = `${match[2] ?? ""}00`;
  const head = frac.slice(0, 2);
  const tail = frac.slice(2).replaceAll(/0+$/g, "");
  const whole = `${match[1]}${head}`.replaceAll(/^0+(?=\d)/g, "");
  return tail === "" ? whole : `${whole}.${tail}`;
}

function addressOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of ["first_name", "last_name", "company", "address1", "address2", "city", "province", "province_code", "country", "country_code", "zip", "phone"]) {
    if (record[key] !== undefined && record[key] !== null) kept[key] = record[key];
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

interface ShopifyTaxLine {
  title?: unknown;
  price?: unknown;
  rate?: unknown;
}

/** Jurisdiction from a Shopify tax line title ("CA State Tax" → "CA"... kept whole: titles vary by province and state). */
function jurisdictionOf(title: string): string {
  return title.trim().toUpperCase();
}

function normalizeTaxLines(lines: unknown, currency: string, marketplace: boolean): ChannelOrder["lines"][number]["taxLines"] {
  if (!Array.isArray(lines)) return [];
  return lines.map((entry) => {
    const line = (entry ?? {}) as ShopifyTaxLine;
    const title = text(line.title) ?? "Tax";
    return {
      jurisdiction: jurisdictionOf(title),
      collectedBy: marketplace ? "marketplace" : "merchant",
      amountMinor: shopMinorUnits(String(line.price ?? "0"), currency),
      ratePercent: rateToPercent(line.rate),
    };
  });
}

/**
 * Normalize one documented Shopify order payload. Marketplace collection
 * is detected per tax line: titles naming a marketplace facilitator state
 * are the merchant's configuration to confirm — the normalizer marks
 * lines whose title carries "(marketplace)" as marketplace-collected and
 * leaves the rest merchant-collected.
 */
export function normalizeShopifyOrder(payload: unknown): ChannelOrder {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("The Shopify order payload is not an object.", "Replay the orders/create delivery from Shopify, then ingest it again.");
  }
  const order = payload as Record<string, unknown>;
  const externalId = text(order.id !== undefined && order.id !== null ? String(order.id) : null);
  if (!externalId) fail("The Shopify order carries no id.", "Replay the orders/create delivery from Shopify, then ingest it again.");
  const currency = (text(order.currency) ?? "USD").toUpperCase();
  const customer = (order.customer ?? {}) as Record<string, unknown>;
  const customerAddress = addressOf(order.billing_address ?? order.shipping_address ?? customer.default_address);
  const discountCodes = Array.isArray(order.discount_codes)
    ? (order.discount_codes as Array<Record<string, unknown>>).map((entry) => text(entry.code)).filter((code): code is string => !!code)
    : [];
  const gatewayNames = Array.isArray(order.payment_gateway_names)
    ? (order.payment_gateway_names as unknown[]).map((name) => String(name))
    : [];
  const transactions = Array.isArray(order.transactions) ? (order.transactions as Array<Record<string, unknown>>) : [];

  const lines: ChannelOrder["lines"] = [];
  const lineItems = Array.isArray(order.line_items) ? (order.line_items as Array<Record<string, unknown>>) : [];
  for (const entry of lineItems) {
    const sku = text(entry.sku);
    const variantId = entry.variant_id !== undefined && entry.variant_id !== null ? String(entry.variant_id) : null;
    const quantity = Number(entry.quantity ?? 0);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      fail(
        `Shopify line "${text(entry.title) ?? "?"}" carries an unusable quantity.`,
        "Re-sync the order from Shopify so every line arrives with a positive quantity, then replay it.",
      );
    }
    const priceMinor = shopMinorUnits(String(entry.price ?? "0"), currency);
    const allocations = Array.isArray(entry.discount_allocations) ? (entry.discount_allocations as Array<Record<string, unknown>>) : [];
    let discountMinor = 0n;
    let discountCode: string | null = null;
    for (const allocation of allocations) {
      discountMinor += shopMinorUnits(String(allocation.amount ?? "0"), currency);
      const index = allocation.discount_application_index;
      if (typeof index === "number" && discountCodes[index]) discountCode = discountCodes[index]!;
    }
    if (discountMinor === 0n && discountCodes.length > 0 && lineItems.length === 1) discountCode = discountCodes[0]!;
    const taxLines = normalizeTaxLines(
      entry.tax_lines,
      currency,
      /marketplace/i.test(text((entry as Record<string, unknown>).title ?? "") ?? "") ||
        (entry.tax_lines as ShopifyTaxLine[] | undefined)?.some((tax) => /marketplace/i.test(text(tax.title) ?? "")) === true,
    );
    lines.push({
      sku,
      variantExternalId: variantId,
      title: text(entry.title) ?? "Untitled line",
      quantity: String(quantity),
      priceMinor,
      discountMinor,
      discountCode,
      taxLines,
      giftCard: entry.gift_card === true,
      promotionId: null,
    });
  }

  const shippingLines: ChannelOrder["shippingLines"] = [];
  const shipLines = Array.isArray(order.shipping_lines) ? (order.shipping_lines as Array<Record<string, unknown>>) : [];
  for (const entry of shipLines) {
    const shipPrice = shopMinorUnits(String(entry.price ?? "0"), currency);
    const shipDiscounted = entry.discounted_price === undefined || entry.discounted_price === null
      ? shipPrice
      : shopMinorUnits(String(entry.discounted_price), currency);
    shippingLines.push({
      title: text(entry.title) ?? "Shipping",
      amountMinor: shipPrice,
      discountMinor: shipDiscounted < shipPrice ? shipPrice - shipDiscounted : 0n,
      taxLines: normalizeTaxLines(entry.tax_lines, currency, false),
    });
  }

  const tenders: ChannelOrder["tenders"] = [];
  const sales = transactions.filter(
    (txn) => (txn.kind === "sale" || txn.kind === "capture") && txn.status === "success",
  );
  if (sales.length > 0) {
    for (const txn of sales) {
      const gateway = text(txn.gateway) ?? gatewayNames[0] ?? "shopify_payments";
      const receipt = (txn.receipt ?? {}) as Record<string, unknown>;
      const giftCardId = receipt.gift_card_id !== undefined && receipt.gift_card_id !== null ? String(receipt.gift_card_id) : null;
      tenders.push({
        gateway,
        amountMinor: shopMinorUnits(String(txn.amount ?? "0"), currency),
        giftCardExternalId: gateway.toLowerCase() === "gift_card" ? (giftCardId ?? String(txn.id ?? "")) : giftCardId,
        authorizationRef: text(txn.authorization),
      });
    }
  } else if (gatewayNames.length > 0) {
    // The order payload without transactions still names its gateways: one
    // tender per gateway for the order total, so posting sees the money.
    // A later fulfillments/payment event replaces these with exact splits.
    tenders.push({
      gateway: gatewayNames[0]!,
      amountMinor: shopMinorUnits(String(order.total_price ?? "0"), currency),
      giftCardExternalId: null,
      authorizationRef: null,
    });
  }

  const tags = typeof order.tags === "string"
    ? order.tags.split(",").map((tag) => tag.trim()).filter((tag) => tag !== "")
    : [];
  const email = text(order.email) ?? text(customer.email);
  const firstName = text(customer.first_name);
  const lastName = text(customer.last_name);
  return {
    externalId,
    number: text(order.name) ?? `#${externalId}`,
    customerExternalId: customer.id !== undefined && customer.id !== null ? String(customer.id) : null,
    customerName: firstName || lastName ? `${firstName ?? ""} ${lastName ?? ""}`.trim() : null,
    customerEmail: email,
    customerAddress,
    tags,
    source: text(order.source_name),
    shopCurrency: currency,
    presentmentCurrency: text(order.presentment_currency)?.toUpperCase() ?? currency,
    subtotalMinor: shopMinorUnits(String(order.subtotal_price ?? "0"), currency),
    taxMinor: shopMinorUnits(String(order.total_tax ?? "0"), currency),
    shippingMinor: shipLines.reduce((sum, entry) => sum + shopMinorUnits(String(entry.price ?? "0"), currency), 0n),
    discountMinor: shopMinorUnits(String(order.total_discounts ?? "0"), currency),
    totalMinor: shopMinorUnits(String(order.total_price ?? "0"), currency),
    financialStatus: text(order.financial_status) ?? "",
    fulfilmentStatus: text(order.fulfillment_status) ?? "",
    lines,
    shippingLines,
    tenders,
    orderedAt: text(order.created_at) ?? new Date().toISOString(),
    cancelledAt: text(order.cancelled_at),
  };
}

/** Normalize one documented Shopify refund payload against its order. */
export function normalizeShopifyRefund(payload: unknown, orderExternalId: string, orderCurrency?: string): ChannelRefund {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("The Shopify refund payload is not an object.", "Replay the refunds/create delivery from Shopify, then ingest it again.");
  }
  const refund = payload as Record<string, unknown>;
  // Refund deliveries carry no currency of their own: the amounts are in
  // the order's shop currency, so the caller passes it and only a truly
  // unknown order falls back to USD (ingest refuses that case by name).
  const currency = (text(refund.currency) ?? text(orderCurrency) ?? "USD").toUpperCase();
  const refundLineItems = Array.isArray(refund.refund_line_items)
    ? (refund.refund_line_items as Array<Record<string, unknown>>)
    : [];
  const transactions = Array.isArray(refund.transactions) ? (refund.transactions as Array<Record<string, unknown>>) : [];
  const refundId = text(refund.id !== undefined && refund.id !== null ? String(refund.id) : null);
  if (!refundId) fail("The Shopify refund carries no id.", "Replay the refunds/create delivery from Shopify, then ingest it again.");
  return {
    externalId: refundId,
    orderExternalId,
    reason: text(refund.note),
    restock: refundLineItems.some((entry) => entry.restock === true),
    totalMinor: transactions.reduce((sum, txn) => sum + shopMinorUnits(String(txn.amount ?? "0"), currency), 0n),
    lines: refundLineItems.map((entry) => {
      const nested = (entry.line_item ?? {}) as Record<string, unknown>;
      const rawQuantity = entry.quantity !== undefined && entry.quantity !== null ? String(entry.quantity) : "";
      if (!/^\d+$/.test(rawQuantity.trim())) {
        fail(
          "A Shopify refund line carries an unusable quantity.",
          "Replay the refunds/create delivery from Shopify, then ingest it again.",
        );
      }
      return {
        lineExternalId: nested.id !== undefined && nested.id !== null ? String(nested.id) : null,
        sku: text(nested.sku),
        quantity: rawQuantity.trim(),
        amountMinor: shopMinorUnits(String(entry.subtotal ?? "0"), currency),
      };
    }),
    tenders: transactions.map((txn) => ({
      gateway: text(txn.gateway) ?? "shopify_payments",
      amountMinor: shopMinorUnits(String(txn.amount ?? "0"), currency),
    })),
    refundedAt: text(refund.created_at) ?? new Date().toISOString(),
  };
}

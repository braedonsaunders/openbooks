import assert from "node:assert/strict";
import test from "node:test";
import { CommerceError } from "../errors.ts";
import { normalizeShopifyOrder, normalizeShopifyRefund, rateToPercent, shopMinorUnits } from "./orders.ts";

/**
 * A realistic Shopify order: two taxed lines with a discount code on the
 * first, a taxed shipping line, two tax jurisdictions' lines merged by the
 * storefront into NY lines, a gateway tender plus a gift card tender, and a
 * presentment currency differing from the shop currency.
 */
function shopifyOrderFixture(): Record<string, unknown> {
  return {
    id: 450789469,
    name: "#1052",
    email: "bob@example.com",
    customer: {
      id: 207119551,
      email: "bob@example.com",
      first_name: "Bob",
      last_name: "Norman",
    },
    billing_address: {
      first_name: "Bob",
      last_name: "Norman",
      address1: "123 Main St",
      city: "New York",
      province: "NY",
      country: "US",
      zip: "10001",
    },
    currency: "USD",
    presentment_currency: "EUR",
    subtotal_price: "62.00",
    total_discounts: "5.00",
    total_tax: "5.86",
    total_price: "68.86",
    financial_status: "paid",
    fulfillment_status: "unfulfilled",
    tags: "vip, wholesale",
    source_name: "web",
    created_at: "2026-07-15T12:00:00-04:00",
    cancelled_at: null,
    payment_gateway_names: ["shopify_payments"],
    discount_codes: [{ code: "SAVE10", amount: "5.00", type: "fixed_amount" }],
    line_items: [
      {
        id: 1,
        variant_id: 808,
        sku: "TEE-RED-M",
        title: "Red Tee — M",
        quantity: 2,
        price: "25.00",
        total_discount: "5.00",
        gift_card: false,
        tax_lines: [{ title: "NY State Tax", price: "4.31", rate: 0.08625 }],
        discount_allocations: [{ amount: "5.00", discount_application_index: 0 }],
      },
      {
        id: 2,
        variant_id: 809,
        sku: "MUG-WHITE",
        title: "White Mug",
        quantity: 1,
        price: "12.00",
        total_discount: "0.00",
        gift_card: false,
        tax_lines: [{ title: "NY State Tax", price: "1.03", rate: 0.08625 }],
        discount_allocations: [],
      },
    ],
    shipping_lines: [
      {
        title: "Standard",
        price: "6.00",
        discounted_price: "6.00",
        tax_lines: [{ title: "NY State Tax", price: "0.52", rate: 0.08625 }],
      },
    ],
    transactions: [
      { id: 11, kind: "sale", status: "success", gateway: "shopify_payments", amount: "63.86", authorization: "auth-1" },
      { id: 12, kind: "sale", status: "success", gateway: "gift_card", amount: "5.00", authorization: null, receipt: { gift_card_id: 777 } },
    ],
  };
}

test("shopify order normalizes exactly in minor units", () => {
  const order = normalizeShopifyOrder(shopifyOrderFixture());
  assert.equal(order.externalId, "450789469");
  assert.equal(order.number, "#1052");
  assert.equal(order.customerExternalId, "207119551");
  assert.equal(order.customerName, "Bob Norman");
  assert.equal(order.customerEmail, "bob@example.com");
  assert.deepEqual(order.tags, ["vip", "wholesale"]);
  assert.equal(order.source, "web");
  assert.equal(order.shopCurrency, "USD");
  assert.equal(order.presentmentCurrency, "EUR");
  assert.equal(order.subtotalMinor, 6200n);
  assert.equal(order.taxMinor, 586n);
  assert.equal(order.shippingMinor, 600n);
  assert.equal(order.discountMinor, 500n);
  assert.equal(order.totalMinor, 6886n);
  assert.equal(order.lines.length, 2);
  assert.equal(order.lines[0]!.sku, "TEE-RED-M");
  assert.equal(order.lines[0]!.variantExternalId, "808");
  assert.equal(order.lines[0]!.quantity, "2");
  assert.equal(order.lines[0]!.priceMinor, 2500n);
  assert.equal(order.lines[0]!.discountMinor, 500n);
  assert.equal(order.lines[0]!.discountCode, "SAVE10");
  assert.equal(order.lines[0]!.taxLines.length, 1);
  assert.equal(order.lines[0]!.taxLines[0]!.jurisdiction, "NY STATE TAX");
  assert.equal(order.lines[0]!.taxLines[0]!.collectedBy, "merchant");
  assert.equal(order.lines[0]!.taxLines[0]!.amountMinor, 431n);
  assert.equal(order.lines[0]!.taxLines[0]!.ratePercent, "8.625");
  assert.equal(order.lines[1]!.discountCode, null);
  assert.equal(order.shippingLines.length, 1);
  assert.equal(order.shippingLines[0]!.amountMinor, 600n);
  assert.equal(order.shippingLines[0]!.discountMinor, 0n);
  assert.equal(order.tenders.length, 2);
  assert.equal(order.tenders[0]!.gateway, "shopify_payments");
  assert.equal(order.tenders[0]!.amountMinor, 6386n);
  assert.equal(order.tenders[0]!.giftCardExternalId, null);
  assert.equal(order.tenders[0]!.authorizationRef, "auth-1");
  assert.equal(order.tenders[1]!.gateway, "gift_card");
  assert.equal(order.tenders[1]!.amountMinor, 500n);
  assert.equal(order.tenders[1]!.giftCardExternalId, "777");
  // The storefront's own arithmetic agrees with itself.
  const footed = order.subtotalMinor + order.taxMinor + order.shippingMinor - order.discountMinor;
  assert.equal(footed, order.totalMinor);
});

test("shopify minor units follow the currency exponent", () => {
  assert.equal(shopMinorUnits("19.99", "USD"), 1999n);
  assert.equal(shopMinorUnits("1500", "JPY"), 1500n);
  assert.equal(shopMinorUnits("1.234", "BHD"), 1234n);
  assert.throws(() => shopMinorUnits("19.999", "USD"), /sub-minor precision/);
  assert.throws(() => shopMinorUnits("nan", "USD"), /not a usable decimal/);
});

test("shopify rates convert to exact percent strings", () => {
  assert.equal(rateToPercent(0.08625), "8.625");
  assert.equal(rateToPercent(0.08), "8");
  assert.equal(rateToPercent(null), null);
  assert.equal(rateToPercent("bogus"), null);
});

test("shopify refund normalizes against its order", () => {
  const refund = normalizeShopifyRefund(
    {
      id: 9001,
      note: "damaged",
      currency: "USD",
      created_at: "2026-07-16T09:00:00-04:00",
      refund_line_items: [
        { quantity: 1, subtotal: "25.00", total_tax: "2.16", restock: true, line_item: { id: 1, variant_id: 808, sku: "TEE-RED-M" } },
      ],
      order_adjustments: [{ kind: "shipping_refund", amount: "0.00" }],
      transactions: [{ gateway: "shopify_payments", amount: "27.16" }],
    },
    "450789469",
    "USD",
  );
  assert.equal(refund.externalId, "9001");
  assert.equal(refund.orderExternalId, "450789469");
  assert.equal(refund.reason, "damaged");
  assert.equal(refund.restock, true);
  assert.equal(refund.totalMinor, 2716n);
  assert.equal(refund.lines.length, 1);
  assert.equal(refund.lines[0]!.sku, "TEE-RED-M");
  assert.equal(refund.lines[0]!.variantExternalId, "808");
  assert.equal(refund.lines[0]!.amountMinor, 2500n);
  assert.equal(refund.lines[0]!.taxMinor, 216n);
  assert.equal(refund.lines[0]!.restock, true);
  assert.equal(refund.shippingMinor, 0n);
  assert.equal(refund.tenders[0]!.gateway, "shopify_payments");
});

test("Shopify orders refuse missing currency before pricing their amounts", () => {
  const payload = { ...shopifyOrderFixture(), currency: undefined };
  assert.throws(() => normalizeShopifyOrder(payload), (error: unknown) => {
    assert.ok(error instanceof CommerceError);
    assert.match(error.message, /order.*450789469.*currency/i);
    assert.match(error.remedy, /re-sync.*replay/i);
    return true;
  });
});

test("Shopify refunds preserve the verified order currency and refuse missing or conflicting evidence", () => {
  const payload = { id: 9002, transactions: [{ gateway: "shopify_payments", amount: "1.23" }] };
  assert.equal(normalizeShopifyRefund(payload, "450789469", "BHD").totalMinor, 1230n);
  assert.throws(() => normalizeShopifyRefund(payload, "450789469"), (error: unknown) => {
    assert.ok(error instanceof CommerceError);
    assert.match(error.message, /refund.*9002.*currency/i);
    assert.match(error.remedy, /order.*replay/i);
    return true;
  });
  assert.throws(() => normalizeShopifyRefund({ ...payload, currency: "USD" }, "450789469", "BHD"), (error: unknown) => {
    assert.ok(error instanceof CommerceError);
    assert.match(error.message, /USD.*BHD/);
    assert.match(error.remedy, /order.*replay/i);
    return true;
  });
});

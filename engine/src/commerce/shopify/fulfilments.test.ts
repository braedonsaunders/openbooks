import assert from "node:assert/strict";
import test from "node:test";
import { normalizeShopifyFulfilment } from "./fulfilments.ts";

test("shopify fulfilment normalizes lines, location and tracking", () => {
  const fulfilment = normalizeShopifyFulfilment(
    {
      id: 1048950313,
      order_id: 450789469,
      status: "success",
      created_at: "2026-07-16T10:00:00Z",
      location_id: 905684977,
      tracking_number: "TRK-1",
      tracking_numbers: ["TRK-1"],
      tracking_urls: ["https://example.com/TRK-1"],
      tracking_company: "UPS",
      line_items: [
        { id: 1, variant_id: 808, sku: "TEE-RED-M", quantity: 2 },
        { id: 2, variant_id: 809, sku: "TEE-RED-L", quantity: 1 },
      ],
    },
    "450789469",
  );
  assert.equal(fulfilment.externalId, "1048950313");
  assert.equal(fulfilment.orderExternalId, "450789469");
  assert.equal(fulfilment.locationExternalId, "905684977");
  assert.equal(fulfilment.cancelled, false);
  assert.equal(fulfilment.trackingNumber, "TRK-1");
  assert.equal(fulfilment.trackingUrl, "https://example.com/TRK-1");
  assert.equal(fulfilment.carrierName, "UPS");
  assert.equal(fulfilment.lines.length, 2);
  assert.equal(fulfilment.lines[0]!.variantExternalId, "808");
  assert.equal(fulfilment.lines[0]!.quantity, "2");
});

test("a cancelled shopify fulfilment normalizes with its flag set", () => {
  const fulfilment = normalizeShopifyFulfilment(
    {
      id: 1048950314,
      order_id: 450789469,
      status: "cancelled",
      created_at: "2026-07-17T10:00:00Z",
      location_id: 905684977,
      line_items: [{ id: 1, variant_id: 808, sku: "TEE-RED-M", quantity: 2 }],
    },
    "450789469",
  );
  assert.equal(fulfilment.cancelled, true);
  assert.equal(fulfilment.status, "cancelled");
});

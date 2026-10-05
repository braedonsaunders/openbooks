import assert from "node:assert/strict";
import test from "node:test";
import {
  mapTrackerStatus,
  parseAddressValidation,
  parseBoughtLabel,
  parseShipmentRates,
  parseTracker,
  shippoAdapter,
} from "./shippo.ts";

const RATES_FIXTURE = {
  object_id: "a21b8c9d4e5f60718293a4b5c6d7e8f90",
  object_owner: "test@example.com",
  status: "SUCCESS",
  address_from: { object_id: "addr_from", city: "New York", state: "NY", zip: "10003", country: "US" },
  address_to: { object_id: "addr_to", city: "San Francisco", state: "CA", zip: "94104", country: "US" },
  parcels: [{ length: "25", width: "20", height: "10", distance_unit: "cm", weight: "1.5", mass_unit: "kg" }],
  rates: [
    {
      object_id: "rate_fedex_home",
      provider: "FedEx",
      servicelevel: { token: "fedex_home_delivery", name: "Home Delivery" },
      amount: "14.20",
      currency: "USD",
      estimated_days: 3,
    },
    {
      object_id: "rate_dhl_express",
      provider: "DHL",
      servicelevel: { token: "dhl_express_worldwide", name: "Express Worldwide" },
      amount: "38.00",
      currency: "USD",
      estimated_days: 1,
    },
  ],
};

test("Shippo rate mapping keeps provider, service level, and exact amount", () => {
  const parsed = parseShipmentRates(RATES_FIXTURE);
  assert.equal(parsed.providerShipmentId, "a21b8c9d4e5f60718293a4b5c6d7e8f90");
  assert.deepEqual(parsed.rates, [
    {
      providerRateId: "rate_fedex_home",
      carrier: "FedEx",
      service: "Home Delivery",
      amount: "14.20",
      currency: "USD",
      deliveryDate: null,
      deliveryDays: 3,
    },
    {
      providerRateId: "rate_dhl_express",
      carrier: "DHL",
      service: "Express Worldwide",
      amount: "38.00",
      currency: "USD",
      deliveryDate: null,
      deliveryDays: 1,
    },
  ]);
});

test("Shippo rate mapping refuses a failed shipment with the provider message", () => {
  assert.throws(
    () =>
      parseShipmentRates({
        object_id: "deadbeef",
        status: "ERROR",
        messages: [{ text: "The destination postal code is invalid" }],
        rates: [],
      }),
    /destination postal code is invalid/,
  );
});

test("Shippo bought-label mapping refuses an errored transaction by name", () => {
  assert.throws(
    () =>
      parseBoughtLabel(
        { object_id: "txn_1", status: "ERROR", messages: [{ text: "Insufficient funds in the Shippo account" }] },
        "rate_fedex_home",
      ),
    /Insufficient funds in the Shippo account/,
  );
});

test("Shippo bought-label mapping keeps transaction artefacts", () => {
  const bought = parseBoughtLabel(
    {
      object_id: "txn_9c8b7a6b5d4e3f2a1b0c9d8e7f6a5b4c",
      object_owner: "test@example.com",
      status: "SUCCESS",
      shipment: "a21b8c9d4e5f60718293a4b5c6d7e8f90",
      rate: "14.20",
      currency: "USD",
      provider: "FedEx",
      servicelevel_name: "Home Delivery",
      tracking_number: "794657823410",
      label_url: "https://shippo-delivery.s3.amazonaws.com/txn_9c8b7a6b5d4e3f2a1b0c9d8e7f6a5b4c.pdf",
    },
    "rate_fedex_home",
  );
  assert.deepEqual(bought, {
    providerShipmentId: "a21b8c9d4e5f60718293a4b5c6d7e8f90",
    providerRateId: "rate_fedex_home",
    providerLabelId: "txn_9c8b7a6b5d4e3f2a1b0c9d8e7f6a5b4c",
    labelUrl: "https://shippo-delivery.s3.amazonaws.com/txn_9c8b7a6b5d4e3f2a1b0c9d8e7f6a5b4c.pdf",
    trackingNumber: "794657823410",
    carrier: "FedEx",
    service: "Home Delivery",
    amount: "14.20",
    currency: "USD",
  });
});

test("Shippo tracker maps the TRANSIT history onto the hub vocabulary", () => {
  const state = parseTracker({
    carrier: "fedex",
    tracking_number: "794657823410",
    tracking_status: { object_created: "2026-10-03T10:00:00Z", status: "TRANSIT", status_details: "Departed FedEx location" },
    tracking_history: [
      { status: "PRE_TRANSIT", status_details: "Label created", location: "New York, NY", status_date: "2026-10-02T09:00:00Z" },
      { status: "TRANSIT", status_details: "Departed FedEx location", location: "Newark, NJ", status_date: "2026-10-03T10:00:00Z" },
    ],
  });
  assert.equal(state.status, "in_transit");
  assert.deepEqual(state.events, [
    { id: null, status: "pre_transit", detail: "Label created", occurredAt: "2026-10-02T09:00:00Z" },
    { id: null, status: "in_transit", detail: "Departed FedEx location", occurredAt: "2026-10-03T10:00:00Z" },
  ]);
  assert.equal(mapTrackerStatus("DELIVERED"), "delivered");
  assert.equal(mapTrackerStatus("FAILURE"), "exception");
  assert.equal(mapTrackerStatus("SOMETHING_ELSE"), "unknown");
});

test("Shippo address validation reports the invalid answer with messages", () => {
  const answer = parseAddressValidation({
    object_id: "addr_to",
    validation_results: {
      is_valid: false,
      messages: [{ code: "Unknown Street", text: "The street was not found" }],
    },
  });
  assert.equal(answer.valid, false);
  assert.deepEqual(answer.messages, ["The street was not found"]);
});

test("Shippo inbound track event keeps carrier and tracking number", () => {
  const parsed = shippoAdapter.parseInboundEvent({
    id: "wh_3f2e1d0c9b8a79685746352413",
    event: "track_updated",
    data: {
      carrier: "fedex",
      tracking_number: "794657823410",
      tracking_status: { status: "DELIVERED", status_details: "Delivered" },
    },
  });
  assert.deepEqual(parsed, {
    eventId: "wh_3f2e1d0c9b8a79685746352413",
    tracker: { carrier: "fedex", trackingNumber: "794657823410" },
  });
});

test("Shippo inbound parsing ignores non-track deliveries without throwing", () => {
  assert.equal(shippoAdapter.parseInboundEvent({ event: "transaction_created", data: {} }), null);
  assert.equal(shippoAdapter.parseInboundEvent({ nonsense: true }), null);
  assert.equal(shippoAdapter.parseInboundEvent(null), null);
});

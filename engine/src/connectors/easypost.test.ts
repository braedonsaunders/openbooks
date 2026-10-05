import assert from "node:assert/strict";
import test from "node:test";
import {
  mapTrackerStatus,
  parseAddressVerification,
  parseBoughtLabel,
  parseShipmentRates,
} from "./easypost.ts";
import { easyPostAdapter } from "./easypost.ts";
import { decimalToMinorUnits, minorUnitsToLedger, verifyRelaySignature } from "./shipping.ts";

const RATES_FIXTURE = {
  id: "shp_9f3c2a1e4b5d6f7890abcdef12",
  object: "Shipment",
  to_address: { id: "adr_to", street1: "417 Montgomery St", city: "San Francisco", state: "CA", zip: "94104", country: "US" },
  from_address: { id: "adr_from", street1: "228 Park Ave S", city: "New York", state: "NY", zip: "10003", country: "US" },
  parcel: { id: "prcl_1", length: 10.2, width: 8.1, height: 4.0, weight: 32.0 },
  rates: [
    {
      id: "rate_ups_ground",
      object: "Rate",
      carrier: "UPS",
      service: "Ground",
      rate: "12.34",
      currency: "USD",
      delivery_days: 4,
      delivery_date: "2026-10-09T20:00:00Z",
    },
    {
      id: "rate_usps_priority",
      object: "Rate",
      carrier: "USPS",
      service: "Priority",
      rate: "9.87",
      currency: "USD",
      delivery_days: 2,
      delivery_date: null,
    },
  ],
};

test("EasyPost rate mapping keeps carrier, service, and exact amount", () => {
  const parsed = parseShipmentRates(RATES_FIXTURE);
  assert.equal(parsed.providerShipmentId, "shp_9f3c2a1e4b5d6f7890abcdef12");
  assert.deepEqual(parsed.rates, [
    {
      providerRateId: "rate_ups_ground",
      carrier: "UPS",
      service: "Ground",
      amount: "12.34",
      currency: "USD",
      deliveryDate: "2026-10-09",
      deliveryDays: 4,
    },
    {
      providerRateId: "rate_usps_priority",
      carrier: "USPS",
      service: "Priority",
      amount: "9.87",
      currency: "USD",
      deliveryDate: null,
      deliveryDays: 2,
    },
  ]);
});

test("EasyPost rate mapping refuses a shipment with no rates array", () => {
  assert.throws(() => parseShipmentRates({ id: "shp_1" }), /carries no rates array/);
});

test("EasyPost bought-label mapping keeps label artefacts and the charged rate", () => {
  const bought = parseBoughtLabel(
    {
      id: "shp_9f3c2a1e4b5d6f7890abcdef12",
      tracking_code: "1Z9999999999999999",
      selected_rate: { carrier: "UPS", service: "Ground", rate: "12.34", currency: "USD" },
      postage_label: {
        id: "pl_abc123",
        label_url: "https://easypost-files.s3.amazonaws.com/pl_abc123.pdf",
        label_pdf_url: "https://easypost-files.s3.amazonaws.com/pl_abc123.pdf",
      },
    },
    "shp_9f3c2a1e4b5d6f7890abcdef12",
    "rate_ups_ground",
  );
  assert.deepEqual(bought, {
    providerShipmentId: "shp_9f3c2a1e4b5d6f7890abcdef12",
    providerRateId: "rate_ups_ground",
    providerLabelId: "pl_abc123",
    labelUrl: "https://easypost-files.s3.amazonaws.com/pl_abc123.pdf",
    trackingNumber: "1Z9999999999999999",
    carrier: "UPS",
    service: "Ground",
    amount: "12.34",
    currency: "USD",
  });
});

test("EasyPost address verification reports failures with the provider message", () => {
  const answer = parseAddressVerification({
    id: "adr_to",
    verifications: {
      delivery: {
        success: false,
        errors: [{ message: "Address not found", code: "E.ADDRESS.NOT_FOUND" }],
      },
    },
  });
  assert.equal(answer.valid, false);
  assert.deepEqual(answer.messages, ["Address not found"]);
});

test("EasyPost tracker statuses map onto the hub vocabulary", () => {
  assert.equal(mapTrackerStatus("out_for_delivery"), "out_for_delivery");
  assert.equal(mapTrackerStatus("return_to_sender"), "returned");
  assert.equal(mapTrackerStatus("failure"), "exception");
  assert.equal(mapTrackerStatus("something_new"), "unknown");
});

test("EasyPost inbound tracker event keeps the provider shipment link", () => {
  const parsed = easyPostAdapter.parseInboundEvent({
    id: "evt_7d2c9a4f1b8e4c3a9d6f0b2e5",
    object: "Event",
    description: "tracker.updated",
    result: {
      id: "trk_55aa11bb22cc33dd44ee55ff",
      object: "Tracker",
      carrier: "UPS",
      tracking_code: "1Z9999999999999999",
      status: "in_transit",
      shipment_id: "shp_9f3c2a1e4b5d6f7890abcdef12",
    },
  });
  assert.deepEqual(parsed, {
    eventId: "evt_7d2c9a4f1b8e4c3a9d6f0b2e5",
    tracker: {
      trackerId: "trk_55aa11bb22cc33dd44ee55ff",
      carrier: "UPS",
      trackingNumber: "1Z9999999999999999",
      providerShipmentId: "shp_9f3c2a1e4b5d6f7890abcdef12",
    },
  });
});

test("EasyPost inbound parsing ignores non-tracker deliveries without throwing", () => {
  assert.equal(easyPostAdapter.parseInboundEvent({ id: "evt_1", object: "Event", description: "shipment.created", result: {} }), null);
  assert.equal(easyPostAdapter.parseInboundEvent({ nonsense: true }), null);
  assert.equal(easyPostAdapter.parseInboundEvent(null), null);
});

test("decimal to minor units is exact with half-up rounding", () => {
  assert.equal(decimalToMinorUnits("12.34", 2), 1234n);
  assert.equal(decimalToMinorUnits("12.345", 2), 1235n);
  assert.equal(decimalToMinorUnits("12.344", 2), 1234n);
  assert.equal(decimalToMinorUnits("1234", 0), 1234n);
  assert.equal(minorUnitsToLedger(1234n, 2), "12.34");
  assert.equal(minorUnitsToLedger(1234n, 0), "1234");
  assert.throws(() => decimalToMinorUnits("12,34", 2), /must be a decimal number/);
});

test("relay signature verifies the t.body scheme and refuses replays", async () => {
  const { createHmac } = await import("node:crypto");
  const secret = "relay-secret-for-tests";
  const t = String(Math.floor(Date.now() / 1000));
  const body = '{"id":"evt_1"}';
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  assert.equal(verifyRelaySignature(body, `t=${t},v1=${v1}`, secret), true);
  assert.equal(verifyRelaySignature(body, `t=${t},v1=deadbeef`, secret), false);
  assert.equal(verifyRelaySignature(body, "t=1,v1=whatever", secret), false);
  assert.equal(verifyRelaySignature(body, null, secret), false);
});

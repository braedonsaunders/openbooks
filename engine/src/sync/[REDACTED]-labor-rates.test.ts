import test from "node:test";
import assert from "node:assert/strict";
import {
  deterministicUuid,
  resolveCustomerReference,
  translateAdjustments,
  yesNo,
} from "./adminapp2-labor-rates.ts";

test("deterministic source identities are stable and resource-separated", () => {
  assert.equal(deterministicUuid("rate", 42), deterministicUuid("rate", "42"));
  assert.notEqual(deterministicUuid("rate", 42), deterministicUuid("item", 42));
  assert.match(
    deterministicUuid("rate", 42),
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("source yes/no values retain an unset state", () => {
  assert.equal(yesNo("Yes"), true);
  assert.equal(yesNo("No"), false);
  assert.equal(yesNo(""), null);
});

test("commercial source fields become general adjustments", () => {
  const rows = translateAdjustments({
    Markup: "0.15",
    TravelBreakout: "Yes",
    TravelType: "Hourly",
    HourAmount: "2",
    PerDiem: "80",
    PerDiemAddToRate: "No",
    CallInMinimum: "Four hours",
    FuelSurchargePercentage: "0.025",
  });
  assert.deepEqual(
    rows.map((row) => [row.code, row.category, row.calculation]),
    [
      ["markup", "markup", "percent"],
      ["travel", "travel", "per_hour"],
      ["per-diem", "allowance", "per_day"],
      ["call-in-minimum", "minimum", "text"],
      ["source-surcharge", "surcharge", "percent"],
    ],
  );
  assert.equal(
    rows.find((row) => row.code === "travel")?.presentation,
    "separate",
  );
});

test("customer attachment resolution prefers external ids unless usage proves local-id intent", () => {
  const external = { id: 8, NetsuiteID: 200, Name: "External match" };
  const local = { id: 200, NetsuiteID: 900, Name: "Local match" };
  const byLocal = new Map([[200, local]]);
  const byExternal = new Map([[200, external]]);
  assert.equal(
    resolveCustomerReference(200, 7, byLocal, byExternal, new Set()).customer
      ?.id,
    8,
  );
  assert.deepEqual(
    resolveCustomerReference(200, 7, byLocal, byExternal, new Set(["900:7"])),
    { customer: local, mode: "local" },
  );
  assert.equal(
    resolveCustomerReference(999, 7, byLocal, byExternal, new Set()).mode,
    "unresolved",
  );
});

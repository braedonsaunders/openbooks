import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTsqlEquipmentRateRows,
  toEquipmentRateRecord,
} from "./adminapp2-equipment-rates.ts";

test("normalizes a legacy day/week/month equipment schedule", () => {
  assert.deepEqual(
    toEquipmentRateRecord({
      id: 42,
      NetsuiteItemID: "2118",
      Daily: "50",
      Weekly: "175.5",
      Monthly: "600",
      AppliesTo: "1 1/2 inch impact",
      CategoryName: "Air tools",
    }),
    {
      sourceRateId: "42",
      netsuiteItemId: "2118",
      daily: "50.0000",
      weekly: "175.5000",
      monthly: "600.0000",
      appliesTo: "1 1/2 inch impact",
      category: "Air tools",
    },
  );
});

test("keeps zero rates and omits missing rate units", () => {
  const rate = toEquipmentRateRecord({
    id: "7",
    NetsuiteItemID: 2118,
    Daily: 0,
    Weekly: null,
    Monthly: "",
  });
  assert.equal(rate.daily, "0.0000");
  assert.equal(rate.weekly, null);
  assert.equal(rate.monthly, null);
});

test("rejects a legacy row without a usable price", () => {
  assert.throws(
    () =>
      toEquipmentRateRecord({
        id: 9,
        NetsuiteItemID: 2118,
        Daily: null,
        Weekly: null,
        Monthly: null,
      }),
    /has no prices/,
  );
});

test("parses quiet tsql tab output without treating diagnostics as data", () => {
  assert.deepEqual(
    parseTsqlEquipmentRateRows(
      "locale is en_CA\n42\t2118\t50.00\t175.00\t600.00\tImpact tools\tAir tools\n",
    ),
    [
      {
        id: "42",
        NetsuiteItemID: "2118",
        Daily: "50.00",
        Weekly: "175.00",
        Monthly: "600.00",
        AppliesTo: "Impact tools",
        CategoryName: "Air tools",
      },
    ],
  );
});

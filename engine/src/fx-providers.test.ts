import assert from "node:assert/strict";
import test from "node:test";
import {
  computeNextSyncAt,
  normalizeFxSnapshots,
  parseBankOfCanadaJson,
  parseEcbCsv,
  ratioRate,
} from "./fx-providers.ts";

test("ratioRate uses exact decimal arithmetic and numeric(19,10) rounding", () => {
  assert.equal(ratioRate("1", "1.25"), "0.8000000000");
  assert.equal(ratioRate("1.25", "1"), "1.2500000000");
  assert.equal(ratioRate("1", "3"), "0.3333333333");
  assert.equal(ratioRate("1e-2", "2"), "0.0050000000");
});

test("ECB CSV parser groups EUR-anchored observations by date", () => {
  const snapshots = parseEcbCsv([
    "KEY,CURRENCY,TIME_PERIOD,OBS_VALUE",
    "EXR.D.USD.EUR.SP00.A,USD,2026-07-14,1.1650",
    "EXR.D.CAD.EUR.SP00.A,CAD,2026-07-14,1.5900",
  ].join("\n"));
  assert.deepEqual(snapshots, [{
    date: "2026-07-14",
    anchor: "EUR",
    unitsPerAnchor: { EUR: "1", USD: "1.1650", CAD: "1.5900" },
  }]);
});

test("Bank of Canada parser converts CAD-per-foreign observations to a CAD anchor", () => {
  const snapshots = parseBankOfCanadaJson(JSON.stringify({
    observations: [{ d: "2026-07-14", FXUSDCAD: { v: "1.2500" } }],
  }));
  assert.deepEqual(snapshots, [{
    date: "2026-07-14",
    anchor: "CAD",
    unitsPerAnchor: { CAD: "1", USD: "0.8000000000" },
  }]);
});

test("normalization materializes every directed currency pair", () => {
  const rates = normalizeFxSnapshots([{
    date: "2026-07-14",
    anchor: "EUR",
    unitsPerAnchor: { EUR: "1", USD: "1.2", CAD: "1.5" },
  }], "CAD", ["USD", "EUR"]);
  assert.equal(rates.length, 6);
  assert.equal(rates.find((rate) => rate.fromCurrency === "USD" && rate.toCurrency === "CAD")?.rate, "1.2500000000");
  assert.equal(rates.find((rate) => rate.fromCurrency === "CAD" && rate.toCurrency === "USD")?.rate, "0.8000000000");
});

test("weekday schedules skip weekends and weekly schedules remain seven days apart", () => {
  assert.equal(
    computeNextSyncAt("weekdays", 22, new Date("2026-07-17T23:00:00Z"))?.toISOString(),
    "2026-07-20T22:00:00.000Z",
  );
  assert.equal(
    computeNextSyncAt("weekly", 22, new Date("2026-07-16T10:00:00Z"))?.toISOString(),
    "2026-07-23T22:00:00.000Z",
  );
});

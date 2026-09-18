import assert from "node:assert/strict";
import { AUSTRIA_TAX_PACK } from "./at.ts";

const pack = AUSTRIA_TAX_PACK;

// Pack found by country, version pin, single return pack.
assert.equal(pack.country, "AT");
assert.equal(pack.code, "AT_INDIRECT_TAX");
assert.equal(pack.version, "2026.08.01");
assert.equal(pack.countryTaxType, "vat");
assert.equal(pack.parentReturnPackCode, "AT_U30");
assert.equal(pack.returnPacks.length, 1);

const ret = pack.returnPacks[0];
assert.equal(ret.code, "AT_U30");
assert.equal(ret.defaultFrequency, "monthly");
assert.equal(ret.submissionChannel, "portal_manual");
assert.equal(ret.governmentFormat, "portal_entry");
assert.ok(ret.submissionUrl.startsWith("https://"), "submissionUrl is https");

// Box line codes present: U30 Kennzahlen plus the two OB workpaper boxes.
const byLine = new Map(ret.boxes.map((b) => [b.lineCode, b]));
for (const kz of ["000", "022", "029", "006", "060", "095", "OB_OUTPUT", "OB_INPUT"]) {
  assert.ok(byLine.has(kz), `box ${kz} present`);
}
const obOut = byLine.get("OB_OUTPUT");
const obIn = byLine.get("OB_INPUT");
assert.equal(obOut?.basis, "tax_collected");
assert.equal(obOut?.glMap, "sales");
assert.equal(obIn?.basis, "tax_paid");
assert.equal(obIn?.glMap, "purchases");

// Jurisdictions: USt is federal, no subnational VAT.
assert.equal(pack.jurisdictions.length, 0);

// Return-pack tax codes: keyed by our return, primary code is the standard one.
const keys = Object.keys(pack.returnPackTaxCodes);
assert.deepEqual(keys, ["AT_U30"]);
const raw = pack.returnPackTaxCodes["AT_U30"];
const codes = Array.isArray(raw) ? [...raw] : [raw];
assert.ok(codes.length > 0, "non-empty code set");
assert.equal(codes[0].code, "AT-VAT-STD");
assert.equal(codes[0].role, "standard");
assert.equal(codes[0].ratePercent, 20);
const byCode = new Map(codes.map((c) => [c.code, c]));
assert.equal(byCode.get("AT-VAT-RED10")?.role, "reduced");
assert.equal(byCode.get("AT-VAT-RED10")?.ratePercent, 10);
assert.equal(byCode.get("AT-VAT-RED13")?.role, "reduced");
assert.equal(byCode.get("AT-VAT-RED13")?.ratePercent, 13);
assert.equal(byCode.get("AT-VAT-ENCLAVE")?.role, undefined);
assert.equal(byCode.get("AT-VAT-ENCLAVE")?.ratePercent, 19);

// Every sourceId resolves; rate history is contiguous per code.
const sourceIds = new Set(pack.sources.map((s) => s.id));
assert.ok(sourceIds.size === pack.sources.length, "source ids unique");
for (const s of pack.sources) {
  assert.ok(s.url.startsWith("https://"), `source ${s.id} url is https`);
  assert.ok(s.asOf.length > 0, `source ${s.id} has asOf`);
}
for (const c of codes) {
  assert.ok(c.rates && c.rates.length > 0, `${c.code} has rates`);
  const sorted = [...(c.rates ?? [])].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  for (const r of sorted) {
    assert.ok(sourceIds.has(r.sourceId), `${c.code} sourceId ${r.sourceId} resolves`);
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const nxt = sorted[i + 1];
    assert.ok(cur.effectiveTo, `${c.code} non-terminal rate has effectiveTo`);
    const dayAfter = new Date(`${cur.effectiveTo}T00:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    assert.equal(nxt.effectiveFrom, dayAfter.toISOString().slice(0, 10), `${c.code} history contiguous`);
  }
}

console.log(`AT pack OK: ${ret.code}, ${ret.boxes.length} boxes, ${codes.length} codes, ${pack.sources.length} sources`);

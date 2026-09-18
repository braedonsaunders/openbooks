import assert from "node:assert/strict";
import test from "node:test";
import { PACK_DEFAULT_CODES } from "../tax-pack-provisioning.ts";
import { packTaxCodesForReturn } from "./index.ts";
import { SPAIN_TAX_PACK } from "./es.ts";

const SOURCE_ID = "aeat_reduced_rates_applicability";

test("Spain declares standard, reducido, and superreducido codes on ES_MODELO303", () => {
  const definitions = packTaxCodesForReturn(SPAIN_TAX_PACK, "ES_MODELO303");
  assert.deepEqual(definitions.map((definition) => definition.code), [
    "ES-VAT-STD",
    "ES-VAT-RED",
    "ES-VAT-SUPERRED",
  ]);
  assert.equal(definitions[0]!.role, undefined);
  assert.equal(definitions[1]!.role, "reduced");
  assert.equal(definitions[2]!.role, "reduced");
});

test("Spain reducido and superreducido carry left-truncated AEAT applicability schedules", () => {
  const definitions = packTaxCodesForReturn(SPAIN_TAX_PACK, "ES_MODELO303");
  const reducido = definitions.find((definition) => definition.code === "ES-VAT-RED")!;
  const superreducido = definitions.find((definition) => definition.code === "ES-VAT-SUPERRED")!;
  assert.deepEqual(reducido.rates, [{ ratePercent: 10, effectiveFrom: "2026-03-26", sourceId: SOURCE_ID }]);
  assert.deepEqual(superreducido.rates, [{ ratePercent: 4, effectiveFrom: "2026-03-26", sourceId: SOURCE_ID }]);
  assert.equal(reducido.ratePercent, 10);
  assert.equal(superreducido.ratePercent, 4);
});

test("Spain reduced-rate source is the live AEAT rates page, titled as applicability", () => {
  const source = SPAIN_TAX_PACK.sources.find((entry) => entry.id === SOURCE_ID)!;
  assert.ok(source, "missing reduced-rate source");
  assert.equal(source.url, "https://sede.agenciatributaria.gob.es/Sede/iva/regimenes-tributacion-iva/regimen-general.html");
  assert.equal(source.asOf, "2026-03-26");
  assert.match(source.title, /applicability/);
});

test("Spain headline default code stays the standard 21% rate", () => {
  assert.equal(PACK_DEFAULT_CODES.ES_MODELO303?.code, "ES-VAT-STD");
  assert.equal(PACK_DEFAULT_CODES.ES_MODELO303?.ratePercent, 21);
  assert.deepEqual(PACK_DEFAULT_CODES.ES_MODELO303?.rates, [
    { ratePercent: 21, effectiveFrom: "2012-09-01", sourceId: "aeat_2012_standard_rate_change" },
  ]);
});

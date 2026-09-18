import assert from "node:assert/strict";
import test from "node:test";
import { isTaxProvisionSelection, PACK_DEFAULT_CODES, supportedTaxCountries } from "../tax-pack-provisioning.ts";
import { COUNTRY_TAX_PACKS, packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import type { CountryTaxPackDefinition, EffectiveTaxRate } from "./types.ts";

const maintainedCountries = ["CH", "AT", "BE", "PL", "SE", "KR"] as const;

function pack(country: (typeof maintainedCountries)[number]): CountryTaxPackDefinition {
  const value = COUNTRY_TAX_PACKS.find((entry) => entry.country === country);
  assert.ok(value, `missing ${country} country pack`);
  return value;
}

function parentReturn(country: (typeof maintainedCountries)[number]): string {
  const parent = pack(country).parentReturnPackCode;
  assert.ok(parent, `${country} must name a parent return pack`);
  return parent;
}

function assertContiguous(rates: readonly EffectiveTaxRate[], code: string): void {
  assert.ok(rates.length > 0, `${code} must carry at least one rate`);
  for (let index = 1; index < rates.length; index++) {
    const prior = rates[index - 1];
    assert.ok(prior, `${code}: rate history stays in bounds`);
    const current = rates[index];
    assert.ok(current, `${code}: rate history stays in bounds`);
    assert.ok(prior.effectiveTo, `${code}: rate before ${current.effectiveFrom} must be closed`);
    const expected = new Date(`${prior.effectiveTo}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    assert.equal(current.effectiveFrom, expected.toISOString().slice(0, 10), `${code}: gap before ${current.effectiveFrom}`);
  }
}

test("fourth-wave maintained country packs are directly provisionable", () => {
  const countries = new Map(supportedTaxCountries().map((entry) => [entry.country, entry]));
  for (const country of maintainedCountries) {
    const definition = pack(country);
    const catalog = countries.get(country);
    assert.ok(catalog, `${country} is absent from setup`);
    assert.equal(catalog.countryStatus, "ready");
    assert.equal(catalog.countryPack, definition.parentReturnPackCode);
    assert.equal(definition.returnPacks.length, 1);
    assert.equal(isTaxProvisionSelection(definition.parentReturnPackCode!), true);
    assert.equal(definition.version, "2026.08.01");
    assert.equal(definition.jurisdictions.length, 0, `${country} must not invent subnational indirect-tax jurisdictions`);
  }
});

test("fourth-wave code sets declare exactly the parent return with contiguous, sourced schedules", () => {
  for (const country of maintainedCountries) {
    const definition = pack(country);
    const parent = parentReturn(country);
    assert.deepEqual(packReturnCodesWithTaxCodes(definition), [parent]);
    const codes = packTaxCodesForReturn(definition, parent);
    assert.ok(codes.length > 0, `${country}: ${parent} declares no tax codes`);
    const sourceIds = new Set(definition.sources.map((source) => source.id));
    for (const code of codes) {
      const rates = code.rates ?? [];
      assertContiguous(rates, code.code);
      for (const rate of rates) {
        assert.ok(sourceIds.has(rate.sourceId), `${code.code}: unknown sourceId ${rate.sourceId}`);
      }
    }
  }
});

test("fourth-wave primary code is the standard band, not a reduced one", () => {
  for (const country of maintainedCountries) {
    const definition = pack(country);
    const parent = parentReturn(country);
    const codes = packTaxCodesForReturn(definition, parent);
    assert.equal(
      codes.filter((code) => code.role === "standard").length,
      1,
      `${country}: exactly one standard-role code`,
    );
    const primary = primaryPackTaxCode(definition, parent);
    assert.ok(primary, `${country}: ${parent} resolves no primary code`);
    assert.equal(primary.role, "standard", `${country}: primary code must be the standard band`);
    const headline = PACK_DEFAULT_CODES[parent];
    assert.ok(headline, `${country}: ${parent} has no headline code`);
    assert.equal(headline.code, primary.code, `${country}: headline code must match the primary`);
  }
});

test("fourth-wave evidence is https with an asOf on every source", () => {
  for (const country of maintainedCountries) {
    const definition = pack(country);
    const sourceIds = new Set(definition.sources.map((source) => source.id));
    assert.equal(sourceIds.size, definition.sources.length, `${country}: source ids unique`);
    for (const source of definition.sources) {
      assert.ok(source.url.startsWith("https://"), `${country}: source ${source.id} url is https`);
      assert.ok(source.asOf.length > 0, `${country}: source ${source.id} has asOf`);
    }
  }
});

test("fourth-wave evidence remains restricted to official government and tax-authority hosts", () => {
  const officialHosts = new Set([
    "www.estv.admin.ch",
    "www.bazg.admin.ch",
    "www.estv2.admin.ch",
    "formulare.bmf.gv.at",
    "www.usp.gv.at",
    "finanzonline.bmf.gv.at",
    "finance.belgium.be",
    "www.podatki.gov.pl",
    "podatki-arch.mf.gov.pl",
    "api.sejm.gov.pl",
    "www.skatteverket.se",
    "nts.go.kr",
    "mofe.go.kr",
  ]);
  // Mirrored primary documents, id-specific and never host-wide: the document
  // is the authority's own file and only the host is secondary. Each entry
  // names the refusal in the owning pack's doc comment.
  const mirroredPrimaryDocuments: Record<string, string> = {
    // BMF's own U30 form (KZ 037 Jungholz/Mittelberg claim) via the
    // statutory chamber's mirror; the BMF formularservice does not host
    // that vintage. See the Austria pack doc comment.
    bmf_u30_2023: "www.wko.at",
  };
  const seenExceptions = new Set<string>();
  for (const country of maintainedCountries) {
    for (const source of pack(country).sources) {
      const host = new URL(source.url).hostname;
      if (mirroredPrimaryDocuments[source.id] === host) {
        seenExceptions.add(source.id);
        continue;
      }
      assert.ok(officialHosts.has(host), `${source.id} is not an approved primary-source host`);
    }
  }
  assert.deepEqual([...seenExceptions].sort(), Object.keys(mirroredPrimaryDocuments).sort(), "named exceptions must all be live");
});

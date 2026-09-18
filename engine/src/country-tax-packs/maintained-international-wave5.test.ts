import assert from "node:assert/strict";
import test from "node:test";
import { isTaxProvisionSelection, PACK_DEFAULT_CODES, supportedTaxCountries } from "../tax-pack-provisioning.ts";
import { COUNTRY_TAX_PACKS, packReturnCodesWithTaxCodes, packTaxCodesForReturn, primaryPackTaxCode } from "./index.ts";
import type { CountryTaxPackDefinition, EffectiveTaxRate } from "./types.ts";

const maintainedCountries = ["PT", "DK", "NO", "SA", "TR", "CZ"] as const;

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

test("fifth-wave maintained country packs are directly provisionable", () => {
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

test("fifth-wave code sets declare exactly the parent return with contiguous, sourced schedules", () => {
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

test("fifth-wave code-set sizes match territorial reality, including the PT and DK exceptions", () => {
  // Portugal files one national return for three rate territories: the
  // Declaracao Periodica fixes the sede territory in Quadro 03 and
  // consolidates other-territory operations via ANEXO R, so the nine codes
  // are regional rate bands — three of them role standard (Continente 23,
  // Madeira 22, Acores 16) — and jurisdictions stays empty by design.
  const pt = pack("PT");
  const ptCodes = packTaxCodesForReturn(pt, parentReturn("PT"));
  assert.equal(ptCodes.length, 9, "PT: nine regional rate bands on the single national return");
  assert.equal(
    ptCodes.filter((code) => code.role === "standard").length,
    3,
    "PT: one standard band per rate territory (Continente, Madeira, Acores)",
  );
  // Denmark has no reduced VAT rate, so one code is the complete set.
  const dk = pack("DK");
  assert.equal(packTaxCodesForReturn(dk, parentReturn("DK")).length, 1, "DK: a single standard code is the whole set");
});

test("fifth-wave primary code is a standard band, never a reduced one", () => {
  for (const country of maintainedCountries) {
    const definition = pack(country);
    const parent = parentReturn(country);
    const codes = packTaxCodesForReturn(definition, parent);
    const standards = codes.filter((code) => code.role === "standard");
    if (country === "PT") {
      assert.equal(standards.length, 3, "PT: exactly three territorial standard bands");
    } else {
      assert.equal(standards.length, 1, `${country}: exactly one standard-role code`);
    }
    const primary = primaryPackTaxCode(definition, parent);
    assert.ok(primary, `${country}: ${parent} resolves no primary code`);
    assert.equal(primary.role, "standard", `${country}: primary code must be a standard band`);
    const headline = PACK_DEFAULT_CODES[parent];
    assert.ok(headline, `${country}: ${parent} has no headline code`);
    assert.equal(headline.code, primary.code, `${country}: headline code must match the primary`);
  }
  assert.equal(primaryPackTaxCode(pack("PT"), parentReturn("PT"))?.code, "PT-VAT-STD", "PT: Continente 23 is the headline standard");
});

test("fifth-wave evidence is https with an asOf on every source", () => {
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

test("fifth-wave evidence remains restricted to official government and tax-authority hosts", () => {
  const officialHosts = new Set([
    "www.portaldasfinancas.gov.pt",
    "info.portaldasfinancas.gov.pt",
    "at.madeira.gov.pt",
    "skat.dk",
    "www.retsinformation.dk",
    "www.skatteetaten.no",
    "lovdata.no",
    "zatca.gov.sa",
    "dijital.gib.gov.tr",
    "ebeyan.gib.gov.tr",
    "www.resmigazete.gov.tr",
    "financnisprava.gov.cz",
    "adisspr.mfcr.cz",
    // e-Sbírka — the state's official legislation portal (zákon č.
    // 349/2023 Sb. consolidation act for the Czechia 12%/books origin).
    // A stronger host than either agency page: the enacted instrument.
    "www.e-sbirka.cz",
  ]);
  // Mirrored primary documents, id-specific and never host-wide: the document
  // is the authority's own file and only the host is secondary. Each entry
  // names the refusal in the owning pack's doc comment.
  const mirroredPrimaryDocuments: Record<string, string> = {
    // Skatteetaten's own published SAF-T code specification (mvaKodeSAFT)
    // for the mva-meldingen return; the tax agency publishes its machine
    // return specification on GitHub. See the Norway pack doc comment.
    saft_mva_koder: "github.com",
    // DSIVA's own 2010 ofícios circulados via professional-body mirrors: the
    // AT portal archives no DSIVA-era ofícios and the gazette PDFs are not
    // retrievable from this sandbox. Both texts were read in full and state
    // exactly the cited rates and dates. See the Portugal pack doc comment.
    at_dp_modelo_instrucoes: "www.aproces.org",
    dsiva_oc30118_2010_aplicabilidade: "cihc.occ.pt",
    dsiva_oc30121_2010_taxa_normal: "www.apeca.pt",
    // Sovos regulatory update on Government Bill 488: the only reachable
    // attestation of the 15%+10% to 12% consolidation and its 2024-01-01
    // date. See the Czechia pack doc comment.
    // learn.microsoft.com documentation page for the Czech VAT declaration
    // rows and DPHDP3/DPHKH1 formats: no FS-hosted equivalent is reachable.
    // See the Czechia pack doc comment.
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

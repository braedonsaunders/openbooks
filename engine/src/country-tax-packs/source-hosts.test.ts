import assert from "node:assert/strict";
import test from "node:test";
import { COUNTRY_TAX_PACKS } from "./index.ts";

/**
 * Fleet-wide source-host guard (tax-vendor-sweep). The per-wave proofs each
 * allowlist only their own wave's countries, so a pack resting on a vendor
 * or junk host outside its wave went unnoticed three times (a Sovos page
 * behind RO, a Jimdo CDN and a private mirror behind MX, a private PDF
 * behind HU). This test scans EVERY registered pack as a set: each source
 * URL must sit on an authority host or a NAMED per-source-id exception.
 * Additions to either list name their reason inline.
 */
const authorityHosts = new Set([
  // AE / AR / AT / AU / BE
  "www.tax.gov.ae",
  "tax.gov.ae",
  "servicios.infoleg.gob.ar",
  "www.afip.gob.ar",
  "biblioteca.arca.gob.ar",
  "www.arca.gob.ar",
  "formulare.bmf.gv.at",
  "www.usp.gv.at",
  "finanzonline.bmf.gv.at",
  "www.ato.gov.au",
  "finance.belgium.be",
  // CA / CH / CL / CO / CZ
  "www.canada.ca",
  "www.bclaws.gov.bc.ca",
  "www.gov.mb.ca",
  "www.revenuquebec.ca",
  "sets.saskatchewan.ca",
  "www.estv.admin.ch",
  "www.bazg.admin.ch",
  "www.estv2.admin.ch",
  "www.sii.cl",
  "www.contraloria.cl",
  "www.dian.gov.co",
  "www.funcionpublica.gov.co",
  "muisca.dian.gov.co",
  "financnisprava.gov.cz",
  "www.e-sbirka.cz",
  "adisspr.mfcr.cz",
  // DE / DK / ES / FI / FR / GB
  "www.bundesfinanzministerium.de",
  "www.elster.de",
  "skat.dk",
  "www.retsinformation.dk",
  "sede.agenciatributaria.gob.es",
  "www.vero.fi",
  "vero.fi",
  "bofip.impots.gouv.fr",
  "www.impots.gouv.fr",
  "www.gov.uk",
  // GR / HU / IE / IN / IS
  "diavgeia.gov.gr",
  "minfin.gov.gr",
  "nav.gov.hu",
  "www.magyarkozlony.hu",
  "www.revenue.ie",
  "cbic-gst.gov.in",
  "tutorial.gst.gov.in",
  "www.skatturinn.is",
  "www.althingi.is",
  "www.reglugerd.is",
  // IT / JP / KE / KR / MX
  "www.gazzettaufficiale.it",
  "def.finanze.it",
  "www1.agenziaentrate.gov.it",
  "www.agenziaentrate.gov.it",
  "www.nta.go.jp",
  "www.kra.go.ke",
  "nts.go.kr",
  "mofe.go.kr",
  "www.diputados.gob.mx",
  "www.sat.gob.mx",
  "dof.gob.mx",
  // NL / NO / NZ / PH / PL
  "www.belastingdienst.nl",
  "zoek.officielebekendmakingen.nl",
  "download.belastingdienst.nl",
  "wetten.overheid.nl",
  "lovdata.no",
  "www.skatteetaten.no",
  "www.taxtechnical.ird.govt.nz",
  "www.ird.govt.nz",
  "www.bir.gov.ph",
  "bir-cdn.bir.gov.ph",
  "www.podatki.gov.pl",
  "api.sejm.gov.pl",
  "podatki-arch.mf.gov.pl",
  // PT / RO / SA / SE / SG
  "www.portaldasfinancas.gov.pt",
  "info.portaldasfinancas.gov.pt",
  "at.madeira.gov.pt",
  "static.anaf.ro",
  "zatca.gov.sa",
  "www.skatteverket.se",
  "svenskforfattningssamling.se",
  "www.iras.gov.sg",
  "apisandbox.iras.gov.sg",
  // TH / TR / US / VN / ZA
  "www.rd.go.th",
  "rd.go.th",
  "efiling.rd.go.th",
  "www.resmigazete.gov.tr",
  "dijital.gib.gov.tr",
  "ebeyan.gib.gov.tr",
  "otr.cfo.dc.gov",
  "revenue.louisiana.gov",
  "www.tax.newmexico.gov",
  "dor.sd.gov",
  "www.cdtfa.ca.gov",
  "comptroller.texas.gov",
  "www.tax.ny.gov",
  "floridarevenue.com",
  "congbaocdn.chinhphu.vn",
  "www.vietnamtradeportal.gov.vn",
  "thuedientu.gdt.gov.vn",
  "www.sars.gov.za",
]);

/**
 * Mirrored primary documents, id-specific and never host-wide: the document
 * is the authority's own file and only the host is secondary. Each entry
 * names its reason; the owning pack's doc comment carries the full story.
 */
const mirroredPrimaryDocuments: Record<string, string> = {
  // BMF's own U30 form (KZ 037 Jungholz/Mittelberg claim) via the
  // statutory chamber's mirror; the BMF formularservice does not host
  // that vintage. See the Austria pack doc comment.
  bmf_u30_2023: "www.wko.at",
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
  // AADE's own Φ2 form (050 ΦΠΑ ΕΚΔΟΣΗ 2024 under decision A.1058/2024)
  // mirrored by the logistis.gr accounting portal; every 2024 box change
  // cross-checks against AADE circular E.2030 on Diavgeia. See the Greece
  // pack doc comment.
  gr_f2_form_2024_mirror: "www.logistis.gr",
  // OPANAF order 2131/2025 (D300 model, MO nr. 826/2025) mirrored by the
  // LegisRO legal publisher; the mirrored PDF carries the official
  // “Monitorul Oficial al României, Partea I, nr. 826/2025” reference.
  // Re-source to an ANAF host if the order appears there.
  mo_826_2025_d300: "legis.medleg.ro",
  // Streamlined Sales Tax Governing Board state-rate tables: the joint
  // publication of the member-state revenue agencies, not a vendor.
  sst_state_tables: "www.streamlinedsalestax.org",
  // USPS postal abbreviations for the US state-code table: the federal
  // postal authority's own publication, not a vendor.
  usps_subdivision_codes: "about.usps.com",
};

test("every registered pack sources only authority hosts or named mirror exceptions", () => {
  assert.ok(COUNTRY_TAX_PACKS.length > 0, "no country tax packs registered");
  const seenExceptions = new Set<string>();
  for (const definition of COUNTRY_TAX_PACKS) {
    assert.ok(definition.sources.length > 0, `${definition.country} declares no sources`);
    for (const source of definition.sources) {
      const host = new URL(source.url).hostname;
      if (mirroredPrimaryDocuments[source.id] === host) {
        seenExceptions.add(source.id);
        continue;
      }
      assert.ok(
        authorityHosts.has(host),
        `${definition.country}/${source.id} rests on non-authority host ${host} — re-source to the authority or name a per-source-id exception`,
      );
    }
  }
  assert.deepEqual([...seenExceptions].sort(), Object.keys(mirroredPrimaryDocuments).sort(), "named exceptions must all be live");
});

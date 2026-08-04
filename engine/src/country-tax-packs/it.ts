import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const IT_LIPE_2026: TaxReturnPack = {
  code: "IT_LIPE",
  name: "Comunicazione delle liquidazioni periodiche IVA (LIPE)",
  country: "IT",
  jurisdiction: { code: "IT", name: "Italy", country: "IT", level: "country", taxType: "vat" },
  defaultFrequency: "quarterly",
  submissionChannel: "file_upload",
  governmentFormat: "certified_file",
  submissionUrl: "https://www1.agenziaentrate.gov.it/servizi/scadenzario/main.php?chi=1595&come=518&cosa=11479&entroil=02-03-2026&op=4",
  watermark: "Working copy — LIPE transmission is exclusively telematic; validate all credits, advances, interest, and special cases before submission",
  boxes: [
    { lineCode: "VP2", label: "Totale operazioni attive, al netto dell'IVA", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
    { lineCode: "VP3", label: "Totale operazioni passive, al netto dell'IVA", sign: 1, sequence: 20, basis: "taxable_base", glMap: "purchases" },
    { lineCode: "VP4", label: "IVA esigibile", sign: -1, sequence: 30, basis: "tax_collected", glMap: "sales" },
    { lineCode: "VP5", label: "IVA detratta", sign: 1, sequence: 40, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "VP6", label: "IVA dovuta o a credito", sign: 1, sequence: 50 },
    { lineCode: "VP7", label: "Debito del periodo precedente non superiore a €25,82", sign: 1, sequence: 60 },
    { lineCode: "VP8", label: "Credito del periodo precedente", sign: 1, sequence: 70 },
    { lineCode: "VP9", label: "Credito dell'anno precedente", sign: 1, sequence: 80 },
    { lineCode: "VP10", label: "Versamenti auto UE", sign: 1, sequence: 90 },
    { lineCode: "VP11", label: "Crediti d'imposta", sign: 1, sequence: 100 },
    { lineCode: "VP12", label: "Interessi dovuti per liquidazioni trimestrali", sign: 1, sequence: 110 },
    { lineCode: "VP13", label: "Acconto dovuto", sign: 1, sequence: 120 },
    { lineCode: "VP14", label: "IVA da versare o a credito", sign: 1, sequence: 130 },
  ],
};

/** Italy VAT localization maintained from Italian tax-administration and official-gazette sources. */
export const ITALY_TAX_PACK: CountryTaxPackDefinition = {
  code: "IT_INDIRECT_TAX",
  version: "2026.08.01",
  country: "IT",
  name: "Italy",
  countryTaxType: "vat",
  parentReturnPackCode: "IT_LIPE",
  completeness: {
    jurisdictions: "not_applicable",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "italy_vat_22_from_2013",
      title: "Gazzetta Ufficiale — statutory record of the standard VAT increase to 22% from 1 October 2013",
      url: "https://www.gazzettaufficiale.it/do/gazzetta/downloadPdf?dataPubblicazioneGazzetta=20251017&edizione=0&estensione=pdf&numeroGazzetta=242&numeroSupplemento=0&progressivo=0&tipoSerie=SG&tipoSupplemento=GU",
      asOf: "2026-08-01",
    },
    {
      id: "italy_lipe_official_model",
      title: "Ministry of Economy and Finance — official Quadro VP line definitions",
      url: "https://def.finanze.it/DocTribFrontend/getContent.do?id=%7BA8483A0A-B513-4D68-BE52-940822A0C478%7D",
      asOf: "2026-08-01",
    },
    {
      id: "agenzia_lipe_2026",
      title: "Agenzia delle Entrate — 2026 LIPE filing requirement and telematic submission method",
      url: "https://www1.agenziaentrate.gov.it/servizi/scadenzario/main.php?chi=1595&come=518&cosa=11479&entroil=02-03-2026&op=4",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [IT_LIPE_2026],
  returnPackTaxCodes: {
    IT_LIPE: {
      code: "IT-VAT-STD",
      name: "Italy standard VAT",
      ratePercent: 22,
      rates: [{ ratePercent: 22, effectiveFrom: "2013-10-01", sourceId: "italy_vat_22_from_2013" }],
    },
  },
};

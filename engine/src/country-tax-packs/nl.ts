import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const NL_OB_2026: TaxReturnPack = {
  code: "NL_OB",
  name: "Aangifte omzetbelasting 2026",
  country: "NL",
  jurisdiction: { code: "NL", name: "Netherlands", country: "NL", level: "country", taxType: "vat" },
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.belastingdienst.nl/wps/wcm/connect/nl/btw/content/ik-moet-btw-aangifte-doen-hoe-vul-ik-die-in",
  watermark: "Working copy — review every rubriek and submit through Mijn Belastingdienst Zakelijk or approved software",
  boxes: [
    { lineCode: "1a", label: "Leveringen/diensten belast met hoog tarief", sign: 1, sequence: 10 },
    { lineCode: "1b", label: "Leveringen/diensten belast met laag tarief", sign: 1, sequence: 20 },
    { lineCode: "1c", label: "Leveringen/diensten belast met overige tarieven, behalve 0%", sign: 1, sequence: 30 },
    { lineCode: "1d", label: "Privégebruik", sign: 1, sequence: 40 },
    { lineCode: "1e", label: "Leveringen/diensten belast met 0% of niet bij u belast", sign: 1, sequence: 50 },
    { lineCode: "2a", label: "Leveringen/diensten waarbij de heffing van omzetbelasting naar u is verlegd", sign: 1, sequence: 60 },
    { lineCode: "3a", label: "Leveringen naar landen buiten de EU", sign: 1, sequence: 70 },
    { lineCode: "3b", label: "Leveringen naar of diensten in landen binnen de EU", sign: 1, sequence: 80 },
    { lineCode: "3c", label: "Installatie/afstandsverkopen binnen de EU", sign: 1, sequence: 90 },
    { lineCode: "4a", label: "Leveringen/diensten uit landen buiten de EU", sign: 1, sequence: 100 },
    { lineCode: "4b", label: "Leveringen/diensten uit landen binnen de EU", sign: 1, sequence: 110 },
    { lineCode: "5a", label: "Verschuldigde omzetbelasting", sign: -1, sequence: 120, basis: "tax_collected", glMap: "sales" },
    { lineCode: "5b", label: "Voorbelasting", sign: 1, sequence: 130, basis: "tax_paid", glMap: "purchases" },
  ],
};

/** Netherlands VAT localization maintained from Belastingdienst and official legislative sources. */
export const NETHERLANDS_TAX_PACK: CountryTaxPackDefinition = {
  code: "NL_INDIRECT_TAX",
  version: "2026.08.01",
  country: "NL",
  name: "Netherlands",
  countryTaxType: "vat",
  parentReturnPackCode: "NL_OB",
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
      id: "belastingdienst_current_vat_rates",
      title: "Belastingdienst — current VAT rates",
      url: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/btw_berekenen_aan_uw_klanten/btw_berekenen/btw_tarief/btw_tarief",
      asOf: "2026-08-01",
    },
    {
      id: "netherlands_standard_rate_history",
      title: "Dutch Parliament — historical standard VAT-rate table",
      url: "https://zoek.officielebekendmakingen.nl/blg-219731.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "netherlands_vat_21_2012",
      title: "Official Gazette — 2012 Tax Agreement Act increasing VAT from 19% to 21%",
      url: "https://zoek.officielebekendmakingen.nl/stb-2012-321.html",
      asOf: "2026-08-01",
    },
    {
      id: "belastingdienst_vat_return_2026",
      title: "Belastingdienst — official 2026 VAT return guidance",
      url: "https://download.belastingdienst.nl/belastingdienst/docs/toelichting_bij_btw_aangifte_ob0731t62fd.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "wet_ob_1968_article_9_reduced_6",
      title: "Wettenbank — Wet op de omzetbelasting 1968, article 9 (6% verlaagd tarief, verified in force 2005–2018)",
      url: "https://wetten.overheid.nl/BWBR0002629/2018-10-01",
      asOf: "2026-09-18",
    },
    {
      id: "netherlands_vat_reduced_9_2019",
      title: "Official Gazette — Belastingplan 2019 raising the reduced VAT rate from 6% to 9% (article XXIV, in force 2019-01-01)",
      url: "https://zoek.officielebekendmakingen.nl/stb-2018-504.html",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [NL_OB_2026],
  returnPackTaxCodes: {
    NL_OB: [
      {
        code: "NL-VAT-STD",
        name: "Netherlands standard VAT",
        ratePercent: 21,
        role: "standard",
        rates: [
          { ratePercent: 17.5, effectiveFrom: "1992-10-01", effectiveTo: "2000-12-31", sourceId: "netherlands_standard_rate_history" },
          { ratePercent: 19, effectiveFrom: "2001-01-01", effectiveTo: "2012-09-30", sourceId: "netherlands_standard_rate_history" },
          { ratePercent: 21, effectiveFrom: "2012-10-01", sourceId: "netherlands_vat_21_2012" },
        ],
        // Rubriek 1a names the "hoog tarief" in words, not numbers.
        returnBoxes: ["1a"],
      },
      {
        code: "NL-VAT-RED",
        name: "Netherlands reduced VAT",
        ratePercent: 9,
        role: "reduced",
        rates: [
          // Earliest Wettenbank version verified in force; pre-2005 reduced-rate origin not transcribed.
          { ratePercent: 6, effectiveFrom: "2005-01-01", effectiveTo: "2018-12-31", sourceId: "wet_ob_1968_article_9_reduced_6" },
          { ratePercent: 9, effectiveFrom: "2019-01-01", sourceId: "netherlands_vat_reduced_9_2019" },
        ],
        // Rubriek 1b names the "laag tarief" in words, not numbers.
        returnBoxes: ["1b"],
      },
    ],
  },
};

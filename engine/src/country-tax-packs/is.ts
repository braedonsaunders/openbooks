import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const IS_VSK_2026: TaxReturnPack = {
  code: "IS_VSK",
  name: "Virðisaukaskattsskýrsla — VSK return filed to Skatturinn",
  country: "IS",
  jurisdiction: { code: "IS", name: "Iceland", country: "IS", level: "country", taxType: "vat" },
  defaultFrequency: "bimonthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.skatturinn.is/english/companies/value-added-tax/",
  watermark: "Working copy — confirm the settlement period on skattur.is, then file the electronic VSK return",
  boxes: [
    { lineCode: "VELTA-24", label: "Skattskyld velta 24% — turnover at the standard rate, excluding VSK", sign: 1, sequence: 10 },
    { lineCode: "VELTA-11", label: "Skattskyld velta 11% — turnover at the reduced rate, excluding VSK", sign: 1, sequence: 20 },
    { lineCode: "VELTA-0", label: "Sala á núllprósentu — zero-rated sales, including exports", sign: 1, sequence: 30 },
    { lineCode: "UTSKATTUR", label: "Útskattur alls — total output VSK", sign: -1, sequence: 40, basis: "tax_collected", glMap: "sales" },
    { lineCode: "INNSKATTUR", label: "Innskattur alls — total input VSK", sign: 1, sequence: 50, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "MISMUNUR", label: "Mismunur útskatts og innskatts — payable or refundable amount", sign: 1, sequence: 60, formula: "UTSKATTUR - INNSKATTUR" },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VSK from the ledger, all configured rates", sign: -1, sequence: 70, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VSK from the ledger, all configured rates", sign: 1, sequence: 80, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Iceland VSK (virðisaukaskattur) localization.
 *
 * Currency is ISK; the pack carries no currency field. VSK is national, so
 * jurisdictions is empty. The general settlement period is two months
 * (January–February through November–December, due the 5th day of the second
 * month after the period), hence `bimonthly`; annual, six-month
 * (agriculture) and monthly variants exist on application but are not
 * modeled.
 *
 * Rate histories are left-truncated at the 1 January 2015 reform (Act
 * 124/2014): 24% standard (from 25.5%) and 11% reduced (from 7%), with the
 * prior values attested by the 143b edition of the act (law as in force
 * 1 September 2014). The origins of the 25.5%/7% bands were not traced, so
 * standardRates is partial. The zero band is applicability-dated: exports
 * and the other Art 12 supplies are attested outside taxable turnover in the
 * 143b edition, and Skatturinn's English page lists them as zero-rated
 * supplies with full input-VSK deduction.
 *
 * Box level detail: the electronic return's form is set by the Director of
 * Internal Revenue (regulation 667/1995 Art 6) and is only reachable after
 * login, so the boxes transcribe the required-information items Skatturinn
 * publishes (turnover per band excluding VSK, zero-rate sales, total output
 * and input tax) rather than numbered form fields.
 */
export const ICELAND_TAX_PACK: CountryTaxPackDefinition = {
  code: "IS_INDIRECT_TAX",
  version: "2026.08.01",
  country: "IS",
  name: "Iceland",
  countryTaxType: "vat",
  parentReturnPackCode: "IS_VSK",
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
      id: "skatturinn_vat_rates_return",
      title: "Skatturinn — Value Added Tax (VAT): 24% standard and 11% reduced rates, zero-rated supplies, and return required information",
      url: "https://www.skatturinn.is/english/companies/value-added-tax/",
      asOf: "2026-09-18",
    },
    {
      id: "skatturinn_vat_settlement",
      title: "Skatturinn — Value Added Tax (VAT): two-month settlement periods, due date one month and five days after the period, electronic filing",
      url: "https://www.skatturinn.is/english/companies/value-added-tax/",
      asOf: "2026-09-18",
    },
    {
      id: "althingi_act50_rate_2015",
      title: "Althingi — VAT Act 50/1988 Art 14: 24% standard and 11% reduced via Act 124/2014 in force 1 January 2015 (origin of the current bands)",
      url: "https://www.althingi.is/lagas/nuna/1988050.html",
      asOf: "2026-09-18",
    },
    {
      id: "althingi_act50_edition_143b",
      title: "Althingi — VAT Act 50/1988 edition 143b, law as in force 1 September 2014 (applicability, not origin): Art 14 attests the prior 25.5% and 7% bands, Art 12 the zero-rated export supplies",
      url: "https://www.althingi.is/lagasafn/pdf/143b/1988050.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "reglugerd_667_1995",
      title: "Reglugerðasafn — Regulation 667/1995 on VSK returns: two-month periods, electronic return set by the Director, due-date rule",
      url: "https://www.reglugerd.is/reglugerdir/eftir-raduneytum/fjarmalaraduneyti/nr/667-1995",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [IS_VSK_2026],
  returnPackTaxCodes: {
    IS_VSK: [
      {
        code: "IS-VAT-STD",
        name: "Iceland standard VSK 24%",
        ratePercent: 24,
        role: "standard",
        rates: [{ ratePercent: 24, effectiveFrom: "2015-01-01", sourceId: "althingi_act50_rate_2015" }],
      },
      {
        code: "IS-VAT-RED11",
        name: "Iceland reduced VSK 11% — food, accommodation, passenger transport, books and press",
        ratePercent: 11,
        role: "reduced",
        rates: [{ ratePercent: 11, effectiveFrom: "2015-01-01", sourceId: "althingi_act50_rate_2015" }],
      },
      {
        code: "IS-VAT-ZERO",
        name: "Iceland zero-rated VSK — exports and other Art 12 supplies",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2014-09-01", sourceId: "althingi_act50_edition_143b" }],
      },
    ],
  },
};

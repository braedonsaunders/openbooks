import type { CountryTaxPackDefinition, EffectiveTaxRate } from "./types.ts";
import { CANADA_RETURN_PACKS } from "./ca-returns.ts";

type UnsourcedRate = Omit<EffectiveTaxRate, "sourceId">;
const sourced = (sourceId: string, rates: readonly UnsourcedRate[]): readonly EffectiveTaxRate[] =>
  rates.map((rate) => ({ ...rate, sourceId }));

const hst = (region: string, name: string, rates: readonly UnsourcedRate[]) => ({
  region,
  name,
  taxType: "hst" as const,
  coverage: "country_tax_setup" as const,
  createDraftRegistration: false,
  defaultTaxCode: {
    code: `CA-${region}-HST`,
    name: `${name} HST`,
    ratePercent: rates.at(-1)!.ratePercent,
    rates: sourced("cra_gst_hst_rates", rates),
  },
});

/** Canada indirect-tax localization, maintained from CRA and provincial sources. */
export const CANADA_TAX_PACK: CountryTaxPackDefinition = {
  code: "CA_INDIRECT_TAX",
  version: "2026.07.31",
  country: "CA",
  name: "Canada",
  countryTaxType: "gst",
  parentReturnPackCode: "CA_GST34",
  parentReturnIncludedTaxTypes: ["gst", "hst"],
  completeness: {
    jurisdictions: "complete",
    standardRates: "complete",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "cra_gst_hst_rates",
      title: "CRA GST/HST calculator and rates",
      url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html",
      asOf: "2026-07-31",
    },
    {
      id: "cra_subdivision_codes",
      title: "CRA provincial and territorial codes",
      url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/completing-slips-summaries/financial-slips-summaries/return-investment-income-t5/provincial-territorial-codes.html",
      asOf: "2026-07-31",
    },
    { id: "bc_pst_rate", title: "British Columbia Provincial Sales Tax Act", url: "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/12035_03", asOf: "2026-07-31" },
    { id: "mb_rst_rate", title: "Manitoba RST registration bulletin", url: "https://www.gov.mb.ca/finance/taxation/pubs/bulletins/register.pdf", asOf: "2026-07-31" },
    { id: "qc_qst_rate", title: "Revenu Québec — calculating GST and QST", url: "https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/collecting-gst-and-qst/calculating-the-taxes/", asOf: "2026-07-31" },
    { id: "sk_pst_rate", title: "Saskatchewan PST rate transition", url: "https://sets.saskatchewan.ca/rptp/wcm/connect/0f6cfa6b-ca97-4e87-9b89-6e282b159b53/IN%2B2017-01%2BPST%2BRate%2BTransition%2BRules.pdf", asOf: "2026-07-31" },
  ],
  jurisdictions: [
    { region: "AB", name: "Alberta", taxType: "gst", coverage: "country_tax_setup", createDraftRegistration: false },
    { region: "BC", name: "British Columbia", taxType: "pst", coverage: "detailed_pack", returnPackCode: "CA_BC_PST", createDraftRegistration: false },
    { region: "MB", name: "Manitoba", taxType: "pst", coverage: "detailed_pack", returnPackCode: "CA_MB_RST", createDraftRegistration: false },
    hst("NB", "New Brunswick", [
      { ratePercent: 15, effectiveFrom: "1997-04-01", effectiveTo: "2006-06-30" },
      { ratePercent: 14, effectiveFrom: "2006-07-01", effectiveTo: "2007-12-31" },
      { ratePercent: 13, effectiveFrom: "2008-01-01", effectiveTo: "2016-06-30" },
      { ratePercent: 15, effectiveFrom: "2016-07-01" },
    ]),
    hst("NL", "Newfoundland and Labrador", [
      { ratePercent: 15, effectiveFrom: "1997-04-01", effectiveTo: "2006-06-30" },
      { ratePercent: 14, effectiveFrom: "2006-07-01", effectiveTo: "2007-12-31" },
      { ratePercent: 13, effectiveFrom: "2008-01-01", effectiveTo: "2016-06-30" },
      { ratePercent: 15, effectiveFrom: "2016-07-01" },
    ]),
    hst("NS", "Nova Scotia", [
      { ratePercent: 15, effectiveFrom: "1997-04-01", effectiveTo: "2006-06-30" },
      { ratePercent: 14, effectiveFrom: "2006-07-01", effectiveTo: "2007-12-31" },
      { ratePercent: 13, effectiveFrom: "2008-01-01", effectiveTo: "2010-06-30" },
      { ratePercent: 15, effectiveFrom: "2010-07-01", effectiveTo: "2025-03-31" },
      { ratePercent: 14, effectiveFrom: "2025-04-01" },
    ]),
    { region: "NT", name: "Northwest Territories", taxType: "gst", coverage: "country_tax_setup", createDraftRegistration: false },
    { region: "NU", name: "Nunavut", taxType: "gst", coverage: "country_tax_setup", createDraftRegistration: false },
    hst("ON", "Ontario", [{ ratePercent: 13, effectiveFrom: "2010-07-01" }]),
    hst("PE", "Prince Edward Island", [
      { ratePercent: 14, effectiveFrom: "2013-04-01", effectiveTo: "2016-09-30" },
      { ratePercent: 15, effectiveFrom: "2016-10-01" },
    ]),
    { region: "QC", name: "Québec", taxType: "qst", coverage: "detailed_pack", returnPackCode: "CA_QC_QST", createDraftRegistration: false },
    { region: "SK", name: "Saskatchewan", taxType: "pst", coverage: "detailed_pack", returnPackCode: "CA_SK_PST", createDraftRegistration: false },
    { region: "YT", name: "Yukon", taxType: "gst", coverage: "country_tax_setup", createDraftRegistration: false },
  ],
  returnPacks: CANADA_RETURN_PACKS,
  returnPackTaxCodes: {
    CA_GST34: { code: "CA-GST", name: "GST", ratePercent: 5, rates: sourced("cra_gst_hst_rates", [
      { ratePercent: 7, effectiveFrom: "1991-01-01", effectiveTo: "2006-06-30" },
      { ratePercent: 6, effectiveFrom: "2006-07-01", effectiveTo: "2007-12-31" },
      { ratePercent: 5, effectiveFrom: "2008-01-01" },
    ]) },
    CA_BC_PST: { code: "CA-BC-PST", name: "British Columbia PST", ratePercent: 7, rates: sourced("bc_pst_rate", [{ ratePercent: 7, effectiveFrom: "2013-04-01" }]) },
    CA_SK_PST: { code: "CA-SK-PST", name: "Saskatchewan PST", ratePercent: 6, rates: sourced("sk_pst_rate", [{ ratePercent: 6, effectiveFrom: "2017-03-23" }]) },
    CA_MB_RST: { code: "CA-MB-RST", name: "Manitoba RST", ratePercent: 7, rates: sourced("mb_rst_rate", [{ ratePercent: 7, effectiveFrom: "2019-07-01" }]) },
    CA_QC_QST: { code: "CA-QC-QST", name: "Québec QST", ratePercent: 9.975, rates: sourced("qc_qst_rate", [{ ratePercent: 9.975, effectiveFrom: "2013-01-01" }]) },
  },
};

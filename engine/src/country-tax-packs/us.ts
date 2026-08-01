import type { CountryTaxJurisdictionDefinition, CountryTaxPackDefinition, EffectiveTaxRate } from "./types.ts";
import { UNITED_STATES_RETURN_PACKS } from "./us-returns.ts";

const detailedReturns: Readonly<Record<string, string>> = {
  CA: "US_CA_CDTFA401",
  FL: "US_FL_DR15",
  NY: "US_NY_ST100",
  TX: "US_TX_01114",
};

const noStatewideSalesTax = new Set(["AK", "DE", "MT", "NH", "OR"]);
type UnsourcedRate = Omit<EffectiveTaxRate, "sourceId">;
const sourced = (sourceId: string, rates: readonly UnsourcedRate[]): readonly EffectiveTaxRate[] =>
  rates.map((rate) => ({ ...rate, sourceId }));

type StatewideRate = {
  ratePercent: number;
  rates?: readonly EffectiveTaxRate[];
};

/**
 * Current statewide/base rates verified against the state-administrator links
 * maintained by the Streamlined Sales Tax Governing Board. Where that matrix
 * does not publish a statutory start date, the rate becomes installable only
 * from this pack's review date; OpenBooks does not backdate an unsourced rate.
 */
const reviewedStatewideRates: Readonly<Record<string, StatewideRate>> = {
  AL: { ratePercent: 4 },
  AZ: { ratePercent: 5.6 },
  AR: { ratePercent: 6.5 },
  CO: { ratePercent: 2.9 },
  CT: { ratePercent: 6.35 },
  DC: {
    ratePercent: 6,
    rates: sourced("dc_2025_rate_notice", [
      { ratePercent: 6, effectiveFrom: "2026-07-31", effectiveTo: "2026-09-30" },
      { ratePercent: 7, effectiveFrom: "2026-10-01" },
    ]),
  },
  GA: { ratePercent: 4 },
  HI: { ratePercent: 4 },
  ID: { ratePercent: 6 },
  IL: { ratePercent: 6.25 },
  IN: { ratePercent: 7 },
  IA: { ratePercent: 6 },
  KS: { ratePercent: 6.5 },
  KY: { ratePercent: 6 },
  LA: {
    ratePercent: 5,
    rates: sourced("la_2025_rate", [{ ratePercent: 5, effectiveFrom: "2025-01-01" }]),
  },
  ME: { ratePercent: 5.5 },
  MD: { ratePercent: 6 },
  MA: { ratePercent: 6.25 },
  MI: { ratePercent: 6 },
  MN: { ratePercent: 6.875 },
  MS: { ratePercent: 7 },
  MO: { ratePercent: 4.225 },
  NE: { ratePercent: 5.5 },
  NV: { ratePercent: 6.85 },
  NJ: { ratePercent: 6.625 },
  NM: {
    ratePercent: 4.875,
    rates: [
      { ratePercent: 5, effectiveFrom: "2022-07-01", effectiveTo: "2023-06-30", sourceId: "nm_grt_2022" },
      { ratePercent: 4.875, effectiveFrom: "2023-07-01", sourceId: "nm_grt_2023" },
    ],
  },
  NC: { ratePercent: 4.75 },
  ND: { ratePercent: 5 },
  OH: { ratePercent: 5.75 },
  OK: { ratePercent: 4.5 },
  PA: { ratePercent: 6 },
  RI: { ratePercent: 7 },
  SC: { ratePercent: 6 },
  SD: {
    ratePercent: 4.2,
    rates: sourced("sd_2023_rate", [
      { ratePercent: 4.2, effectiveFrom: "2023-07-01", effectiveTo: "2027-06-30" },
      { ratePercent: 4.5, effectiveFrom: "2027-07-01" },
    ]),
  },
  TN: { ratePercent: 7 },
  UT: { ratePercent: 4.85 },
  VT: { ratePercent: 6 },
  VA: { ratePercent: 5.3 },
  WA: { ratePercent: 6.5 },
  WV: { ratePercent: 6 },
  WI: { ratePercent: 5 },
  WY: { ratePercent: 4 },
};

const snapshotRates = (rate: StatewideRate): readonly EffectiveTaxRate[] =>
  rate.rates ?? sourced("sst_state_tables", [{ ratePercent: rate.ratePercent, effectiveFrom: "2026-07-31" }]);

const state = (region: string, name: string): CountryTaxJurisdictionDefinition => ({
  region,
  name,
  taxType: region === "HI" || region === "NM"
    ? "other"
    : region === "AK" || !noStatewideSalesTax.has(region)
      ? "sales_use"
      : "other",
  coverage: detailedReturns[region] ? "detailed_pack" : "jurisdiction_setup",
  returnPackCode: detailedReturns[region],
  createDraftRegistration: region === "AK" || !noStatewideSalesTax.has(region),
  defaultTaxCode: reviewedStatewideRates[region]
    ? {
        code: region === "HI" ? "US-HI-GET" : region === "NM" ? "US-NM-GRT" : `US-${region}-ST`,
        name: region === "HI"
          ? "Hawaii general excise tax"
          : region === "NM"
            ? "New Mexico gross receipts tax"
            : `${name} statewide sales tax`,
        ratePercent: reviewedStatewideRates[region]!.ratePercent,
        rates: snapshotRates(reviewedStatewideRates[region]!),
      }
    : undefined,
});

/** United States indirect-tax localization. Unsourced local rates remain absent. */
export const UNITED_STATES_TAX_PACK: CountryTaxPackDefinition = {
  code: "US_INDIRECT_TAX",
  version: "2026.08.01",
  country: "US",
  name: "United States",
  countryTaxType: "sales_use",
  parentReturnPackCode: "US_SALES_TAX_WORKPAPER",
  completeness: {
    jurisdictions: "complete",
    standardRates: "complete",
    returnDefinitions: "partial",
    localRates: "partial",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    { id: "usps_subdivision_codes", title: "USPS state abbreviations", url: "https://about.usps.com/who/profile/history/state-abbreviations.htm", asOf: "2026-07-31" },
    { id: "sst_state_tables", title: "Streamlined Sales Tax Governing Board — state tax administration and rate table", url: "https://www.streamlinedsalestax.org/state-tables", asOf: "2026-07-31" },
    { id: "dc_2025_rate_notice", title: "District of Columbia Office of Tax and Revenue — October 2025 tax changes", url: "https://otr.cfo.dc.gov/vi/node/1800521", asOf: "2026-07-31" },
    { id: "la_2025_rate", title: "Louisiana Department of Revenue — state sales tax rate", url: "https://revenue.louisiana.gov/tax-education-and-faqs/faqs/sales-tax/what-is-the-sales-tax-rate-in-louisiana/", asOf: "2026-07-31" },
    { id: "nm_grt_2022", title: "New Mexico Taxation and Revenue Department — 2022 statewide GRT rate reduction", url: "https://www.tax.newmexico.gov/wp-content/uploads/2022/07/Tax-laws-take-effect.pdf", asOf: "2026-08-01" },
    { id: "nm_grt_2023", title: "New Mexico Taxation and Revenue Department — 2023 statewide GRT rate reduction", url: "https://www.tax.newmexico.gov/wp-content/uploads/2023/06/July-1-tax-changes.pdf", asOf: "2026-08-01" },
    { id: "sd_2023_rate", title: "South Dakota Department of Revenue — state tax rate decrease and sunset", url: "https://dor.sd.gov/newsroom/department-of-revenue-updates-tax-system-for-decrease-in-state-tax-rate/", asOf: "2026-07-31" },
    { id: "ca_rate_history", title: "California statewide sales and use tax rate history", url: "https://www.cdtfa.ca.gov/taxes-and-fees/sales-use-tax-rates-history.htm", asOf: "2026-07-31" },
    { id: "tx_rate_history", title: "Texas historical state sales tax rates", url: "https://comptroller.texas.gov/transparency/local/quarterly-report/hist.php", asOf: "2026-07-31" },
    { id: "ny_rate_history", title: "New York State sales and use tax rate decrease effective June 1, 2005", url: "https://www.tax.ny.gov/pdf/notices/n05_8.pdf", asOf: "2026-07-31" },
    { id: "fl_rate_history", title: "Florida sales and use tax state-rate history", url: "https://floridarevenue.com/taxes/Documents/flHistorySalesTaxRates.pdf", asOf: "2026-07-31" },
  ],
  jurisdictions: [
    state("AL", "Alabama"), state("AK", "Alaska"), state("AZ", "Arizona"), state("AR", "Arkansas"),
    state("CA", "California"), state("CO", "Colorado"), state("CT", "Connecticut"), state("DE", "Delaware"),
    state("DC", "District of Columbia"), state("FL", "Florida"), state("GA", "Georgia"), state("HI", "Hawaii"),
    state("ID", "Idaho"), state("IL", "Illinois"), state("IN", "Indiana"), state("IA", "Iowa"),
    state("KS", "Kansas"), state("KY", "Kentucky"), state("LA", "Louisiana"), state("ME", "Maine"),
    state("MD", "Maryland"), state("MA", "Massachusetts"), state("MI", "Michigan"), state("MN", "Minnesota"),
    state("MS", "Mississippi"), state("MO", "Missouri"), state("MT", "Montana"), state("NE", "Nebraska"),
    state("NV", "Nevada"), state("NH", "New Hampshire"), state("NJ", "New Jersey"), state("NM", "New Mexico"),
    state("NY", "New York"), state("NC", "North Carolina"), state("ND", "North Dakota"), state("OH", "Ohio"),
    state("OK", "Oklahoma"), state("OR", "Oregon"), state("PA", "Pennsylvania"), state("RI", "Rhode Island"),
    state("SC", "South Carolina"), state("SD", "South Dakota"), state("TN", "Tennessee"), state("TX", "Texas"),
    state("UT", "Utah"), state("VT", "Vermont"), state("VA", "Virginia"), state("WA", "Washington"),
    state("WV", "West Virginia"), state("WI", "Wisconsin"), state("WY", "Wyoming"),
  ],
  returnPacks: UNITED_STATES_RETURN_PACKS,
  returnPackTaxCodes: {
    US_CA_CDTFA401: { code: "US-CA-ST", name: "California statewide base sales tax", ratePercent: 7.25, rates: sourced("ca_rate_history", [
      { ratePercent: 3, effectiveFrom: "1949-07-01", effectiveTo: "1961-12-31" },
      { ratePercent: 4, effectiveFrom: "1962-01-01", effectiveTo: "1967-07-31" },
      { ratePercent: 5, effectiveFrom: "1967-08-01", effectiveTo: "1972-06-30" },
      { ratePercent: 5, effectiveFrom: "1972-07-01", effectiveTo: "1973-06-30" },
      { ratePercent: 6, effectiveFrom: "1973-07-01", effectiveTo: "1973-09-30" },
      { ratePercent: 5, effectiveFrom: "1973-10-01", effectiveTo: "1974-03-31" },
      { ratePercent: 6, effectiveFrom: "1974-04-01", effectiveTo: "1989-11-30" },
      { ratePercent: 6.25, effectiveFrom: "1989-12-01", effectiveTo: "1990-12-31" },
      { ratePercent: 6, effectiveFrom: "1991-01-01", effectiveTo: "1991-07-14" },
      { ratePercent: 7.25, effectiveFrom: "1991-07-15", effectiveTo: "2000-12-31" },
      { ratePercent: 7, effectiveFrom: "2001-01-01", effectiveTo: "2001-12-31" },
      { ratePercent: 7.25, effectiveFrom: "2002-01-01", effectiveTo: "2004-06-30" },
      { ratePercent: 7.25, effectiveFrom: "2004-07-01", effectiveTo: "2009-03-31" },
      { ratePercent: 8.25, effectiveFrom: "2009-04-01", effectiveTo: "2011-06-30" },
      { ratePercent: 7.25, effectiveFrom: "2011-07-01", effectiveTo: "2012-12-31" },
      { ratePercent: 7.5, effectiveFrom: "2013-01-01", effectiveTo: "2016-12-31" },
      { ratePercent: 7.25, effectiveFrom: "2017-01-01" },
    ]) },
    US_TX_01114: { code: "US-TX-ST", name: "Texas state sales tax", ratePercent: 6.25, rates: sourced("tx_rate_history", [
      { ratePercent: 2, effectiveFrom: "1961-09-01", effectiveTo: "1968-10-01" },
      { ratePercent: 3, effectiveFrom: "1968-10-02", effectiveTo: "1969-09-30" },
      { ratePercent: 3.25, effectiveFrom: "1969-10-01", effectiveTo: "1971-06-30" },
      { ratePercent: 4, effectiveFrom: "1971-07-01", effectiveTo: "1984-10-01" },
      { ratePercent: 4.125, effectiveFrom: "1984-10-02", effectiveTo: "1986-12-31" },
      { ratePercent: 5.25, effectiveFrom: "1987-01-01", effectiveTo: "1987-09-30" },
      { ratePercent: 6, effectiveFrom: "1987-10-01", effectiveTo: "1990-06-30" },
      { ratePercent: 6.25, effectiveFrom: "1990-07-01" },
    ]) },
    US_NY_ST100: { code: "US-NY-ST", name: "New York State sales tax", ratePercent: 4, rates: sourced("ny_rate_history", [
      { ratePercent: 4.25, effectiveFrom: "2003-06-01", effectiveTo: "2005-05-31" },
      { ratePercent: 4, effectiveFrom: "2005-06-01" },
    ]) },
    US_FL_DR15: { code: "US-FL-ST", name: "Florida state sales tax", ratePercent: 6, rates: sourced("fl_rate_history", [
      { ratePercent: 3, effectiveFrom: "1949-11-01", effectiveTo: "1968-03-31" },
      { ratePercent: 4, effectiveFrom: "1968-04-01", effectiveTo: "1982-04-30" },
      { ratePercent: 5, effectiveFrom: "1982-05-01", effectiveTo: "1988-01-31" },
      { ratePercent: 6, effectiveFrom: "1988-02-01" },
    ]) },
  },
};

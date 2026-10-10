import type { CountryTaxJurisdictionDefinition, CountryTaxPackDefinition, EffectiveTaxRate } from "./types.ts";
import { UNITED_STATES_RETURN_PACKS } from "./us-returns.ts";
import { US_BACKUP_WITHHOLDING } from "./contractor-other-schemes.ts";

const detailedReturns: Readonly<Record<string, string>> = {
  CA: "US_CA_CDTFA401",
  FL: "US_FL_DR15",
  NY: "US_NY_ST100",
  TX: "US_TX_01114",
  WA: "US_WA_CET",
};

const noStatewideSalesTax = new Set(["AK", "DE", "MT", "NH", "OR"]);
type UnsourcedRate = Omit<EffectiveTaxRate, "sourceId">;
const sourced = (sourceId: string, rates: readonly UnsourcedRate[]): readonly EffectiveTaxRate[] =>
  rates.map((rate) => ({ ...rate, sourceId }));

type StatewideRate = {
  ratePercent: string;
  rates: readonly EffectiveTaxRate[];
};

/**
 * Current statewide/base rates, every one with its statutory start date
 * from the state's own revenue agency, legislature, or code. A schedule
 * never opens at the pack's review date: a seeded effective_from prices
 * historical documents, so an unverifiable start is omitted rather than
 * invented (Alabama, Hawaii, Mississippi, and Missouri carry no statewide
 * code until their session-law start dates are transcribed; California,
 * Florida, New York, Texas, and Washington carry full histories on their
 * detailed returns instead of here).
 */
const reviewedStatewideRates: Readonly<Record<string, StatewideRate>> = {
  AZ: {
    ratePercent: "5.6",
    rates: sourced("az_jlbc_tpt_history", [{ ratePercent: "5.6", effectiveFrom: "2001-05-31" }]),
  },
  AR: {
    ratePercent: "6.5",
    rates: sourced("ar_dfa_state_rates", [{ ratePercent: "6.5", effectiveFrom: "2013-07-01" }]),
  },
  CO: {
    ratePercent: "2.9",
    rates: sourced("co_dor_dr1250_rate_history", [{ ratePercent: "2.9", effectiveFrom: "2001-01-01" }]),
  },
  CT: {
    ratePercent: "6.35",
    rates: sourced("ct_drs_ip_2011_17", [{ ratePercent: "6.35", effectiveFrom: "2011-07-01" }]),
  },
  DC: {
    ratePercent: "7",
    rates: sourced("dc_2025_rate_notice", [
      { ratePercent: "6", effectiveFrom: "2026-07-31", effectiveTo: "2026-09-30" },
      { ratePercent: "7", effectiveFrom: "2026-10-01" },
    ]),
  },
  GA: {
    ratePercent: "4",
    rates: sourced("ga_dor_historical_rate_chart", [{ ratePercent: "4", effectiveFrom: "1989-04-01" }]),
  },
  ID: {
    ratePercent: "6",
    rates: sourced("id_legislature_session_laws_2007", [{ ratePercent: "6", effectiveFrom: "2006-10-01" }]),
  },
  IL: {
    ratePercent: "6.25",
    rates: sourced("il_cgfa_sales_tax_issues", [{ ratePercent: "6.25", effectiveFrom: "1990-01-01" }]),
  },
  IN: {
    ratePercent: "7",
    rates: sourced("in_dor_sales_tax_history", [{ ratePercent: "7", effectiveFrom: "2008-04-01" }]),
  },
  IA: {
    ratePercent: "6",
    rates: sourced("ia_dor_retail_sales_use_tax", [{ ratePercent: "6", effectiveFrom: "2008-07-01" }]),
  },
  KS: {
    ratePercent: "6.5",
    rates: sourced("ks_dor_annual_report_2015", [{ ratePercent: "6.5", effectiveFrom: "2015-07-01" }]),
  },
  KY: {
    ratePercent: "6",
    rates: sourced("ky_krs_139_200", [{ ratePercent: "6", effectiveFrom: "1990-07-01" }]),
  },
  LA: {
    ratePercent: "5",
    rates: sourced("la_2025_rate", [{ ratePercent: "5", effectiveFrom: "2025-01-01" }]),
  },
  ME: {
    ratePercent: "5.5",
    rates: sourced("me_mrs_sales_use_history", [{ ratePercent: "5.5", effectiveFrom: "2013-10-01" }]),
  },
  MD: {
    ratePercent: "6",
    rates: sourced("md_comptroller_bulletin_07_02", [{ ratePercent: "6", effectiveFrom: "2008-01-03" }]),
  },
  MA: {
    ratePercent: "6.25",
    rates: sourced("ma_auditor_2016_tax_report", [{ ratePercent: "6.25", effectiveFrom: "2009-08-01" }]),
  },
  MI: {
    ratePercent: "6",
    rates: sourced("mi_treasury_sales_use_2000", [{ ratePercent: "6", effectiveFrom: "1994-05-01" }]),
  },
  MN: {
    ratePercent: "6.875",
    rates: sourced("mn_house_session_weekly_2009", [{ ratePercent: "6.875", effectiveFrom: "2009-07-01" }]),
  },
  NE: {
    ratePercent: "5.5",
    rates: sourced("ne_legislature_sales_tax_history", [{ ratePercent: "5.5", effectiveFrom: "2002-10-01" }]),
  },
  NV: {
    ratePercent: "6.85",
    rates: sourced("nv_senate_revenue_brief_2011", [{ ratePercent: "6.85", effectiveFrom: "2009-07-01" }]),
  },
  NJ: {
    ratePercent: "6.625",
    rates: sourced("nj_taxation_whats_new_2018", [{ ratePercent: "6.625", effectiveFrom: "2018-01-01" }]),
  },
  NM: {
    ratePercent: "4.875",
    rates: [
      { ratePercent: "5", effectiveFrom: "2022-07-01", effectiveTo: "2023-06-30", sourceId: "nm_grt_2022" },
      { ratePercent: "4.875", effectiveFrom: "2023-07-01", sourceId: "nm_grt_2023" },
    ],
  },
  NC: {
    ratePercent: "4.75",
    rates: sourced("nc_dor_rate_decrease_2011", [{ ratePercent: "4.75", effectiveFrom: "2011-07-01" }]),
  },
  ND: {
    ratePercent: "5",
    rates: sourced("nd_tax_history", [{ ratePercent: "5", effectiveFrom: "1990-01-04" }]),
  },
  OH: {
    ratePercent: "5.75",
    rates: sourced("oh_tax_2014_annual_report", [{ ratePercent: "5.75", effectiveFrom: "2013-09-01" }]),
  },
  OK: {
    ratePercent: "4.5",
    rates: sourced("ok_otc_legislative_tax_guide", [{ ratePercent: "4.5", effectiveFrom: "1990-05-01" }]),
  },
  PA: {
    ratePercent: "6",
    rates: sourced("pa_tax_reform_code_1971", [{ ratePercent: "6", effectiveFrom: "1971-03-04" }]),
  },
  RI: {
    ratePercent: "7",
    rates: sourced("ri_rigl_44_18_18", [{ ratePercent: "7", effectiveFrom: "1990-07-01" }]),
  },
  SC: {
    ratePercent: "6",
    rates: sourced("sc_code_12_36_1110", [{ ratePercent: "6", effectiveFrom: "2007-06-01" }]),
  },
  SD: {
    ratePercent: "4.2",
    rates: sourced("sd_2023_rate", [
      { ratePercent: "4.2", effectiveFrom: "2023-07-01", effectiveTo: "2027-06-30" },
      { ratePercent: "4.5", effectiveFrom: "2027-07-01" },
    ]),
  },
  TN: {
    ratePercent: "7",
    rates: sourced("tn_ag_op_02_087", [{ ratePercent: "7", effectiveFrom: "2002-07-15" }]),
  },
  UT: {
    ratePercent: "4.85",
    rates: sourced("ut_code_59_12_103", [{ ratePercent: "4.85", effectiveFrom: "2019-04-01" }]),
  },
  VT: {
    ratePercent: "6",
    rates: sourced("vt_jfo_fiscal_facts_2020", [{ ratePercent: "6", effectiveFrom: "2003-10-01" }]),
  },
  VA: {
    ratePercent: "5.3",
    rates: sourced("va_tax_legislative_summary_13_164", [{ ratePercent: "5.3", effectiveFrom: "2013-07-01" }]),
  },
  WV: {
    ratePercent: "6",
    rates: sourced("wv_digest_revenue_2010", [{ ratePercent: "6", effectiveFrom: "1988-06-01" }]),
  },
  WI: {
    ratePercent: "5",
    rates: sourced("wi_dor_wtb_28", [{ ratePercent: "5", effectiveFrom: "1982-05-01" }]),
  },
  WY: {
    ratePercent: "4",
    rates: sourced("wy_hb0007_2005", [{ ratePercent: "4", effectiveFrom: "1993-07-01" }]),
  },
};

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
        rates: reviewedStatewideRates[region]!.rates,
      }
    : undefined,
});

/** United States indirect-tax localization. Unsourced local rates remain absent. */
export const UNITED_STATES_TAX_PACK: CountryTaxPackDefinition = {
  code: "US_INDIRECT_TAX",
  version: "2026.10.10",
  country: "US",
  name: "United States",
  contractorWithholdingSchemes: [US_BACKUP_WITHHOLDING],
  countryTaxType: "sales_use",
  parentReturnPackCode: "US_SALES_TAX_WORKPAPER",
  completeness: {
    jurisdictions: "complete",
    standardRates: "partial",
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
    { id: "wa_dor_tax_history_notes", title: "Washington Department of Revenue — tax history notes (retail sales and B&O rate tables)", url: "https://dor.wa.gov/sites/default/files/2022-02/Notes2008.pdf", asOf: "2026-10-10" },
    { id: "wa_eshb_2081_session_law", title: "Washington session law ESHB 2081, Chapter 420, Laws of 2025 (B&O rate changes)", url: "https://lawfilesext.leg.wa.gov/biennium/2025-26/Pdf/Bills/Session%20Laws/House/2081-S.SL.pdf?q=20250528094308", asOf: "2026-10-10" },
    { id: "wa_dor_2020_tax_legislation", title: "Washington Department of Revenue — 2020 tax legislation (service B&O 1.75% tier from April 1, 2020)", url: "https://dor.wa.gov/forms-publications/publications-subject/tax-topics/2020-tax-legislation", asOf: "2026-10-10" },
    { id: "wa_dor_workforce_education", title: "Washington Department of Revenue — workforce education service B&O tiers from October 1, 2025", url: "https://dor.wa.gov/taxes-rates/business-occupation-tax/workforce-education", asOf: "2026-10-10" },
    { id: "ar_dfa_state_rates", title: "Arkansas Department of Finance and Administration — state sales and use tax rates", url: "https://www.dfa.arkansas.gov/office/taxes/excise-tax-administration/sales-use-tax/sales-use-tax-rates/state-sales-use-tax-rates/", asOf: "2026-10-10" },
    { id: "az_jlbc_tpt_history", title: "Arizona Joint Legislative Budget Committee — tax handbook history: transaction privilege tax", url: "https://azjlbc.gov/08taxbook/tpt.pdf", asOf: "2026-10-10" },
    { id: "co_dor_dr1250_rate_history", title: "Colorado Department of Revenue — retail sales tax rate history (DR 1250)", url: "https://tax.colorado.gov/sites/tax/files/DR1250_2019.pdf", asOf: "2026-10-10" },
    { id: "ct_drs_ip_2011_17", title: "Connecticut Department of Revenue Services — Informational Publication 2011(17)", url: "https://portal.ct.gov/drs/publications/informational-publications/2011/ip-201117-sales-and-use-taxes-on-returned-goods-even-exchanges-and-tradeins", asOf: "2026-10-10" },
    { id: "ga_dor_historical_rate_chart", title: "Georgia Department of Revenue — sales and use tax historical rate chart", url: "https://dor.georgia.gov/document/distributions/july-2017-historical/download", asOf: "2026-10-10" },
    { id: "id_legislature_session_laws_2007", title: "Idaho Legislature — 2007 session laws (6% state sales tax from October 1, 2006)", url: "https://legislature.idaho.gov/wp-content/uploads/sessionlaws/sessionlaws_vol1_2007.pdf", asOf: "2026-10-10" },
    { id: "il_cgfa_sales_tax_issues", title: "Illinois Commission on Government Forecasting and Accountability — sales tax issues (6.25% from January 1, 1990)", url: "https://cgfa.ilga.gov/Upload/2001_sales_tax_issues.pdf", asOf: "2026-10-10" },
    { id: "in_dor_sales_tax_history", title: "Indiana Department of Revenue — corporate and sales tax history", url: "https://www.in.gov/dor/resources/tax-rates-and-reports/rates-fees-and-penalties/corporate-sales-tax-history/", asOf: "2026-10-10" },
    { id: "ia_dor_retail_sales_use_tax", title: "Iowa Department of Revenue — retail sales and use tax history", url: "https://tax.iowa.gov/media/3051/download?inline", asOf: "2026-10-10" },
    { id: "ks_dor_annual_report_2015", title: "Kansas Department of Revenue — 2015 annual report (6.5% from July 1, 2015)", url: "https://ksrevenue.gov/pdf/ar15complete.pdf", asOf: "2026-10-10" },
    { id: "ky_krs_139_200", title: "Kentucky Revised Statutes 139.200 — imposition of sales tax (6% from July 1, 1990)", url: "https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=58186", asOf: "2026-10-10" },
    { id: "me_mrs_sales_use_history", title: "Maine Revenue Services — sales and use tax history reference guide", url: "https://www1.maine.gov/REVENUE/salesuse/salestax/ReferenceGuide2019.pdf", asOf: "2026-10-10" },
    { id: "md_comptroller_bulletin_07_02", title: "Maryland Comptroller — Bulletin 07-02 (6% from January 3, 2008)", url: "https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/legal-publications/bulletins/sales-and-use-tax/su_bul07-2.pdf", asOf: "2026-10-10" },
    { id: "ma_auditor_2016_tax_report", title: "Massachusetts State Auditor — 2016 state tax revenues report (6.25% from August 1, 2009)", url: "https://stage.mass.gov/doc/determination-of-whether-net-state-tax-revenues-exceeded-allowable-state-tax-revenues-4/download", asOf: "2026-10-10" },
    { id: "mi_treasury_sales_use_2000", title: "Michigan Department of Treasury — Sales and Use Taxes 2000 (6% from May 1, 1994)", url: "https://www.michigan.gov/taxes/-/media/Project/Websites/treasury/CONV/Reports/MISalesandUset2000_120601.pdf?rev=74cd34d8cbc342c7ab0c42f7ec9e6249", asOf: "2026-10-10" },
    { id: "mn_house_session_weekly_2009", title: "Minnesota House of Representatives — Session Weekly (6.875% from July 1, 2009)", url: "https://www.house.mn.gov/sessionweekly/art.asp?ls_year=86&issueid_=26&storyid=740&year_=2009", asOf: "2026-10-10" },
    { id: "ne_legislature_sales_tax_history", title: "Nebraska Legislature — taxes and spending: sales tax history", url: "https://nebraskalegislature.gov/app_rev/source/narrative_salestaxhistory.htm", asOf: "2026-10-10" },
    { id: "nv_senate_revenue_brief_2011", title: "Nevada Legislature — Senate Revenue Committee policy brief (6.85% from July 1, 2009)", url: "https://www.leg.state.nv.us/App/NELIS/REL/76th2011/ExhibitDocument/OpenExhibitDocument?exhibitId=18806&fileDownloadName=Final%20Policy%20Brief%20Senate%20Committee%20on%20Revenue.pdf", asOf: "2026-10-10" },
    { id: "nj_taxation_whats_new_2018", title: "New Jersey Division of Taxation — what is new in 2018 (6.625% from January 1, 2018)", url: "https://www.nj.gov/treasury/taxation/whatsnew2018.shtml", asOf: "2026-10-10" },
    { id: "nc_dor_rate_decrease_2011", title: "North Carolina Department of Revenue — rate decrease notice (4.75% from July 1, 2011)", url: "https://www.ncdor.gov/documents/important-notices/important-notice-state-sales-and-use-tax-rate-decrease-effective-july-1-2011/open", asOf: "2026-10-10" },
    { id: "nd_tax_history", title: "North Dakota Office of State Tax Commissioner — sales and use tax history", url: "https://www.tax.nd.gov/sales-and-use-tax-history", asOf: "2026-10-10" },
    { id: "oh_tax_2014_annual_report", title: "Ohio Department of Taxation — 2014 annual report sales and use tax (5.75% from September 1, 2013)", url: "https://dam.assets.ohio.gov/image/upload/tax.ohio.gov/communications/publications/annual_reports/2014_annual_report/2014_ar_section_2_sales_and_use_tax.pdf", asOf: "2026-10-10" },
    { id: "ok_otc_legislative_tax_guide", title: "Oklahoma Tax Commission — legislative tax guide (4.5% from May 1, 1990)", url: "https://digitalprairie.ok.gov/digital/api/collection/stgovpub/id/6957/download", asOf: "2026-10-10" },
    { id: "pa_tax_reform_code_1971", title: "Pennsylvania Tax Reform Code of 1971, Act No. 2 (6% from March 4, 1971)", url: "https://www.palrb.gov/getfile.cfm?file=resources/preservation-project/PLTIFTOPDF/19001999/1971/0/act/0002.pdf&view=true", asOf: "2026-10-10" },
    { id: "ri_rigl_44_18_18", title: "Rhode Island General Laws 44-18-18 — sales tax imposed (7% from July 1, 1990)", url: "https://webserver.rilegislature.gov/Statutes/TITLE44/44-18/44-18-18.HTM", asOf: "2026-10-10" },
    { id: "sc_code_12_36_1110", title: "South Carolina Code of Laws 12-36-1110 (additional 1% from June 1, 2007)", url: "https://www.scstatehouse.gov/code/t12c036.php", asOf: "2026-10-10" },
    { id: "tn_ag_op_02_087", title: "Tennessee Attorney General Opinion 02-087 (7% from July 15, 2002)", url: "https://www.tn.gov/content/dam/tn/attorneygeneral/documents/ops/2002/op02-087.pdf", asOf: "2026-10-10" },
    { id: "ut_code_59_12_103", title: "Utah Code 59-12-103 — sales and use tax base and rates (4.85% from April 1, 2019)", url: "https://le.utah.gov/xcode/Title59/Chapter12/C59-12-S103_2020062920200629.pdf", asOf: "2026-10-10" },
    { id: "vt_jfo_fiscal_facts_2020", title: "Vermont Joint Fiscal Office — fiscal facts revenue history (6% from October 1, 2003)", url: "https://ljfo.vermont.gov/assets/Publications/2020-Fiscal-Facts-Booklet/cf3c9d226e/2020-Fiscal-Facts-Revenue-History.pdf", asOf: "2026-10-10" },
    { id: "va_tax_legislative_summary_13_164", title: "Virginia Department of Taxation — 2013 legislative summary 13-164 (5.3% from July 1, 2013)", url: "https://www.tax.virginia.gov/laws-rules-decisions/legislative-summaries/13-164", asOf: "2026-10-10" },
    { id: "wv_digest_revenue_2010", title: "West Virginia Legislature — digest of revenue sources FY2010 (6% since June 1, 1988)", url: "https://www.wvlegislature.gov/legisdocs/reports/budget/2010_digest_revenue.pdf", asOf: "2026-10-10" },
    { id: "wi_dor_wtb_28", title: "Wisconsin Department of Revenue — Wisconsin Tax Bulletin 28 (5% from May 1, 1982)", url: "https://www.revenue.wi.gov/WisconsinTaxBulletin/028law.pdf", asOf: "2026-10-10" },
    { id: "wy_hb0007_2005", title: "Wyoming Legislature — 2005 HB0007 (W.S. 39-15-104(b): 4% from July 1, 1993)", url: "https://wyoleg.gov/2005/Introduced/HB0007.pdf", asOf: "2026-10-10" },
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
    US_CA_CDTFA401: { code: "US-CA-ST", name: "California statewide base sales tax", ratePercent: "7.25", rates: sourced("ca_rate_history", [
      { ratePercent: "3", effectiveFrom: "1949-07-01", effectiveTo: "1961-12-31" },
      { ratePercent: "4", effectiveFrom: "1962-01-01", effectiveTo: "1967-07-31" },
      { ratePercent: "5", effectiveFrom: "1967-08-01", effectiveTo: "1972-06-30" },
      { ratePercent: "5", effectiveFrom: "1972-07-01", effectiveTo: "1973-06-30" },
      { ratePercent: "6", effectiveFrom: "1973-07-01", effectiveTo: "1973-09-30" },
      { ratePercent: "5", effectiveFrom: "1973-10-01", effectiveTo: "1974-03-31" },
      { ratePercent: "6", effectiveFrom: "1974-04-01", effectiveTo: "1989-11-30" },
      { ratePercent: "6.25", effectiveFrom: "1989-12-01", effectiveTo: "1990-12-31" },
      { ratePercent: "6", effectiveFrom: "1991-01-01", effectiveTo: "1991-07-14" },
      { ratePercent: "7.25", effectiveFrom: "1991-07-15", effectiveTo: "2000-12-31" },
      { ratePercent: "7", effectiveFrom: "2001-01-01", effectiveTo: "2001-12-31" },
      { ratePercent: "7.25", effectiveFrom: "2002-01-01", effectiveTo: "2004-06-30" },
      { ratePercent: "7.25", effectiveFrom: "2004-07-01", effectiveTo: "2009-03-31" },
      { ratePercent: "8.25", effectiveFrom: "2009-04-01", effectiveTo: "2011-06-30" },
      { ratePercent: "7.25", effectiveFrom: "2011-07-01", effectiveTo: "2012-12-31" },
      { ratePercent: "7.5", effectiveFrom: "2013-01-01", effectiveTo: "2016-12-31" },
      { ratePercent: "7.25", effectiveFrom: "2017-01-01" },
    ]) },
    US_TX_01114: { code: "US-TX-ST", name: "Texas state sales tax", ratePercent: "6.25", rates: sourced("tx_rate_history", [
      { ratePercent: "2", effectiveFrom: "1961-09-01", effectiveTo: "1968-10-01" },
      { ratePercent: "3", effectiveFrom: "1968-10-02", effectiveTo: "1969-09-30" },
      { ratePercent: "3.25", effectiveFrom: "1969-10-01", effectiveTo: "1971-06-30" },
      { ratePercent: "4", effectiveFrom: "1971-07-01", effectiveTo: "1984-10-01" },
      { ratePercent: "4.125", effectiveFrom: "1984-10-02", effectiveTo: "1986-12-31" },
      { ratePercent: "5.25", effectiveFrom: "1987-01-01", effectiveTo: "1987-09-30" },
      { ratePercent: "6", effectiveFrom: "1987-10-01", effectiveTo: "1990-06-30" },
      { ratePercent: "6.25", effectiveFrom: "1990-07-01" },
    ]) },
    US_NY_ST100: { code: "US-NY-ST", name: "New York State sales tax", ratePercent: "4", rates: sourced("ny_rate_history", [
      { ratePercent: "4.25", effectiveFrom: "2003-06-01", effectiveTo: "2005-05-31" },
      { ratePercent: "4", effectiveFrom: "2005-06-01" },
    ]) },
    US_FL_DR15: { code: "US-FL-ST", name: "Florida state sales tax", ratePercent: "6", rates: sourced("fl_rate_history", [
      { ratePercent: "3", effectiveFrom: "1949-11-01", effectiveTo: "1968-03-31" },
      { ratePercent: "4", effectiveFrom: "1968-04-01", effectiveTo: "1982-04-30" },
      { ratePercent: "5", effectiveFrom: "1982-05-01", effectiveTo: "1988-01-31" },
      { ratePercent: "6", effectiveFrom: "1988-02-01" },
    ]) },
    US_WA_CET: [
      {
        code: "US-WA-ST",
        name: "Washington state retail sales and use tax",
        ratePercent: "6.5",
        returnBoxes: ["ST_TAXABLE", "ST_TAX", "USE_TAX"],
        rates: sourced("wa_dor_tax_history_notes", [
          { ratePercent: "2", effectiveFrom: "1935-05-01", effectiveTo: "1941-04-30" },
          { ratePercent: "3", effectiveFrom: "1941-05-01", effectiveTo: "1955-04-30" },
          { ratePercent: "3.33", effectiveFrom: "1955-05-01", effectiveTo: "1959-03-31" },
          { ratePercent: "4", effectiveFrom: "1959-04-01", effectiveTo: "1965-05-31" },
          { ratePercent: "4.2", effectiveFrom: "1965-06-01", effectiveTo: "1967-06-30" },
          { ratePercent: "4.5", effectiveFrom: "1967-07-01", effectiveTo: "1976-05-31" },
          { ratePercent: "4.6", effectiveFrom: "1976-06-01", effectiveTo: "1979-06-30" },
          { ratePercent: "4.5", effectiveFrom: "1979-07-01", effectiveTo: "1981-12-03" },
          { ratePercent: "5.5", effectiveFrom: "1981-12-04", effectiveTo: "1982-04-30" },
          { ratePercent: "5.4", effectiveFrom: "1982-05-01", effectiveTo: "1983-02-28" },
          { ratePercent: "6.5", effectiveFrom: "1983-03-01" },
        ]),
      },
      {
        code: "US-WA-BO-RET",
        name: "Washington B&O tax — retailing",
        ratePercent: "0.471",
        returnBoxes: ["BO_RET"],
        rates: [
          { ratePercent: "0.471", effectiveFrom: "1982-07-01", effectiveTo: "2026-12-31", sourceId: "wa_dor_tax_history_notes" },
          { ratePercent: "0.5", effectiveFrom: "2027-01-01", sourceId: "wa_eshb_2081_session_law" },
        ],
      },
      {
        code: "US-WA-BO-WHO",
        name: "Washington B&O tax — wholesaling",
        ratePercent: "0.484",
        returnBoxes: ["BO_WHO"],
        rates: [
          { ratePercent: "0.484", effectiveFrom: "1982-07-01", effectiveTo: "2026-12-31", sourceId: "wa_dor_tax_history_notes" },
          { ratePercent: "0.5", effectiveFrom: "2027-01-01", sourceId: "wa_eshb_2081_session_law" },
        ],
      },
      {
        code: "US-WA-BO-MFG",
        name: "Washington B&O tax — manufacturing",
        ratePercent: "0.484",
        returnBoxes: ["BO_MFG"],
        rates: [
          { ratePercent: "0.484", effectiveFrom: "1982-07-01", effectiveTo: "2026-12-31", sourceId: "wa_dor_tax_history_notes" },
          { ratePercent: "0.5", effectiveFrom: "2027-01-01", sourceId: "wa_eshb_2081_session_law" },
        ],
      },
      {
        code: "US-WA-BO-SVC",
        name: "Washington B&O tax — service and other activities",
        ratePercent: "1.5",
        returnBoxes: ["BO_SVC"],
        rates: sourced("wa_dor_tax_history_notes", [{ ratePercent: "1.5", effectiveFrom: "1982-07-01" }]),
      },
      {
        code: "US-WA-BO-SVC1M",
        name: "Washington B&O tax — service, $1M to $5M prior-year income",
        ratePercent: "1.75",
        returnBoxes: ["BO_SVC1M"],
        rates: sourced("wa_dor_2020_tax_legislation", [{ ratePercent: "1.75", effectiveFrom: "2020-04-01" }]),
      },
      {
        code: "US-WA-BO-SVC5M",
        name: "Washington B&O tax — service, $5M or more prior-year income",
        ratePercent: "2.1",
        returnBoxes: ["BO_SVC5M"],
        rates: sourced("wa_dor_workforce_education", [{ ratePercent: "2.1", effectiveFrom: "2025-10-01" }]),
      },
    ],
  },
};

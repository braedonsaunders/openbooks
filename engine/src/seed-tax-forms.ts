import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * Importable government return definitions. A pack supplies the official box
 * structure and filing channel; tenant tax codes remain tenant data and are
 * mapped at import time. Packs deliberately do not contain credentials or file
 * tax returns. Re-importing a pack resets that form's boxes to library defaults.
 */

export type TaxBoxBasis = "tax_collected" | "tax_paid" | "taxable_base";
export type TaxBoxMap = "sales" | "purchases";

export interface TaxReturnPackBox {
  lineCode: string;
  label: string;
  sign: number;
  sequence: number;
  basis?: TaxBoxBasis;
  formula?: string;
  /** Without a GL map or formula, the box is intentionally filer-entered. */
  glMap?: TaxBoxMap;
}

/** The taxing jurisdiction a pack files into — created as reference data on
 *  install and linked to the form, so nexus/registrations attach to structured
 *  jurisdictions rather than loose country text. */
export interface TaxReturnPackJurisdiction {
  code: string; // "CA", "US-CA", "DE"
  name: string; // "Canada", "California", "Germany"
  country: string; // ISO-2
  region?: string; // subdivision, "CA" for a US state
  level: "country" | "state" | "county" | "city" | "special" | "federal";
  taxType: "vat" | "gst" | "hst" | "pst" | "qst" | "sales_use" | "consumption" | "other";
}

export interface TaxReturnPack {
  code: string;
  name: string;
  country: string;
  jurisdiction: TaxReturnPackJurisdiction;
  /** Frequency this return is typically filed on — a sensible default for a
   *  registration the filer creates against this jurisdiction. */
  defaultFrequency: "monthly" | "bimonthly" | "quarterly" | "semiannual" | "annual";
  submissionChannel: "print_pdf" | "file_upload" | "efile_api" | "portal_manual";
  governmentFormat: "portal_entry" | "certified_file" | "api" | "paper";
  submissionUrl: string;
  watermark: string;
  boxes: readonly TaxReturnPackBox[];
}

export const TAX_RETURN_PACKS: readonly TaxReturnPack[] = [
  {
    code: "CA_GST34",
    name: "GST/HST Return (GST34)",
    country: "CA",
    jurisdiction: { code: "CA", name: "Canada", country: "CA", level: "country", taxType: "gst" },
    defaultFrequency: "quarterly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/file-gst-hst-return/how-file.html",
    watermark: "Working copy — submit electronically through the government filing service",
    boxes: [
      { lineCode: "101", label: "Sales and other revenue", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "103", label: "GST/HST collected or collectible", sign: -1, sequence: 20, basis: "tax_collected", glMap: "sales" },
      { lineCode: "104", label: "Adjustments to be added to net tax", sign: 1, sequence: 30 },
      { lineCode: "105", label: "Total GST/HST and adjustments (add lines 103 and 104)", sign: 1, sequence: 40, formula: "103 + 104" },
      { lineCode: "106", label: "Input tax credits (ITCs)", sign: 1, sequence: 50, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "107", label: "Adjustments to be deducted from net tax", sign: 1, sequence: 60 },
      { lineCode: "108", label: "Total ITCs and adjustments (add lines 106 and 107)", sign: 1, sequence: 70, formula: "106 + 107" },
      { lineCode: "109", label: "Net tax (subtract line 108 from line 105)", sign: 1, sequence: 80, formula: "105 - 108" },
      { lineCode: "110", label: "Instalment and other annual filer payments", sign: 1, sequence: 90 },
      { lineCode: "111", label: "Rebates (attach the rebate form to this return)", sign: 1, sequence: 100 },
      { lineCode: "112", label: "Total other credits (add lines 110 and 111)", sign: 1, sequence: 110, formula: "110 + 111" },
      { lineCode: "113A", label: "Balance (subtract line 112 from line 109)", sign: 1, sequence: 120, formula: "109 - 112" },
      { lineCode: "205", label: "GST/HST due on the acquisition of taxable real property", sign: 1, sequence: 130 },
      { lineCode: "405", label: "Other GST/HST to be self-assessed", sign: 1, sequence: 140 },
      { lineCode: "113B", label: "Total other debits (add lines 205 and 405)", sign: 1, sequence: 150, formula: "205 + 405" },
      { lineCode: "113C", label: "Balance (add lines 113A and 113B)", sign: 1, sequence: 160, formula: "113A + 113B" },
      { lineCode: "114", label: "Refund claimed", sign: 1, sequence: 170, formula: "113C" },
      { lineCode: "115", label: "Payment enclosed", sign: 1, sequence: 180, formula: "113C" },
    ],
  },

  // --- Canada, provincial sales taxes (separate provincial remittance) -------
  // HST provinces (ON, NB, NL, NS, PE) file the federal GST34 above and remit to
  // the CRA. These provinces run their OWN sales tax with its own return remitted
  // to the province, NOT the CRA: BC/SK/MB provincial sales tax, and Quebec QST
  // (administered by Revenu Québec).
  {
    code: "CA_BC_PST",
    name: "British Columbia PST Return",
    country: "CA",
    jurisdiction: { code: "CA-BC", name: "British Columbia", country: "CA", region: "BC", level: "state", taxType: "pst" },
    defaultFrequency: "monthly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.etax.gov.bc.ca/",
    watermark: "Working copy — file and remit through BC eTaxBC. Not a government return.",
    boxes: [
      { lineCode: "A", label: "Total sales", sign: 1, sequence: 10 },
      { lineCode: "B", label: "Taxable sales and leases", sign: 1, sequence: 20, basis: "taxable_base", glMap: "sales" },
      { lineCode: "C", label: "PST collected (7%)", sign: -1, sequence: 30, basis: "tax_collected", glMap: "sales" },
      { lineCode: "D", label: "Adjustments", sign: 1, sequence: 40 },
      { lineCode: "E", label: "Net PST due", sign: 1, sequence: 50, formula: "C + D" },
    ],
  },
  {
    code: "CA_SK_PST",
    name: "Saskatchewan PST Return",
    country: "CA",
    jurisdiction: { code: "CA-SK", name: "Saskatchewan", country: "CA", region: "SK", level: "state", taxType: "pst" },
    defaultFrequency: "monthly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://sets.saskatchewan.ca/",
    watermark: "Working copy — file and remit through Saskatchewan SETS. Not a government return.",
    boxes: [
      { lineCode: "1", label: "Total sales", sign: 1, sequence: 10 },
      { lineCode: "2", label: "Taxable sales", sign: 1, sequence: 20, basis: "taxable_base", glMap: "sales" },
      { lineCode: "3", label: "Tax collected (6%)", sign: -1, sequence: 30, basis: "tax_collected", glMap: "sales" },
      { lineCode: "4", label: "Adjustments", sign: 1, sequence: 40 },
      { lineCode: "5", label: "Net tax due", sign: 1, sequence: 50, formula: "3 + 4" },
    ],
  },
  {
    code: "CA_MB_RST",
    name: "Manitoba Retail Sales Tax Return",
    country: "CA",
    jurisdiction: { code: "CA-MB", name: "Manitoba", country: "CA", region: "MB", level: "state", taxType: "pst" },
    defaultFrequency: "monthly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://taxcess.gov.mb.ca/",
    watermark: "Working copy — file and remit through Manitoba TAXcess. Not a government return.",
    boxes: [
      { lineCode: "1", label: "Total sales", sign: 1, sequence: 10 },
      { lineCode: "2", label: "Taxable sales", sign: 1, sequence: 20, basis: "taxable_base", glMap: "sales" },
      { lineCode: "3", label: "RST collected (7%)", sign: -1, sequence: 30, basis: "tax_collected", glMap: "sales" },
      { lineCode: "4", label: "Commission / adjustments", sign: 1, sequence: 40 },
      { lineCode: "5", label: "Net RST due", sign: 1, sequence: 50, formula: "3 + 4" },
    ],
  },
  {
    code: "CA_QC_QST",
    name: "Québec QST Return",
    country: "CA",
    jurisdiction: { code: "CA-QC", name: "Québec", country: "CA", region: "QC", level: "state", taxType: "qst" },
    defaultFrequency: "quarterly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.revenuquebec.ca/en/",
    watermark: "Working copy — file and remit through Revenu Québec. Not a government return.",
    boxes: [
      { lineCode: "205", label: "Taxable sales (QST-eligible)", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "203", label: "QST collected (9.975%)", sign: -1, sequence: 20, basis: "tax_collected", glMap: "sales" },
      { lineCode: "205I", label: "Input tax refunds (ITRs)", sign: 1, sequence: 30, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "206", label: "Adjustments", sign: 1, sequence: 40 },
      { lineCode: "208", label: "Net QST to remit or refund", sign: 1, sequence: 50, formula: "203 - 205I + 206" },
    ],
  },
  {
    code: "GB_VAT100",
    name: "VAT Return (VAT100)",
    country: "GB",
    jurisdiction: { code: "GB", name: "United Kingdom", country: "GB", level: "country", taxType: "vat" },
    defaultFrequency: "quarterly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.gov.uk/submit-vat-return",
    watermark: "Working copy — submit with compatible digital VAT filing software",
    boxes: [
      { lineCode: "1", label: "VAT due on sales and other outputs", sign: -1, sequence: 10, basis: "tax_collected", glMap: "sales" },
      { lineCode: "2", label: "VAT due on acquisitions from other EC Member States", sign: 1, sequence: 20 },
      { lineCode: "3", label: "Total VAT due", sign: 1, sequence: 30, formula: "1 + 2" },
      { lineCode: "4", label: "VAT reclaimed on purchases and other inputs", sign: 1, sequence: 40, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "5", label: "Net VAT to pay or reclaim", sign: 1, sequence: 50, formula: "abs(3 - 4)" },
      { lineCode: "6", label: "Total value of sales and other outputs excluding VAT", sign: 1, sequence: 60, basis: "taxable_base", glMap: "sales" },
      { lineCode: "7", label: "Total value of purchases and other inputs excluding VAT", sign: 1, sequence: 70, basis: "taxable_base", glMap: "purchases" },
      { lineCode: "8", label: "Goods supplied to EC Member States", sign: 1, sequence: 80 },
      { lineCode: "9", label: "Goods acquired from EC Member States", sign: 1, sequence: 90 },
    ],
  },
  {
    code: "AU_BAS_GST",
    name: "Business Activity Statement — GST",
    country: "AU",
    jurisdiction: { code: "AU", name: "Australia", country: "AU", level: "country", taxType: "gst" },
    defaultFrequency: "quarterly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/how-to-lodge-your-bas",
    watermark: "Working copy — lodge through the government business portal or enabled software",
    boxes: [
      { lineCode: "G1", label: "Total sales", sign: 1, sequence: 10 },
      { lineCode: "G2", label: "Export sales", sign: 1, sequence: 20 },
      { lineCode: "G3", label: "Other GST-free sales", sign: 1, sequence: 30 },
      { lineCode: "G10", label: "Capital purchases", sign: 1, sequence: 40 },
      { lineCode: "G11", label: "Non-capital purchases", sign: 1, sequence: 50 },
      { lineCode: "1A", label: "GST on sales", sign: -1, sequence: 60, basis: "tax_collected", glMap: "sales" },
      { lineCode: "1B", label: "GST on purchases", sign: 1, sequence: 70, basis: "tax_paid", glMap: "purchases" },
    ],
  },
  {
    code: "NZ_GST101A",
    name: "Goods and Services Tax Return (GST101A)",
    country: "NZ",
    jurisdiction: { code: "NZ", name: "New Zealand", country: "NZ", level: "country", taxType: "gst" },
    defaultFrequency: "bimonthly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.ird.govt.nz/gst/filing-and-paying-gst-and-refunds/filing-gst/file-your-gst-return",
    watermark: "Working copy — file through the government online account",
    boxes: [
      { lineCode: "5", label: "Total sales and income including GST", sign: 1, sequence: 10 },
      { lineCode: "6", label: "Zero-rated supplies included in box 5", sign: 1, sequence: 20 },
      { lineCode: "8", label: "GST on sales and income", sign: -1, sequence: 30, basis: "tax_collected", glMap: "sales" },
      { lineCode: "9", label: "Adjustments from calculation sheet", sign: 1, sequence: 40 },
      { lineCode: "10", label: "Total GST collected", sign: 1, sequence: 50, formula: "8 + 9" },
      { lineCode: "11", label: "Total purchases and expenses including GST", sign: 1, sequence: 60 },
      { lineCode: "12", label: "GST on purchases and expenses", sign: 1, sequence: 70, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "13", label: "Credit adjustments from calculation sheet", sign: 1, sequence: 80 },
      { lineCode: "14", label: "Total GST credit", sign: 1, sequence: 90, formula: "12 + 13" },
      { lineCode: "15", label: "GST refund or GST to pay", sign: 1, sequence: 100, formula: "abs(10 - 14)" },
    ],
  },
  {
    code: "US_SALES_TAX_WORKPAPER",
    name: "United States Sales Tax Workpaper",
    country: "US",
    jurisdiction: { code: "US", name: "United States", country: "US", level: "country", taxType: "sales_use" },
    defaultFrequency: "monthly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.usa.gov/state-taxes",
    watermark: "Not a government return — customize for each state and local jurisdiction before filing",
    boxes: [
      { lineCode: "GROSS_SALES", label: "Gross sales", sign: 1, sequence: 10 },
      { lineCode: "EXEMPT_SALES", label: "Exempt and non-taxable sales", sign: 1, sequence: 20 },
      { lineCode: "TAXABLE_SALES", label: "Taxable sales", sign: 1, sequence: 30, basis: "taxable_base", glMap: "sales" },
      { lineCode: "TAX_COLLECTED", label: "Sales and use tax collected", sign: -1, sequence: 40, basis: "tax_collected", glMap: "sales" },
      { lineCode: "ADJUSTMENTS", label: "Jurisdiction adjustments", sign: 1, sequence: 50 },
      { lineCode: "TAX_DUE", label: "Tax due before jurisdiction-specific credits and fees", sign: 1, sequence: 60, formula: "TAX_COLLECTED + ADJUSTMENTS" },
    ],
  },

  // --- European Union VAT ---------------------------------------------------
  // Each pack mirrors the official return's real box numbers. One box GL-maps
  // total output VAT (tax_collected) and one total input VAT (tax_paid); the
  // ledger already holds the tax at every rate, so the net line is exact even
  // where a rate-split box on the paper form is left filer-entered.
  {
    code: "DE_USTVA",
    name: "Umsatzsteuer-Voranmeldung (Advance VAT Return)",
    country: "DE",
    jurisdiction: { code: "DE", name: "Germany", country: "DE", level: "country", taxType: "vat" },
    defaultFrequency: "monthly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.elster.de",
    watermark: "Working copy — transmit electronically via ELSTER",
    boxes: [
      { lineCode: "81", label: "Taxable supplies at standard rate (19%) — net base", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "86", label: "Taxable supplies at reduced rate (7%) — net base", sign: 1, sequence: 20 },
      { lineCode: "OUTPUT", label: "Output VAT (Umsatzsteuer), all rates", sign: -1, sequence: 30, basis: "tax_collected", glMap: "sales" },
      { lineCode: "66", label: "Deductible input VAT (Vorsteuer)", sign: 1, sequence: 40, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "83", label: "VAT prepayment due or surplus", sign: 1, sequence: 50, formula: "OUTPUT - 66" },
    ],
  },
  {
    code: "FR_CA3",
    name: "Déclaration de TVA (CA3, 3310-CA3)",
    country: "FR",
    jurisdiction: { code: "FR", name: "France", country: "FR", level: "country", taxType: "vat" },
    defaultFrequency: "monthly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.impots.gouv.fr",
    watermark: "Working copy — télédéclaration via impots.gouv.fr",
    boxes: [
      { lineCode: "08", label: "Operations taxed at standard rate (20%) — base", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "16", label: "Total output VAT due (TVA brute)", sign: -1, sequence: 20, basis: "tax_collected", glMap: "sales" },
      { lineCode: "19", label: "Deductible VAT on fixed assets", sign: 1, sequence: 30 },
      { lineCode: "20", label: "Deductible VAT on other goods and services", sign: 1, sequence: 40, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "23", label: "Total deductible VAT", sign: 1, sequence: 50, formula: "19 + 20" },
      { lineCode: "28", label: "Net VAT payable (TVA nette due)", sign: 1, sequence: 60, formula: "16 - 23" },
    ],
  },
  {
    code: "ES_MODELO303",
    name: "Modelo 303 — IVA Autoliquidación",
    country: "ES",
    jurisdiction: { code: "ES", name: "Spain", country: "ES", level: "country", taxType: "vat" },
    defaultFrequency: "quarterly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://sede.agenciatributaria.gob.es",
    watermark: "Working copy — presentar en la Sede Electrónica de la AEAT",
    boxes: [
      { lineCode: "07", label: "Taxable base of standard-rate (21%) sales", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "27", label: "Total output VAT accrued (cuota devengada)", sign: -1, sequence: 20, basis: "tax_collected", glMap: "sales" },
      { lineCode: "29", label: "Deductible input VAT — interior operations", sign: 1, sequence: 30, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "45", label: "Total deductible VAT (total a deducir)", sign: 1, sequence: 40, formula: "29" },
      { lineCode: "46", label: "Result of the general regime", sign: 1, sequence: 50, formula: "27 - 45" },
    ],
  },
  {
    code: "IT_LIPE",
    name: "Liquidazione Periodica IVA (LIPE)",
    country: "IT",
    jurisdiction: { code: "IT", name: "Italy", country: "IT", level: "country", taxType: "vat" },
    defaultFrequency: "quarterly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.agenziaentrate.gov.it",
    watermark: "Working copy — trasmettere all'Agenzia delle Entrate",
    boxes: [
      { lineCode: "VP2", label: "Total active operations (sales base)", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "VP3", label: "Total passive operations (purchases base)", sign: 1, sequence: 20, basis: "taxable_base", glMap: "purchases" },
      { lineCode: "VP4", label: "VAT due (IVA esigibile)", sign: -1, sequence: 30, basis: "tax_collected", glMap: "sales" },
      { lineCode: "VP5", label: "VAT deducted (IVA detratta)", sign: 1, sequence: 40, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "VP6", label: "VAT due or credit for the period", sign: 1, sequence: 50, formula: "VP4 - VP5" },
    ],
  },
  {
    code: "NL_OB",
    name: "Omzetbelasting (BTW) aangifte",
    country: "NL",
    jurisdiction: { code: "NL", name: "Netherlands", country: "NL", level: "country", taxType: "vat" },
    defaultFrequency: "quarterly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.belastingdienst.nl",
    watermark: "Working copy — aangifte doen via de Belastingdienst",
    boxes: [
      { lineCode: "1a", label: "Domestic supplies at high rate (21%) — base", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "1b", label: "Domestic supplies at low rate (9%) — base", sign: 1, sequence: 20 },
      { lineCode: "5a", label: "VAT owed (verschuldigde omzetbelasting)", sign: -1, sequence: 30, basis: "tax_collected", glMap: "sales" },
      { lineCode: "5b", label: "Input VAT (voorbelasting)", sign: 1, sequence: 40, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "5g", label: "Total to pay or reclaim", sign: 1, sequence: 50, formula: "5a - 5b" },
    ],
  },
  {
    code: "IE_VAT3",
    name: "VAT3 Return",
    country: "IE",
    jurisdiction: { code: "IE", name: "Ireland", country: "IE", level: "country", taxType: "vat" },
    defaultFrequency: "bimonthly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.revenue.ie",
    watermark: "Working copy — file through Revenue Online Service (ROS)",
    boxes: [
      { lineCode: "T1", label: "VAT on sales (output VAT)", sign: -1, sequence: 10, basis: "tax_collected", glMap: "sales" },
      { lineCode: "T2", label: "VAT on purchases (input VAT)", sign: 1, sequence: 20, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "T3", label: "VAT payable", sign: 1, sequence: 30, formula: "T1 - T2" },
      { lineCode: "T4", label: "VAT repayable", sign: 1, sequence: 40, formula: "T2 - T1" },
      { lineCode: "E1", label: "Goods supplied to other EU countries", sign: 1, sequence: 50 },
      { lineCode: "E2", label: "Goods acquired from other EU countries", sign: 1, sequence: 60 },
    ],
  },

  // --- Other major economies ------------------------------------------------
  {
    code: "IN_GSTR3B",
    name: "GSTR-3B — Monthly Summary Return",
    country: "IN",
    jurisdiction: { code: "IN", name: "India", country: "IN", level: "country", taxType: "gst" },
    defaultFrequency: "monthly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.gst.gov.in",
    watermark: "Working copy — file on the GST portal",
    boxes: [
      { lineCode: "3.1A", label: "Outward taxable supplies (other than zero/nil/exempt) — taxable value", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "OUT", label: "Output tax on outward supplies (IGST+CGST+SGST+Cess)", sign: -1, sequence: 20, basis: "tax_collected", glMap: "sales" },
      { lineCode: "4A5", label: "ITC Available — all other ITC", sign: 1, sequence: 30, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "4C", label: "Net ITC Available", sign: 1, sequence: 40, formula: "4A5" },
      { lineCode: "6.1", label: "Tax payable (output tax less net ITC)", sign: 1, sequence: 50, formula: "OUT - 4C" },
    ],
  },
  {
    code: "SG_GSTF5",
    name: "GST F5 Return",
    country: "SG",
    jurisdiction: { code: "SG", name: "Singapore", country: "SG", level: "country", taxType: "gst" },
    defaultFrequency: "quarterly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.iras.gov.sg",
    watermark: "Working copy — file through myTax Portal (IRAS)",
    boxes: [
      { lineCode: "1", label: "Total value of standard-rated supplies", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "2", label: "Total value of zero-rated supplies", sign: 1, sequence: 20 },
      { lineCode: "3", label: "Total value of exempt supplies", sign: 1, sequence: 30 },
      { lineCode: "4", label: "Total value of (1) + (2) + (3)", sign: 1, sequence: 40, formula: "1 + 2 + 3" },
      { lineCode: "5", label: "Total value of taxable purchases", sign: 1, sequence: 50, basis: "taxable_base", glMap: "purchases" },
      { lineCode: "6", label: "Output tax due", sign: -1, sequence: 60, basis: "tax_collected", glMap: "sales" },
      { lineCode: "7", label: "Input tax and refunds claimed", sign: 1, sequence: 70, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "8", label: "Net GST to be paid to / claimed from IRAS", sign: 1, sequence: 80, formula: "6 - 7" },
    ],
  },
  {
    code: "ZA_VAT201",
    name: "VAT201 — Value-Added Tax Return",
    country: "ZA",
    jurisdiction: { code: "ZA", name: "South Africa", country: "ZA", level: "country", taxType: "vat" },
    defaultFrequency: "bimonthly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.sarsefiling.co.za",
    watermark: "Working copy — file through SARS eFiling",
    boxes: [
      { lineCode: "1", label: "Standard-rate supplies (excluding capital goods) — value", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "4", label: "Output tax on standard-rate supplies", sign: -1, sequence: 20, basis: "tax_collected", glMap: "sales" },
      { lineCode: "13", label: "Total Output Tax", sign: 1, sequence: 30, formula: "4" },
      { lineCode: "14", label: "Input tax — capital goods and/or services", sign: 1, sequence: 40 },
      { lineCode: "15", label: "Input tax — other goods and/or services", sign: 1, sequence: 50, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "19", label: "Total Input Tax", sign: 1, sequence: 60, formula: "14 + 15" },
      { lineCode: "20", label: "VAT payable or refundable", sign: 1, sequence: 70, formula: "13 - 19" },
    ],
  },
  {
    code: "AE_VAT201",
    name: "VAT201 — VAT Return",
    country: "AE",
    jurisdiction: { code: "AE", name: "United Arab Emirates", country: "AE", level: "country", taxType: "vat" },
    defaultFrequency: "quarterly",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://eservices.tax.gov.ae",
    watermark: "Working copy — file through the FTA EmaraTax portal",
    boxes: [
      { lineCode: "1", label: "Standard-rated supplies — amount (by Emirate)", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "8", label: "Total output VAT", sign: -1, sequence: 20, basis: "tax_collected", glMap: "sales" },
      { lineCode: "9", label: "Standard-rated expenses — recoverable input VAT", sign: 1, sequence: 30, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "11", label: "Total recoverable input VAT", sign: 1, sequence: 40, formula: "9" },
      { lineCode: "14", label: "Net VAT due (payable)", sign: 1, sequence: 50, formula: "8 - 11" },
    ],
  },
  {
    code: "JP_CONSUMPTION",
    name: "Consumption Tax Return (消費税申告書)",
    country: "JP",
    jurisdiction: { code: "JP", name: "Japan", country: "JP", level: "country", taxType: "consumption" },
    defaultFrequency: "annual",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.e-tax.nta.go.jp",
    watermark: "Working copy — file through e-Tax (NTA)",
    boxes: [
      { lineCode: "1", label: "Taxable base amount (taxable sales, tax-exclusive)", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "2", label: "Consumption tax on sales", sign: -1, sequence: 20, basis: "tax_collected", glMap: "sales" },
      { lineCode: "4", label: "Deductible purchase (input) tax", sign: 1, sequence: 30, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "7", label: "Subtotal of deductions", sign: 1, sequence: 40, formula: "4" },
      { lineCode: "9", label: "Net consumption tax payable", sign: 1, sequence: 50, formula: "2 - 7" },
    ],
  },

  // --- United States, per-state sales & use tax -----------------------------
  // Real state return line structures. Rates and local/district overlays are
  // NOT bundled — they are configured per jurisdiction — so these are honest
  // working copies of the state form, not certified returns.
  {
    code: "US_CA_CDTFA401",
    name: "California Sales and Use Tax Return (CDTFA-401)",
    country: "US",
    jurisdiction: { code: "US-CA", name: "California", country: "US", region: "CA", level: "state", taxType: "sales_use" },
    defaultFrequency: "quarterly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://onlineservices.cdtfa.ca.gov",
    watermark: "Working copy — file through CDTFA online services; district/local rates configured per jurisdiction",
    boxes: [
      { lineCode: "1", label: "Total sales", sign: 1, sequence: 10 },
      { lineCode: "2", label: "Purchases subject to use tax", sign: 1, sequence: 20 },
      { lineCode: "3", label: "Total", sign: 1, sequence: 30, formula: "1 + 2" },
      { lineCode: "11", label: "Total nontaxable transactions", sign: 1, sequence: 40 },
      { lineCode: "12", label: "Transactions subject to tax", sign: 1, sequence: 50, formula: "3 - 11" },
      { lineCode: "19", label: "Total tax amount (state, county, local, district)", sign: -1, sequence: 60, basis: "tax_collected", glMap: "sales" },
      { lineCode: "20", label: "Credits", sign: 1, sequence: 70 },
      { lineCode: "21", label: "Net tax", sign: 1, sequence: 80, formula: "19 - 20" },
    ],
  },
  {
    code: "US_TX_01114",
    name: "Texas Sales and Use Tax Return (01-114)",
    country: "US",
    jurisdiction: { code: "US-TX", name: "Texas", country: "US", region: "TX", level: "state", taxType: "sales_use" },
    defaultFrequency: "monthly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://comptroller.texas.gov/taxes/file-pay/",
    watermark: "Working copy — file through Texas Comptroller Webfile; local rates configured per jurisdiction",
    boxes: [
      { lineCode: "1", label: "Total sales", sign: 1, sequence: 10 },
      { lineCode: "2", label: "Taxable sales", sign: 1, sequence: 20, basis: "taxable_base", glMap: "sales" },
      { lineCode: "3", label: "Taxable purchases", sign: 1, sequence: 30 },
      { lineCode: "4", label: "Amount subject to state tax", sign: 1, sequence: 40, formula: "2 + 3" },
      { lineCode: "7", label: "Tax due (state and local)", sign: -1, sequence: 50, basis: "tax_collected", glMap: "sales" },
      { lineCode: "13", label: "Net tax due", sign: 1, sequence: 60, formula: "7" },
    ],
  },
  {
    code: "US_NY_ST100",
    name: "New York State and Local Sales and Use Tax Return (ST-100)",
    country: "US",
    jurisdiction: { code: "US-NY", name: "New York", country: "US", region: "NY", level: "state", taxType: "sales_use" },
    defaultFrequency: "quarterly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.tax.ny.gov/online/",
    watermark: "Working copy — file through NY Online Services; jurisdiction rates configured per locality",
    boxes: [
      { lineCode: "1", label: "Gross sales and services", sign: 1, sequence: 10 },
      { lineCode: "1a", label: "Nontaxable sales", sign: 1, sequence: 20 },
      { lineCode: "12", label: "Total taxable sales and services", sign: 1, sequence: 30, basis: "taxable_base", glMap: "sales" },
      { lineCode: "14", label: "Total sales and use tax", sign: -1, sequence: 40, basis: "tax_collected", glMap: "sales" },
      { lineCode: "17", label: "Taxes due", sign: 1, sequence: 50, formula: "14" },
    ],
  },
  {
    code: "US_FL_DR15",
    name: "Florida Sales and Use Tax Return (DR-15)",
    country: "US",
    jurisdiction: { code: "US-FL", name: "Florida", country: "US", region: "FL", level: "state", taxType: "sales_use" },
    defaultFrequency: "monthly",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://floridarevenue.com/taxes/eservices/",
    watermark: "Working copy — file through Florida DOR e-Services; discretionary surtax configured per county",
    boxes: [
      { lineCode: "A1", label: "Gross sales", sign: 1, sequence: 10 },
      { lineCode: "A2", label: "Exempt sales", sign: 1, sequence: 20 },
      { lineCode: "A3", label: "Taxable amount", sign: 1, sequence: 30, basis: "taxable_base", glMap: "sales" },
      { lineCode: "5", label: "Total amount of tax due", sign: -1, sequence: 40, basis: "tax_collected", glMap: "sales" },
      { lineCode: "6", label: "Less lawful deductions", sign: 1, sequence: 50 },
      { lineCode: "7", label: "Net tax due", sign: 1, sequence: 60, formula: "5 - 6" },
    ],
  },
] as const;

export interface SeedTaxFormsResult {
  formCreated: boolean;
  boxRows: number;
  mappedSalesCodes: number;
  mappedPurchaseCodes: number;
}

export interface InstalledTaxReturnPack extends SeedTaxFormsResult {
  code: string;
}

type TaxPackExecutor = Pick<typeof db, "execute">;

export function taxReturnPack(code: string): TaxReturnPack | undefined {
  return TAX_RETURN_PACKS.find((pack) => pack.code === code);
}

/** Idempotently install or reset one library pack for a tenant. */
export async function installTaxReturnPack(
  orgId: string,
  packCode: string,
  actorId: string | null = null,
): Promise<SeedTaxFormsResult> {
  const pack = taxReturnPack(packCode);
  if (!pack) throw new Error(`unknown tax return pack "${packCode}"`);

  return db.transaction((tx) => installTaxReturnPackWith(tx, orgId, pack, actorId));
}

/** Install several packs atomically so a failed pack never leaves a partial library import. */
export async function installTaxReturnPacks(
  orgId: string,
  packCodes: readonly string[],
  actorId: string | null = null,
): Promise<InstalledTaxReturnPack[]> {
  const uniqueCodes = [...new Set(packCodes)];
  const packs = uniqueCodes.map((code) => {
    const pack = taxReturnPack(code);
    if (!pack) throw new Error(`unknown tax return pack "${code}"`);
    return pack;
  });

  return db.transaction(async (tx) => {
    const results: InstalledTaxReturnPack[] = [];
    for (const pack of packs) {
      results.push({ code: pack.code, ...(await installTaxReturnPackWith(tx, orgId, pack, actorId)) });
    }
    return results;
  });
}

async function installTaxReturnPackWith(
  tx: TaxPackExecutor,
  orgId: string,
  pack: TaxReturnPack,
  actorId: string | null,
): Promise<SeedTaxFormsResult> {
  // Reference-data jurisdiction the return files into. Idempotent by (org, code)
  // so re-importing a pack keeps the same jurisdiction row and its registrations.
  const j = pack.jurisdiction;
  const jurRes = (await tx.execute(sql`
    insert into tax_jurisdictions
      (org_id, code, name, country, region, level, tax_type, is_active, created_by, updated_by)
    values (${orgId}, ${j.code}, ${j.name}, ${j.country}, ${j.region ?? null},
            ${j.level}, ${j.taxType}, true, ${actorId}, ${actorId})
    on conflict (org_id, code) do update
      set name = excluded.name, country = excluded.country, region = excluded.region,
          level = excluded.level, tax_type = excluded.tax_type, is_active = true,
          updated_at = now(), updated_by = ${actorId}
    returning id`)) as unknown as { rows: { id: string }[] };
  const jurisdictionId = jurRes.rows[0]?.id ?? null;

  const formRes = (await tx.execute(sql`
    insert into tax_return_forms
      (org_id, code, name, country, jurisdiction_id, submission_channel, government_format,
       submission_url, watermark, is_active, created_by, updated_by)
    values (${orgId}, ${pack.code}, ${pack.name}, ${pack.country}, ${jurisdictionId},
            ${pack.submissionChannel}, ${pack.governmentFormat}, ${pack.submissionUrl},
            ${pack.watermark}, true, ${actorId}, ${actorId})
    on conflict (org_id, code) do update
      set name = excluded.name, country = excluded.country,
          jurisdiction_id = excluded.jurisdiction_id,
          submission_channel = excluded.submission_channel,
          government_format = excluded.government_format,
          submission_url = excluded.submission_url,
          watermark = excluded.watermark, is_active = true,
          updated_at = now(), updated_by = ${actorId}
    returning id, (xmax = 0) as inserted`)) as unknown as { rows: { id: string; inserted: boolean }[] };

  await tx.execute(sql`delete from tax_report_lines where org_id = ${orgId} and report_code = ${pack.code}`);

  const candidates = (await tx.execute(sql`
    select id, country, jurisdiction_id, applies_to from tax_codes
     where org_id = ${orgId} and is_active
       and applies_to in ('sales', 'purchases', 'both')`)) as unknown as {
    rows: { id: string; country: string | null; jurisdiction_id: string | null; applies_to: "sales" | "purchases" | "both" }[];
  };
  // Prefer tax codes scoped to THIS jurisdiction (so a state return sums only its
  // own state's codes, not every US code); fall back to country, then to codes
  // with no country at all.
  const jurisdictionCodes = jurisdictionId
    ? candidates.rows.filter((row) => row.jurisdiction_id === jurisdictionId)
    : [];
  const hasCountryCodes = candidates.rows.some((row) => row.country === pack.country);
  const eligible = jurisdictionCodes.length
    ? jurisdictionCodes
    : candidates.rows.filter((row) => (hasCountryCodes ? row.country === pack.country : row.country === null));
  const sales = eligible.filter((row) => row.applies_to === "sales" || row.applies_to === "both");
  const purchases = eligible.filter((row) => row.applies_to === "purchases" || row.applies_to === "both");

  let boxRows = 0;
  const insertRow = async (box: TaxReturnPackBox, taxCodeId: string | null) => {
    await tx.execute(sql`
      insert into tax_report_lines
        (org_id, report_code, line_code, label, tax_code_id, basis, sign,
         sequence, formula, created_by, updated_by)
      values (${orgId}, ${pack.code}, ${box.lineCode}, ${box.label}, ${taxCodeId},
              ${box.basis ?? null}, ${box.sign}, ${box.sequence}, ${box.formula ?? null},
              ${actorId}, ${actorId})`);
    boxRows++;
  };

  for (const box of pack.boxes) {
    const codes = box.glMap === "sales" ? sales : box.glMap === "purchases" ? purchases : [];
    if (box.glMap && codes.length > 0) {
      for (const code of codes) await insertRow(box, code.id);
    } else {
      await insertRow(box, null);
    }
  }

  const result = {
    formCreated: formRes.rows[0]?.inserted ?? false,
    boxRows,
    mappedSalesCodes: sales.length,
    mappedPurchaseCodes: purchases.length,
  };
  if (actorId && formRes.rows[0]) {
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_return_forms', ${formRes.rows[0].id},
              ${result.formCreated ? "insert" : "update"},
              ${JSON.stringify({ pack: pack.code, resetToLibraryDefaults: !result.formCreated, boxRows, mappedSalesCodes: sales.length, mappedPurchaseCodes: purchases.length })}::jsonb,
              ${actorId})`);
  }
  return result;
}

/** Backwards-compatible engine entry point used by existing seed scripts. */
export function seedCanadaGst34(orgId: string, actorId: string | null = null): Promise<SeedTaxFormsResult> {
  return installTaxReturnPack(orgId, "CA_GST34", actorId);
}

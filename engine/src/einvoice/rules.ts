// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * EN 16931 business rules, evaluated natively over the semantic model.
 *
 * A receiver validates an e-invoice with the published Schematron artefacts
 * and reports each failure by rule identifier (BR-61, BR-CO-15, BR-DE-15,
 * PEPPOL-EN16931-R003, ...). Every finding here carries the identifier that
 * receiver would report for the corresponding implemented check. The
 * native rules cover the modeled terms; they do not substitute for the
 * complete published Schematron or every receiver-specific requirement. Rules whose identifier no artefact defines
 * (input-shape refusals and house advisories) use the `OB-` prefix.
 *
 * Rule families are selected only by the rule-set ids a profile declares;
 * national rule sets are selected by the seller country under which the
 * profile declares them, and receive that country as context.
 *
 * Calculation rules compare exactly after rounding to the document
 * precision (BR-CO-10 to BR-CO-16). BR-CO-17 and the BR-x-8 family allow
 * the official tolerance of one currency unit, because tax posted per line
 * legitimately differs from basis × rate by accumulated rounding.
 */

import { paymentAccountRefusal, paymentProviderRefusal, validPaymentIban } from "./bank.ts";
import { add, mulPercent, neg, sum } from "../money/money.ts";
import {
  CREDIT_TRANSFER_MEANS,
  DIRECT_DEBIT_MEANS,
  DOCUMENT_TYPE_LABELS,
  INVOICE_TYPE_CODES,
  CREDIT_NOTE_TYPE_CODES,
  PAYMENT_CARD_MEANS,
  PEPPOL_CREDIT_NOTE_TYPE_CODES,
  PEPPOL_INVOICE_TYPE_CODES,
  SUPPLEMENTARY_INVOICE_TYPE_CODES,
  TAXED_VAT_CATEGORIES,

  isCreditNoteTypeCode,
  isKnownEasScheme,
  isKnownPaymentMeansCode,
  isKnownVatexCode,
  isVatCategory,
  vatCategoryRulePrefix,
} from "./codes.ts";
import {
  compare,
  fixed,
  hasAtMostDecimals,
  isPlainDecimal,
  money,
  percentOfWithin,
  productWithin,
  rateKey,
  sign,
  within,
} from "./decimal.ts";
import type { EInvoice, EInvoiceAddress, EInvoiceParty, VatCategory } from "./model.ts";
import {
  EINVOICE_PROFILES,
  PEPPOL_BIS_GUIDELINE,
  XRECHNUNG_GUIDELINE,
  getEInvoiceProfile,
  type EInvoiceProfile,
  type EInvoiceRuleSetId,
} from "./profiles.ts";
import { isIsoDate } from "./xml.ts";
import { CURRENCY_CODES, COUNTRY_CODES, UNIT_CODES } from "./standard-codes.ts";
import { validateAunzRules, validateSingaporeRules, validateNlcIusRules, validateNorwegianRules, validateGstBreakdown } from "./national-rules.ts";

export type EInvoiceFindingSeverity = "fatal" | "warning";

export interface EInvoiceFinding {
  /** The identifier a receiver's validator reports, e.g. "BR-61". */
  ruleId: string;
  severity: EInvoiceFindingSeverity;
  /** The EN 16931 business term or group at fault, e.g. "BT-84". */
  term: string | null;
  /** What the operator must change, as one actionable sentence. */
  message: string;
  /** Values the message interpolates, for translated renderings. */
  params: Record<string, string>;
}

/** Raised when a document with fatal findings is rendered strictly. */
export class EInvoiceRefusal extends Error {
  readonly findings: EInvoiceFinding[];

  constructor(findings: EInvoiceFinding[]) {
    const fatal = findings.filter((finding) => finding.severity === "fatal");
    super(
      `The e-invoice cannot be issued until ${fatal.length} rule ${fatal.length === 1 ? "violation is" : "violations are"} fixed: ` +
        fatal.map((finding) => `${finding.ruleId}: ${finding.message}`).join(" "),
    );
    this.name = "EInvoiceRefusal";
    this.findings = findings;
  }
}

export function fatalFindings(findings: readonly EInvoiceFinding[]): EInvoiceFinding[] {
  return findings.filter((finding) => finding.severity === "fatal");
}

// ---------------------------------------------------------------------------
// Context and helpers
// ---------------------------------------------------------------------------

interface RuleContext {
  inv: EInvoice;
  profile: EInvoiceProfile;
  /** Document precision, validated to 0..2. */
  decimals: number;
  /** Every amount, quantity and rate is a plain decimal, so calculation rules can run. */
  numeric: boolean;
  /** For a national rule set: the seller country under which the profile declared it. */
  country: string | null;
}

type RuleSet = (ctx: RuleContext) => EInvoiceFinding[];

function finding(
  ruleId: string,
  severity: EInvoiceFindingSeverity,
  term: string | null,
  message: string,
  params: Record<string, string> = {},
): EInvoiceFinding {
  return { ruleId, severity, term, message, params };
}

const fatal = (ruleId: string, term: string | null, message: string, params?: Record<string, string>) =>
  finding(ruleId, "fatal", term, message, params);
const warning = (ruleId: string, term: string | null, message: string, params?: Record<string, string>) =>
  finding(ruleId, "warning", term, message, params);

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/** A group or line rate as a canonical key; category O may omit its rate, which reads as 0. */
function rateOf(rate: string | null | undefined): string {
  return blank(rate) ? "0" : rateKey(rate!);
}

function amountText(ctx: RuleContext, value: string): string {
  return `${fixed(value, ctx.decimals)} ${ctx.inv.currency}`.trim();
}

/** Every VAT category the document uses on lines, allowances and charges. */
function usedCategories(inv: EInvoice): Set<string> {
  return new Set([
    ...inv.lines.map((line) => line.vatCategory),
    ...inv.allowanceCharges.map((entry) => entry.vatCategory),
  ]);
}

function hasCategory(inv: EInvoice, category: VatCategory): { line: boolean; allowance: boolean; charge: boolean } {
  return {
    line: inv.lines.some((line) => line.vatCategory === category),
    allowance: inv.allowanceCharges.some((entry) => !entry.isCharge && entry.vatCategory === category),
    charge: inv.allowanceCharges.some((entry) => entry.isCharge && entry.vatCategory === category),
  };
}

const EN16931_TYPE_CODES = new Set([...INVOICE_TYPE_CODES, ...SUPPLEMENTARY_INVOICE_TYPE_CODES, ...CREDIT_NOTE_TYPE_CODES]);

// ---------------------------------------------------------------------------
// Input shape: numbers, dates and precision
// ---------------------------------------------------------------------------

/** BR-DEC rule per amount term: amounts may carry no more decimals than the document states. */
const DECIMAL_RULES: Readonly<Record<string, string>> = {
  "BT-92": "BR-DEC-01", "BT-93": "BR-DEC-02", "BT-99": "BR-DEC-05", "BT-100": "BR-DEC-06",
  "BT-106": "BR-DEC-09", "BT-107": "BR-DEC-10", "BT-108": "BR-DEC-11", "BT-109": "BR-DEC-12",
  "BT-110": "BR-DEC-13", "BT-112": "BR-DEC-14", "BT-111": "BR-DEC-15", "BT-113": "BR-DEC-16",
  "BT-114": "BR-DEC-17", "BT-115": "BR-DEC-18", "BT-116": "BR-DEC-19", "BT-117": "BR-DEC-20",
  "BT-131": "BR-DEC-23",
};

function checkShape(inv: EInvoice): { findings: EInvoiceFinding[]; decimals: number; numeric: boolean } {
  const out: EInvoiceFinding[] = [];
  const decimals = inv.currencyDecimals;
  const decimalsValid = Number.isInteger(decimals) && decimals >= 0 && decimals <= 2;
  if (!decimalsValid) {
    out.push(fatal("OB-FMT-03", "BT-5",
      `Resolve the number of decimals for ${inv.currency || "the invoice currency"} to 0, 1 or 2; EN 16931 amounts carry at most two decimals.`,
      { decimals: String(decimals) }));
  }
  let numeric = decimalsValid;

  const numbers: Array<[string, string, string | null | undefined, boolean]> = [];
  const amount = (term: string, label: string, value: string | null | undefined, optional = false) =>
    numbers.push([term, label, value, optional]);
  inv.lines.forEach((line) => {
    amount("BT-129", `the quantity on line ${line.id}`, line.quantity);
    amount("BT-146", `the net price on line ${line.id}`, line.netPrice);
    amount("BT-149", `the price base quantity on line ${line.id}`, line.baseQuantity, true);
    amount("BT-131", `the net amount on line ${line.id}`, line.netAmount);
    amount("BT-152", `the VAT rate on line ${line.id}`, line.vatRate);
  });
  inv.allowanceCharges.forEach((entry, index) => {
    const kind = entry.isCharge ? "charge" : "allowance";
    amount(entry.isCharge ? "BT-99" : "BT-92", `the amount of document ${kind} ${index + 1}`, entry.amount);
    amount(entry.isCharge ? "BT-100" : "BT-93", `the base amount of document ${kind} ${index + 1}`, entry.baseAmount, true);
    amount(entry.isCharge ? "BT-101" : "BT-94", `the percentage of document ${kind} ${index + 1}`, entry.percent, true);
    amount(entry.isCharge ? "BT-103" : "BT-96", `the VAT rate of document ${kind} ${index + 1}`, entry.vatRate);
  });
  inv.vatBreakdown.forEach((group) => {
    amount("BT-119", `the rate of the VAT ${group.category} group`, group.rate, group.category === "O");
    amount("BT-116", `the taxable amount of the VAT ${group.category} group`, group.taxableAmount);
    amount("BT-117", `the tax amount of the VAT ${group.category} group`, group.taxAmount);
  });
  const totals = inv.totals;
  amount("BT-106", "the sum of line net amounts", totals.lineNet);
  amount("BT-107", "the allowance total", totals.allowances);
  amount("BT-108", "the charge total", totals.charges);
  amount("BT-109", "the total without VAT", totals.taxExclusive);
  amount("BT-110", "the VAT total", totals.tax);
  amount("BT-112", "the total with VAT", totals.taxInclusive);
  amount("BT-113", "the paid amount", totals.prepaid);
  amount("BT-114", "the rounding amount", totals.rounding);
  amount("BT-115", "the amount due", totals.payable);
  amount("BT-111", "the VAT total in the VAT accounting currency", inv.taxTotalInTaxCurrency, true);
  if (inv.accountingCurrencyTotals) {
    amount("BT-109", "the accounting-currency total without tax", inv.accountingCurrencyTotals.taxExclusive);
    amount("BT-112", "the accounting-currency total with tax", inv.accountingCurrencyTotals.taxInclusive);
  }

  for (const [term, label, value, optional] of numbers) {
    if (optional && blank(value)) continue;
    if (!isPlainDecimal(value)) {
      numeric = false;
      out.push(fatal("OB-FMT-01", term, `Enter ${label} (${term}) as a plain decimal number such as 1250.00.`,
        { term, value: String(value ?? "") }));
      continue;
    }
    if (["BT-119", "BT-152", "BT-96", "BT-103", "BT-94", "BT-101"].includes(term) && !hasAtMostDecimals(value, 18)) {
      numeric = false;
      out.push(fatal("OB-FMT-04", term, `State ${label} with at most eighteen decimal places.`, { term }));
    }
    const decimalRule = DECIMAL_RULES[term];
    if (decimalsValid && decimalRule && !hasAtMostDecimals(value, decimals)) {
      out.push(fatal(decimalRule, term,
        `State ${label} (${term}) with at most ${decimals} decimals; ${value} carries more than ${inv.currency} amounts allow.`,
        { term, value, decimals: String(decimals) }));
    }
  }

  const dates: Array<[string, string, string | null | undefined]> = [
    ["BT-9", "the payment due date", inv.dueDate],
    ["BT-7", "the VAT point date", inv.taxPointDate],
    ["BT-72", "the actual delivery date", inv.delivery?.date],
    ["BT-73", "the invoicing period start date", inv.invoicePeriod?.start],
    ["BT-74", "the invoicing period end date", inv.invoicePeriod?.end],
    ...inv.precedingInvoices.map((entry): [string, string, string | null | undefined] =>
      ["BT-26", `the issue date of preceding invoice ${entry.number}`, entry.issueDate]),
    ...inv.lines.flatMap((line): Array<[string, string, string | null | undefined]> => [
      ["BT-134", `the period start date on line ${line.id}`, line.period?.start],
      ["BT-135", `the period end date on line ${line.id}`, line.period?.end],
    ]),
  ];
  if (!blank(inv.issueDate)) dates.unshift(["BT-2", "the invoice issue date", inv.issueDate]);
  for (const [term, label, value] of dates) {
    if (blank(value) || isIsoDate(value)) continue;
    out.push(fatal("OB-FMT-02", term, `Enter ${label} (${term}) as a calendar date in the form YYYY-MM-DD.`,
      { term, value: String(value) }));
  }
  return { findings: out, decimals: decimalsValid ? decimals : 2, numeric };
}

// ---------------------------------------------------------------------------
// EN 16931 core
// ---------------------------------------------------------------------------

function checkHeader({ inv, profile }: RuleContext): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  if (blank(inv.number)) out.push(fatal("BR-2", "BT-1", "Give the invoice a number (BT-1)."));
  if (blank(inv.issueDate)) out.push(fatal("BR-3", "BT-2", "Set the invoice issue date (BT-2)."));
  if (blank(inv.typeCode)) {
    out.push(fatal("BR-4", "BT-3", "Set the invoice type code (BT-3), for example 380 for an invoice or 381 for a credit note."));
  } else if (!EN16931_TYPE_CODES.has(inv.typeCode.trim())) {
    out.push(fatal("BR-CL-01", "BT-3",
      `Invoice type code ${inv.typeCode} is not an EN 16931 document type; use a UNTDID 1001 invoice or credit note code such as 380 or 381.`,
      { code: inv.typeCode }));
  }
  if (blank(inv.currency)) {
    out.push(fatal("BR-5", "BT-5", "Set the invoice currency (BT-5), for example EUR."));
  } else if (!CURRENCY_CODES.has(inv.currency)) {
    out.push(fatal("BR-CL-04", "BT-5", `Write the invoice currency as a three-letter ISO 4217 code; "${inv.currency}" is not one.`,
      { currency: inv.currency }));
  }
  if (!blank(inv.taxCurrency) && !CURRENCY_CODES.has(inv.taxCurrency!)) {
    out.push(fatal("BR-CL-05", "BT-6", `Write the VAT accounting currency as a three-letter ISO 4217 code; "${inv.taxCurrency}" is not one.`,
      { currency: inv.taxCurrency! }));
  }
  if (inv.lines.length === 0) out.push(fatal("BR-16", "BG-25", "Add at least one invoice line."));
  if (profile.syntax === "cii" && inv.precedingInvoices.length > 1) out.push(fatal("OB-CII-01", "BG-3", "CII D16B carries one preceding invoice reference; use UBL when multiple references are required."));
  inv.precedingInvoices.forEach((entry, index) => {
    if (blank(entry.number)) {
      out.push(fatal("BR-55", "BT-25", `Give preceding invoice reference ${index + 1} the number of the invoice it refers to (BT-25).`,
        { index: String(index + 1) }));
    }
  });
  const period = inv.invoicePeriod;
  if (period) {
    if (blank(period.start) && blank(period.end)) {
      out.push(fatal("BR-CO-19", "BG-14", "Give the invoicing period a start date (BT-73), an end date (BT-74) or both, or remove the period."));
    } else if (isIsoDate(period.start) && isIsoDate(period.end) && period.end < period.start) {
      out.push(fatal("BR-29", "BT-74", `The invoicing period ends (${period.end}) before it starts (${period.start}); correct the dates.`,
        { start: period.start, end: period.end }));
    }
  }
  if (inv.delivery?.address && !blank(inv.delivery.address.countryCode) && !COUNTRY_CODES.has(inv.delivery.address.countryCode)) {
    out.push(fatal("BR-CL-14", "BT-80", `Write the deliver-to country as a two-letter ISO 3166-1 code; "${inv.delivery.address.countryCode}" is not one.`,
      { country: inv.delivery.address.countryCode }));
  }
  return out;
}

function hasCountryPrefix(vatId: string): boolean {
  return /^[A-Z]{2}[A-Za-z0-9]/.test(vatId.trim().replace(/\s+/g, ""));
}

function checkParties({ inv }: RuleContext): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  if (blank(inv.seller.name)) out.push(fatal("BR-6", "BT-27", "Add the seller's legal name (BT-27)."));
  if (blank(inv.buyer.name)) out.push(fatal("BR-7", "BT-44", "Add the buyer's name (BT-44)."));
  const sides: Array<{ party: EInvoiceParty; role: "seller" | "buyer"; countryRule: string; countryTerm: string; vatTerm: string; schemeRule: string; addressTerm: string }> = [
    { party: inv.seller, role: "seller", countryRule: "BR-9", countryTerm: "BT-40", vatTerm: "BT-31", schemeRule: "BR-62", addressTerm: "BT-34" },
    { party: inv.buyer, role: "buyer", countryRule: "BR-11", countryTerm: "BT-55", vatTerm: "BT-48", schemeRule: "BR-63", addressTerm: "BT-49" },
  ];
  for (const { party, role, countryRule, countryTerm, vatTerm, schemeRule, addressTerm } of sides) {
    const country = party.address.countryCode;
    if (blank(country)) {
      out.push(fatal(countryRule, countryTerm, `Add the ${role}'s country code (${countryTerm}), two letters such as DE or FR.`, { party: role }));
    } else if (!COUNTRY_CODES.has(country)) {
      out.push(fatal("BR-CL-14", countryTerm, `Write the ${role}'s country as a two-letter ISO 3166-1 code; "${country}" is not one.`,
        { party: role, country }));
    }
    if (!blank(party.vatId) && !hasCountryPrefix(party.vatId!)) {
      out.push(fatal("BR-CO-9", vatTerm,
        `Prefix the ${role}'s VAT identifier (${vatTerm}) with the two-letter code of the issuing country, for example DE123456789.`,
        { party: role, vatId: party.vatId! }));
    }
    const address = party.electronicAddress;
    if (address && !blank(address.id)) {
      if (blank(address.schemeId)) {
        out.push(fatal(schemeRule, addressTerm, `State the scheme of the ${role}'s electronic address (${addressTerm}), for example 0204 for a Leitweg-ID or 0088 for a GLN.`,
          { party: role }));
      } else if (!isKnownEasScheme(address.schemeId)) {
        out.push(fatal("BR-CL-25", addressTerm, `Electronic address scheme ${address.schemeId} for the ${role} is not in the CEF EAS code list; choose a listed scheme.`,
          { party: role, scheme: address.schemeId }));
      }
    }
  }
  if (blank(inv.seller.vatId) && blank(inv.seller.legalRegistration?.id) && blank(inv.seller.identifier?.id)) {
    out.push(fatal("BR-CO-26", "BT-31",
      "Add the seller identifier (BT-29), VAT identifier (BT-31) or legal registration identifier (BT-30) so the buyer can identify the seller."));
  }
  return out;
}

function checkLines({ inv, profile }: RuleContext): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  inv.lines.forEach((line, index) => {
    const where = blank(line.id) ? String(index + 1) : line.id;
    const params = { line: where };
    if (blank(line.id)) out.push(fatal("BR-21", "BT-126", `Give invoice line ${where} a line identifier (BT-126).`, params));
    if (blank(line.name)) out.push(fatal("BR-25", "BT-153", `Give the item on line ${where} a name (BT-153).`, params));
    if (blank(line.unitCode)) {
      out.push(fatal("BR-23", "BT-130", `Give line ${where} a unit of measure (BT-130).`, params));
    } else if (!UNIT_CODES.has(line.unitCode)) {
      out.push(fatal("BR-CL-23", "BT-130",
        `Unit "${line.unitCode}" on line ${where} is not a UNECE Recommendation 20 code; map it to a code such as HUR, DAY or EA.`,
        { ...params, unit: line.unitCode }));
    }
    if (isPlainDecimal(line.netPrice) && sign(line.netPrice) < 0) {
      out.push(fatal("BR-27", "BT-146",
        `The net price on line ${where} is negative; state a non-negative price and carry the credit in the quantity or as an allowance.`,
        params));
    }
    if (blank(line.vatCategory)) {
      out.push(fatal("BR-CO-4", "BT-151", `Give line ${where} a VAT category (BT-151).`, params));
    } else if (!profile.taxCategories.includes(line.vatCategory)) {
      out.push(fatal("BR-CL-18", "BT-151", `VAT category "${line.vatCategory}" on line ${where} is not a known code; use S, Z, E, AE, K, G, O, L or M.`,
        { ...params, category: line.vatCategory }));
    }
    if (line.period) {
      if (blank(line.period.start) && blank(line.period.end)) {
        out.push(fatal("BR-CO-20", "BG-26", `Give the period on line ${where} a start date (BT-134), an end date (BT-135) or both, or remove it.`, params));
      } else if (isIsoDate(line.period.start) && isIsoDate(line.period.end) && line.period.end < line.period.start) {
        out.push(fatal("BR-30", "BT-135", `The period on line ${where} ends before it starts; correct the dates.`, params));
      }
    }
  });
  inv.allowanceCharges.forEach((entry, index) => {
    const kind = entry.isCharge ? "charge" : "allowance";
    const params = { index: String(index + 1), kind };
    if (blank(entry.amount)) {
      out.push(fatal(entry.isCharge ? "BR-36" : "BR-31", entry.isCharge ? "BT-99" : "BT-92", `Give document ${kind} ${index + 1} an amount.`, params));
    }
    if (blank(entry.vatCategory)) {
      out.push(fatal(entry.isCharge ? "BR-37" : "BR-32", entry.isCharge ? "BT-102" : "BT-95", `Give document ${kind} ${index + 1} a VAT category.`, params));
    } else if (!profile.taxCategories.includes(entry.vatCategory)) {
      out.push(fatal("BR-CL-17", entry.isCharge ? "BT-102" : "BT-95",
        `VAT category "${entry.vatCategory}" on document ${kind} ${index + 1} is not a known code; use S, Z, E, AE, K, G, O, L or M.`,
        { ...params, category: entry.vatCategory }));
    }
    if (blank(entry.reason) && blank(entry.reasonCode)) {
      out.push(fatal(entry.isCharge ? "BR-38" : "BR-33", entry.isCharge ? "BT-104" : "BT-97",
        `State why document ${kind} ${index + 1} applies, as a reason text or a reason code.`, params));
    }
  });
  return out;
}

function checkTotals(ctx: RuleContext): EInvoiceFinding[] {
  const { inv, decimals } = ctx;
  if (!ctx.numeric) return [];
  const out: EInvoiceFinding[] = [];
  const r = (value: string) => money(value, decimals);
  const t = inv.totals;
  const same = (a: string, b: string) => r(a) === r(b);
  const lineSum = sum(inv.lines.map((line) => r(line.netAmount)));
  const allowanceSum = sum(inv.allowanceCharges.filter((entry) => !entry.isCharge).map((entry) => r(entry.amount)));
  const chargeSum = sum(inv.allowanceCharges.filter((entry) => entry.isCharge).map((entry) => r(entry.amount)));
  const expect = (rule: string, term: string, label: string, stated: string, expected: string, basis: string) => {
    if (!same(stated, expected)) {
      out.push(fatal(rule, term, `${label} (${term}) is ${amountText(ctx, stated)} but must be ${amountText(ctx, expected)}, ${basis}.`,
        { stated: fixed(stated, decimals), expected: fixed(expected, decimals) }));
    }
  };
  expect("BR-CO-10", "BT-106", "The sum of line net amounts", t.lineNet, lineSum, "the sum of the invoice lines");
  expect("BR-CO-11", "BT-107", "The allowance total", t.allowances, allowanceSum, "the sum of the document allowances");
  expect("BR-CO-12", "BT-108", "The charge total", t.charges, chargeSum, "the sum of the document charges");
  expect("BR-CO-13", "BT-109", "The total without VAT", t.taxExclusive, add(add(r(t.lineNet), neg(r(t.allowances))), r(t.charges)),
    "the line total less allowances plus charges");
  expect("BR-CO-14", "BT-110", "The VAT total", t.tax, sum(inv.vatBreakdown.map((group) => r(group.taxAmount))),
    "the sum of the VAT breakdown");
  expect("BR-CO-15", "BT-112", "The total with VAT", t.taxInclusive, add(r(t.taxExclusive), r(t.tax)), "the total without VAT plus VAT");
  expect("BR-CO-16", "BT-115", "The amount due", t.payable, add(add(r(t.taxInclusive), neg(r(t.prepaid))), r(t.rounding)),
    "the total with VAT less the paid amount plus rounding");

  if (inv.vatBreakdown.length === 0) {
    out.push(fatal("BR-CO-18", "BG-23", "Add the VAT breakdown: at least one group per VAT category and rate used on the invoice."));
  }
  if (sign(t.payable) > 0 && blank(inv.dueDate) && blank(inv.payment.terms)) {
    out.push(fatal("BR-CO-25", "BT-9", "An amount is due, so state the payment due date (BT-9) or the payment terms (BT-20)."));
  }
  if (!blank(inv.taxCurrency) && inv.taxCurrency !== inv.currency && blank(inv.taxTotalInTaxCurrency)) {
    out.push(fatal("BR-53", "BT-111", `VAT is accounted for in ${inv.taxCurrency}, so also state the VAT total in ${inv.taxCurrency} (BT-111).`,
      { currency: inv.taxCurrency! }));
  }
  return out;
}

function checkVatBreakdown(ctx: RuleContext): EInvoiceFinding[] {
  const { inv, decimals, profile } = ctx;
  const out: EInvoiceFinding[] = [];
  const r = (value: string) => money(value, decimals);

  for (const group of inv.vatBreakdown) {
    if (blank(group.category)) {
      out.push(fatal("BR-47", "BT-118", "Give every VAT breakdown group a VAT category (BT-118)."));
      continue;
    }
    if (!profile.taxCategories.includes(group.category)) {
      out.push(fatal("BR-CL-17", "BT-118", `VAT breakdown category "${group.category}" is not a known code; use S, Z, E, AE, K, G, O, L or M.`,
        { category: group.category }));
      continue;
    }
    if (blank(group.rate) && group.category !== "O") {
      out.push(fatal("BR-48", "BT-119", `Give the VAT ${group.category} breakdown group a rate (BT-119).`, { category: group.category }));
      continue;
    }
    if (!blank(group.exemptionReasonCode) && !isKnownVatexCode(group.exemptionReasonCode!)) {
      out.push(fatal("BR-CL-22", "BT-121",
        `Exemption reason code ${group.exemptionReasonCode} is not in the CEF VATEX list; use a listed code such as VATEX-EU-AE.`,
        { code: group.exemptionReasonCode! }));
    }
    if (!ctx.numeric) continue;
    const expected = mulPercent(r(group.taxableAmount), rateOf(group.rate), decimals);
    if (!within(r(group.taxAmount), expected, "1")) {
      out.push(fatal("BR-CO-17", "BT-117",
        `The VAT for the ${group.category} ${rateOf(group.rate)}% group is ${amountText(ctx, group.taxAmount)} but must be within one ${inv.currency} of ${amountText(ctx, expected)}, its taxable amount times its rate.`,
        { category: group.category, rate: rateOf(group.rate), stated: fixed(group.taxAmount, decimals), expected: fixed(expected, decimals) }));
    }
    const prefix = vatCategoryRulePrefix(group.category)!;
    if (!TAXED_VAT_CATEGORIES.has(group.category) && sign(group.taxAmount) !== 0) {
      out.push(fatal(`${prefix}-9`, "BT-117",
        `VAT category ${group.category} carries no VAT, so its breakdown tax amount must be 0; it is ${amountText(ctx, group.taxAmount)}.`,
        { category: group.category, stated: fixed(group.taxAmount, decimals) }));
    }
  }

  // BR-x-5 / -6 / -7: the rate each category admits, on lines, allowances and charges.
  const rateFindings = (category: string, rate: string, where: string, slot: "5" | "6" | "7", term: string) => {
    const prefix = vatCategoryRulePrefix(category);
    if (!prefix || !isPlainDecimal(rate)) return;
    const s = sign(rate);
    if (category === "S" && s <= 0) {
      out.push(fatal(`${prefix}-${slot}`, term, `${where} is standard rated, so its VAT rate must be above 0%.`, { where }));
    } else if ((category === "L" || category === "M") && s < 0) {
      out.push(fatal(`${prefix}-${slot}`, term, `${where} is VAT category ${category}, so its VAT rate must be 0% or more.`, { where }));
    } else if (!TAXED_VAT_CATEGORIES.has(category as VatCategory) && s !== 0) {
      out.push(fatal(`${prefix}-${slot}`, term, `${where} is VAT category ${category}, so its VAT rate must be 0%.`, { where, category }));
    }
  };
  for (const line of inv.lines) rateFindings(line.vatCategory, line.vatRate, `Line ${line.id}`, "5", "BT-152");
  inv.allowanceCharges.forEach((entry, index) => {
    rateFindings(entry.vatCategory, entry.vatRate, `Document ${entry.isCharge ? "charge" : "allowance"} ${index + 1}`,
      entry.isCharge ? "7" : "6", entry.isCharge ? "BT-103" : "BT-96");
  });

  // BR-x-1: every category used needs its breakdown group; non-taxed categories exactly one.
  for (const category of usedCategories(inv)) {
    const prefix = vatCategoryRulePrefix(category);
    if (!prefix) continue;
    const count = inv.vatBreakdown.filter((group) => group.category === category).length;
    if (count === 0) {
      out.push(fatal(`${prefix}-1`, "BG-23", `Add a VAT breakdown group for category ${category}, which the invoice uses.`, { category }));
    } else if (count > 1 && !TAXED_VAT_CATEGORIES.has(category as VatCategory)) {
      out.push(fatal(`${prefix}-1`, "BG-23", `Combine the ${count} VAT breakdown groups for category ${category} into exactly one.`,
        { category, count: String(count) }));
    }
  }

  // BR-x-8: each group's taxable amount equals its own lines, charges and allowances.
  if (ctx.numeric) {
    const basis = new Map<string, { category: string; rate: string; parts: string[] }>();
    const contribute = (category: string, rate: string, amount: string) => {
      const key = `${category}|${rateOf(rate)}`;
      const entry = basis.get(key) ?? { category, rate: rateOf(rate), parts: [] };
      entry.parts.push(amount);
      basis.set(key, entry);
    };
    for (const line of inv.lines) contribute(line.vatCategory, line.vatRate, r(line.netAmount));
    for (const entry of inv.allowanceCharges) {
      contribute(entry.vatCategory, entry.vatRate, entry.isCharge ? r(entry.amount) : neg(r(entry.amount)));
    }
    const stated = new Map<string, string[]>();
    for (const group of inv.vatBreakdown) {
      if (!isVatCategory(group.category)) continue;
      const key = `${group.category}|${rateOf(group.rate)}`;
      stated.set(key, [...(stated.get(key) ?? []), r(group.taxableAmount)]);
      if (!basis.has(key)) basis.set(key, { category: group.category, rate: rateOf(group.rate), parts: [] });
    }
    for (const [key, entry] of basis) {
      const prefix = vatCategoryRulePrefix(entry.category);
      if (!prefix) continue;
      const expected = sum(entry.parts);
      const actual = sum(stated.get(key) ?? []);
      if (stated.has(key) && !within(actual, expected, "1")) {
        out.push(fatal(`${prefix}-8`, "BT-116",
          `The VAT ${entry.category} ${entry.rate}% group states a taxable amount of ${amountText(ctx, actual)}, but its lines, allowances and charges add up to ${amountText(ctx, expected)}.`,
          { category: entry.category, rate: entry.rate, stated: fixed(actual, decimals), expected: fixed(expected, decimals) }));
      }
    }
  }

  out.push(...checkExemptionReasons(ctx), ...checkCategoryParties(ctx), ...checkCategorySpecifics(ctx));
  return out;
}

const REASON_REQUIRED: ReadonlySet<string> = new Set(["E", "AE", "K", "G", "O"]);
const REASON_FORBIDDEN: ReadonlySet<string> = new Set(["S", "Z"]);

/** BR-x-10: exempting categories must state why; standard and zero rating must not. */
function checkExemptionReasons({ inv }: RuleContext): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  for (const group of inv.vatBreakdown) {
    const prefix = vatCategoryRulePrefix(group.category);
    if (!prefix) continue;
    const hasReason = !blank(group.exemptionReason) || !blank(group.exemptionReasonCode);
    if (REASON_REQUIRED.has(group.category) && !hasReason) {
      out.push(fatal(`${prefix}-10`, "BT-120",
        `The invoice uses VAT category ${group.category}, so state the VAT exemption reason (BT-120) or exemption reason code (BT-121).`,
        { category: group.category }));
    } else if (REASON_FORBIDDEN.has(group.category) && hasReason) {
      out.push(fatal(`${prefix}-10`, "BT-120",
        `VAT category ${group.category} must not carry an exemption reason; remove it, or use an exempting category such as E.`,
        { category: group.category }));
    }
  }
  return out;
}

/** BR-x-2 / -3 / -4: the party identifiers each category obliges, for lines, allowances and charges. */
function checkCategoryParties({ inv }: RuleContext): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  const seller = inv.seller;
  const buyer = inv.buyer;
  const sellerTaxId = !blank(seller.vatId) || !blank(seller.taxRegistrationId);
  const requirements: Array<{ category: VatCategory; satisfied: boolean; message: string; term: string }> = [
    ...(["S", "Z", "E", "L", "M"] as const).map((category) => ({
      category,
      satisfied: sellerTaxId,
      term: "BT-31",
      message: `The invoice uses VAT category ${category}, so add the seller's VAT identifier (BT-31) or tax registration identifier (BT-32).`,
    })),
    {
      category: "AE",
      satisfied: sellerTaxId && (!blank(buyer.vatId) || !blank(buyer.legalRegistration?.id)),
      term: "BT-48",
      message: "The invoice uses reverse charge (AE), so add the seller's VAT or tax registration identifier and the buyer's VAT identifier (BT-48) or legal registration identifier (BT-47).",
    },
    {
      category: "K",
      satisfied: !blank(seller.vatId) && !blank(buyer.vatId),
      term: "BT-48",
      message: "The invoice uses intra-community supply (K), so add both the seller's VAT identifier (BT-31) and the buyer's VAT identifier (BT-48).",
    },
    {
      category: "G",
      satisfied: !blank(seller.vatId),
      term: "BT-31",
      message: "The invoice uses export outside the EU (G), so add the seller's VAT identifier (BT-31).",
    },
    {
      category: "O",
      satisfied: blank(seller.vatId) && blank(buyer.vatId),
      term: "BT-31",
      message: "The invoice uses not subject to VAT (O), so remove the seller's VAT identifier (BT-31) and the buyer's VAT identifier (BT-48).",
    },
  ];
  for (const requirement of requirements) {
    if (requirement.satisfied) continue;
    const prefix = vatCategoryRulePrefix(requirement.category)!;
    const used = hasCategory(inv, requirement.category);
    const slots: Array<[boolean, string]> = [[used.line, "2"], [used.allowance, "3"], [used.charge, "4"]];
    for (const [present, slot] of slots) {
      if (present) out.push(fatal(`${prefix}-${slot}`, requirement.term, requirement.message, { category: requirement.category }));
    }
  }
  return out;
}

function checkCategorySpecifics({ inv }: RuleContext): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  const used = hasCategory(inv, "K");
  if (used.line || used.allowance || used.charge) {
    if (blank(inv.delivery?.date) && !inv.invoicePeriod) {
      out.push(fatal("BR-IC-11", "BT-72", "The invoice uses intra-community supply (K), so state the actual delivery date (BT-72) or the invoicing period (BG-14)."));
    }
    if (blank(inv.delivery?.address?.countryCode)) {
      out.push(fatal("BR-IC-12", "BT-80", "The invoice uses intra-community supply (K), so state the deliver-to country (BT-80)."));
    }
  }
  if (inv.vatBreakdown.some((group) => group.category === "O")) {
    if (inv.vatBreakdown.some((group) => group.category !== "O")) {
      out.push(fatal("BR-O-11", "BG-23", "A not-subject-to-VAT (O) invoice cannot carry other VAT categories; issue the O items on a separate invoice."));
    }
    if (inv.lines.some((line) => line.vatCategory !== "O")) {
      out.push(fatal("BR-O-12", "BT-151", "A not-subject-to-VAT (O) invoice cannot have lines in another VAT category; issue them on a separate invoice."));
    }
    if (inv.allowanceCharges.some((entry) => !entry.isCharge && entry.vatCategory !== "O")) {
      out.push(fatal("BR-O-13", "BT-95", "A not-subject-to-VAT (O) invoice cannot have allowances in another VAT category."));
    }
    if (inv.allowanceCharges.some((entry) => entry.isCharge && entry.vatCategory !== "O")) {
      out.push(fatal("BR-O-14", "BT-102", "A not-subject-to-VAT (O) invoice cannot have charges in another VAT category."));
    }
  }
  return out;
}

function checkPayment({ inv }: RuleContext): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  const payment = inv.payment;
  const code = payment.meansCode?.trim() ?? "";
  if (!code) {
    out.push(fatal("BR-49", "BT-81", "State the payment means code (BT-81), for example 58 for a SEPA credit transfer."));
  } else if (!isKnownPaymentMeansCode(code)) {
    out.push(fatal("BR-CL-16", "BT-81", `Payment means code ${code} is not in UNTDID 4461; choose a listed code such as 30 or 58.`, { code }));
  }
  const account = payment.creditTransfer?.accountId;
  if (account && paymentAccountRefusal(account, code)) out.push(fatal("OB-PAYMENT-ACCOUNT", "BT-84", paymentAccountRefusal(account, code)!));
  const provider = payment.creditTransfer?.providerId;
  if (provider && paymentProviderRefusal(provider)) out.push(fatal("OB-PAYMENT-PROVIDER", "BT-86", paymentProviderRefusal(provider)!));
  if (payment.creditTransfer && blank(account)) {
    out.push(fatal("BR-50", "BT-84", "The credit transfer details have no account; add the payment account identifier (BT-84), such as an IBAN."));
  }
  if (CREDIT_TRANSFER_MEANS.has(code) && blank(account)) {
    out.push(fatal("BR-61", "BT-84", `Payment means ${code} is a credit transfer, so add the account the buyer pays into (BT-84).`, { code }));
  }
  return out;
}

const EN16931_SET: RuleSet = (ctx) => [
  ...checkHeader(ctx),
  ...checkParties(ctx),
  ...checkLines(ctx),
  ...checkTotals(ctx),
  ...checkVatBreakdown(ctx),
  ...checkPayment(ctx),
];

// ---------------------------------------------------------------------------
// Obligations a profile declares
// ---------------------------------------------------------------------------

function checkDeclaredObligations(ctx: RuleContext, buyerReferenceRule: string): EInvoiceFinding[] {
  const { inv, profile } = ctx;
  const out: EInvoiceFinding[] = [];
  if (profile.businessProcessId === null) {
    out.push(fatal("PEPPOL-EN16931-R001", "BT-23", `${profile.label} requires a business process type (BT-23); choose a profile that declares one.`));
  }
  const hasBuyerReference = !blank(inv.buyerReference);
  const orderSatisfies = profile.orderReferenceSatisfiesBuyerReference && !blank(inv.orderReference);
  if (profile.buyerReferenceRequired && !hasBuyerReference && !orderSatisfies) {
    out.push(fatal(buyerReferenceRule, "BT-10", profile.orderReferenceSatisfiesBuyerReference
      ? `Add the buyer reference (BT-10) or the purchase order reference (BT-13); ${profile.label} requires one of them.`
      : `Add the buyer reference (BT-10), such as the buyer's Leitweg-ID; ${profile.label} requires it.`));
  }
  if (profile.electronicAddressesRequired) {
    if (blank(inv.buyer.electronicAddress?.id)) {
      out.push(fatal("PEPPOL-EN16931-R010", "BT-49", `Add the buyer's electronic address (BT-49) with its scheme; ${profile.label} requires it.`));
    }
    if (blank(inv.seller.electronicAddress?.id)) {
      out.push(fatal("PEPPOL-EN16931-R020", "BT-34", `Add the seller's electronic address (BT-34) with its scheme; ${profile.label} requires it.`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// XRechnung (KoSIT CIUS)
// ---------------------------------------------------------------------------

const XRECHNUNG_TAX_REGISTRATION_CATEGORIES: ReadonlySet<string> = new Set(["S", "Z", "E", "AE", "K", "G", "L", "M"]);
const SKONTO_LINE = /^#SKONTO#TAGE=[0-9]+#PROZENT=[0-9]+\.[0-9]{2}#(BASISBETRAG=-?[0-9]+\.[0-9]{2}#)?$/;

function addressRules(
  address: EInvoiceAddress | null | undefined,
  rules: Array<[string, string, keyof EInvoiceAddress, string]>,
): EInvoiceFinding[] {
  return rules
    .filter(([, , field]) => blank(address?.[field] as string | null | undefined))
    .map(([ruleId, term, , label]) => fatal(ruleId, term, `Add the ${label} (${term}); XRechnung requires it.`));
}

const XRECHNUNG_SET: RuleSet = (ctx) => {
  const { inv, profile } = ctx;
  const out: EInvoiceFinding[] = [];
  const code = inv.payment.meansCode?.trim() ?? "";
  if (!code) out.push(fatal("BR-DE-1", "BG-16", "Add the payment instructions (BG-16) with a payment means code; XRechnung requires them."));

  const contact = inv.seller.contact;
  const contactFields: Array<[string, string, "name" | "phone" | "email", string]> = [
    ["BR-DE-5", "BT-41", "name", "seller contact point"],
    ["BR-DE-6", "BT-42", "phone", "seller contact telephone number"],
    ["BR-DE-7", "BT-43", "email", "seller contact email address"],
  ];
  if (!contact || contactFields.every(([, , field]) => blank(contact[field]))) {
    out.push(fatal("BR-DE-2", "BG-6", "Add the seller contact (BG-6) with a name, telephone number and email address; XRechnung requires it."));
  } else {
    for (const [ruleId, term, field, label] of contactFields) {
      if (blank(contact[field])) out.push(fatal(ruleId, term, `Add the ${label} (${term}); XRechnung requires it.`));
    }
  }
  out.push(...addressRules(inv.seller.address, [["BR-DE-3", "BT-37", "city", "seller city"], ["BR-DE-4", "BT-38", "postcode", "seller post code"]]));
  out.push(...addressRules(inv.buyer.address, [["BR-DE-8", "BT-52", "city", "buyer city"], ["BR-DE-9", "BT-53", "postcode", "buyer post code"]]));
  if (inv.delivery?.address) {
    out.push(...addressRules(inv.delivery.address, [["BR-DE-10", "BT-77", "city", "deliver-to city"], ["BR-DE-11", "BT-78", "postcode", "deliver-to post code"]]));
  }

  out.push(...checkDeclaredObligations(ctx, "BR-DE-15"));

  if ([...usedCategories(inv)].some((category) => XRECHNUNG_TAX_REGISTRATION_CATEGORIES.has(category))
    && blank(inv.seller.vatId) && blank(inv.seller.taxRegistrationId)) {
    out.push(fatal("BR-DE-16", "BT-31",
      "Add the seller's VAT identifier (BT-31) or tax number (BT-32); XRechnung does not accept a company registration number in their place."));
  }

  if (!blank(inv.typeCode) && !profile.allowedTypeCodes.includes(inv.typeCode.trim())) {
    out.push(warning("BR-DE-17", "BT-3",
      `XRechnung expects the invoice type code to be one of ${profile.allowedTypeCodes.join(", ")}; this document says ${inv.typeCode}.`,
      { code: inv.typeCode, codes: profile.allowedTypeCodes.join(", ") }));
  }

  const terms = inv.payment.terms ?? "";
  if (terms.includes("#SKONTO#")) {
    const segments = terms.split("\n");
    const unterminated = segments[segments.length - 1]!;
    const malformed = segments.slice(0, -1).filter((line) => line.includes("#SKONTO#") && !SKONTO_LINE.test(line.trim()));
    if (malformed.length > 0 || unterminated.includes("#SKONTO#")) {
      out.push(fatal("BR-DE-18", "BT-20",
        "Write each cash discount in the payment terms as #SKONTO#TAGE=n#PROZENT=n.nn# (optionally followed by BASISBETRAG=n.nn#) on its own line, ending with a line break.",
        { terms }));
    }
  }

  const account = inv.payment.creditTransfer?.accountId ?? "";
  if (code === "58" && !blank(account) && !validPaymentIban(account)) {
    out.push(warning("BR-DE-19", "BT-84", `Payment means 58 is a SEPA credit transfer, so the account ${account} should be a valid IBAN.`, { account }));
  }

  if (profile.guidelineId !== XRECHNUNG_GUIDELINE) {
    out.push(fatal("BR-DE-21", "BT-24", `The specification identifier must be ${XRECHNUNG_GUIDELINE}; choose an XRechnung 3.0 profile.`));
  }

  const hasTransfer = Boolean(inv.payment.creditTransfer);
  if (CREDIT_TRANSFER_MEANS.has(code) && (!hasTransfer || blank(account))) {
    out.push(fatal("BR-DE-23-a", "BG-17", `Payment means ${code} is a credit transfer, so add the credit transfer details (BG-17) with the account to pay into.`, { code }));
  }
  if (PAYMENT_CARD_MEANS.has(code)) {
    out.push(fatal("BR-DE-24-a", "BG-18",
      `Payment means ${code} is a card payment, which requires card details (BG-18) this document cannot carry; choose a credit transfer code (30 or 58).`, { code }));
    if (hasTransfer) {
      out.push(fatal("BR-DE-24-b", "BG-17", `Payment means ${code} is a card payment, so remove the credit transfer details (BG-17).`, { code }));
    }
  }
  if (DIRECT_DEBIT_MEANS.has(code)) {
    out.push(fatal("BR-DE-25-a", "BG-19",
      `Payment means ${code} is a direct debit, which requires mandate details (BG-19) this document cannot carry; choose a credit transfer code (30 or 58).`, { code }));
    if (hasTransfer) {
      out.push(fatal("BR-DE-25-b", "BG-17", `Payment means ${code} is a direct debit, so remove the credit transfer details (BG-17).`, { code }));
    }
  }

  if (inv.typeCode.trim() === "384" && inv.precedingInvoices.length === 0) {
    out.push(warning("BR-DE-26", "BG-3", "A corrected invoice (384) should reference the invoice it corrects (BG-3)."));
  }
  const phone = contact?.phone?.trim() ?? "";
  if (phone && (phone.match(/\d/g)?.length ?? 0) < 3) {
    out.push(warning("BR-DE-27", "BT-42", `The seller telephone number "${phone}" should contain at least three digits.`, { phone }));
  }
  const email = contact?.email?.trim() ?? "";
  if (email && !plausibleEmail(email)) {
    out.push(warning("BR-DE-28", "BT-43",
      `The seller email address "${email}" should contain exactly one @ with at least two characters on each side, and no dot next to the @ or at either end.`,
      { email }));
  }
  return out;
};

function plausibleEmail(value: string): boolean {
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  if (local.length < 2 || domain.length < 2) return false;
  if (/[\s.]$/.test(local) || /^[\s.]/.test(domain)) return false;
  return !value.startsWith(".") && !value.endsWith(".");
}

// ---------------------------------------------------------------------------
// Peppol BIS Billing 3.0
// ---------------------------------------------------------------------------

const PEPPOL_SET: RuleSet = (ctx) => {
  const { inv, profile } = ctx;
  const out: EInvoiceFinding[] = [];
  if (profile.guidelineId !== PEPPOL_BIS_GUIDELINE) {
    out.push(fatal("PEPPOL-EN16931-R004", "BT-24", `The specification identifier must be ${PEPPOL_BIS_GUIDELINE}; choose the Peppol BIS Billing 3.0 profile.`));
  }
  if (inv.notes.filter((note) => !blank(note)).length > 1) {
    out.push(fatal("PEPPOL-EN16931-R002", "BT-22", "Combine the invoice notes into one; Peppol allows a single document note."));
  }
  out.push(...checkDeclaredObligations(ctx, "PEPPOL-EN16931-R003"));
  if (!blank(inv.taxCurrency) && inv.taxCurrency === inv.currency) {
    out.push(fatal("PEPPOL-EN16931-R005", "BT-6", "Remove the VAT accounting currency (BT-6), or set it to a currency other than the invoice currency."));
  }
  if (blank(inv.taxCurrency) && !blank(inv.taxTotalInTaxCurrency)) {
    out.push(fatal("PEPPOL-EN16931-R054", "BT-111", "A VAT total in the VAT accounting currency (BT-111) requires the VAT accounting currency (BT-6); add the currency or remove the amount."));
  }
  if (ctx.numeric && !blank(inv.taxTotalInTaxCurrency) && sign(inv.taxTotalInTaxCurrency!) * sign(inv.totals.tax) < 0) {
    out.push(fatal("PEPPOL-EN16931-R055", "BT-111", "The VAT total (BT-110) and the VAT total in the accounting currency (BT-111) must have the same sign."));
  }

  if (ctx.numeric) {
    inv.allowanceCharges.forEach((entry, index) => {
      const kind = entry.isCharge ? "charge" : "allowance";
      const params = { index: String(index + 1), kind };
      const hasBase = !blank(entry.baseAmount);
      const hasPercent = !blank(entry.percent);
      if (hasBase && hasPercent && !percentOfWithin(entry.amount, entry.baseAmount!, entry.percent!, "0.02")) {
        out.push(fatal("PEPPOL-EN16931-R040", entry.isCharge ? "BT-99" : "BT-92",
          `Document ${kind} ${index + 1} is ${entry.amount}, but its base ${entry.baseAmount} at ${entry.percent}% gives ${fixed(mulPercent(money(entry.baseAmount!, ctx.decimals), entry.percent!, ctx.decimals), ctx.decimals)}; correct the amount, base or percentage.`,
          params));
      }
      if (hasPercent && !hasBase) {
        out.push(fatal("PEPPOL-EN16931-R041", entry.isCharge ? "BT-100" : "BT-93", `Document ${kind} ${index + 1} states a percentage, so also state its base amount.`, params));
      }
      if (hasBase && !hasPercent) {
        out.push(fatal("PEPPOL-EN16931-R042", entry.isCharge ? "BT-101" : "BT-94", `Document ${kind} ${index + 1} states a base amount, so also state its percentage.`, params));
      }
    });
  }

  const period = inv.invoicePeriod;
  for (const line of inv.lines) {
    const params = { line: line.id };
    if (period && line.period) {
      if (isIsoDate(period.start) && isIsoDate(line.period.start) && line.period.start < period.start) {
        out.push(fatal("PEPPOL-EN16931-R110", "BT-134", `The period on line ${line.id} starts before the invoicing period; move its start date inside the invoicing period.`, params));
      }
      if (isIsoDate(period.end) && isIsoDate(line.period.end) && line.period.end > period.end) {
        out.push(fatal("PEPPOL-EN16931-R111", "BT-135", `The period on line ${line.id} ends after the invoicing period; move its end date inside the invoicing period.`, params));
      }
    }
    if (!ctx.numeric) continue;
    const base = blank(line.baseQuantity) ? "1" : line.baseQuantity!;
    if (!blank(line.baseQuantity) && sign(line.baseQuantity!) <= 0) {
      out.push(fatal("PEPPOL-EN16931-R121", "BT-149", `The price base quantity on line ${line.id} must be greater than zero.`, params));
    } else if (!productWithin(line.netAmount, line.quantity, line.netPrice, base, "0.02")) {
      out.push(fatal("PEPPOL-EN16931-R120", "BT-131",
        `The net amount on line ${line.id} is ${line.netAmount}, but quantity ${line.quantity} at price ${line.netPrice} per ${base} gives a different amount; correct the quantity, price or amount.`,
        params));
    }
  }

  const typeCode = inv.typeCode.trim();
  if (typeCode) {
    if (isCreditNoteTypeCode(typeCode)) {
      if (!profile.allowedTypeCodes.includes(typeCode)) {
        out.push(fatal("PEPPOL-EN16931-P0101", "BT-3",
          `Credit note type code ${typeCode} is not allowed in Peppol; use one of ${PEPPOL_CREDIT_NOTE_TYPE_CODES.join(", ")}.`, { code: typeCode }));
      }
    } else if (!profile.allowedTypeCodes.includes(typeCode)) {
      out.push(fatal("PEPPOL-EN16931-P0100", "BT-3",
        `Invoice type code ${typeCode} (${DOCUMENT_TYPE_LABELS[typeCode] ?? "unlisted"}) is not allowed in Peppol; use a Peppol invoice type code such as 380.`,
        { code: typeCode }));
    }
  }

  for (const [party, role, term] of [[inv.seller, "seller", "BT-34"], [inv.buyer, "buyer", "BT-49"]] as const) {
    const scheme = party.electronicAddress?.schemeId;
    if (party.electronicAddress && !blank(scheme) && !isKnownEasScheme(scheme!)) {
      out.push(fatal("PEPPOL-EN16931-CL008", term, `Electronic address scheme ${scheme} for the ${role} is not in the Peppol EAS code list; choose a listed scheme.`,
        { party: role, scheme: scheme! }));
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Peppol national rules for the Netherlands (NLCIUS on Peppol)
// ---------------------------------------------------------------------------

/** Legal registration schemes the Dutch rules accept: KvK (0106) and OIN (0190). */
const NL_REGISTRATION_SCHEMES: readonly string[] = ["0106", "0190"];
const NL_INVOICE_MEANS: readonly string[] = ["30", "48", "49", "57", "58", "59"];

const PEPPOL_NL_SET: RuleSet = (ctx) => {
  const { inv, country } = ctx;
  const out: EInvoiceFinding[] = [];
  const creditNote = isCreditNoteTypeCode(inv.typeCode);
  if (creditNote && inv.precedingInvoices.length === 0) {
    out.push(fatal("NL-R-001", "BG-3", "A credit note from a Dutch supplier must reference the invoice it credits (BT-25)."));
  }
  const address = (party: EInvoiceParty, ruleId: string, role: string) => {
    const missing = (["line1", "city", "postcode"] as const).filter((field) => blank(party.address[field]));
    if (missing.length > 0) {
      out.push(fatal(ruleId, role === "seller" ? "BG-5" : "BG-8",
        `Add the ${role}'s street, city and post code; Dutch rules require a complete ${role} address.`, { party: role }));
    }
  };
  const registration = (party: EInvoiceParty, ruleId: string, role: string) => {
    const scheme = party.legalRegistration?.schemeId ?? "";
    if (blank(party.legalRegistration?.id) || !NL_REGISTRATION_SCHEMES.includes(scheme)) {
      out.push(fatal(ruleId, role === "seller" ? "BT-30" : "BT-47",
        `Give the ${role}'s legal registration identifier as a KvK number (scheme 0106) or OIN (scheme 0190).`,
        { party: role, scheme }));
    }
  };
  address(inv.seller, "NL-R-002", "seller");
  registration(inv.seller, "NL-R-003", "seller");
  if (country !== null && inv.buyer.address.countryCode === country) {
    address(inv.buyer, "NL-R-004", "buyer");
    registration(inv.buyer, "NL-R-005", "buyer");
  }
  const code = inv.payment.meansCode?.trim() ?? "";
  if (!creditNote) {
    if (!code) {
      out.push(fatal("NL-R-007", "BG-16", "Add the payment means; Dutch rules require it on an invoice."));
    } else if (!NL_INVOICE_MEANS.includes(code)) {
      out.push(fatal("NL-R-008", "BT-81", `Payment means ${code} is not accepted on a Dutch invoice; use one of ${NL_INVOICE_MEANS.join(", ")}.`, { code }));
    }
  }
  if (blank(inv.orderReference) && inv.lines.some((line) => !blank(line.orderLineReference))) {
    out.push(fatal("NL-R-009", "BT-13", "Lines reference purchase order lines, so add the purchase order reference (BT-13)."));
  }
  return out;
};

// ---------------------------------------------------------------------------
// House advisories
// ---------------------------------------------------------------------------

const HOUSE_SET: RuleSet = (ctx) => {
  const { inv } = ctx;
  const out: EInvoiceFinding[] = [];
  const code = inv.payment.meansCode?.trim() ?? "";
  if (blank(inv.payment.creditTransfer?.accountId) && !PAYMENT_CARD_MEANS.has(code) && !DIRECT_DEBIT_MEANS.has(code)) {
    out.push(warning("OB-PAY-01", "BT-84", "No payment account is given, so the buyer cannot pay this invoice automatically; add the account to pay into."));
  }
  if (
    ctx.numeric &&
    !isCreditNoteTypeCode(inv.typeCode) &&
    inv.lines.length > 0 &&
    inv.lines.every((line) => line.vatCategory === "Z") &&
    compare(inv.totals.taxExclusive, "0") > 0 &&
    inv.vatBreakdown.every((group) => blank(group.exemptionReason) && blank(group.exemptionReasonCode))
  ) {
    out.push(warning("OB-VAT-01", "BT-118",
      "Every line is zero rated (Z) with no VAT charged; confirm the supply is zero rated, or state the VAT rate or an exempting category."));
  }
  return out;
};

const RULE_SETS: Readonly<Record<EInvoiceRuleSetId, RuleSet>> = {
  en16931: EN16931_SET,
  xrechnung: XRECHNUNG_SET,
  peppol: PEPPOL_SET,
  "peppol-nl": PEPPOL_NL_SET,
  nlcius: (ctx) => validateNlcIusRules(ctx.inv),
  norway: (ctx) => validateNorwegianRules(ctx.inv),
  "gst-shared": (ctx) => [
    ...checkHeader(ctx),
    ...checkParties(ctx).filter((entry) => entry.ruleId !== "BR-CO-9"),
    ...checkLines(ctx), ...checkTotals(ctx),
    ...checkPayment(ctx).filter((entry) => entry.ruleId !== "BR-CL-16" || !["Z01", "Z02"].includes(ctx.inv.payment.meansCode) || !ctx.profile.ruleSets.includes("sg")),
    ...PEPPOL_SET(ctx).filter((entry) => !["PEPPOL-EN16931-R004", "PEPPOL-EN16931-R002"].includes(entry.ruleId)),
    ...(ctx.numeric ? validateGstBreakdown(ctx.inv, ctx.profile) : []),
  ],
  aunz: (ctx) => validateAunzRules(ctx.inv, ctx.profile),
  sg: (ctx) => validateSingaporeRules(ctx.inv, ctx.profile),
  house: HOUSE_SET,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate every rule the invoice's profile declares. Returns all findings,
 * fatal and warning alike, in a stable order; an empty list means the
 * document passes every rule implemented here.
 */
export function validateEInvoice(inv: EInvoice): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  let profile = getEInvoiceProfile(inv.profile);
  if (!profile) {
    out.push(fatal("BR-1", "BT-24", `"${String(inv.profile)}" is not a supported e-invoice profile; choose one of ${Object.keys(EINVOICE_PROFILES).join(", ")}.`,
      { profile: String(inv.profile) }));
    profile = EINVOICE_PROFILES["en16931-cii"];
  }
  const shape = checkShape(inv);
  out.push(...shape.findings);
  const base: RuleContext = { inv, profile, decimals: shape.decimals, numeric: shape.numeric, country: null };
  for (const id of profile.ruleSets) out.push(...RULE_SETS[id](base));
  const sellerCountry = inv.seller.address.countryCode;
  const national = Object.hasOwn(profile.nationalRuleSets, sellerCountry) ? profile.nationalRuleSets[sellerCountry] : undefined;
  if (national && !profile.ruleSets.includes(national)) {
    out.push(...RULE_SETS[national]({ ...base, country: sellerCountry }));
  }
  return out;
}

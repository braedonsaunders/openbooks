/** National invoice rules over the native model. Source editions are pinned in standards/README.md. */
import { add, mulPercent, neg, sum } from "../money/money.ts";
import { compare, isPlainDecimal, money, rateKey, within } from "./decimal.ts";
import type { EInvoice, EInvoiceParty } from "./model.ts";
import type { EInvoiceProfile } from "./profiles.ts";
import type { EInvoiceFinding } from "./rules.ts";

const present = (value: string | null | undefined) => typeof value === "string" && value.trim() !== "";
function fatal(ruleId: string, term: string, message: string): EInvoiceFinding {
  return { ruleId, term, message, severity: "fatal", params: {} };
}
function warning(ruleId: string, term: string, message: string): EInvoiceFinding {
  return { ruleId, term, message, severity: "warning", params: {} };
}

/** GS1 check digit for a GLN/NZBN; identifiers remain strings, including leading zeroes. */
export function validGln(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  const digits = [...value].map(Number);
  return (10 - digits.slice(0, 12).reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0) % 10) % 10 === digits[12];
}
export function validAbn(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  const digits = [...value].map(Number);
  digits[0] = digits[0]! - 1;
  return digits.reduce((total, digit, index) => total + digit * [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19][index]!, 0) % 89 === 0;
}
export function validNorwegianOrganizationNumber(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const remainder = digits.slice(0, 8).reduce((total, digit, index) => total + digit * [3, 2, 7, 6, 5, 4, 3, 2][index]!, 0) % 11;
  const check = remainder === 0 ? 0 : 11 - remainder;
  return check !== 10 && check === digits[8];
}

export function validateNorwegianRules(inv: EInvoice): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  if (inv.seller.address.countryCode === "NO" && present(inv.seller.vatId)) {
    const id = inv.seller.vatId!;
    if (!/^NO\d{9}MVA$/.test(id) || !validNorwegianOrganizationNumber(id.slice(2, 11))) out.push(fatal("NO-R-001", "BT-31", "State the Norwegian VAT identifier as NO, a valid nine-digit organization number, and MVA."));
  }
  for (const party of [inv.seller, inv.buyer]) {
    for (const id of [party.electronicAddress, party.legalRegistration, party.identifier]) {
      if (id?.schemeId === "0192" && !validNorwegianOrganizationNumber(id.id)) out.push(fatal("PEPPOL-COMMON-R041", "BT-34", "The Norwegian organization identifier must contain nine digits with a valid modulus 11 check digit."));
    }
  }
  return out;
}

export function validateNlcIusRules(inv: EInvoice): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  if (inv.lines.some((line) => present(line.orderLineReference)) && !present(inv.orderReference)) out.push(fatal("BR-NL-13", "BT-13", "Add the document purchase order reference when invoice lines refer to order lines."));
  if (inv.seller.address.countryCode !== "NL") return out;
  const registration = (party: EInvoiceParty, rule: string, term: string) => {
    if (!present(party.legalRegistration?.id) || !["0106", "0190"].includes(party.legalRegistration?.schemeId ?? "")) out.push(fatal(rule, term, "State a KvK identifier with scheme 0106 or an OIN identifier with scheme 0190."));
  };
  const address = (party: EInvoiceParty, rule: string, term: string) => {
    if (![party.address.line1, party.address.city, party.address.postcode].every(present)) out.push(fatal(rule, term, "Complete the Dutch postal address with street, city and postcode."));
  };
  registration(inv.seller, "BR-NL-1", "BT-30");
  if (!present(inv.buyerReference) && !present(inv.orderReference)) out.push(fatal("BR-NL-2", "BT-10", "Add a buyer reference or purchase order reference."));
  address(inv.seller, "BR-NL-3", "BG-5");
  if (inv.buyer.address.countryCode === "NL") {
    address(inv.buyer, "BR-NL-4", "BG-8");
    registration(inv.buyer, "BR-NL-10", "BT-47");
  }
  if (!["380", "381", "384", "389"].includes(inv.typeCode)) out.push(fatal("BR-NL-7", "BT-3", "NLCIUS permits invoice types 380, 381, 384 and 389."));
  if (inv.typeCode === "384" && inv.precedingInvoices.length === 0) out.push(fatal("BR-NL-9", "BG-3", "A corrective invoice must reference the invoice it corrects."));
  if (!["30", "48", "49", "57", "58", "59"].includes(inv.payment.meansCode)) out.push(fatal("BR-NL-12", "BT-81", "Use payment means 30, 48, 49, 57, 58 or 59 for a Dutch supplier."));
  if (present(inv.taxCurrency)) out.push(warning("BR-NL-19", "BT-6", "NLCIUS discourages a separate tax accounting currency."));
  if (present(inv.taxPointDate)) out.push(warning("BR-NL-20", "BT-7", "NLCIUS receivers may ignore the tax point date."));
  if (present(inv.seller.taxRegistrationId)) out.push(warning("BR-NL-25", "BT-32", "For Dutch suppliers use the VAT identifier as the tax registration."));
  return out;
}

export function validateAunzRules(inv: EInvoice, profile: EInvoiceProfile): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  for (const [party, role, term, auRule, nzRule] of [
    [inv.seller, "seller", "BT-30", "aligned-ibr-001-aunz", "aligned-ibr-002-aunz"],
    [inv.buyer, "buyer", "BT-47", "aligned-ibr-004-aunz", "aligned-ibr-005-aunz"],
  ] as const) {
    const country = party.address.countryCode;
    if (country === "AU" && (!present(party.legalRegistration?.id) || party.legalRegistration?.schemeId !== "0151")) out.push(fatal(auRule, term, `Add the ${role}'s Australian Business Number using scheme 0151.`));
    if (country === "NZ" && (!present(party.legalRegistration?.id) || party.legalRegistration?.schemeId !== "0088")) out.push(fatal(nzRule, term, `Add the ${role}'s New Zealand Business Number using scheme 0088.`));
    for (const id of [party.legalRegistration, party.electronicAddress, party.identifier]) {
      if (id?.schemeId === "0151" && !validAbn(id.id)) out.push(fatal("OB-ABN-01", term, `Correct the ${role}'s ABN; it must contain eleven digits with a valid check value.`));
      if (id?.schemeId === "0088" && !validGln(id.id)) out.push(fatal("IBR-068", term, `Correct the ${role}'s GS1 identifier; it must contain thirteen digits with a valid check digit.`));
    }
  }
  if (profile.key === "peppol-aunz") out.push(warning("OB-PROFILE-01", "BT-24", "This is the legacy A-NZ BIS specification; use PINT A-NZ for receivers requiring the current specification."));
  return out;
}

const SG_REGISTERED_CATEGORIES = new Set(["SR", "SRCA-S", "SRCA-C", "ZR", "SRRC", "SROVR-RS", "SROVR-LVG", "SRLVG", "NA"]);
export function validateSingaporeRules(inv: EInvoice, profile: EInvoiceProfile): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  const categories = [...inv.lines.map((line) => line.vatCategory), ...inv.allowanceCharges.map((entry) => entry.vatCategory)];
  const registered = categories.some((category) => SG_REGISTERED_CATEGORIES.has(category));
  if (present(inv.uuid) && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(inv.uuid!)) out.push(fatal("BR-109-GST-SG", "BT-SG-003", "Use a UUID in the standard 8-4-4-4-12 hexadecimal format."));
  if (registered) {
    if (!present(inv.seller.vatId)) out.push(fatal("BR-105-GST-SG", "BT-31", "Add the seller's GST registration identifier."));
    if (!present(inv.seller.address.line1) || !present(inv.seller.address.postcode)) out.push(fatal("BR-106-GST-SG", "BG-5", "Add the seller's street address and postcode."));
    if (!present(inv.buyer.address.line1) || !present(inv.buyer.address.postcode)) out.push(fatal("BR-107-GST-SG", "BG-8", "Add the buyer's street address and postcode."));
    if (!present(inv.uuid)) out.push(fatal("BR-108-GST-SG", "BT-SG-003", "Supply the invoice UUID from its native document identity."));
    if (!present(inv.seller.legalRegistration?.id)) out.push(fatal("BR-112-GST-SG", "BT-30", "Add the seller's legal registration identifier."));
    if ((inv.currency === "SGD" && present(inv.taxCurrency)) || (inv.currency !== "SGD" && inv.taxCurrency !== "SGD")) out.push(fatal("BR-113-GST-SG", "BT-6", "For a foreign-currency Singapore invoice set the accounting currency to SGD; omit it for an SGD invoice."));
    if (inv.typeCode === "381" && !inv.notes.some(present)) out.push(fatal("BR-111-GST-SG", "BT-22", "State the reason for the credit in the credit-note text."));
  }
  if (categories.includes("NG")) {
    if (present(inv.seller.vatId) || present(inv.buyer.vatId)) out.push(fatal("BR-NG-02-GST-SG", "BT-31", "Non-GST-registered invoices must omit seller and buyer GST identifiers."));
    if (categories.some((category) => category !== "NG") || inv.vatBreakdown.some((group) => group.category !== "NG")) out.push(fatal("BR-NG-11-GST-SG", "BG-23", "An NG invoice must contain only non-GST-registered lines, allowances, charges and breakdowns."));
  }
  if (present(inv.taxCurrency) && (!inv.accountingCurrencyTotals || !present(inv.taxTotalInTaxCurrency))) out.push(fatal("BR-53-GST-SG", "BT-111", "Supply the GST amount and both inclusive and exclusive totals in SGD using the posted accounting-currency figures."));
  if (!present(inv.taxCurrency) && inv.accountingCurrencyTotals) out.push(fatal("BR-110-GST-SG", "BT-6", "Accounting-currency totals require an accounting currency."));
  if (inv.accountingCurrencyTotals) {
    const t = inv.accountingCurrencyTotals;
    if (![t.taxExclusive, t.taxInclusive, inv.taxTotalInTaxCurrency].every(isPlainDecimal)) out.push(fatal("OB-SG-01", "BT-111", "The SGD totals and GST amount must be exact decimal strings."));
    else if (compare(t.taxInclusive, add(t.taxExclusive, inv.taxTotalInTaxCurrency!)) !== 0) out.push(fatal("OB-SG-02", "BT-111", "The SGD inclusive total must equal the SGD exclusive total plus the SGD GST amount."));
  }
  if (profile.key === "peppol-sg") out.push(warning("OB-PROFILE-01", "BT-24", "This is the legacy Singapore BIS specification; use PINT Singapore for receivers requiring the current specification."));
  return out;
}

/** Exact taxable bases and tax totals; no international VAT identifier or exemption policy is imposed on GST. */
export function validateGstBreakdown(inv: EInvoice, profile: EInvoiceProfile): EInvoiceFinding[] {
  const out: EInvoiceFinding[] = [];
  const seen = new Set<string>();
  const sg = profile.ruleSets.includes("sg");
  if (!sg && inv.vatBreakdown.some((group) => group.category === "O") && inv.vatBreakdown.some((group) => group.category !== "O")) out.push(fatal("aligned-ibrp-o-11-aunz", "BG-23", "An outside-scope GST invoice must not contain other tax categories."));
  for (const group of inv.vatBreakdown) {
    if (!profile.taxCategories.includes(group.category)) { out.push(fatal(sg ? "BR-CL-17-GST-SG" : "aligned-ibrp-cl-01-aunz", "BT-118", "Choose a tax category defined by the selected GST specification.")); continue; }
    const rate = rateKey(group.rate || "0");
    const key = `${group.category}|${rate}`;
    if (seen.has(key)) out.push(fatal("OB-GST-01", "BG-23", "Combine duplicate tax breakdowns for the same category and rate."));
    seen.add(key);
    const matches = (category: string, value: string) => category === group.category && rateKey(value || "0") === rate;
    const parts = inv.lines.filter((line) => matches(line.vatCategory, line.vatRate)).map((line) => line.netAmount);
    for (const entry of inv.allowanceCharges.filter((entry) => matches(entry.vatCategory, entry.vatRate))) parts.push(entry.isCharge ? entry.amount : neg(entry.amount));
    if (compare(group.taxableAmount, sum(parts)) !== 0) out.push(fatal("OB-GST-02", "BT-116", "The GST taxable base must reconcile with lines and document allowances and charges in its category and rate."));
    const expected = mulPercent(money(group.taxableAmount, inv.currencyDecimals), rate, inv.currencyDecimals);
    if (!within(group.taxAmount, expected, sg ? "1.99" : "1")) out.push(fatal(sg ? "BR-CO-17-GST-SG" : "aligned-ibrp-051-aunz", "BT-117", "The GST amount does not agree with its taxable base and rate within the specification tolerance."));
    if (["Z", "E", "G", "O", "ZR", "ES33", "ESN33", "OS", "NA", "NG"].includes(group.category) && (compare(group.taxAmount, "0") !== 0 || compare(rate, "0") !== 0)) out.push(fatal("OB-GST-03", "BT-117", "The selected tax-free GST category must carry zero tax and a zero rate."));
    if (group.category === "S" && compare(rate, "0") <= 0) out.push(fatal("aligned-ibrp-s-05-aunz", "BT-119", "Standard-rated GST must have a positive rate."));
    if (["S", "Z"].includes(group.category) && (present(group.exemptionReason) || present(group.exemptionReasonCode))) out.push(fatal(group.category === "S" ? "aligned-ibrp-s-10-aunz" : "aligned-ibrp-z-10-aunz", "BT-120", "Standard and zero-rated GST breakdowns must omit exemption reasons."));
  }
  for (const entry of [...inv.lines.map((line) => ({ category: line.vatCategory, rate: line.vatRate })), ...inv.allowanceCharges.map((entry) => ({ category: entry.vatCategory, rate: entry.vatRate }))]) {
    if (!seen.has(`${entry.category}|${rateKey(entry.rate || "0")}`)) out.push(fatal("OB-GST-04", "BG-23", "Add a GST breakdown for every tax category and rate used on the invoice."));
    if (compare(entry.rate || "0", "0") < 0) out.push(fatal("OB-GST-05", "BT-152", "GST rates cannot be negative."));
  }
  return out;
}

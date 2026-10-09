// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * The EN 16931-1 semantic model of an electronic invoice, independent of
 * syntax. Writers render it as UN/CEFACT CII or OASIS UBL; the rule
 * evaluator judges it against the same business rules a receiver's
 * validator applies. Field comments cite the business terms (BT) and groups
 * (BG) of EN 16931-1.
 *
 * Every amount is an exact decimal string, never a float. Dates are ISO
 * `YYYY-MM-DD`.
 */

import { add, isZero, mulPercent, neg, sum } from "../money/money.ts";
import { TAXED_VAT_CATEGORIES, vatCategoryOrder } from "./codes.ts";
import { compare, money, rateKey } from "./decimal.ts";
import type { EInvoiceProfileKey } from "./profiles.ts";

export type { EInvoiceProfileKey } from "./profiles.ts";

export type VatCategory = "S" | "Z" | "E" | "AE" | "K" | "G" | "O" | "L" | "M"
  | "SR" | "SRCA-S" | "SRCA-C" | "ZR" | "ES33" | "ESN33" | "DS" | "OS" | "NA" | "NG" | "SRRC" | "SROVR-RS" | "SROVR-LVG" | "SRLVG";

/** BG-5 / BG-8 / BG-15. `countryCode` is "" when unknown so BR-9 / BR-11 can say so; it is never guessed. */
export interface EInvoiceAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  postcode?: string | null;
  subdivision?: string | null;
  countryCode: string;
}

export interface EInvoiceParty {
  name: string;                         // BT-27 / BT-44
  identifier?: { id: string; schemeId?: string | null } | null; // BT-29 / BT-46
  tradingName?: string | null;          // BT-28 / BT-45
  address: EInvoiceAddress;             // BG-5 / BG-8
  vatId?: string | null;                // BT-31 / BT-48
  taxRegistrationId?: string | null;    // BT-32 (seller only)
  legalRegistration?: { id: string; schemeId?: string | null } | null; // BT-30 / BT-47
  electronicAddress?: { id: string; schemeId: string } | null;        // BT-34 / BT-49 + EAS scheme
  contact?: { name?: string | null; phone?: string | null; email?: string | null } | null; // BG-6 / BG-9
}

export interface EInvoiceLine {
  id: string;                    // BT-126
  name: string;                  // BT-153
  description?: string | null;   // BT-154
  sellerItemId?: string | null;  // BT-155
  buyerItemId?: string | null;   // BT-156
  note?: string | null;          // BT-127
  quantity: string;              // BT-129, may be negative
  unitCode: string;              // BT-130, UNECE Rec 20
  netPrice: string;              // BT-146, must be >= 0 (BR-27)
  baseQuantity?: string | null;  // BT-149
  netAmount: string;             // BT-131, at document precision
  vatCategory: VatCategory;      // BT-151
  vatRate: string;               // BT-152 percent
  period?: { start: string; end: string } | null; // BG-26
  orderLineReference?: string | null;             // BT-132
  accountingReference?: string | null;            // BT-133
}

/** BG-20 (allowance) / BG-21 (charge) at document level. */
export interface EInvoiceAllowanceCharge {
  isCharge: boolean;
  amount: string;               // BT-92 / BT-99
  baseAmount?: string | null;   // BT-93 / BT-100
  percent?: string | null;      // BT-94 / BT-101
  reason?: string | null;       // BT-97 / BT-104
  reasonCode?: string | null;   // BT-98 / BT-105
  vatCategory: VatCategory;     // BT-95 / BT-102
  vatRate: string;              // BT-96 / BT-103
}

/** BG-23. */
export interface EInvoiceVatBreakdown {
  category: VatCategory;                // BT-118
  rate: string;                         // BT-119
  taxableAmount: string;                // BT-116
  taxAmount: string;                    // BT-117
  exemptionReason?: string | null;      // BT-120
  exemptionReasonCode?: string | null;  // BT-121
}

export interface EInvoicePayment {
  meansCode: string;                     // BT-81 (UNTDID 4461)
  meansText?: string | null;             // BT-82
  remittanceInformation?: string | null; // BT-83
  creditTransfer?: { accountId: string; accountName?: string | null; providerId?: string | null } | null; // BG-17
  terms?: string | null;                 // BT-20
}

/** BG-22. */
export interface EInvoiceTotals {
  lineNet: string;       // BT-106
  allowances: string;    // BT-107
  charges: string;       // BT-108
  taxExclusive: string;  // BT-109
  tax: string;           // BT-110
  taxInclusive: string;  // BT-112
  prepaid: string;       // BT-113
  rounding: string;      // BT-114
  payable: string;       // BT-115
}

export interface EInvoice {
  profile: EInvoiceProfileKey;
  uuid?: string | null;            // Singapore unique invoice identifier
  accountingCurrencyTotals?: { taxExclusive: string; taxInclusive: string } | null; // Singapore SGD totals
  number: string;                 // BT-1
  typeCode: string;               // BT-3
  issueDate: string;              // BT-2
  dueDate?: string | null;        // BT-9
  taxPointDate?: string | null;   // BT-7
  currency: string;               // BT-5
  /** Decimals amounts are written with: min(ISO minor units, 2), resolved by the caller. */
  currencyDecimals: number;
  taxCurrency?: string | null;            // BT-6
  taxTotalInTaxCurrency?: string | null;  // BT-111
  buyerReference?: string | null;     // BT-10
  projectReference?: string | null;   // BT-11
  contractReference?: string | null;  // BT-12
  orderReference?: string | null;     // BT-13
  salesOrderReference?: string | null; // BT-14
  precedingInvoices: Array<{ number: string; issueDate?: string | null }>; // BG-3
  notes: string[];                     // BT-22
  seller: EInvoiceParty;
  buyer: EInvoiceParty;
  delivery?: { date?: string | null; address?: EInvoiceAddress | null; locationName?: string | null } | null; // BT-72, BG-15, BT-70
  invoicePeriod?: { start: string; end: string } | null; // BG-14
  payment: EInvoicePayment;
  lines: EInvoiceLine[];
  allowanceCharges: EInvoiceAllowanceCharge[];
  vatBreakdown: EInvoiceVatBreakdown[];
  totals: EInvoiceTotals;
}

export interface EInvoiceAmountsInput {
  lines: EInvoiceLine[];
  allowanceCharges: EInvoiceAllowanceCharge[];
  currencyDecimals: number;
  /** Tax as posted, per (category, rate). It may differ from basis × rate by per-line rounding. */
  statedTax?: Array<{ category: VatCategory; rate: string; taxAmount: string }>;
  exemptions?: Array<{ category: VatCategory; reason?: string | null; reasonCode?: string | null }>;
  prepaid?: string;
  rounding?: string;
}

function groupKey(category: string, rate: string): string {
  return `${category}|${rateKey(rate)}`;
}

/**
 * Derive the VAT breakdown (BG-23) and document totals (BG-22) from lines and
 * document-level allowances and charges.
 *
 * Each (category, rate) group's taxable amount is the sum of its line nets
 * and charges less its allowances. Its tax is the caller's stated (posted)
 * tax when supplied, otherwise basis × rate rounded half away from zero.
 * Without a stated amount, categories other than S, L and M carry zero tax;
 * a stated non-zero amount on such a category is kept as posted so BR-x-9
 * refuses it rather than the document silently disagreeing with the ledger.
 *
 * Every amount is rounded to the document precision before it is summed, so
 * the document reconciles exactly the way a receiver adds the written
 * strings (BR-CO-10 to BR-CO-16).
 */
export function computeEInvoiceAmounts(input: EInvoiceAmountsInput): {
  vatBreakdown: EInvoiceVatBreakdown[];
  totals: EInvoiceTotals;
} {
  const decimals = input.currencyDecimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 2) {
    throw new Error(`currencyDecimals must be 0, 1 or 2 (EN 16931 BR-DEC), saw ${String(decimals)}`);
  }
  const round = (value: string) => money(value, decimals);

  const groups = new Map<string, { category: VatCategory; rate: string; parts: string[] }>();
  const contribute = (category: VatCategory, rate: string, amount: string) => {
    const key = groupKey(category, rate);
    const group = groups.get(key) ?? { category, rate: rateKey(rate), parts: [] };
    group.parts.push(amount);
    groups.set(key, group);
  };

  const lineNets = input.lines.map((line) => round(line.netAmount));
  input.lines.forEach((line, index) => contribute(line.vatCategory, line.vatRate, lineNets[index]!));

  const allowances: string[] = [];
  const charges: string[] = [];
  for (const entry of input.allowanceCharges) {
    const amount = round(entry.amount);
    (entry.isCharge ? charges : allowances).push(amount);
    contribute(entry.vatCategory, entry.vatRate, entry.isCharge ? amount : neg(amount));
  }

  const stated = new Map<string, string>();
  for (const entry of input.statedTax ?? []) {
    const key = groupKey(entry.category, entry.rate);
    if (!groups.has(key) && !isZero(round(entry.taxAmount))) {
      throw new Error(
        `stated tax of ${entry.taxAmount} for VAT category ${entry.category} at ${entry.rate}% has no line, allowance or charge in that group`,
      );
    }
    stated.set(key, round(add(stated.get(key) ?? "0", round(entry.taxAmount))));
  }

  const vatBreakdown = [...groups.entries()]
    .sort(([, a], [, b]) => vatCategoryOrder(a.category) - vatCategoryOrder(b.category) || compare(b.rate, a.rate))
    .map(([key, group]): EInvoiceVatBreakdown => {
      const taxableAmount = sum(group.parts);
      const statedAmount = stated.get(key);
      const taxAmount = statedAmount
        ?? (TAXED_VAT_CATEGORIES.has(group.category) ? mulPercent(taxableAmount, group.rate, decimals) : "0.0000");
      const exemption = input.exemptions?.find((entry) => entry.category === group.category);
      return {
        category: group.category,
        rate: group.rate,
        taxableAmount,
        taxAmount,
        exemptionReason: exemption?.reason ?? null,
        exemptionReasonCode: exemption?.reasonCode ?? null,
      };
    });

  const lineNet = sum(lineNets);
  const allowanceTotal = sum(allowances);
  const chargeTotal = sum(charges);
  const taxExclusive = add(add(lineNet, neg(allowanceTotal)), chargeTotal);
  const tax = sum(vatBreakdown.map((group) => group.taxAmount));
  const taxInclusive = add(taxExclusive, tax);
  const prepaid = round(input.prepaid ?? "0");
  const rounding = round(input.rounding ?? "0");
  const payable = add(add(taxInclusive, neg(prepaid)), rounding);

  return {
    vatBreakdown,
    totals: {
      lineNet,
      allowances: allowanceTotal,
      charges: chargeTotal,
      taxExclusive,
      tax,
      taxInclusive,
      prepaid,
      rounding,
      payable,
    },
  };
}

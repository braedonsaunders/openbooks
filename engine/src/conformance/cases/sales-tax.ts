/**
 * Sales and consumption tax — ETA (GST/HST), Revenu Québec (QST), CRA GST34,
 * HMRC VAT Notice 700/12 (VAT100), and US economic-nexus thresholds.
 *
 * These cases drive the product's actual indirect-tax machinery:
 * `computeLineTaxes` (the exact line-level calculator every posting path
 * uses), `assembleReturn` over the shipped GST34/VAT100 return packs, and
 * `evaluateUsNexus` over the reference threshold table. Amounts are exact to
 * the cent with the arithmetic shown in `facts`, so an accountant can check
 * each figure without reading any code.
 */

import { add } from "../../money/money.ts";
import { computeLineTaxes } from "../../tax/tax.ts";
import { assembleReturn, planReturn } from "../../tax-returns/return.ts";
import { CANADA_RETURN_PACKS } from "../../country-tax-packs/ca-returns.ts";
import { UNITED_KINGDOM_TAX_PACK } from "../../country-tax-packs/gb.ts";
import type { TaxReturnPack } from "../../country-tax-packs/types.ts";
import { evaluateUsNexus } from "../../tax/us-nexus.ts";
import type { ConformanceCase } from "../types.ts";

const GST34 = CANADA_RETURN_PACKS.find((pack) => pack.code === "CA_GST34")!;
const VAT100 = UNITED_KINGDOM_TAX_PACK.returnPacks.find((pack) => pack.code === "GB_VAT100")!;

/**
 * Plan a return pack's boxes through the product's own planner, then assemble
 * them over GL-summed raw values. The pack supplies the box layout; planReturn
 * decides computed vs GL-mapped vs manual-adjustment boxes exactly as the
 * filing path does.
 */
function assemblePack(
  pack: TaxReturnPack,
  glRawByLineCode: Map<string, string>,
): { lineCode: string; value: string }[] {
  const { boxes } = planReturn(
    pack.boxes.map((box) => ({
      lineCode: box.lineCode,
      label: box.label,
      sign: box.sign,
      sequence: box.sequence,
      taxCodeId: box.basis ? "TEST-CODE" : null,
      basis: box.basis ?? null,
      formula: box.formula ?? null,
    })),
  );
  return assembleReturn(boxes, glRawByLineCode);
}

export const SALES_TAX_CASES: readonly ConformanceCase[] = [
  {
    id: "sales-tax-exclusive-standard",
    title: "Tax-exclusive consideration bears GST at the statutory rate",
    citations: [
      {
        standard: "ETA",
        reference: "ETA 165(1)",
        kind: "requirement",
        requirement:
          "GST is charged at 5% on the value of the consideration for a taxable supply made in Canada.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A tax-exclusive line of $100.00 carries exactly $5.00 of GST and settles at $105.00 — the net amount posted to revenue is untouched by the tax.",
    facts: [
      "Taxable consideration of $100.00, GST at 5%, tax-exclusive pricing.",
      "Tax is 100.00 × 5% = $5.00; the settlement total is $105.00.",
    ],
    expected: {
      values: { net: "100.0000", tax: "5.0000", total: "105.0000" },
    },
    run: () => {
      const result = computeLineTaxes("100.00", [{ taxCodeId: "GST", sequence: 1, ratePercent: "5" }]);
      return {
        values: { net: result.netAmount, tax: result.taxTotal, total: result.total },
      };
    },
  },

  {
    id: "sales-tax-inclusive-extraction",
    title: "A tax-included price yields the exact statutory tax with no residue",
    citations: [
      {
        standard: "ETA",
        reference: "ETA 165(1)",
        kind: "requirement",
        requirement:
          "GST is charged at 5% on the value of the consideration for a taxable supply made in Canada, including when the advertised price already includes the tax.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A $105.00 tax-included price extracts to exactly $100.00 of revenue and $5.00 of GST — the line cross-foots to the penny with no rounding residue parked anywhere.",
    facts: [
      "Advertised tax-included price of $105.00, GST at 5% included.",
      "Net is $100.00 and tax is $5.00; net plus tax equals the entered $105.00 exactly.",
    ],
    expected: {
      values: { net: "100.0000", tax: "5.0000", total: "105.0000" },
    },
    run: () => {
      const result = computeLineTaxes("105.00", [
        { taxCodeId: "GST", sequence: 1, ratePercent: "5", priceIncludesTax: true },
      ]);
      return {
        values: { net: result.netAmount, tax: result.taxTotal, total: result.total },
      };
    },
  },

  {
    id: "sales-tax-qst-excludes-gst",
    title: "QST and GST both use the pre-tax selling price",
    citations: [
      {
        standard: "RQ QST",
        reference: "Revenu Québec — Calculating the Taxes, two-step calculation (https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/collecting-gst-and-qst/calculating-the-taxes/; verified 2026-09-19)",
        kind: "requirement",
        requirement:
          "GST at 5% and QST at 9.975% are each calculated on the selling price excluding the other tax.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "On a $100.00 Québec sale the engine charges $5.00 of GST and $9.98 of QST, each on the $100.00 selling price, for a $114.98 total. QST does not tax the GST amount.",
    facts: [
      "Pre-tax price of $100.00; GST at 5% is $5.00.",
      "The QST base is $100.00; QST is 100.00 × 9.975% = 9.975, rounded half-up to $9.98.",
      "Settlement total is 100.00 + 5.00 + 9.98 = $114.98.",
    ],
    expected: {
      values: {
        net: "100.0000",
        gst: "5.0000",
        qstBase: "100.0000",
        qst: "9.9800",
        total: "114.9800",
      },
    },
    run: () => {
      const result = computeLineTaxes("100.00", [
        { taxCodeId: "GST", sequence: 1, ratePercent: "5" },
        { taxCodeId: "QST", sequence: 2, ratePercent: "9.975", compoundOnPrevious: false },
      ]);
      const gst = result.components[0]!;
      const qst = result.components[1]!;
      return {
        values: {
          net: result.netAmount,
          gst: gst.taxAmount,
          qstBase: qst.taxableAmount,
          qst: qst.taxAmount,
          total: result.total,
        },
      };
    },
  },

  {
    id: "sales-tax-per-line-rounding",
    title: "Each line's tax rounds independently before the document total is summed",
    citations: [
      {
        standard: "ETA",
        reference: "ETA 165(1)",
        kind: "requirement",
        requirement:
          "GST at 5% applies to each taxable supply, and each line's tax is rounded half-up to the cent before the document total is summed.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Three lines of $33.33, $33.33 and $33.34 each carry $1.67 of GST for a $5.01 document tax — one cent above the $5.00 a single $100.00 line would carry. The penny is the deterministic consequence of per-line rounding, stated openly rather than forced to agree.",
    facts: [
      "Lines of $33.33, $33.33 and $33.34 at 5%: 33.33 × 5% = 1.6665 → $1.67 each; 33.34 × 5% = 1.667 → $1.67.",
      "Document tax is 1.67 + 1.67 + 1.67 = $5.01.",
      "A single $100.00 line at 5% would carry $5.00 — the case pins the one-cent difference as policy, not error.",
    ],
    expected: {
      values: {
        line1: "1.6700",
        line2: "1.6700",
        line3: "1.6700",
        linesSum: "5.0100",
        documentLevel: "5.0000",
      },
    },
    run: () => {
      const lines = ["33.33", "33.33", "33.34"].map(
        (amount) =>
          computeLineTaxes(amount, [{ taxCodeId: "GST", sequence: 1, ratePercent: "5" }]).taxTotal,
      );
      const document = computeLineTaxes("100.00", [{ taxCodeId: "GST", sequence: 1, ratePercent: "5" }]);
      return {
        values: {
          line1: lines[0]!,
          line2: lines[1]!,
          line3: lines[2]!,
          linesSum: add(add(lines[0]!, lines[1]!), lines[2]!),
          documentLevel: document.taxTotal,
        },
      };
    },
  },

  {
    id: "sales-tax-partial-itc",
    title: "A partially recoverable tax splits into credit and cost exactly",
    citations: [
      {
        standard: "ETA",
        reference: "ETA 169(1)",
        kind: "requirement",
        requirement:
          "An input tax credit is claimable only to the extent the purchase is for consumption or use in commercial activity; the non-creditable share stays in cost.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A $10.00 tax that is 50% recoverable produces a $5.00 input credit and a $5.00 non-recoverable cost — the split sums to the tax with neither side rounded away.",
    facts: [
      "Purchase of $200.00 at 5% carries $10.00 of tax, 50% recoverable.",
      "Recoverable is $5.00; non-recoverable is 10.00 − 5.00 = $5.00.",
    ],
    expected: {
      values: { tax: "10.0000", recoverable: "5.0000", nonrecoverable: "5.0000" },
    },
    run: () => {
      const result = computeLineTaxes("200.00", [
        { taxCodeId: "GST", sequence: 1, ratePercent: "5", recoverablePercent: "50" },
      ]);
      const component = result.components[0]!;
      return {
        values: {
          tax: component.taxAmount,
          recoverable: component.recoverableAmount,
          nonrecoverable: component.nonrecoverableAmount,
        },
      };
    },
  },

  {
    id: "sales-tax-gst34-payable",
    title: "A GST34 return with tax owing computes every box from the ledger",
    citations: [
      {
        standard: "CRA GST34",
        reference: "GST34 lines 101/103/105/106/108/109/113C/114/115",
        kind: "requirement",
        requirement:
          "Net tax is total GST/HST collected (line 105) less total input credits (line 108); a positive balance is an amount owing (line 115).",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "With $1,000.00 of sales, $50.00 of tax collected and $20.00 of input credits, the return computes net tax of $30.00 owing — line 109 flows through 113A and 113C into a $30.00 payment on line 115 with no refund on line 114.",
    facts: [
      "Line 101 sales: $1,000.00. Line 103 collected: $50.00; line 104 adjustments: $0.00.",
      "Line 105 is 103 + 104 = $50.00. Line 106 credits: $20.00; line 107 adjustments: $0.00.",
      "Line 108 is 106 + 107 = $20.00. Line 109 is 105 − 108 = $30.00.",
      "Lines 110–112, 205 and 405 are $0.00, so 113A, 113B and 113C are $30.00, $0.00 and $30.00.",
      "Line 114 (refund) is max(−30.00, 0) = $0.00; line 115 (payment) is max(30.00, 0) = $30.00.",
    ],
    expected: {
      values: {
        line101: "1000.0000",
        line103: "50.0000",
        line105: "50.0000",
        line106: "20.0000",
        line108: "20.0000",
        line109: "30.0000",
        line113C: "30.0000",
        line114: "0.0000",
        line115: "30.0000",
      },
    },
    run: () => {
      const boxes = assemblePack(
        GST34,
        new Map([
          ["101", "1000.00"],
          ["103", "-50.00"],
          ["106", "20.00"],
        ]),
      );
      const value = (code: string): string => boxes.find((box) => box.lineCode === code)!.value;
      return {
        values: {
          line101: value("101"),
          line103: value("103"),
          line105: value("105"),
          line106: value("106"),
          line108: value("108"),
          line109: value("109"),
          line113C: value("113C"),
          line114: value("114"),
          line115: value("115"),
        },
      };
    },
  },

  {
    id: "sales-tax-gst34-refund",
    title: "A GST34 return with excess credits claims a refund, not a negative payment",
    citations: [
      {
        standard: "CRA GST34",
        reference: "GST34 lines 109/113C/114/115",
        kind: "requirement",
        requirement:
          "A negative balance is a refund claimed (line 114); only a positive balance is an amount enclosed (line 115).",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "With $10.00 collected and $25.00 of credits, the $15.00 negative balance becomes a $15.00 refund on line 114 with $0.00 on the payment line — the return never presents a negative payment.",
    facts: [
      "Line 105 is $10.00; line 108 is $25.00; line 109 is 10.00 − 25.00 = −$15.00.",
      "Lines 110–112, 205 and 405 are $0.00, so 113C is −$15.00.",
      "Line 114 is max(15.00, 0) = $15.00; line 115 is max(−15.00, 0) = $0.00.",
    ],
    expected: {
      values: { line109: "-15.0000", line113C: "-15.0000", line114: "15.0000", line115: "0.0000" },
    },
    run: () => {
      const boxes = assemblePack(
        GST34,
        new Map([
          ["103", "-10.00"],
          ["106", "25.00"],
        ]),
      );
      const value = (code: string): string => boxes.find((box) => box.lineCode === code)!.value;
      return {
        values: { line109: value("109"), line113C: value("113C"), line114: value("114"), line115: value("115") },
      };
    },
  },

  {
    id: "sales-tax-vat100-net",
    title: "A VAT100 return nets output tax against reclaimed input tax",
    citations: [
      {
        standard: "HMRC VAT700/12",
        reference: "VAT100 boxes 1/3/4/5/6/7",
        kind: "requirement",
        requirement:
          "Box 5 is the difference between total output tax (box 3) and total input tax (box 4), with boxes 6 and 7 carrying the net sales and purchases excluding VAT.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "With £200.00 of output VAT and £50.00 of input VAT, box 3 is £200.00 and box 5 is £150.00 to pay — while boxes 6 and 7 carry the £1,000.00 of net sales and £250.00 of net purchases the tax was computed from.",
    facts: [
      "Box 1 output VAT: £200.00; box 2 Northern Ireland acquisitions: £0.00.",
      "Box 3 is 1 + 2 = £200.00. Box 4 reclaimed input VAT: £50.00.",
      "Box 5 is |200.00 − 50.00| = £150.00.",
      "Box 6 net sales excluding VAT: £1,000.00; box 7 net purchases excluding VAT: £250.00.",
    ],
    expected: {
      values: {
        box1: "200.0000",
        box3: "200.0000",
        box4: "50.0000",
        box5: "150.0000",
        box6: "1000.0000",
        box7: "250.0000",
      },
    },
    run: () => {
      const boxes = assemblePack(
        VAT100,
        new Map([
          ["1", "-200.00"],
          ["4", "50.00"],
          ["6", "1000.00"],
          ["7", "250.00"],
        ]),
      );
      const value = (code: string): string => boxes.find((box) => box.lineCode === code)!.value;
      return {
        values: {
          box1: value("1"),
          box3: value("3"),
          box4: value("4"),
          box5: value("5"),
          box6: value("6"),
          box7: value("7"),
        },
      };
    },
  },

  {
    id: "sales-tax-nexus-default-or",
    title: "A default state is met through either the sales or the transaction trigger",
    citations: [
      {
        standard: "SD v. Wayfair",
        reference: "585 U.S. 342 (2018)",
        kind: "requirement",
        requirement:
          "A state may require a remote seller to collect sales tax once the seller exceeds $100,000 in sales or 200 transactions in the state.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Either trigger alone creates the obligation: $120,000 with 5 transactions is met, 250 transactions at $40,000 is met, and $40,000 with 5 transactions is not.",
    facts: [
      "Florida follows the prevailing $100,000-or-200-transaction pattern.",
      "$120,000 with 5 transactions meets the sales trigger.",
      "$40,000 with 250 transactions meets the transaction trigger.",
      "$40,000 with 5 transactions meets neither.",
    ],
    expected: {
      values: { salesTrigger: "met", txnTrigger: "met", belowBoth: "none" },
    },
    run: () => {
      const rows = evaluateUsNexus([
        { state: "FL", salesUsd: "120000", txnCount: 5 },
        { state: "FL", salesUsd: "40000", txnCount: 250 },
        { state: "FL", salesUsd: "40000", txnCount: 5 },
      ]);
      // The evaluator sorts most-urgent first, so look each scenario up by
      // its exact (sales, transactions) pair — every asserted status is read
      // back from the evaluator, never hardcoded.
      const status = (sales: string, txn: number): string =>
        rows.find((row) => row.salesUsd === sales && row.txnCount === txn)!.status;
      return {
        values: {
          salesTrigger: status("120000", 5),
          txnTrigger: status("40000", 250),
          belowBoth: status("40000", 5),
        },
      };
    },
  },

  {
    id: "sales-tax-nexus-ca-sales-only",
    title: "California ignores transaction count: only the $500,000 sales threshold binds",
    citations: [
      {
        standard: "CDTFA Reg 1684",
        reference: "Cal. RTC 6203 — $500,000 sales threshold",
        kind: "requirement",
        requirement:
          "A retailer without physical presence in California is engaged in business there once combined California sales exceed $500,000; there is no transaction-count trigger.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "$200,000 of sales with one hundred thousand transactions is not nexus in California, while $600,000 with no transactions at all is — the transaction count is genuinely ignored, not merely outweighed.",
    facts: [
      "California applies a $500,000 sales-only threshold.",
      "$200,000 with 100,000 transactions: sales below threshold, transactions irrelevant — no nexus.",
      "$600,000 with 0 transactions: sales above threshold — nexus met.",
    ],
    expected: {
      values: { highTxnLowSales: "none", highSalesNoTxn: "met" },
    },
    run: () => {
      const rows = evaluateUsNexus([
        { state: "CA", salesUsd: "200000", txnCount: 100000 },
        { state: "CA", salesUsd: "600000", txnCount: 0 },
      ]);
      const status = (sales: string): string =>
        rows.find((row) => row.salesUsd === sales)!.status;
      return { values: { highTxnLowSales: status("200000"), highSalesNoTxn: status("600000") } };
    },
  },

  {
    id: "sales-tax-nexus-ny-and",
    title: "New York requires both $500,000 of sales and 100 transactions",
    citations: [
      {
        standard: "NY Tax Law 1101",
        reference: "Tax Law 1101(b)(8)(iv) — $500,000 and 100 transactions",
        kind: "requirement",
        requirement:
          "A remote seller has nexus in New York only when it exceeds both $500,000 in sales and 100 transactions; meeting one trigger alone is not enough.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "$600,000 with 50 transactions is not nexus in New York, while the same sales with 150 transactions is — the conjunction is enforced, not treated as a disjunction.",
    facts: [
      "New York applies a $500,000-and-100-transaction threshold.",
      "$600,000 with 50 transactions: sales met, transactions not — no nexus.",
      "$600,000 with 150 transactions: both met — nexus met.",
    ],
    expected: {
      values: { salesOnly: "none", bothTriggers: "met" },
    },
    run: () => {
      const rows = evaluateUsNexus([
        { state: "NY", salesUsd: "600000", txnCount: 50 },
        { state: "NY", salesUsd: "600000", txnCount: 150 },
      ]);
      const status = (txn: number): string =>
        rows.find((row) => row.txnCount === txn)!.status;
      return { values: { salesOnly: status(50), bothTriggers: status(150) } };
    },
  },

  {
    id: "sales-tax-place-of-supply",
    title: "Native place-of-supply determination from the delivery address",
    citations: [
      {
        standard: "ETA",
        reference: "ETA 144.1 (place of supply)",
        kind: "requirement",
        requirement:
          "Whether GST or a participating province's HST applies — and at which of the differing HST rates — follows where the supply is made, so the same $100 supply bears $5.00 for an Alberta delivery and $13.00 for an Ontario one.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    assertion:
      "Given a supply and its delivery province, the kernel selects the applicable sourced rate (GST 5% for Alberta, HST 13% for Ontario) on its own, without the merchant pre-selecting the tax code or calling an external rate service.",
    facts: [
      "A $100.00 taxable supply delivered in Alberta must bear $5.00 (GST 5%).",
      "The identical supply delivered in Ontario must bear $13.00 (HST 13%).",
      "The required outcome is the rate selected from the delivery province alone.",
    ],
    gap:
      "The country packs carry sourced jurisdictional rates (Ontario HST 13%, GST 5%) but the kernel never selects among them: the merchant configures which tax code a document line uses, or an external rate provider quotes it. There is no native place-of-supply function mapping a delivery province or address to the applicable pack rate, and the packs self-report sourcingRules as partial.",
    expected: {
      values: { albertaTax: "5.0000", ontarioTax: "13.0000" },
    },
  },
];

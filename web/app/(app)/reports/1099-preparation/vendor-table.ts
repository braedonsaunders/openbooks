import {
  badge,
  column,
  date,
  field,
  link,
  money,
  text,
  type Column,
  type Value,
} from "@braedonsaunders/appkit-viewspec";
import type { NecPreparationVendor } from "@openbooks/engine/compliance/information-returns";

/**
 * 1099-NEC preparation vendor rows and their report columns.
 *
 * This module stays free of server imports so the worksheet's cell contract
 * — every link resolves a row field, never a nested cell — is covered by a
 * plain unit test. A link whose label is a nested cell object renders the
 * literal "[object Object]", which is how the payments count lost its
 * drill-down.
 */

const row = field;
const payment = field;

export interface NecVendorRow {
  rowKey: string;
  partyId: string;
  vendorName: string;
  /** Masked TIN (•••1234) or the translated missing-TIN message. */
  tinText: string;
  /** Vendor compliance drawer when the TIN is missing; empty keeps plain text. */
  tinHref: string;
  box1: string;
  withheld: string;
  reportableTotal: string;
  thresholdFlag: "reportable" | "below" | "excluded";
  thresholdLabel: string;
  thresholdVariant: "success" | "secondary" | "warning";
  paymentCount: string;
  vendorHref: string;
  /** Formatted card-funded total, excluded by rule. */
  cardPaid: string;
  /** Corporate, missing-form, unmapped-account and card notes; blank when clean. */
  exclusionNote: string;
  /** Box-mapping setup when an account lacks a box rule; empty keeps plain text. */
  exclusionHref: string;
}

export interface NecPaymentRow {
  rowKey: string;
  paymentId: string;
  paymentDate: string;
  documentNumber: string;
  cash: string;
  paymentHref: string;
}

export interface NecVendorColumnHeaders {
  vendor: Value;
  tin: Value;
  box1: Value;
  withheld: Value;
  total: Value;
  threshold: Value;
  payments: Value;
  cardPaid: Value;
  notes: Value;
}

export interface NecPaymentColumnHeaders {
  date: Value;
  number: Value;
  cash: Value;
}

export function mapNecVendorRow(
  source: NecPreparationVendor,
  opts: {
    formatMoney: (value: string) => string;
    missingTinText: string;
    thresholdBelow: string;
    thresholdReportable: string;
    cardExcludedText: (amount: string) => string;
    vendorHref: string;
    vendorDrawerHref: string;
    boxRulesHref: string;
  },
): NecVendorRow {
  const flag = source.belowThreshold ? ("below" as const) : ("reportable" as const);
  const cardNote =
    Number(source.cardPaid) > 0 ? opts.cardExcludedText(opts.formatMoney(source.cardPaid)) : null;
  const notes = [...source.exclusionDetails, ...(cardNote ? [cardNote] : [])];
  return {
    rowKey: source.partyId,
    partyId: source.partyId,
    vendorName: source.vendorName,
    tinText: source.tinLast4 ? `•••${source.tinLast4}` : opts.missingTinText,
    tinHref: source.tinLast4 ? "" : opts.vendorDrawerHref,
    box1: opts.formatMoney(source.box1),
    withheld: opts.formatMoney(source.withheld),
    reportableTotal: opts.formatMoney(source.reportableTotal),
    thresholdFlag: flag,
    thresholdLabel: flag === "below" ? opts.thresholdBelow : opts.thresholdReportable,
    thresholdVariant: flag === "below" ? "secondary" : "success",
    paymentCount: String(source.paymentCount),
    vendorHref: opts.vendorHref,
    cardPaid: opts.formatMoney(source.cardPaid),
    exclusionNote: notes.length > 0 ? notes.join("; ") : "",
    exclusionHref: source.exclusionKinds.includes("unmapped_account") ? opts.boxRulesHref : "",
  };
}

export function necVendorColumns(
  header: NecVendorColumnHeaders,
  opts: { hasCardPaid: boolean },
): Column[] {
  return [
    column(header.vendor, text(row("vendorName"))),
    column(header.tin, link(row("tinText"), row("tinHref"))),
    column(header.box1, money(row("box1")), { align: "right" }),
    column(header.withheld, money(row("withheld")), { align: "right" }),
    column(header.total, money(row("reportableTotal")), { align: "right" }),
    column(header.threshold, badge(row("thresholdLabel"), { variant: row("thresholdVariant") })),
    column(header.payments, link(row("paymentCount"), row("vendorHref")), { align: "right" }),
    ...(opts.hasCardPaid
      ? [column(header.cardPaid, money(row("cardPaid")), { align: "right" })]
      : []),
    column(header.notes, link(row("exclusionNote"), row("exclusionHref"))),
  ];
}

export function necPaymentColumns(header: NecPaymentColumnHeaders): Column[] {
  return [
    column(header.date, date(payment("paymentDate"))),
    column(header.number, link(payment("documentNumber"), payment("paymentHref"))),
    column(header.cash, money(payment("cash")), { align: "right" }),
  ];
}

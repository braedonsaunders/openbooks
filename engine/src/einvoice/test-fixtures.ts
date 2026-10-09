// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Realistic invoices for the e-invoice tests: a German construction
 * services invoice to a public-sector buyer (XRechnung), assembled the way
 * an issuing service would, through computeEInvoiceAmounts.
 */

import {
  computeEInvoiceAmounts,
  type EInvoice,
  type EInvoiceAllowanceCharge,
  type EInvoiceAmountsInput,
  type EInvoiceLine,
} from "./model.ts";

export const GERMAN_LINES: EInvoiceLine[] = [
  {
    id: "1",
    name: "Concrete works <C25/30> & formwork",
    description: "Foundation slab, building section B",
    sellerItemId: "CW-2530",
    quantity: "12.5",
    unitCode: "HUR",
    netPrice: "85.40",
    netAmount: "1067.50",
    vatCategory: "S",
    vatRate: "19",
    period: { start: "2026-09-01", end: "2026-09-30" },
  },
  {
    id: "2",
    name: "Site safety handbook",
    quantity: "3",
    unitCode: "EA",
    netPrice: "24.90",
    netAmount: "74.70",
    vatCategory: "S",
    vatRate: "7",
  },
];

export const GERMAN_ALLOWANCES: EInvoiceAllowanceCharge[] = [
  { isCharge: false, amount: "50.00", reason: "Loyalty discount", reasonCode: "95", vatCategory: "S", vatRate: "19" },
];

/** A complete XRechnung invoice; overrides replace top-level fields, amounts are recomputed from `amounts`. */
export function germanInvoice(
  overrides: Partial<EInvoice> = {},
  amounts: Partial<Omit<EInvoiceAmountsInput, "currencyDecimals">> = {},
): EInvoice {
  const lines = amounts.lines ?? GERMAN_LINES;
  const allowanceCharges = amounts.allowanceCharges ?? GERMAN_ALLOWANCES;
  const { vatBreakdown, totals } = computeEInvoiceAmounts({ ...amounts, lines, allowanceCharges, currencyDecimals: 2 });
  return {
    profile: "xrechnung-cii",
    number: "RE-2026-0042",
    typeCode: "380",
    issueDate: "2026-10-08",
    dueDate: "2026-11-07",
    currency: "EUR",
    currencyDecimals: 2,
    buyerReference: "04011000-12345-67",
    orderReference: "BEST-2026-118",
    precedingInvoices: [],
    notes: ["Thank you for your order & continued trust."],
    seller: {
      name: "Muster Bau GmbH",
      address: { line1: "Hauptstraße 1", city: "Berlin", postcode: "10115", countryCode: "DE" },
      vatId: "DE123456789",
      taxRegistrationId: "12/345/67890",
      legalRegistration: { id: "HRB 12345" },
      electronicAddress: { id: "rechnung@musterbau.de", schemeId: "EM" },
      contact: { name: "Anna Schmidt", phone: "+49 30 1234567", email: "anna.schmidt@musterbau.de" },
    },
    buyer: {
      name: "Stadt Musterstadt Bauamt",
      address: { line1: "Rathausplatz 1", city: "Hamburg", postcode: "20095", countryCode: "DE" },
      electronicAddress: { id: "04011000-12345-67", schemeId: "0204" },
    },
    delivery: { date: "2026-09-30" },
    payment: {
      meansCode: "58",
      remittanceInformation: "RE-2026-0042",
      creditTransfer: { accountId: "DE89 3704 0044 0532 0130 00", accountName: "Muster Bau GmbH", providerId: "COBADEFFXXX" },
      terms: "Payable within 30 days without deduction.",
    },
    lines,
    allowanceCharges,
    vatBreakdown,
    totals,
    ...overrides,
  };
}

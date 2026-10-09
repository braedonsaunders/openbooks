// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * OASIS UBL 2.1 writer for EN 16931: the syntax of Peppol BIS Billing 3.0
 * and of XRechnung (UBL).
 *
 * A credit-note-class type code renders a UBL CreditNote document, which
 * differs from an Invoice in its root, type code and quantity elements, in
 * where the VAT point date sits, and in carrying the payment due date
 * (BT-9) inside the payment means. Element order follows the UBL 2.1 XSD
 * sequence of each type.
 */

import { isCreditNoteTypeCode } from "./codes.ts";
import { canonicalDecimal, fixed, hasAtMostDecimals, isZeroDecimal } from "./decimal.ts";
import type { EInvoice, EInvoiceAddress, EInvoiceParty, VatCategory } from "./model.ts";
import type { EInvoiceProfile } from "./profiles.ts";
import { el, isoDate, leaf, required, serializeXml, type XmlElement } from "./xml.ts";

const NS = {
  invoice: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  creditNote: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
} as const;

const percent = (rate: string) => hasAtMostDecimals(rate, 2) ? fixed(rate, 2) : canonicalDecimal(rate);

function date(name: string, value: string | null | undefined, term: string): XmlElement | null {
  return value ? leaf(`cbc:${name}`, isoDate(value, term)) : null;
}

function postalAddress(name: string, value: EInvoiceAddress | null | undefined): XmlElement | null {
  if (!value) return null;
  return el(
    `cac:${name}`,
    leaf("cbc:StreetName", value.line1),
    leaf("cbc:AdditionalStreetName", value.line2),
    leaf("cbc:CityName", value.city),
    leaf("cbc:PostalZone", value.postcode),
    leaf("cbc:CountrySubentity", value.subdivision),
    el("cac:Country", leaf("cbc:IdentificationCode", value.countryCode)),
  );
}

function taxCategory(name: string, category: VatCategory, rate: string, extra: XmlElement[] = [], schemeId = "VAT"): XmlElement {
  return required(
    `cac:${name}`,
    {},
    leaf("cbc:ID", category),
    // Peppol: category O carries no rate.
    category === "O" || category === "NG" ? null : leaf("cbc:Percent", percent(rate)),
    ...extra,
    el("cac:TaxScheme", leaf("cbc:ID", schemeId)),
  );
}

function party(wrapper: string, value: EInvoiceParty, role: "seller" | "buyer", taxSchemeId: string): XmlElement {
  const legal = value.legalRegistration;
  const contact = value.contact;
  return required(
    `cac:${wrapper}`,
    {},
    required(
      "cac:Party",
      {},
      value.electronicAddress
        ? leaf("cbc:EndpointID", value.electronicAddress.id, { schemeID: value.electronicAddress.schemeId })
        : null,
      el("cac:PartyIdentification", leaf("cbc:ID", value.identifier?.id, { schemeID: value.identifier?.schemeId })),
      el("cac:PartyName", leaf("cbc:Name", value.tradingName || value.name)),
      postalAddress("PostalAddress", value.address),
      el("cac:PartyTaxScheme", leaf("cbc:CompanyID", value.vatId), value.vatId ? el("cac:TaxScheme", leaf("cbc:ID", taxSchemeId)) : null),
      role === "seller" && value.taxRegistrationId
        ? el("cac:PartyTaxScheme", leaf("cbc:CompanyID", value.taxRegistrationId), el("cac:TaxScheme", leaf("cbc:ID", "FC")))
        : null,
      el(
        "cac:PartyLegalEntity",
        leaf("cbc:RegistrationName", value.name),
        leaf("cbc:CompanyID", legal?.id, { schemeID: legal?.schemeId }),
      ),
      contact
        ? el(
          "cac:Contact",
          leaf("cbc:Name", contact.name),
          leaf("cbc:Telephone", contact.phone),
          leaf("cbc:ElectronicMail", contact.email),
        )
        : null,
    ),
  );
}

/** Render an invoice as UBL. The caller has already judged it against the rules. */
export function renderUbl(inv: EInvoice, profile: EInvoiceProfile): string {
  const creditNote = isCreditNoteTypeCode(inv.typeCode);
  const d = inv.currencyDecimals;
  const currency = inv.currency;
  const money = (name: string, value: string, currencyId = currency) =>
    leaf(`cbc:${name}`, fixed(value, d), { currencyID: currencyId });
  const taxCurrency = inv.taxCurrency && inv.taxCurrency !== currency ? inv.taxCurrency : null;
  const transfer = inv.payment.creditTransfer;
  const totals = inv.totals;
  const hasAllowances = inv.allowanceCharges.some((entry) => !entry.isCharge);
  const hasCharges = inv.allowanceCharges.some((entry) => entry.isCharge);

  const lineNodes = inv.lines.map((line) =>
    required(
      creditNote ? "cac:CreditNoteLine" : "cac:InvoiceLine",
      {},
      leaf("cbc:ID", line.id),
      leaf("cbc:Note", line.note),
      leaf(creditNote ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity", canonicalDecimal(line.quantity), { unitCode: line.unitCode }),
      money("LineExtensionAmount", line.netAmount),
      leaf("cbc:AccountingCost", line.accountingReference),
      line.period
        ? el("cac:InvoicePeriod", date("StartDate", line.period.start, "BT-134"), date("EndDate", line.period.end, "BT-135"))
        : null,
      el("cac:OrderLineReference", leaf("cbc:LineID", line.orderLineReference)),
      required(
        "cac:Item",
        {},
        leaf("cbc:Description", line.description),
        leaf("cbc:Name", line.name),
        el("cac:BuyersItemIdentification", leaf("cbc:ID", line.buyerItemId)),
        el("cac:SellersItemIdentification", leaf("cbc:ID", line.sellerItemId)),
        taxCategory("ClassifiedTaxCategory", line.vatCategory, line.vatRate, [], profile.taxSchemeId),
      ),
      el(
        "cac:Price",
        leaf("cbc:PriceAmount", canonicalDecimal(line.netPrice), { currencyID: currency }),
        line.baseQuantity ? leaf("cbc:BaseQuantity", canonicalDecimal(line.baseQuantity), { unitCode: line.unitCode }) : null,
      ),
    ));

  const header: Array<XmlElement | null> = [
    leaf("cbc:CustomizationID", profile.guidelineId),
    leaf("cbc:ProfileID", profile.businessProcessId),
    leaf("cbc:ID", inv.number),
    leaf("cbc:UUID", inv.uuid),
    date("IssueDate", inv.issueDate, "BT-2"),
    ...(creditNote
      ? [date("TaxPointDate", inv.taxPointDate, "BT-7"), leaf("cbc:CreditNoteTypeCode", inv.typeCode)]
      : [date("DueDate", inv.dueDate, "BT-9"), leaf("cbc:InvoiceTypeCode", inv.typeCode)]),
    ...inv.notes.map((note) => leaf("cbc:Note", note)),
    creditNote ? null : date("TaxPointDate", inv.taxPointDate, "BT-7"),
    leaf("cbc:DocumentCurrencyCode", currency),
    leaf("cbc:TaxCurrencyCode", taxCurrency),
    leaf("cbc:BuyerReference", inv.buyerReference),
    inv.invoicePeriod
      ? el("cac:InvoicePeriod", date("StartDate", inv.invoicePeriod.start, "BT-73"), date("EndDate", inv.invoicePeriod.end, "BT-74"))
      : null,
    // UBL requires OrderReference/ID; a sales order reference alone is written against the "NA" placeholder Peppol prescribes.
    inv.orderReference || inv.salesOrderReference
      ? el("cac:OrderReference", leaf("cbc:ID", inv.orderReference || "NA"), leaf("cbc:SalesOrderID", inv.salesOrderReference))
      : null,
    ...inv.precedingInvoices.map((entry) =>
      el(
        "cac:BillingReference",
        el("cac:InvoiceDocumentReference", leaf("cbc:ID", entry.number), date("IssueDate", entry.issueDate, "BT-26")),
      )),
    el("cac:ContractDocumentReference", leaf("cbc:ID", inv.contractReference)),
    ...(profile.taxSchemeId === "GST" && inv.accountingCurrencyTotals ? [
      el("cac:AdditionalDocumentReference", leaf("cbc:ID", "SGD"), leaf("cbc:DocumentTypeCode", "sgdtotal-excl-gst"), leaf("cbc:DocumentDescription", fixed(inv.accountingCurrencyTotals.taxExclusive, d))),
      el("cac:AdditionalDocumentReference", leaf("cbc:ID", "SGD"), leaf("cbc:DocumentTypeCode", "sgdtotal-incl-gst"), leaf("cbc:DocumentDescription", fixed(inv.accountingCurrencyTotals.taxInclusive, d))),
    ] : []),
    // A UBL CreditNote has no ProjectReference; EN 16931 carries BT-11 there as a document reference of type 50.
    creditNote
      ? el("cac:AdditionalDocumentReference", leaf("cbc:ID", inv.projectReference), inv.projectReference ? leaf("cbc:DocumentTypeCode", "50") : null)
      : el("cac:ProjectReference", leaf("cbc:ID", inv.projectReference)),
  ];

  const delivery = inv.delivery;
  const body: Array<XmlElement | null> = [
    party("AccountingSupplierParty", inv.seller, "seller", profile.taxSchemeId),
    party("AccountingCustomerParty", inv.buyer, "buyer", profile.taxSchemeId),
    delivery
      ? el(
        "cac:Delivery",
        date("ActualDeliveryDate", delivery.date, "BT-72"),
        el("cac:DeliveryLocation", postalAddress("Address", delivery.address)),
        el("cac:DeliveryParty", el("cac:PartyName", leaf("cbc:Name", delivery.locationName))),
      )
      : null,
    el(
      "cac:PaymentMeans",
      leaf("cbc:PaymentMeansCode", inv.payment.meansCode, { name: inv.payment.meansText }),
      creditNote ? date("PaymentDueDate", inv.dueDate, "BT-9") : null,
      leaf("cbc:PaymentID", inv.payment.remittanceInformation),
      transfer
        ? el(
          "cac:PayeeFinancialAccount",
          leaf("cbc:ID", transfer.accountId?.replace(/[\s-]+/g, "").toUpperCase()),
          leaf("cbc:Name", transfer.accountName),
          el("cac:FinancialInstitutionBranch", leaf("cbc:ID", transfer.providerId)),
        )
        : null,
    ),
    el("cac:PaymentTerms", leaf("cbc:Note", inv.payment.terms)),
    ...inv.allowanceCharges.map((entry) =>
      el(
        "cac:AllowanceCharge",
        leaf("cbc:ChargeIndicator", entry.isCharge ? "true" : "false"),
        leaf("cbc:AllowanceChargeReasonCode", entry.reasonCode),
        leaf("cbc:AllowanceChargeReason", entry.reason),
        entry.percent ? leaf("cbc:MultiplierFactorNumeric", percent(entry.percent)) : null,
        money("Amount", entry.amount),
        entry.baseAmount ? money("BaseAmount", entry.baseAmount) : null,
        taxCategory("TaxCategory", entry.vatCategory, entry.vatRate, [], profile.taxSchemeId),
      )),
    required(
      "cac:TaxTotal",
      {},
      money("TaxAmount", totals.tax),
      ...inv.vatBreakdown.map((group) =>
        el(
          "cac:TaxSubtotal",
          money("TaxableAmount", group.taxableAmount),
          money("TaxAmount", group.taxAmount),
          taxCategory("TaxCategory", group.category, group.rate, [
            leaf("cbc:TaxExemptionReasonCode", group.exemptionReasonCode),
            leaf("cbc:TaxExemptionReason", group.exemptionReason),
          ].filter((node): node is XmlElement => node !== null), profile.taxSchemeId),
        )),
    ),
    taxCurrency && inv.taxTotalInTaxCurrency
      ? el("cac:TaxTotal", money("TaxAmount", inv.taxTotalInTaxCurrency, taxCurrency))
      : null,
    required(
      "cac:LegalMonetaryTotal",
      {},
      money("LineExtensionAmount", totals.lineNet),
      money("TaxExclusiveAmount", totals.taxExclusive),
      money("TaxInclusiveAmount", totals.taxInclusive),
      hasAllowances ? money("AllowanceTotalAmount", totals.allowances) : null,
      hasCharges ? money("ChargeTotalAmount", totals.charges) : null,
      isZeroDecimal(totals.prepaid) ? null : money("PrepaidAmount", totals.prepaid),
      isZeroDecimal(totals.rounding) ? null : money("PayableRoundingAmount", totals.rounding),
      money("PayableAmount", totals.payable),
    ),
  ];

  const rootName = creditNote ? "CreditNote" : "Invoice";
  const root = required(
    rootName,
    { xmlns: creditNote ? NS.creditNote : NS.invoice, "xmlns:cac": NS.cac, "xmlns:cbc": NS.cbc },
    ...header,
    ...body,
    ...lineNodes,
  );
  return serializeXml(root);
}

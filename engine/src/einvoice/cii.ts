// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * UN/CEFACT Cross Industry Invoice (CII, D16B) writer for EN 16931.
 *
 * This is the syntax of XRechnung (CII), Factur-X and ZUGFeRD. Element
 * order follows the D16B XSD sequence of each type, because a receiver's
 * schema validation rejects a document whose siblings are out of order even
 * when every value is right.
 */

import { validPaymentIban } from "./bank.ts";
import { isValidBic } from "../payments-core/rail-settings.ts";
import { canonicalDecimal, fixed, hasAtMostDecimals, isZeroDecimal } from "./decimal.ts";
import type { EInvoice, EInvoiceAddress, EInvoiceParty, VatCategory } from "./model.ts";
import type { EInvoiceProfile } from "./profiles.ts";
import { el, format102, leaf, required, serializeXml, type XmlElement } from "./xml.ts";

const NS = {
  rsm: "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
  ram: "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
  udt: "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
  qdt: "urn:un:unece:uncefact:data:standard:QualifiedDataType:100",
} as const;

const percent = (rate: string) => hasAtMostDecimals(rate, 2) ? fixed(rate, 2) : canonicalDecimal(rate);

function dateTime(name: string, iso: string | null | undefined, term: string): XmlElement | null {
  if (!iso) return null;
  return el(`ram:${name}`, leaf("udt:DateTimeString", format102(iso, term), { format: "102" }));
}

function address(value: EInvoiceAddress | null | undefined): XmlElement | null {
  if (!value) return null;
  return el(
    "ram:PostalTradeAddress",
    leaf("ram:PostcodeCode", value.postcode),
    leaf("ram:LineOne", value.line1),
    leaf("ram:LineTwo", value.line2),
    leaf("ram:CityName", value.city),
    leaf("ram:CountryID", value.countryCode),
    leaf("ram:CountrySubDivisionName", value.subdivision),
  );
}

function tradeParty(name: string, party: EInvoiceParty, role: "seller" | "buyer"): XmlElement {
  const legal = party.legalRegistration;
  const contact = party.contact;
  return required(
    `ram:${name}`,
    {},
    leaf("ram:ID", party.identifier?.id, { schemeID: party.identifier?.schemeId }),
    leaf("ram:Name", party.name),
    el(
      "ram:SpecifiedLegalOrganization",
      leaf("ram:ID", legal?.id, { schemeID: legal?.schemeId }),
      leaf("ram:TradingBusinessName", party.tradingName),
    ),
    contact
      ? el(
        "ram:DefinedTradeContact",
        leaf("ram:PersonName", contact.name),
        el("ram:TelephoneUniversalCommunication", leaf("ram:CompleteNumber", contact.phone)),
        el("ram:EmailURIUniversalCommunication", leaf("ram:URIID", contact.email)),
      )
      : null,
    address(party.address),
    party.electronicAddress
      ? el("ram:URIUniversalCommunication", leaf("ram:URIID", party.electronicAddress.id, { schemeID: party.electronicAddress.schemeId }))
      : null,
    el("ram:SpecifiedTaxRegistration", leaf("ram:ID", party.vatId, { schemeID: "VA" })),
    role === "seller" ? el("ram:SpecifiedTaxRegistration", leaf("ram:ID", party.taxRegistrationId, { schemeID: "FC" })) : null,
  );
}

function tradeTax(category: VatCategory, rate: string): XmlElement[] {
  return [
    leaf("ram:TypeCode", "VAT")!,
    leaf("ram:CategoryCode", category)!,
    // EN 16931 BR-O-5 / BR-O-9: category O states no rate.
    ...(category === "O" ? [] : [leaf("ram:RateApplicablePercent", percent(rate))!]),
  ];
}

/** Render an invoice as CII. The caller has already judged it against the rules. */
export function renderCii(inv: EInvoice, profile: EInvoiceProfile): string {
  const d = inv.currencyDecimals;
  const amount = (value: string) => fixed(value, d);
  const transfer = inv.payment.creditTransfer;
  const accountId = transfer?.accountId?.trim() ?? "";
  const accountIsIban = accountId !== "" && validPaymentIban(accountId);
  const hasAllowances = inv.allowanceCharges.some((entry) => !entry.isCharge);
  const hasCharges = inv.allowanceCharges.some((entry) => entry.isCharge);

  const lines = inv.lines.map((line) =>
    required(
      "ram:IncludedSupplyChainTradeLineItem",
      {},
      el("ram:AssociatedDocumentLineDocument", leaf("ram:LineID", line.id), el("ram:IncludedNote", leaf("ram:Content", line.note))),
      el(
        "ram:SpecifiedTradeProduct",
        leaf("ram:SellerAssignedID", line.sellerItemId),
        leaf("ram:BuyerAssignedID", line.buyerItemId),
        leaf("ram:Name", line.name),
        leaf("ram:Description", line.description),
      ),
      el(
        "ram:SpecifiedLineTradeAgreement",
        el("ram:BuyerOrderReferencedDocument", leaf("ram:LineID", line.orderLineReference)),
        el(
          "ram:NetPriceProductTradePrice",
          leaf("ram:ChargeAmount", canonicalDecimal(line.netPrice)),
          line.baseQuantity ? leaf("ram:BasisQuantity", canonicalDecimal(line.baseQuantity), { unitCode: line.unitCode }) : null,
        ),
      ),
      el("ram:SpecifiedLineTradeDelivery", leaf("ram:BilledQuantity", canonicalDecimal(line.quantity), { unitCode: line.unitCode })),
      el(
        "ram:SpecifiedLineTradeSettlement",
        el("ram:ApplicableTradeTax", ...tradeTax(line.vatCategory, line.vatRate)),
        line.period
          ? el(
            "ram:BillingSpecifiedPeriod",
            dateTime("StartDateTime", line.period.start, "BT-134"),
            dateTime("EndDateTime", line.period.end, "BT-135"),
          )
          : null,
        el("ram:SpecifiedTradeSettlementLineMonetarySummation", leaf("ram:LineTotalAmount", amount(line.netAmount))),
        el("ram:ReceivableSpecifiedTradeAccountingAccount", leaf("ram:ID", line.accountingReference)),
      ),
    ));

  const agreement = required(
    "ram:ApplicableHeaderTradeAgreement",
    {},
    leaf("ram:BuyerReference", inv.buyerReference),
    tradeParty("SellerTradeParty", inv.seller, "seller"),
    tradeParty("BuyerTradeParty", inv.buyer, "buyer"),
    el("ram:SellerOrderReferencedDocument", leaf("ram:IssuerAssignedID", inv.salesOrderReference)),
    el("ram:BuyerOrderReferencedDocument", leaf("ram:IssuerAssignedID", inv.orderReference)),
    el("ram:ContractReferencedDocument", leaf("ram:IssuerAssignedID", inv.contractReference)),
    // D16B makes the project name mandatory; EN 16931 carries only the identifier (BT-11).
    inv.projectReference ? el("ram:SpecifiedProcuringProject", leaf("ram:ID", inv.projectReference), leaf("ram:Name", "Project")) : null,
  );

  const delivery = inv.delivery;
  // ApplicableHeaderTradeDelivery is mandatory in D16B even when it has no content.
  const deliveryNode = required(
    "ram:ApplicableHeaderTradeDelivery",
    {},
    delivery && (delivery.address || delivery.locationName)
      ? el("ram:ShipToTradeParty", leaf("ram:Name", delivery.locationName), address(delivery.address))
      : null,
    delivery?.date ? el("ram:ActualDeliverySupplyChainEvent", dateTime("OccurrenceDateTime", delivery.date, "BT-72")) : null,
  );

  const taxCurrency = inv.taxCurrency && inv.taxCurrency !== inv.currency ? inv.taxCurrency : null;
  const totals = inv.totals;
  const settlement = required(
    "ram:ApplicableHeaderTradeSettlement",
    {},
    leaf("ram:PaymentReference", inv.payment.remittanceInformation),
    leaf("ram:TaxCurrencyCode", taxCurrency),
    leaf("ram:InvoiceCurrencyCode", inv.currency),
    el(
      "ram:SpecifiedTradeSettlementPaymentMeans",
      leaf("ram:TypeCode", inv.payment.meansCode),
      leaf("ram:Information", inv.payment.meansText),
      transfer
        ? el(
          "ram:PayeePartyCreditorFinancialAccount",
          accountIsIban ? leaf("ram:IBANID", accountId.replace(/[\s-]+/g, "").toUpperCase()) : null,
          leaf("ram:AccountName", transfer.accountName),
          accountIsIban ? null : leaf("ram:ProprietaryID", accountId),
        )
        : null,
      transfer?.providerId && isValidBic(transfer.providerId)
        ? el("ram:PayeeSpecifiedCreditorFinancialInstitution", leaf("ram:BICID", transfer.providerId.trim().toUpperCase()))
        : null,
    ),
    ...inv.vatBreakdown.map((group) =>
      el(
        "ram:ApplicableTradeTax",
        leaf("ram:CalculatedAmount", amount(group.taxAmount)),
        leaf("ram:TypeCode", "VAT"),
        leaf("ram:ExemptionReason", group.exemptionReason),
        leaf("ram:BasisAmount", amount(group.taxableAmount)),
        leaf("ram:CategoryCode", group.category),
        leaf("ram:ExemptionReasonCode", group.exemptionReasonCode),
        inv.taxPointDate
          ? el("ram:TaxPointDate", leaf("udt:DateString", format102(inv.taxPointDate, "BT-7"), { format: "102" }))
          : null,
        group.category === "O" ? null : leaf("ram:RateApplicablePercent", percent(group.rate)),
      )),
    inv.invoicePeriod
      ? el(
        "ram:BillingSpecifiedPeriod",
        dateTime("StartDateTime", inv.invoicePeriod.start, "BT-73"),
        dateTime("EndDateTime", inv.invoicePeriod.end, "BT-74"),
      )
      : null,
    ...inv.allowanceCharges.map((entry) =>
      el(
        "ram:SpecifiedTradeAllowanceCharge",
        el("ram:ChargeIndicator", leaf("udt:Indicator", entry.isCharge ? "true" : "false")),
        entry.percent ? leaf("ram:CalculationPercent", percent(entry.percent)) : null,
        entry.baseAmount ? leaf("ram:BasisAmount", amount(entry.baseAmount)) : null,
        leaf("ram:ActualAmount", amount(entry.amount)),
        leaf("ram:ReasonCode", entry.reasonCode),
        leaf("ram:Reason", entry.reason),
        el("ram:CategoryTradeTax", ...tradeTax(entry.vatCategory, entry.vatRate)),
      )),
    // A due date without terms text still needs the payment terms container.
    el(
      "ram:SpecifiedTradePaymentTerms",
      leaf("ram:Description", inv.payment.terms),
      dateTime("DueDateDateTime", inv.dueDate, "BT-9"),
    ),
    el(
      "ram:SpecifiedTradeSettlementHeaderMonetarySummation",
      leaf("ram:LineTotalAmount", amount(totals.lineNet)),
      hasCharges ? leaf("ram:ChargeTotalAmount", amount(totals.charges)) : null,
      hasAllowances ? leaf("ram:AllowanceTotalAmount", amount(totals.allowances)) : null,
      leaf("ram:TaxBasisTotalAmount", amount(totals.taxExclusive)),
      leaf("ram:TaxTotalAmount", amount(totals.tax), { currencyID: inv.currency }),
      taxCurrency && inv.taxTotalInTaxCurrency
        ? leaf("ram:TaxTotalAmount", amount(inv.taxTotalInTaxCurrency), { currencyID: taxCurrency })
        : null,
      isZeroDecimal(totals.rounding) ? null : leaf("ram:RoundingAmount", amount(totals.rounding)),
      leaf("ram:GrandTotalAmount", amount(totals.taxInclusive)),
      isZeroDecimal(totals.prepaid) ? null : leaf("ram:TotalPrepaidAmount", amount(totals.prepaid)),
      leaf("ram:DuePayableAmount", amount(totals.payable)),
    ),
    ...inv.precedingInvoices.map((entry) =>
      el(
        "ram:InvoiceReferencedDocument",
        leaf("ram:IssuerAssignedID", entry.number),
        entry.issueDate
          ? el("ram:FormattedIssueDateTime", leaf("qdt:DateTimeString", format102(entry.issueDate, "BT-26"), { format: "102" }))
          : null,
      )),
  );

  const root = required(
    "rsm:CrossIndustryInvoice",
    { "xmlns:rsm": NS.rsm, "xmlns:ram": NS.ram, "xmlns:udt": NS.udt, "xmlns:qdt": NS.qdt },
    required(
      "rsm:ExchangedDocumentContext",
      {},
      el("ram:BusinessProcessSpecifiedDocumentContextParameter", leaf("ram:ID", profile.businessProcessId)),
      el("ram:GuidelineSpecifiedDocumentContextParameter", leaf("ram:ID", profile.guidelineId)),
    ),
    required(
      "rsm:ExchangedDocument",
      {},
      leaf("ram:ID", inv.number),
      leaf("ram:TypeCode", inv.typeCode),
      el("ram:IssueDateTime", leaf("udt:DateTimeString", format102(inv.issueDate, "BT-2"), { format: "102" })),
      ...inv.notes.map((note) => el("ram:IncludedNote", leaf("ram:Content", note))),
    ),
    required("rsm:SupplyChainTradeTransaction", {}, ...lines, agreement, deliveryNode, settlement),
  );
  return serializeXml(root);
}

import { add, cmp, fromUnits, sum, toUnits } from "../money/money.ts";
import { isIso4217CurrencyCode } from "../fx/currencies.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import {
  analyzeAzureDocument,
  applyAzurePageGeometry,
  azureCapturedMoney as capturedMoney,
  azureDocumentConfidence,
  azureEvidence as evidenceFor,
  azureFieldConfidence as confidence,
  azureFieldText as textValue,
  invalidMoneyIssue,
  isCanonicalMoney,
  withinNumeric19_4 as numeric19_4,
  type AddressLookup,
  type AzureAnalyzeResponse,
  type AzureField,
  type CaptureEvidence,
  type CaptureIssue,
} from "./document-capture-azure.ts";

export type { AddressLookup, CaptureEvidence, CaptureIssue };
export {
  AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
  captureContentMatchesMime,
  DocumentEndpointError,
  normalizeCapturedDecimal,
  testAzureDocumentProvider,
  validateAzureDocumentEndpoint,
  verifyAzureDocumentEndpoint,
} from "./document-capture-azure.ts";

export const DEFAULT_INVOICE_MODEL = "prebuilt-invoice";

export type CaptureLine = {
  description: string;
  productCode: string | null;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  amount: string;
  taxAmount: string;
  accountId?: string | null;
  itemId?: string | null;
  purchaseOrderLineId?: string | null;
  confidence: string | null;
};

export type NormalizedCapture = {
  vendorName: string | null;
  vendorTaxId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  purchaseOrderNumber: string | null;
  currency: string | null;
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
  memo: string | null;
  lines: CaptureLine[];
};

export function validatePurchaseOrderQuantities(input: {
  invoiceQuantity: string;
  orderedQuantity: string;
  billedQuantity: string;
  fulfilledQuantity: string;
  requiresReceipt: boolean;
}): Array<{ code: "po_quantity_exceeded" | "receipt_quantity_shortfall"; expected: string; actual: string }> {
  const billable = fromUnits(toUnits(input.orderedQuantity) - toUnits(input.billedQuantity));
  const issues: Array<{ code: "po_quantity_exceeded" | "receipt_quantity_shortfall"; expected: string; actual: string }> = [];
  if (cmp(input.invoiceQuantity, billable) > 0) {
    issues.push({ code: "po_quantity_exceeded", expected: billable, actual: input.invoiceQuantity });
  }
  if (input.requiresReceipt) {
    const received = fromUnits(toUnits(input.fulfilledQuantity) - toUnits(input.billedQuantity));
    if (cmp(input.invoiceQuantity, received) > 0) {
      issues.push({ code: "receipt_quantity_shortfall", expected: received, actual: input.invoiceQuantity });
    }
  }
  return issues;
}

function exactProduct(quantity: string, price: string): string {
  const product = toUnits(quantity) * toUnits(price);
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const rounded = (absolute + 5_000n) / 10_000n;
  return fromUnits(negative ? -rounded : rounded);
}

function normalizeLine(item: AzureField, index: number, evidence: CaptureEvidence[]): CaptureLine | null {
  const fields = item.valueObject ?? {};
  const description = textValue(fields.Description) ?? textValue(fields.ItemDescription) ?? "";
  const productCode = textValue(fields.ProductCode);
  const quantity = capturedMoney(fields.Quantity);
  const unitPrice = capturedMoney(fields.UnitPrice);
  const extractedAmount = capturedMoney(fields.Amount);
  const tax = capturedMoney(fields.Tax);
  // Refused OCR text is preserved verbatim so every boundary re-derives the
  // named refusal from the stored capture; only truly absent fields take the
  // legacy defaults. Derivations run on canonical inputs alone.
  const quantityValue = quantity.canonical ?? quantity.supplied ?? "1.0000";
  const unitPriceValue = unitPrice.canonical ?? unitPrice.supplied;
  // Absent quantity keeps the legacy "1.0000" derivation input; refused text
  // derives nothing.
  const quantityForMath = quantity.canonical ?? (quantity.supplied === null ? "1.0000" : null);
  const amountValue = extractedAmount.canonical ?? extractedAmount.supplied
    ?? (unitPrice.canonical && quantityForMath ? exactProduct(quantityForMath, unitPrice.canonical) : null);
  if (!description && !productCode && amountValue === null) return null;
  const canonicalPrice = unitPriceValue
    ?? (quantityForMath !== null && cmp(quantityForMath, "0") === 0 ? "0.0000" : amountValue ?? "0.0000");
  const taxValue = tax.canonical ?? tax.supplied ?? "0.0000";

  const mapped: Array<[string, AzureField | undefined, unknown]> = [
    ["lines.description", fields.Description ?? fields.ItemDescription, description],
    ["lines.productCode", fields.ProductCode, productCode],
    ["lines.quantity", fields.Quantity, quantityValue],
    ["lines.unit", fields.Unit, textValue(fields.Unit)],
    ["lines.unitPrice", fields.UnitPrice, canonicalPrice],
    ["lines.amount", fields.Amount, amountValue ?? "0.0000"],
    ["lines.taxAmount", fields.Tax, taxValue],
  ];
  for (const [key, field, value] of mapped) if (field) evidence.push(evidenceFor(key, field, value, index));

  const confidences = Object.values(fields).map(confidence).filter((v): v is string => v !== null);
  const average = confidences.length
    ? (confidences.reduce((n, v) => n + Number(v), 0) / confidences.length).toFixed(4)
    : confidence(item);
  return {
    description,
    productCode,
    quantity: quantityValue,
    unit: textValue(fields.Unit),
    unitPrice: canonicalPrice,
    amount: amountValue ?? "0.0000",
    taxAmount: taxValue,
    confidence: average,
  };
}

const HEADER_FIELDS: Record<
  keyof Omit<NormalizedCapture, "lines">,
  { names: string[]; kind: "text" | "money" }
> = {
  vendorName: { names: ["VendorName", "VendorAddressRecipient", "MerchantName"], kind: "text" },
  vendorTaxId: { names: ["VendorTaxId", "VendorTaxID", "VendorRegistrationId"], kind: "text" },
  invoiceNumber: { names: ["InvoiceId", "InvoiceNumber", "ReceiptId"], kind: "text" },
  invoiceDate: { names: ["InvoiceDate", "TransactionDate"], kind: "text" },
  dueDate: { names: ["DueDate"], kind: "text" },
  purchaseOrderNumber: { names: ["PurchaseOrder"], kind: "text" },
  currency: { names: ["CurrencyCode"], kind: "text" },
  subtotal: { names: ["SubTotal", "Subtotal"], kind: "money" },
  taxTotal: { names: ["TotalTax"], kind: "money" },
  total: { names: ["InvoiceTotal", "Total"], kind: "money" },
  memo: { names: ["Memo", "Notes", "Comments", "Description"], kind: "text" },
};

/** Translate the current Azure invoice model into the stable capture contract. */
export function normalizeAzureInvoice(raw: AzureAnalyzeResponse): {
  normalized: NormalizedCapture;
  evidence: CaptureEvidence[];
  overallConfidence: string | null;
} {
  const document = raw.analyzeResult?.documents?.[0];
  if (!document) throw new Error("Document provider returned no recognized document");
  const fields = document.fields ?? {};
  const evidence: CaptureEvidence[] = [];
  const header: Record<string, string | null> = {};
  for (const [key, spec] of Object.entries(HEADER_FIELDS)) {
    const sourceName = spec.names.find((name) => fields[name]);
    const field = sourceName ? fields[sourceName] : undefined;
    // Refused header money is preserved as supplied raw text (never nulled
    // into a silent default) so validation names the refusal at every
    // boundary; truly absent money stays null and takes the required-field path.
    const reading = spec.kind === "money" ? capturedMoney(field) : null;
    const value = reading ? (reading.canonical ?? reading.supplied) : textValue(field);
    header[key] = value;
    if (field) evidence.push(evidenceFor(key, field, value, null));
  }
  if (!header.currency) {
    header.currency = fields.InvoiceTotal?.valueCurrency?.currencyCode
      ?? fields.SubTotal?.valueCurrency?.currencyCode
      ?? null;
  }
  const itemField = fields.Items ?? fields.LineItems;
  const lines = (itemField?.valueArray ?? [])
    .map((item, index) => normalizeLine(item, index, evidence))
    .filter((line): line is CaptureLine => line !== null);
  applyAzurePageGeometry(raw, evidence);
  return {
    normalized: { ...(header as Omit<NormalizedCapture, "lines">), lines },
    evidence,
    overallConfidence: azureDocumentConfidence(document),
  };
}

export function validateNormalizedCapture(
  capture: NormalizedCapture,
  confidenceThreshold = "0.9000",
): CaptureIssue[] {
  const issues: CaptureIssue[] = [];
  for (const field of ["vendorName", "invoiceNumber", "invoiceDate", "total"] as const) {
    if (!capture[field]) issues.push({ code: "required_field", severity: "blocking", field });
  }
  if (capture.invoiceDate && !isIsoCalendarDate(capture.invoiceDate)) {
    issues.push({ code: "invalid_date", severity: "blocking", field: "invoiceDate" });
  }
  if (capture.dueDate && !isIsoCalendarDate(capture.dueDate)) {
    issues.push({ code: "invalid_date", severity: "blocking", field: "dueDate" });
  }
  // Membership in the shared ISO 4217 registry, not shape: an OCR misread
  // like "ZZZ" passes a three-letter check but denominates nothing, and the
  // ledger boundary refuses it at post — so capture refuses it here, naming
  // the supplied code and the correction, instead of parking it for review
  // purgatory or letting it through to a doomed draft.
  if (capture.currency && !isIso4217CurrencyCode(capture.currency)) {
    issues.push({
      code: "invalid_currency",
      severity: "blocking",
      field: "currency",
      actual: capture.currency,
      message:
        `Capture currency ${JSON.stringify(capture.currency)} is not an ISO 4217 code — ` +
        `correct it to the 3-letter code on the invoice before resubmitting`,
    });
  }
  // Refused OCR text is preserved verbatim in the capture, so validation must
  // name it as a blocking refusal — never throw on it and never read it as math.
  for (const [field, value] of [["subtotal", capture.subtotal], ["taxTotal", capture.taxTotal], ["total", capture.total]] as const) {
    if (!value) continue;
    if (!isCanonicalMoney(value)) issues.push(invalidMoneyIssue(field, "an amount", value, { field }));
    else if (!numeric19_4(value)) issues.push({ code: "amount_out_of_range", severity: "blocking", field });
  }
  if (capture.lines.length === 0) issues.push({ code: "missing_lines", severity: "blocking", field: "lines" });
  capture.lines.forEach((line, lineIndex) => {
    if (!line.description && !line.productCode) {
      issues.push({ code: "missing_line_description", severity: "warning", lineIndex });
    }
    const entries = [
      ["quantity", line.quantity, "a quantity"],
      ["unitPrice", line.unitPrice, "an amount"],
      ["amount", line.amount, "an amount"],
      ["taxAmount", line.taxAmount, "an amount"],
    ] as const;
    let lineMoneyValid = true;
    for (const [key, value, noun] of entries) {
      if (!isCanonicalMoney(value)) {
        issues.push(invalidMoneyIssue(`line ${lineIndex + 1} ${key}`, noun, value, { field: key, lineIndex }));
        lineMoneyValid = false;
      } else if (!numeric19_4(value)) {
        issues.push({ code: "amount_out_of_range", severity: "blocking", lineIndex });
      }
    }
    if (lineMoneyValid) {
      const expected = exactProduct(line.quantity, line.unitPrice);
      if (cmp(expected, line.amount) !== 0) {
        issues.push({ code: "line_math_mismatch", severity: "blocking", lineIndex, expected, actual: line.amount });
      }
    }
    if (line.confidence && cmp(line.confidence, confidenceThreshold) < 0) {
      issues.push({ code: "low_confidence", severity: "warning", lineIndex });
    }
  });
  // Cross-totals only run when every input they read is canonical; refused
  // text already has its own blocking refusal above.
  const amountsCanonical = capture.lines.every((line) => isCanonicalMoney(line.amount));
  const taxesCanonical = capture.lines.every((line) => isCanonicalMoney(line.taxAmount));
  const lineSubtotal = amountsCanonical ? sum(capture.lines.map((line) => line.amount)) : null;
  const lineTax = taxesCanonical ? sum(capture.lines.map((line) => line.taxAmount)) : null;
  if (capture.subtotal && isCanonicalMoney(capture.subtotal) && lineSubtotal !== null
    && cmp(capture.subtotal, lineSubtotal) !== 0) {
    issues.push({ code: "subtotal_mismatch", severity: "blocking", expected: lineSubtotal, actual: capture.subtotal });
  }
  const subtotal = capture.subtotal && isCanonicalMoney(capture.subtotal) ? capture.subtotal : lineSubtotal;
  const tax = capture.taxTotal && isCanonicalMoney(capture.taxTotal) ? capture.taxTotal : lineTax;
  if (capture.taxTotal && isCanonicalMoney(capture.taxTotal) && lineTax !== null
    && cmp(capture.taxTotal, lineTax) !== 0) {
    issues.push({ code: "line_tax_mismatch", severity: "blocking", expected: lineTax, actual: capture.taxTotal });
  }
  if (capture.total && isCanonicalMoney(capture.total) && subtotal !== null && tax !== null) {
    const expected = add(subtotal, tax);
    if (cmp(expected, capture.total) !== 0) {
      issues.push({ code: "total_mismatch", severity: "blocking", expected, actual: capture.total });
    }
  }
  return issues;
}

/** Production Azure REST adapter: submit bytes, poll asynchronously, retain raw evidence. */
export async function extractAzureInvoice(input: {
  endpoint: string;
  apiKey: string;
  model?: string;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
  lookup?: AddressLookup;
}): Promise<{ raw: AzureAnalyzeResponse; normalized: NormalizedCapture; evidence: CaptureEvidence[]; overallConfidence: string | null }> {
  const raw = await analyzeAzureDocument({ ...input, model: input.model?.trim() || DEFAULT_INVOICE_MODEL });
  return { raw, ...normalizeAzureInvoice(raw) };
}

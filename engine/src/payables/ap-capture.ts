import { add, cmp, fromUnits, sum, toUnits } from "../money/money.ts";
import { fromQuantityUnits, toQuantityUnits } from "../money/quantity.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
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

import {
  extractJsonObject,
  llmEvidence,
  llmMoney,
  llmOverallConfidence,
  readLlmField,
  requestLlmVision,
  type LlmField,
  type LlmVisionConfig,
} from "./document-capture-llm.ts";

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
  cancelledQuantity: string;
  billedQuantity: string;
  fulfilledQuantity: string;
  requiresReceipt: boolean;
}): Array<{
  code: "po_quantity_exceeded" | "receipt_quantity_shortfall";
  expected: string;
  actual: string;
}> {
  const invoiceUnits = toQuantityUnits(input.invoiceQuantity);
  const billableUnits =
    toQuantityUnits(input.orderedQuantity) -
    toQuantityUnits(input.cancelledQuantity) -
    toQuantityUnits(input.billedQuantity);
  const billable = fromQuantityUnits(billableUnits > 0n ? billableUnits : 0n);
  const issues: Array<{
    code: "po_quantity_exceeded" | "receipt_quantity_shortfall";
    expected: string;
    actual: string;
  }> = [];
  if (invoiceUnits > billableUnits) {
    issues.push({
      code: "po_quantity_exceeded",
      expected: billable,
      actual: fromQuantityUnits(invoiceUnits),
    });
  }
  if (input.requiresReceipt) {
    const receivedUnits =
      toQuantityUnits(input.fulfilledQuantity) - toQuantityUnits(input.billedQuantity);
    const received = fromQuantityUnits(receivedUnits > 0n ? receivedUnits : 0n);
    if (invoiceUnits > receivedUnits) {
      issues.push({
        code: "receipt_quantity_shortfall",
        expected: received,
        actual: fromQuantityUnits(invoiceUnits),
      });
    }
  }
  return issues;
}

function exactProduct(quantity: string, price: string): string {
  const product = toQuantityUnits(quantity) * toUnits(price);
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const rounded = (absolute + 50_000_000n) / 100_000_000n;
  return fromUnits(negative ? -rounded : rounded);
}

function normalizeLine(
  item: AzureField,
  index: number,
  evidence: CaptureEvidence[],
): CaptureLine | null {
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
  const amountValue =
    extractedAmount.canonical ??
    extractedAmount.supplied ??
    (unitPrice.canonical && quantityForMath
      ? exactProduct(quantityForMath, unitPrice.canonical)
      : null);
  if (!description && !productCode && amountValue === null) return null;
  const canonicalPrice =
    unitPriceValue ??
    (quantityForMath !== null && cmp(quantityForMath, "0") === 0
      ? "0.0000"
      : (amountValue ?? "0.0000"));
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
  for (const [key, field, value] of mapped)
    if (field) evidence.push(evidenceFor(key, field, value, index));

  const confidences = Object.values(fields)
    .map(confidence)
    .filter((v): v is string => v !== null);
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
    header.currency =
      fields.InvoiceTotal?.valueCurrency?.currencyCode ??
      fields.SubTotal?.valueCurrency?.currencyCode ??
      null;
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
  for (const [field, value] of [
    ["subtotal", capture.subtotal],
    ["taxTotal", capture.taxTotal],
    ["total", capture.total],
  ] as const) {
    if (!value) continue;
    if (!isCanonicalMoney(value))
      issues.push(invalidMoneyIssue(field, "an amount", value, { field }));
    else if (!numeric19_4(value))
      issues.push({ code: "amount_out_of_range", severity: "blocking", field });
  }
  if (capture.lines.length === 0)
    issues.push({ code: "missing_lines", severity: "blocking", field: "lines" });
  capture.lines.forEach((line, lineIndex) => {
    if (!line.description && !line.productCode) {
      issues.push({ code: "missing_line_description", severity: "warning", lineIndex });
    }
    const quantityValid = canonicalDecimal(line.quantity, 8) !== null;
    if (!quantityValid) {
      issues.push(
        invalidMoneyIssue(
          `line ${lineIndex + 1} quantity`,
          "a quantity",
          line.quantity,
          { field: "quantity", lineIndex },
          8,
        ),
      );
    }
    const entries = [
      ["unitPrice", line.unitPrice, "an amount"],
      ["amount", line.amount, "an amount"],
      ["taxAmount", line.taxAmount, "an amount"],
    ] as const;
    let lineMoneyValid = true;
    for (const [key, value, noun] of entries) {
      if (!isCanonicalMoney(value)) {
        issues.push(
          invalidMoneyIssue(`line ${lineIndex + 1} ${key}`, noun, value, { field: key, lineIndex }),
        );
        lineMoneyValid = false;
      } else if (!numeric19_4(value)) {
        issues.push({ code: "amount_out_of_range", severity: "blocking", lineIndex });
      }
    }
    if (quantityValid && lineMoneyValid) {
      const expected = exactProduct(line.quantity, line.unitPrice);
      if (cmp(expected, line.amount) !== 0) {
        issues.push({
          code: "line_math_mismatch",
          severity: "blocking",
          lineIndex,
          expected,
          actual: line.amount,
        });
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
  if (
    capture.subtotal &&
    isCanonicalMoney(capture.subtotal) &&
    lineSubtotal !== null &&
    cmp(capture.subtotal, lineSubtotal) !== 0
  ) {
    issues.push({
      code: "subtotal_mismatch",
      severity: "blocking",
      expected: lineSubtotal,
      actual: capture.subtotal,
    });
  }
  const subtotal =
    capture.subtotal && isCanonicalMoney(capture.subtotal) ? capture.subtotal : lineSubtotal;
  const tax = capture.taxTotal && isCanonicalMoney(capture.taxTotal) ? capture.taxTotal : lineTax;
  if (
    capture.taxTotal &&
    isCanonicalMoney(capture.taxTotal) &&
    lineTax !== null &&
    cmp(capture.taxTotal, lineTax) !== 0
  ) {
    issues.push({
      code: "line_tax_mismatch",
      severity: "blocking",
      expected: lineTax,
      actual: capture.taxTotal,
    });
  }
  if (capture.total && isCanonicalMoney(capture.total) && subtotal !== null && tax !== null) {
    const expected = add(subtotal, tax);
    if (cmp(expected, capture.total) !== 0) {
      issues.push({
        code: "total_mismatch",
        severity: "blocking",
        expected,
        actual: capture.total,
      });
    }
  }
  return issues;
}

/**
 * The invoice reading contract an AI model answers. Values are copied as
 * printed; nothing is computed, inferred or defaulted.
 */
export const INVOICE_LLM_PROMPT = [
  "You read one vendor invoice or bill. Answer with ONLY a JSON object: no prose, no code fences.",
  'Every header field is an object {"value": ..., "confidence": number from 0 to 1} giving your confidence that the value is exactly what the document prints.',
  "Use null for any value that is not visible or not legible. Never guess, infer, compute or default a value.",
  "Use exactly these keys:",
  "{",
  '  "vendorName": {"value": string|null, "confidence": number},',
  '  "vendorTaxId": {"value": string|null, "confidence": number},',
  '  "invoiceNumber": {"value": string|null, "confidence": number},',
  '  "invoiceDate": {"value": "YYYY-MM-DD"|null, "confidence": number},',
  '  "dueDate": {"value": "YYYY-MM-DD"|null, "confidence": number},',
  '  "purchaseOrderNumber": {"value": string|null, "confidence": number},',
  '  "currency": {"value": string|null, "confidence": number},',
  '  "subtotal": {"value": string|null, "confidence": number},',
  '  "taxTotal": {"value": string|null, "confidence": number},',
  '  "total": {"value": string|null, "confidence": number},',
  '  "memo": {"value": string|null, "confidence": number},',
  '  "lines": [{"description": string|null, "productCode": string|null, "quantity": string|null, "unit": string|null, "unitPrice": string|null, "amount": string|null, "taxAmount": string|null, "confidence": number}]',
  "}",
  "Dates are set only when the printed date has exactly one reading. currency is the ISO 4217 code only when the document prints it.",
  "Amounts and quantities are strings with the digits as printed, using a dot as the decimal point and no currency symbols or thousands separators.",
  "List at most 200 lines.",
].join("\n");

const LLM_HEADER_FIELDS = [
  "vendorName",
  "vendorTaxId",
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "purchaseOrderNumber",
  "currency",
  "subtotal",
  "taxTotal",
  "total",
  "memo",
] as const satisfies readonly (keyof Omit<NormalizedCapture, "lines">)[];
const LLM_MONEY_FIELDS = new Set<string>(["subtotal", "taxTotal", "total"]);

/**
 * Translate an AI model's invoice answer into the stable capture contract.
 * A header field read below the organization's confidence threshold stays
 * blank (its reading kept as evidence) and is flagged, so required fields
 * block until a reviewer confirms them; nothing is filled from a guess.
 */
export function normalizeLlmInvoice(
  answer: Record<string, unknown>,
  confidenceThreshold: string,
): {
  normalized: NormalizedCapture;
  evidence: CaptureEvidence[];
  overallConfidence: string | null;
  issues: CaptureIssue[];
} {
  if (!("total" in answer) && !("vendorName" in answer) && !("lines" in answer)) {
    throw new Error("The AI model's answer was not an invoice reading — retry the capture");
  }
  const evidence: CaptureEvidence[] = [];
  const issues: CaptureIssue[] = [];
  const header: Record<string, string | null> = {};
  const fields: Record<string, LlmField> = {};
  for (const key of LLM_HEADER_FIELDS) {
    const field = readLlmField(answer[key]);
    fields[key] = field;
    const reading = LLM_MONEY_FIELDS.has(key) ? llmMoney(field) : null;
    let value = reading ? (reading.canonical ?? reading.supplied) : field.value;
    if (key === "currency" && value) value = value.toUpperCase();
    if (field.value !== null) evidence.push(llmEvidence(key, field, value));
    const confident = field.confidence !== null && cmp(field.confidence, confidenceThreshold) >= 0;
    if (value !== null && !confident) {
      issues.push({
        code: "low_confidence",
        severity: "warning",
        field: key,
        ...(field.confidence !== null ? { actual: field.confidence } : {}),
        expected: confidenceThreshold,
      });
      value = null;
    }
    header[key] = value;
  }
  const lines: CaptureLine[] = [];
  for (const entry of (Array.isArray(answer.lines) ? answer.lines : []).slice(0, 200)) {
    const line =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    const index = lines.length;
    const confidence = readLlmField({ value: null, confidence: line.confidence }).confidence;
    const text = (key: string) =>
      typeof line[key] === "string" ? (line[key] as string).trim() || null : null;
    const money = (key: string) => {
      const field = readLlmField({ value: line[key], confidence: line.confidence });
      const reading = llmMoney(field);
      const value = reading.canonical ?? reading.supplied;
      if (field.value !== null) evidence.push(llmEvidence(`lines.${key}`, field, value, index));
      return { canonical: reading.canonical, value };
    };
    const description = text("description") ?? "";
    const productCode = text("productCode");
    const quantity = money("quantity");
    const unitPrice = money("unitPrice");
    const amount = money("amount");
    const tax = money("taxAmount");
    if (!description && !productCode && amount.value === null) continue;
    if (description)
      evidence.push(
        llmEvidence(
          "lines.description",
          { value: description, confidence, raw: description },
          description,
          index,
        ),
      );
    // An absent quantity reads as one unit and an absent tax as none, exactly
    // as for any provider; refused text is preserved for the reviewer.
    const quantityValue = quantity.value ?? "1.0000";
    const quantityForMath = quantity.canonical ?? (quantity.value === null ? "1.0000" : null);
    const amountValue =
      amount.value ??
      (unitPrice.canonical && quantityForMath
        ? exactProduct(quantityForMath, unitPrice.canonical)
        : null);
    lines.push({
      description,
      productCode,
      quantity: quantityValue,
      unit: text("unit"),
      unitPrice: unitPrice.value ?? amountValue ?? "0.0000",
      amount: amountValue ?? "0.0000",
      taxAmount: tax.value ?? "0.0000",
      confidence,
    });
  }
  return {
    normalized: { ...(header as Omit<NormalizedCapture, "lines">), lines },
    evidence,
    overallConfidence: llmOverallConfidence([
      fields.vendorName!,
      fields.invoiceNumber!,
      fields.total!,
    ]),
    issues,
  };
}

/** Read one invoice through the organization's AI model and normalize the answer. */
export async function extractLlmInvoice(input: {
  config: LlmVisionConfig;
  confidenceThreshold: string;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
  lookup?: AddressLookup;
}): Promise<{
  raw: { answer: string };
  normalized: NormalizedCapture;
  evidence: CaptureEvidence[];
  overallConfidence: string | null;
  issues: CaptureIssue[];
}> {
  const answer = await requestLlmVision({ ...input, prompt: INVOICE_LLM_PROMPT });
  const parsed = extractJsonObject(answer);
  if (!parsed)
    throw new Error("The AI model did not answer with an invoice reading — retry the capture");
  return { raw: { answer }, ...normalizeLlmInvoice(parsed, input.confidenceThreshold) };
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
}): Promise<{
  raw: AzureAnalyzeResponse;
  normalized: NormalizedCapture;
  evidence: CaptureEvidence[];
  overallConfidence: string | null;
}> {
  const raw = await analyzeAzureDocument({
    ...input,
    model: input.model?.trim() || DEFAULT_INVOICE_MODEL,
  });
  return { raw, ...normalizeAzureInvoice(raw) };
}

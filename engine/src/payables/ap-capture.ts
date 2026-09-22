import { canonicalDecimal } from "../money/exact-decimal.ts";
import { add, cmp, fromUnits, sum, toUnits } from "../money/money.ts";
import { decimalNullCause, decimalNullRefusal } from "../money/decimal-refusal.ts";

export const AZURE_DOCUMENT_INTELLIGENCE_API_VERSION = "2024-11-30";
export const DEFAULT_INVOICE_MODEL = "prebuilt-invoice";

/** Reject mislabeled uploads before they enter the evidence store or provider queue. */
export function captureContentMatchesMime(bytes: Uint8Array, contentType: string): boolean {
  const prefix = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (contentType === "application/pdf") return prefix(0x25, 0x50, 0x44, 0x46);
  if (contentType === "image/jpeg") return prefix(0xff, 0xd8, 0xff);
  if (contentType === "image/png") return prefix(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (contentType === "image/tiff") {
    return prefix(0x49, 0x49, 0x2a, 0x00) || prefix(0x4d, 0x4d, 0x00, 0x2a);
  }
  return false;
}

export type CaptureEvidence = {
  fieldKey: string;
  lineIndex: number | null;
  rawValue: string | null;
  normalizedValue: unknown;
  confidence: string | null;
  pageNumber: number | null;
  polygon: { points: number[]; width: number; height: number } | null;
};

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

export type CaptureIssue = {
  code: string;
  severity: "blocking" | "warning";
  field?: string;
  lineIndex?: number;
  expected?: string;
  actual?: string;
  /**
   * The operator-facing refusal naming the remedy, when the code alone does
   * not carry it. The review drawer renders this verbatim when present and
   * falls back to its translated code text otherwise.
   */
  message?: string;
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

type AzureRegion = { pageNumber?: number; polygon?: number[] };
type AzureField = {
  type?: string;
  content?: string;
  confidence?: number;
  valueString?: string;
  valueDate?: string;
  valueNumber?: number;
  valueCurrency?: { amount?: number; currencyCode?: string };
  valueAddress?: Record<string, string>;
  valueArray?: AzureField[];
  valueObject?: Record<string, AzureField>;
  boundingRegions?: AzureRegion[];
};
type AzureAnalyzeResponse = {
  status?: string;
  error?: { code?: string; message?: string };
  analyzeResult?: {
    documents?: Array<{ confidence?: number; fields?: Record<string, AzureField> }>;
    pages?: Array<{ pageNumber?: number; width?: number; height?: number }>;
    content?: string;
  };
};

function firstRegion(field: AzureField): AzureRegion | undefined {
  return field.boundingRegions?.[0];
}

function confidence(field: AzureField | undefined): string | null {
  if (field?.confidence === undefined || !Number.isFinite(field.confidence)) return null;
  const bounded = Math.min(1, Math.max(0, field.confidence));
  return bounded.toFixed(4);
}

function textValue(field: AzureField | undefined): string | null {
  if (!field) return null;
  if (typeof field.valueString === "string") return field.valueString.trim() || null;
  if (typeof field.valueDate === "string") return field.valueDate.trim() || null;
  if (field.valueAddress) {
    const a = field.valueAddress;
    const parts = [a.houseNumber, a.road, a.city, a.state, a.postalCode, a.countryRegion].filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return field.content?.trim() || null;
}

/** Canonical numeric(19,4) parser for OCR text. It never uses floating money math. */
export function normalizeCapturedDecimal(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let raw = String(value).trim().replace(/[\u00a0\s]/g, "");
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)[eE][-+]?\d+$/.test(raw)) return fromUnits(toUnits(raw));
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith("-");
  raw = raw.replace(/[()]/g, "").replace(/^[+-]/, "").replace(/[^0-9.,]/g, "");
  if (!raw) return null;

  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    raw = raw.replace(thousands, "").replace(decimal, ".");
  } else if (lastComma >= 0) {
    // A lone comma is two readings, never a guess: let the shared decimal
    // classifier decide. Ambiguous text ("1,234") is refused by name, the
    // decimal-comma reading ("12,34") keeps its dotted value, and pure
    // grouping ("1,234,567") strips. A typed provider number never reaches
    // this branch — String(number) has no comma — so nothing canonical is lost.
    const cause = decimalNullCause(`${negative ? "-" : ""}${raw}`);
    if (cause.cause === "ambiguous-comma") return null;
    if (cause.cause === "decimal-comma") raw = raw.replace(/,/g, ".");
    else if (cause.cause === "separator") raw = raw.replace(/,/g, "");
    else return null;
  } else if ((raw.match(/\./g) ?? []).length > 1) {
    // Two or more dots is two readings, never a guess: "1.234.567" is
    // one-point-two million in every dot-grouped locale (DE, IT, ES) and a
    // misread decimal in others, and the old last-dot-is-the-point rule
    // turned the German reading into 1234.567 — a 1000x understated total
    // that looked plausible in review. Refuse instead: the raw text rides
    // through as `supplied` so the reviewer sees what the document said.
    return null;
  }
  const signed = `${negative ? "-" : ""}${raw}`;
  return fromUnits(toUnits(signed));
}

/**
 * A captured money reading with its provenance split: `canonical` is ledger
 * money, `supplied` is raw OCR text the parser refused. Typed numeric fields
 * do not carry comma-separator ambiguity; raw supplied text must survive
 * refusal so every boundary can name it.
 */
function capturedMoney(field: AzureField | undefined): { canonical: string | null; supplied: string | null } {
  if (!field) return { canonical: null, supplied: null };
  const typed = field.valueCurrency?.amount ?? field.valueNumber;
  if (typeof typed === "number") {
    if (!Number.isFinite(typed)) return { canonical: null, supplied: null };
    return { canonical: normalizeCapturedDecimal(typed), supplied: null };
  }
  const text = typeof typed === "string" ? typed : field.content;
  if (typeof text === "number") return { canonical: normalizeCapturedDecimal(text), supplied: null };
  if (typeof text !== "string" || text.trim() === "") return { canonical: null, supplied: null };
  const canonical = normalizeCapturedDecimal(text);
  return canonical === null ? { canonical: null, supplied: text.trim() } : { canonical, supplied: null };
}


function evidenceFor(fieldKey: string, field: AzureField, normalizedValue: unknown, lineIndex: number | null): CaptureEvidence {
  const region = firstRegion(field);
  return {
    fieldKey,
    lineIndex,
    rawValue: field.content ?? textValue(field),
    normalizedValue,
    confidence: confidence(field),
    pageNumber: region?.pageNumber ?? null,
    polygon: region?.polygon ? { points: region.polygon, width: 0, height: 0 } : null,
  };
}

function exactProduct(quantity: string, price: string): string {
  const product = toUnits(quantity) * toUnits(price);
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const rounded = (absolute + 5_000n) / 10_000n;
  return fromUnits(negative ? -rounded : rounded);
}

const MAX_NUMERIC_19_4_UNITS = 9_999_999_999_999_999_999n;

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function numeric19_4(value: string): boolean {
  const units = toUnits(value);
  return units >= -MAX_NUMERIC_19_4_UNITS && units <= MAX_NUMERIC_19_4_UNITS;
}

/** Ledger-canonical money or quantity text, the only shape math may read. */
function isCanonicalMoney(value: string): boolean {
  return canonicalDecimal(value, 4) !== null;
}

function invalidMoneyIssue(fieldLabel: string, noun: string, raw: string, extra: Partial<CaptureIssue> = {}): CaptureIssue {
  return {
    code: "invalid_amount",
    severity: "blocking",
    actual: raw,
    message: decimalNullRefusal(fieldLabel, noun, raw, 4),
    ...extra,
  };
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
  const pages = new Map((raw.analyzeResult?.pages ?? [])
    .filter((page) => page.pageNumber && page.width && page.height)
    .map((page) => [page.pageNumber!, { width: page.width!, height: page.height! }]));
  for (const field of evidence) {
    const page = field.pageNumber ? pages.get(field.pageNumber) : undefined;
    if (field.polygon && page) field.polygon = { ...field.polygon, ...page };
    else field.polygon = null;
  }
  return {
    normalized: { ...(header as Omit<NormalizedCapture, "lines">), lines },
    evidence,
    overallConfidence: document.confidence === undefined
      ? null
      : Math.min(1, Math.max(0, document.confidence)).toFixed(4),
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
  if (capture.invoiceDate && !validIsoDate(capture.invoiceDate)) {
    issues.push({ code: "invalid_date", severity: "blocking", field: "invoiceDate" });
  }
  if (capture.dueDate && !validIsoDate(capture.dueDate)) {
    issues.push({ code: "invalid_date", severity: "blocking", field: "dueDate" });
  }
  if (capture.currency && !/^[A-Z]{3}$/.test(capture.currency)) {
    issues.push({ code: "invalid_currency", severity: "blocking", field: "currency" });
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

export function validateAzureDocumentEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:") throw new Error("Document provider endpoint must use HTTPS");
  const host = endpoint.hostname.toLowerCase();
  if (!(host.endsWith(".cognitiveservices.azure.com") || host.endsWith(".api.cognitive.microsoft.com"))) {
    throw new Error("Document provider endpoint is not an Azure Document Intelligence endpoint");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

async function providerError(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? `HTTP ${response.status}`;
  } catch {
    return body.slice(0, 300) || `HTTP ${response.status}`;
  }
}

/** Production Azure REST adapter: submit bytes, poll asynchronously, retain raw evidence. */
export async function extractAzureInvoice(input: {
  endpoint: string;
  apiKey: string;
  model?: string;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
}): Promise<{ raw: AzureAnalyzeResponse; normalized: NormalizedCapture; evidence: CaptureEvidence[]; overallConfidence: string | null }> {
  const endpoint = validateAzureDocumentEndpoint(input.endpoint);
  const model = input.model?.trim() || DEFAULT_INVOICE_MODEL;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._~-]{1,63}$/.test(model)) throw new Error("Invalid document model id");
  if (!input.apiKey.trim()) throw new Error("Document provider API key is missing");
  const runFetch = input.fetchImpl ?? fetch;
  const url = new URL(
    `${endpoint.pathname}/documentintelligence/documentModels/${encodeURIComponent(model)}:analyze`,
    endpoint,
  );
  url.searchParams.set("api-version", AZURE_DOCUMENT_INTELLIGENCE_API_VERSION);
  const submitted = await runFetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": input.apiKey,
      "Content-Type": input.contentType,
    },
    body: Buffer.from(input.bytes),
    signal: AbortSignal.timeout(60_000),
  });
  if (submitted.status !== 202) throw new Error(`Document provider submission failed: ${await providerError(submitted)}`);
  const operation = submitted.headers.get("operation-location");
  if (!operation) throw new Error("Document provider omitted the operation location");
  const operationUrl = new URL(operation);
  if (operationUrl.origin !== endpoint.origin) throw new Error("Document provider returned an unexpected operation host");

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 1_000 + attempt * 200)));
    const polled = await runFetch(operationUrl, {
      headers: { "Ocp-Apim-Subscription-Key": input.apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!polled.ok) throw new Error(`Document provider polling failed: ${await providerError(polled)}`);
    const raw = (await polled.json()) as AzureAnalyzeResponse;
    const status = raw.status?.toLowerCase();
    if (status === "failed") throw new Error(raw.error?.message ?? "Document provider analysis failed");
    if (status === "succeeded") return { raw, ...normalizeAzureInvoice(raw) };
    if (status !== "running" && status !== "notstarted") {
      throw new Error(`Document provider returned unknown status: ${raw.status ?? "missing"}`);
    }
  }
  throw new Error("Document provider analysis timed out");
}

/** Live, non-mutating credential check used by Platform → AI. */
export async function testAzureDocumentProvider(input: {
  endpoint: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const endpoint = validateAzureDocumentEndpoint(input.endpoint);
    if (!input.apiKey.trim()) return { ok: false, message: "Document provider API key is missing" };
    const url = new URL(`${endpoint.pathname}/documentintelligence/documentModels`, endpoint);
    url.searchParams.set("api-version", AZURE_DOCUMENT_INTELLIGENCE_API_VERSION);
    const response = await (input.fetchImpl ?? fetch)(url, {
      headers: { "Ocp-Apim-Subscription-Key": input.apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { ok: false, message: (await providerError(response)).slice(0, 180) };
    return { ok: true, message: "Connected to the document provider" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message.slice(0, 180) : "Connection failed" };
  }
}

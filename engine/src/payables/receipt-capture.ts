import { cmp, sum } from "../money/money.ts";
import { isIso4217CurrencyCode } from "../fx/currencies.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import {
  analyzeAzureDocument,
  applyAzurePageGeometry,
  azureCapturedMoney,
  azureDocumentConfidence,
  azureEvidence,
  azureFieldConfidence,
  azureFieldText,
  invalidMoneyIssue,
  isCanonicalMoney,
  withinNumeric19_4,
  type AddressLookup,
  type AzureAnalyzeResponse,
  type AzureField,
  type CaptureEvidence,
  type CaptureIssue,
} from "./document-capture-azure.ts";
import {
  extractJsonObject,
  llmDate,
  llmEvidence,
  llmMoney,
  llmOverallConfidence,
  readLlmField,
  requestLlmVision,
  type LlmField,
  type LlmVisionConfig,
} from "./document-capture-llm.ts";

/**
 * Expense receipt capture: the Azure Document Intelligence receipt model's
 * field contract, its review validation, and the draft expense line a
 * reviewer confirms. Nothing here guesses: a field the provider did not read,
 * read ambiguously, or read below the organization's confidence threshold
 * stays blank in the draft and is flagged for the reviewer.
 */

export const DEFAULT_RECEIPT_MODEL = "prebuilt-receipt";

/** Receipt evidence formats the provider reads and the cabinet previews. */
export const RECEIPT_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
] as const;
export type ReceiptContentType = (typeof RECEIPT_CONTENT_TYPES)[number];
export function isReceiptContentType(value: string): value is ReceiptContentType {
  return (RECEIPT_CONTENT_TYPES as readonly string[]).includes(value);
}

export type ReceiptHeaderField =
  "merchantName" | "transactionDate" | "currency" | "subtotal" | "taxTotal" | "tip" | "total";

export type ReceiptTaxDetail = {
  /** Canonical amount, or the refused supplied text. */
  amount: string | null;
  /** The rate exactly as printed; display evidence only, never used in math. */
  rate: string | null;
  netAmount: string | null;
  description: string | null;
};

export type ReceiptItem = {
  description: string;
  quantity: string | null;
  unitPrice: string | null;
  /** The printed line total; never derived from quantity and price. */
  amount: string | null;
  confidence: string | null;
};

export type NormalizedReceipt = {
  receiptType: string | null;
  merchantName: string | null;
  merchantAddress: string | null;
  merchantPhone: string | null;
  /** An ISO calendar date the provider typed, or null. */
  transactionDate: string | null;
  /** The printed date text when no valid typed date was read. */
  transactionDateText: string | null;
  /** The ISO 4217 code the document states. Never inferred from a symbol. */
  currency: string | null;
  /** Every distinct currency code read across the amounts. */
  currencyReadings: string[];
  /** A printed symbol such as "$", kept as evidence only. */
  currencySymbol: string | null;
  /** Canonical amounts, or the refused supplied text for the reviewer. */
  subtotal: string | null;
  taxTotal: string | null;
  tip: string | null;
  total: string | null;
  taxDetails: ReceiptTaxDetail[];
  items: ReceiptItem[];
  confidence: Record<ReceiptHeaderField, string | null>;
};

function receiptMoney(field: AzureField | undefined): string | null {
  const reading = azureCapturedMoney(field);
  return reading.canonical ?? reading.supplied;
}

function currencyCode(field: AzureField | undefined): string | null {
  const code = field?.valueCurrency?.currencyCode?.trim().toUpperCase();
  return code ? code : null;
}

function currencySymbol(field: AzureField | undefined): string | null {
  const symbol = field?.valueCurrency?.currencySymbol?.trim();
  return symbol ? symbol : null;
}

/** Translate the Azure receipt model into the stable receipt contract. */
export function normalizeAzureReceipt(raw: AzureAnalyzeResponse): {
  normalized: NormalizedReceipt;
  evidence: CaptureEvidence[];
  overallConfidence: string | null;
} {
  const document = raw.analyzeResult?.documents?.[0];
  if (!document) throw new Error("Document provider returned no recognized receipt");
  const fields = document.fields ?? {};
  const evidence: CaptureEvidence[] = [];
  const record = (
    key: string,
    field: AzureField | undefined,
    value: unknown,
    lineIndex: number | null = null,
  ) => {
    if (field) evidence.push(azureEvidence(key, field, value, lineIndex));
  };

  const merchantName = azureFieldText(fields.MerchantName);
  record("merchantName", fields.MerchantName, merchantName);
  const merchantAddress = azureFieldText(fields.MerchantAddress);
  record("merchantAddress", fields.MerchantAddress, merchantAddress);
  const merchantPhone =
    typeof fields.MerchantPhoneNumber?.valuePhoneNumber === "string"
      ? fields.MerchantPhoneNumber.valuePhoneNumber.trim() || null
      : azureFieldText(fields.MerchantPhoneNumber);
  record("merchantPhone", fields.MerchantPhoneNumber, merchantPhone);

  // Only a typed calendar date is a date. Printed text such as "03/04/26"
  // has several readings, so it rides as evidence and the draft stays blank.
  const typedDate = fields.TransactionDate?.valueDate?.trim() ?? null;
  const transactionDate = typedDate && isIsoCalendarDate(typedDate) ? typedDate : null;
  const transactionDateText = transactionDate
    ? null
    : fields.TransactionDate?.content?.trim() || typedDate || null;
  record("transactionDate", fields.TransactionDate, transactionDate);

  const subtotal = receiptMoney(fields.Subtotal);
  record("subtotal", fields.Subtotal, subtotal);
  const taxTotal = receiptMoney(fields.TotalTax);
  record("taxTotal", fields.TotalTax, taxTotal);
  const tip = receiptMoney(fields.Tip);
  record("tip", fields.Tip, tip);
  const total = receiptMoney(fields.Total);
  record("total", fields.Total, total);

  const taxDetails: ReceiptTaxDetail[] = (fields.TaxDetails?.valueArray ?? []).map(
    (entry, index) => {
      const detail = entry.valueObject ?? {};
      const amount = receiptMoney(detail.Amount);
      record("taxDetails.amount", detail.Amount, amount, index);
      return {
        amount,
        rate:
          detail.Rate?.content?.trim() ||
          (typeof detail.Rate?.valueNumber === "number" ? String(detail.Rate.valueNumber) : null),
        netAmount: receiptMoney(detail.NetAmount),
        description: azureFieldText(detail.Description),
      };
    },
  );

  const items: ReceiptItem[] = [];
  for (const entry of fields.Items?.valueArray ?? []) {
    const item = entry.valueObject ?? {};
    const description = azureFieldText(item.Description) ?? "";
    const amount = receiptMoney(item.TotalPrice);
    if (!description && amount === null) continue;
    const index = items.length;
    record("items.description", item.Description, description, index);
    record("items.amount", item.TotalPrice, amount, index);
    items.push({
      description,
      quantity: receiptMoney(item.Quantity),
      unitPrice: receiptMoney(item.Price),
      amount,
      confidence: azureFieldConfidence(item.TotalPrice) ?? azureFieldConfidence(entry),
    });
  }

  // The currency is what the document states, from any amount. Conflicting
  // codes are not reconciled here; the reviewer sees every reading.
  const readings = [
    currencyCode(fields.Total),
    currencyCode(fields.Subtotal),
    currencyCode(fields.TotalTax),
    currencyCode(fields.Tip),
    ...(fields.Items?.valueArray ?? []).map((entry) => currencyCode(entry.valueObject?.TotalPrice)),
  ].filter((code): code is string => code !== null);
  const currencyReadings = [...new Set(readings)];
  const currency = currencyReadings.length === 1 ? currencyReadings[0]! : null;
  const symbol = currencySymbol(fields.Total) ?? currencySymbol(fields.Subtotal);
  const currencyField = [fields.Total, fields.Subtotal, fields.TotalTax, fields.Tip].find((field) =>
    currencyCode(field),
  );

  applyAzurePageGeometry(raw, evidence);
  return {
    normalized: {
      receiptType: document.docType ?? azureFieldText(fields.ReceiptType),
      merchantName,
      merchantAddress,
      merchantPhone,
      transactionDate,
      transactionDateText,
      currency,
      currencyReadings,
      currencySymbol: symbol,
      subtotal,
      taxTotal,
      tip,
      total,
      taxDetails,
      items,
      confidence: {
        merchantName: azureFieldConfidence(fields.MerchantName),
        transactionDate: azureFieldConfidence(fields.TransactionDate),
        currency: azureFieldConfidence(currencyField),
        subtotal: azureFieldConfidence(fields.Subtotal),
        taxTotal: azureFieldConfidence(fields.TotalTax),
        tip: azureFieldConfidence(fields.Tip),
        total: azureFieldConfidence(fields.Total),
      },
    },
    evidence,
    overallConfidence: azureDocumentConfidence(document),
  };
}

const MONEY_FIELDS = ["subtotal", "taxTotal", "tip", "total"] as const;

function usableMoney(value: string | null): value is string {
  return value !== null && isCanonicalMoney(value) && withinNumeric19_4(value);
}

function belowThreshold(confidence: string | null, threshold: string): boolean {
  return confidence === null || cmp(confidence, threshold) < 0;
}

/**
 * Review issues for one normalized receipt. Blocking issues name a draft
 * field the reviewer must supply; warnings surface readings to check. No
 * issue is resolved by substituting a default.
 */
export function validateNormalizedReceipt(
  receipt: NormalizedReceipt,
  options: { confidenceThreshold: string; today?: string },
): CaptureIssue[] {
  const issues: CaptureIssue[] = [];
  if (!receipt.merchantName)
    issues.push({ code: "required_field", severity: "blocking", field: "merchantName" });
  if (receipt.transactionDate === null) {
    issues.push(
      receipt.transactionDateText
        ? {
            code: "invalid_date",
            severity: "blocking",
            field: "transactionDate",
            actual: receipt.transactionDateText,
            message: `The receipt date "${receipt.transactionDateText}" could not be read as one calendar date — enter the transaction date shown on the receipt`,
          }
        : { code: "required_field", severity: "blocking", field: "transactionDate" },
    );
  } else if (
    options.today &&
    isIsoCalendarDate(options.today) &&
    receipt.transactionDate > options.today
  ) {
    issues.push({
      code: "future_date",
      severity: "warning",
      field: "transactionDate",
      actual: receipt.transactionDate,
      expected: options.today,
    });
  }
  if (!receipt.total) issues.push({ code: "required_field", severity: "blocking", field: "total" });

  if (receipt.currency && !isIso4217CurrencyCode(receipt.currency)) {
    issues.push({
      code: "invalid_currency",
      severity: "blocking",
      field: "currency",
      actual: receipt.currency,
      message: `Receipt currency ${JSON.stringify(receipt.currency)} is not an ISO 4217 code — confirm the currency shown on the receipt`,
    });
  } else if (!receipt.currency && receipt.currencyReadings.length > 1) {
    issues.push({
      code: "currency_conflict",
      severity: "blocking",
      field: "currency",
      actual: receipt.currencyReadings.join(", "),
      message: `The receipt amounts carry different currencies (${receipt.currencyReadings.join(", ")}) — confirm the currency that was charged`,
    });
  } else if (!receipt.currency) {
    issues.push({
      code: "currency_unread",
      severity: "warning",
      field: "currency",
      ...(receipt.currencySymbol ? { actual: receipt.currencySymbol } : {}),
      message:
        "The receipt does not state a currency code — confirm the amount is in the report currency",
    });
  }

  for (const field of MONEY_FIELDS) {
    const value = receipt[field];
    if (value === null) continue;
    if (!isCanonicalMoney(value))
      issues.push(invalidMoneyIssue(field, "an amount", value, { field }));
    else if (!withinNumeric19_4(value))
      issues.push({ code: "amount_out_of_range", severity: "blocking", field });
  }
  if (usableMoney(receipt.total) && cmp(receipt.total, "0") <= 0) {
    issues.push({
      code: "non_positive_total",
      severity: "warning",
      field: "total",
      actual: receipt.total,
    });
  }

  for (const field of ["merchantName", "transactionDate", "currency", ...MONEY_FIELDS] as const) {
    const present = field === "currency" ? receipt.currency !== null : receipt[field] !== null;
    if (present && belowThreshold(receipt.confidence[field], options.confidenceThreshold)) {
      issues.push({
        code: "low_confidence",
        severity: "warning",
        field,
        ...(receipt.confidence[field] !== null ? { actual: receipt.confidence[field]! } : {}),
        expected: options.confidenceThreshold,
      });
    }
  }

  // Cross-foot only canonical readings; refused text already has its own
  // blocking issue. An unread tip or tax is not assumed to be zero: the
  // check compares the components the receipt states.
  if (usableMoney(receipt.total) && usableMoney(receipt.subtotal)) {
    const components = [receipt.subtotal, receipt.taxTotal, receipt.tip];
    if (components.every((value) => value === null || usableMoney(value))) {
      const expected = sum(components.filter((value): value is string => value !== null));
      if (cmp(expected, receipt.total) !== 0) {
        issues.push({
          code: "total_mismatch",
          severity: "warning",
          field: "total",
          expected,
          actual: receipt.total,
        });
      }
    }
  }
  if (
    usableMoney(receipt.taxTotal) &&
    receipt.taxDetails.length > 0 &&
    receipt.taxDetails.every((detail) => usableMoney(detail.amount))
  ) {
    const expected = sum(receipt.taxDetails.map((detail) => detail.amount!));
    if (cmp(expected, receipt.taxTotal) !== 0) {
      issues.push({
        code: "tax_detail_mismatch",
        severity: "warning",
        field: "taxTotal",
        expected,
        actual: receipt.taxTotal,
      });
    }
  }
  if (
    usableMoney(receipt.subtotal) &&
    receipt.items.length > 0 &&
    receipt.items.every((item) => usableMoney(item.amount))
  ) {
    const expected = sum(receipt.items.map((item) => item.amount!));
    if (cmp(expected, receipt.subtotal) !== 0) {
      issues.push({
        code: "items_mismatch",
        severity: "warning",
        field: "subtotal",
        expected,
        actual: receipt.subtotal,
      });
    }
  }
  return issues;
}

/**
 * Merchant identity for history and duplicate checks: accents, case,
 * punctuation and printed store numbers ("#1234") do not distinguish
 * merchants. Letters of every script survive, so non-Latin merchant names
 * keep a key. Null when nothing identifying remains.
 */
export function receiptMerchantKey(name: string | null | undefined): string | null {
  if (!name) return null;
  // Accents fold only on Latin letters: a Japanese voicing mark distinguishes
  // words and must survive.
  const key = name
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/#\s*\d+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return key || null;
}

export type DraftField = {
  /** The value the draft proposes; null when unread, invalid or below threshold. */
  value: string | null;
  /** What the provider read, shown beside a blank field. */
  reading: string | null;
  confidence: string | null;
  /** True when the reviewer must supply or confirm this field. */
  needsReview: boolean;
};

export type AccountSuggestionSource =
  "employee_history" | "organization_history" | "vendor_default";
export type AccountSuggestion = { accountId: string; source: AccountSuggestionSource };

export type ReceiptLineDraft = {
  transactionDate: DraftField;
  merchantName: DraftField;
  /** A vendor party matched confidently by name; otherwise null and the merchant text stands. */
  merchantPartyId: string | null;
  currency: DraftField;
  total: DraftField;
  taxAmount: DraftField;
  tip: DraftField;
  reportCurrency: string;
  /** Null while the receipt currency is unknown; false drafts a foreign-currency line. */
  currencyMatchesReport: boolean | null;
  /** A suggestion for the reviewer to accept or change; never applied silently. */
  suggestedAccount: AccountSuggestion | null;
};

function draftField(
  reading: string | null,
  confidence: string | null,
  threshold: string,
  valid: boolean,
  required: boolean,
): DraftField {
  if (reading === null) return { value: null, reading: null, confidence, needsReview: required };
  const confident = valid && !belowThreshold(confidence, threshold);
  return { value: confident ? reading : null, reading, confidence, needsReview: !confident };
}

/**
 * The draft expense line for one receipt. Low-confidence, unread or invalid
 * fields are blank and flagged. Amounts are in the receipt's own currency;
 * a receipt in another currency than the report drafts a foreign-currency
 * line that converts into the report currency when the reviewer adds it.
 */
export function draftExpenseLineFromReceipt(input: {
  receipt: NormalizedReceipt;
  confidenceThreshold: string;
  reportCurrency: string;
  merchantPartyId: string | null;
  suggestedAccount: AccountSuggestion | null;
}): ReceiptLineDraft {
  const { receipt, confidenceThreshold: threshold } = input;
  const currencyValid = receipt.currency !== null && isIso4217CurrencyCode(receipt.currency);
  const currency = draftField(
    receipt.currency,
    receipt.confidence.currency,
    threshold,
    currencyValid,
    true,
  );
  const currencyMatchesReport =
    currency.value === null ? null : currency.value === input.reportCurrency;
  const money = (field: "total" | "taxTotal" | "tip", required: boolean): DraftField =>
    draftField(
      receipt[field],
      receipt.confidence[field],
      threshold,
      usableMoney(receipt[field]),
      required,
    );
  const merchant = draftField(
    receipt.merchantName,
    receipt.confidence.merchantName,
    threshold,
    true,
    true,
  );
  return {
    transactionDate: draftField(
      receipt.transactionDate ?? receipt.transactionDateText,
      receipt.confidence.transactionDate,
      threshold,
      receipt.transactionDate !== null,
      true,
    ),
    merchantName: merchant,
    merchantPartyId: merchant.value !== null ? input.merchantPartyId : null,
    currency,
    total: money("total", true),
    taxAmount: money("taxTotal", false),
    tip: money("tip", false),
    reportCurrency: input.reportCurrency,
    currencyMatchesReport,
    suggestedAccount: input.suggestedAccount,
  };
}

/**
 * The first suggestion that names an account still valid for posting: the
 * employee's own most recent choice for the merchant, then the
 * organization's, then the matched vendor's default expense account.
 */
export function chooseAccountSuggestion(input: {
  employeeHistory: string | null;
  organizationHistory: string | null;
  vendorDefault: string | null;
  postableAccountIds: ReadonlySet<string>;
}): AccountSuggestion | null {
  const ordered: Array<[string | null, AccountSuggestionSource]> = [
    [input.employeeHistory, "employee_history"],
    [input.organizationHistory, "organization_history"],
    [input.vendorDefault, "vendor_default"],
  ];
  for (const [accountId, source] of ordered) {
    if (accountId && input.postableAccountIds.has(accountId)) return { accountId, source };
  }
  return null;
}

export type ReceiptDuplicateCandidate = {
  captureId: string;
  reason: "same_file" | "same_receipt";
  documentId: string;
  documentNumber: string | null;
  sameReport: boolean;
};

/** Duplicate receipts warn; the reviewer decides whether the expense is a second one. */
export function receiptDuplicateIssues(
  candidates: readonly ReceiptDuplicateCandidate[],
): CaptureIssue[] {
  const seen = new Set<string>();
  const issues: CaptureIssue[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.reason}:${candidate.documentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const where = candidate.sameReport
      ? "this report"
      : `expense report ${candidate.documentNumber ?? candidate.documentId}`;
    issues.push({
      code: "possible_duplicate",
      severity: "warning",
      cause: candidate.reason,
      detail: candidate.documentNumber ?? candidate.documentId,
      message:
        candidate.reason === "same_file"
          ? `This receipt file was already scanned on ${where} — discard it unless this is a separate expense`
          : `A receipt with the same merchant, date and total is already on ${where} — discard it unless this is a separate expense`,
    });
  }
  return issues;
}

/**
 * The receipt reading contract an AI model answers. Values are copied as
 * printed and nothing is inferred: a currency is the ISO code the receipt
 * prints, never one guessed from a symbol or a country.
 */
export const RECEIPT_LLM_PROMPT = [
  "You read one expense receipt. Answer with ONLY a JSON object: no prose, no code fences.",
  'Every field is an object {"value": ..., "confidence": number from 0 to 1} giving your confidence that the value is exactly what the receipt prints.',
  "Use null for any value that is not visible or not legible. Never guess, infer, compute or default a value.",
  "Use exactly these keys:",
  "{",
  '  "merchantName": {"value": string|null, "confidence": number},',
  '  "merchantAddress": {"value": string|null, "confidence": number},',
  '  "merchantPhone": {"value": string|null, "confidence": number},',
  '  "transactionDate": {"value": "YYYY-MM-DD"|null, "text": string|null, "confidence": number},',
  '  "currency": {"value": string|null, "symbol": string|null, "confidence": number},',
  '  "subtotal": {"value": string|null, "confidence": number},',
  '  "taxTotal": {"value": string|null, "confidence": number},',
  '  "tip": {"value": string|null, "confidence": number},',
  '  "total": {"value": string|null, "confidence": number},',
  '  "taxDetails": [{"amount": string|null, "rate": string|null, "netAmount": string|null, "description": string|null}],',
  '  "items": [{"description": string, "quantity": string|null, "unitPrice": string|null, "amount": string|null, "confidence": number}]',
  "}",
  "transactionDate.value is set only when the printed date has exactly one reading; otherwise null, with the printed text in transactionDate.text.",
  "currency.value is the three-letter ISO 4217 code only when the receipt prints it; otherwise null, with any printed symbol such as $ in currency.symbol.",
  "Amounts are strings with the digits as printed, using a dot as the decimal point and no currency symbols or thousands separators; total is the grand total paid including tax and tip.",
  "List at most 50 items.",
].join("\n");

function llmObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * Translate an AI model's receipt answer into the stable receipt contract.
 * Throws when the answer is not the contract, so the capture fails with a
 * retryable reason instead of drafting from an unreadable answer.
 */
export function normalizeLlmReceipt(answer: Record<string, unknown>): {
  normalized: NormalizedReceipt;
  evidence: CaptureEvidence[];
  overallConfidence: string | null;
} {
  if (!("total" in answer) && !("merchantName" in answer)) {
    throw new Error(
      "The AI model's answer was not a receipt reading — retry the scan, or enter the line by hand",
    );
  }
  const evidence: CaptureEvidence[] = [];
  const text = (key: string): LlmField => {
    const field = readLlmField(answer[key]);
    if (field.value !== null) evidence.push(llmEvidence(key, field, field.value));
    return field;
  };
  const money = (key: string): { field: LlmField; value: string | null } => {
    const field = readLlmField(answer[key]);
    const reading = llmMoney(field);
    const value = reading.canonical ?? reading.supplied;
    if (field.value !== null) evidence.push(llmEvidence(key, field, value));
    return { field, value };
  };

  const merchant = text("merchantName");
  const address = text("merchantAddress");
  const phone = text("merchantPhone");
  const dateRaw = llmObject(answer.transactionDate);
  const dateField = readLlmField(dateRaw);
  const date = llmDate(dateField);
  const printedDate =
    typeof dateRaw.text === "string" && dateRaw.text.trim() ? dateRaw.text.trim() : null;
  if (dateField.value !== null || printedDate)
    evidence.push(
      llmEvidence(
        "transactionDate",
        { ...dateField, raw: printedDate ?? dateField.raw },
        date.date,
      ),
    );

  const currencyRaw = llmObject(answer.currency);
  const currencyField = readLlmField(currencyRaw);
  const code = currencyField.value?.toUpperCase() ?? null;
  const symbol =
    typeof currencyRaw.symbol === "string" && currencyRaw.symbol.trim()
      ? currencyRaw.symbol.trim()
      : null;
  if (code !== null) evidence.push(llmEvidence("currency", currencyField, code));

  const subtotal = money("subtotal");
  const taxTotal = money("taxTotal");
  const tip = money("tip");
  const total = money("total");

  const taxDetails: ReceiptTaxDetail[] = (Array.isArray(answer.taxDetails) ? answer.taxDetails : [])
    .slice(0, 50)
    .map((entry, index) => {
      const detail = llmObject(entry);
      const amountField = readLlmField({ value: detail.amount, confidence: null });
      const reading = llmMoney(amountField);
      const amount = reading.canonical ?? reading.supplied;
      if (amountField.value !== null)
        evidence.push(llmEvidence("taxDetails.amount", amountField, amount, index));
      const net = llmMoney(readLlmField({ value: detail.netAmount }));
      return {
        amount,
        rate: typeof detail.rate === "string" ? detail.rate.trim() || null : null,
        netAmount: net.canonical ?? net.supplied,
        description:
          typeof detail.description === "string" ? detail.description.trim() || null : null,
      };
    });

  const items: ReceiptItem[] = [];
  for (const entry of (Array.isArray(answer.items) ? answer.items : []).slice(0, 50)) {
    const item = llmObject(entry);
    const description = typeof item.description === "string" ? item.description.trim() : "";
    const amountField = readLlmField({ value: item.amount, confidence: item.confidence });
    const reading = llmMoney(amountField);
    const amount = reading.canonical ?? reading.supplied;
    if (!description && amount === null) continue;
    const index = items.length;
    if (description)
      evidence.push(
        llmEvidence(
          "items.description",
          { value: description, confidence: amountField.confidence, raw: description },
          description,
          index,
        ),
      );
    if (amountField.value !== null)
      evidence.push(llmEvidence("items.amount", amountField, amount, index));
    const quantity = llmMoney(readLlmField({ value: item.quantity }));
    const unitPrice = llmMoney(readLlmField({ value: item.unitPrice }));
    items.push({
      description,
      quantity: quantity.canonical ?? quantity.supplied,
      unitPrice: unitPrice.canonical ?? unitPrice.supplied,
      amount,
      confidence: amountField.confidence,
    });
  }

  return {
    normalized: {
      receiptType: null,
      merchantName: merchant.value,
      merchantAddress: address.value,
      merchantPhone: phone.value,
      transactionDate: date.date,
      transactionDateText: date.date ? null : (date.text ?? printedDate),
      currency: code,
      currencyReadings: code ? [code] : [],
      currencySymbol: symbol,
      subtotal: subtotal.value,
      taxTotal: taxTotal.value,
      tip: tip.value,
      total: total.value,
      taxDetails,
      items,
      confidence: {
        merchantName: merchant.confidence,
        transactionDate: dateField.confidence,
        currency: currencyField.confidence,
        subtotal: subtotal.field.confidence,
        taxTotal: taxTotal.field.confidence,
        tip: tip.field.confidence,
        total: total.field.confidence,
      },
    },
    evidence,
    overallConfidence: llmOverallConfidence([merchant, dateField, total.field]),
  };
}

/** Read one receipt through the organization's AI model and normalize the answer. */
export async function extractLlmReceipt(input: {
  config: LlmVisionConfig;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
  lookup?: AddressLookup;
}): Promise<{
  raw: { answer: string };
  normalized: NormalizedReceipt;
  evidence: CaptureEvidence[];
  overallConfidence: string | null;
}> {
  const answer = await requestLlmVision({ ...input, prompt: RECEIPT_LLM_PROMPT });
  const parsed = extractJsonObject(answer);
  if (!parsed)
    throw new Error(
      "The AI model did not answer with a receipt reading — retry the scan, or enter the line by hand",
    );
  return { raw: { answer }, ...normalizeLlmReceipt(parsed) };
}

/** Submit one receipt to the configured Azure endpoint and normalize the result. */
export async function extractAzureReceipt(input: {
  endpoint: string;
  apiKey: string;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
  lookup?: AddressLookup;
}): Promise<{
  raw: AzureAnalyzeResponse;
  normalized: NormalizedReceipt;
  evidence: CaptureEvidence[];
  overallConfidence: string | null;
}> {
  const raw = await analyzeAzureDocument({ ...input, model: DEFAULT_RECEIPT_MODEL });
  return { raw, ...normalizeAzureReceipt(raw) };
}

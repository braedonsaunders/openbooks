import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseAccountSuggestion,
  draftExpenseLineFromReceipt,
  extractAzureReceipt,
  extractLlmReceipt,
  isReceiptContentType,
  normalizeAzureReceipt,
  normalizeLlmReceipt,
  receiptDuplicateIssues,
  receiptMerchantKey,
  validateNormalizedReceipt,
  type NormalizedReceipt,
} from "./receipt-capture.ts";
import type { AzureAnalyzeResponse, AzureField } from "./document-capture-azure.ts";

const THRESHOLD = "0.8000";

function region(page = 1): AzureField["boundingRegions"] {
  return [{ pageNumber: page, polygon: [1, 1, 3, 1, 3, 2, 1, 2] }];
}

function currency(
  amount: number,
  code: string | undefined,
  confidence = 0.98,
  content?: string,
): AzureField {
  return {
    type: "currency",
    content: content ?? String(amount),
    confidence,
    valueCurrency: {
      amount,
      ...(code ? { currencyCode: code } : {}),
      currencySymbol: code === "EUR" ? "€" : "$",
    },
    boundingRegions: region(),
  };
}

function receipt(
  fields: Record<string, AzureField>,
  docType = "receipt.retailMeal",
): AzureAnalyzeResponse {
  return {
    status: "succeeded",
    analyzeResult: {
      pages: [{ pageNumber: 1, width: 8.5, height: 11 }],
      documents: [{ docType, confidence: 0.97, fields }],
    },
  };
}

/** A Canadian restaurant receipt: HST detail, a tip, and two items. */
const restaurant = receipt({
  MerchantName: {
    type: "string",
    valueString: "The Keg Steakhouse #214",
    content: "The Keg Steakhouse #214",
    confidence: 0.97,
    boundingRegions: region(),
  },
  MerchantAddress: {
    type: "address",
    content: "26 Bay St, Toronto, ON",
    confidence: 0.9,
    valueAddress: { houseNumber: "26", road: "Bay St", city: "Toronto", state: "ON" },
  },
  MerchantPhoneNumber: {
    type: "phoneNumber",
    content: "(416) 555-0199",
    valuePhoneNumber: "+14165550199",
    confidence: 0.95,
  },
  TransactionDate: {
    type: "date",
    valueDate: "2026-10-03",
    content: "Oct 3, 2026",
    confidence: 0.96,
    boundingRegions: region(),
  },
  Subtotal: currency(84.5, "CAD"),
  TotalTax: currency(10.99, "CAD"),
  Tip: currency(15, "CAD"),
  Total: currency(110.49, "CAD"),
  TaxDetails: {
    type: "array",
    valueArray: [
      {
        type: "object",
        valueObject: {
          Amount: currency(10.99, "CAD"),
          Rate: { type: "number", content: "13%", valueNumber: 0.13, confidence: 0.9 },
          NetAmount: currency(84.5, "CAD"),
          Description: { type: "string", valueString: "HST", confidence: 0.9 },
        },
      },
    ],
  },
  Items: {
    type: "array",
    valueArray: [
      {
        type: "object",
        confidence: 0.94,
        valueObject: {
          Description: {
            type: "string",
            valueString: "Sirloin",
            confidence: 0.95,
            boundingRegions: region(),
          },
          Quantity: { type: "number", valueNumber: 1, confidence: 0.9 },
          TotalPrice: currency(52, "CAD"),
        },
      },
      {
        type: "object",
        confidence: 0.92,
        valueObject: {
          Description: { type: "string", valueString: "Caesar salad", confidence: 0.93 },
          Quantity: { type: "number", valueNumber: 1, confidence: 0.9 },
          Price: currency(32.5, "CAD"),
          TotalPrice: currency(32.5, "CAD"),
        },
      },
    ],
  },
});

test("normalizes a restaurant receipt with tip, tax details and items exactly", () => {
  const { normalized, evidence, overallConfidence } = normalizeAzureReceipt(restaurant);
  assert.equal(normalized.merchantName, "The Keg Steakhouse #214");
  assert.equal(normalized.merchantPhone, "+14165550199");
  assert.equal(normalized.transactionDate, "2026-10-03");
  assert.equal(normalized.transactionDateText, null);
  assert.equal(normalized.currency, "CAD");
  assert.equal(normalized.subtotal, "84.5000");
  assert.equal(normalized.taxTotal, "10.9900");
  assert.equal(normalized.tip, "15.0000");
  assert.equal(normalized.total, "110.4900");
  assert.deepEqual(normalized.taxDetails, [
    { amount: "10.9900", rate: "13%", netAmount: "84.5000", description: "HST" },
  ]);
  assert.deepEqual(
    normalized.items.map((item) => [item.description, item.amount]),
    [
      ["Sirloin", "52.0000"],
      ["Caesar salad", "32.5000"],
    ],
  );
  assert.equal(normalized.receiptType, "receipt.retailMeal");
  assert.equal(overallConfidence, "0.9700");
  const total = evidence.find((entry) => entry.fieldKey === "total")!;
  assert.equal(total.confidence, "0.9800");
  assert.deepEqual(total.polygon, { points: [1, 1, 3, 1, 3, 2, 1, 2], width: 8.5, height: 11 });
  assert.deepEqual(
    validateNormalizedReceipt(normalized, { confidenceThreshold: THRESHOLD, today: "2026-10-17" }),
    [],
  );
});

test("a euro receipt keeps its own currency and decimal-comma text is read exactly", () => {
  const { normalized } = normalizeAzureReceipt(
    receipt({
      MerchantName: { type: "string", valueString: "Café de Flore", confidence: 0.93 },
      TransactionDate: { type: "date", valueDate: "2026-09-28", confidence: 0.94 },
      Total: {
        type: "currency",
        content: "23,40 €",
        confidence: 0.91,
        valueCurrency: { currencyCode: "EUR", currencySymbol: "€" },
      },
    }),
  );
  assert.equal(normalized.currency, "EUR");
  assert.equal(normalized.total, "23.4000");
  assert.equal(normalized.subtotal, null);
  const draft = draftExpenseLineFromReceipt({
    receipt: normalized,
    confidenceThreshold: THRESHOLD,
    reportCurrency: "CAD",
    merchantPartyId: null,
    suggestedAccount: null,
  });
  // A receipt in another currency drafts its own amounts; the line converts
  // into the report currency when the reviewer adds it.
  assert.equal(draft.currencyMatchesReport, false);
  assert.equal(draft.currency.value, "EUR");
  assert.equal(draft.total.value, "23.4000");
  assert.equal(draft.total.needsReview, false);
});

test("a currency symbol alone is never read as a currency code", () => {
  const { normalized } = normalizeAzureReceipt(
    receipt({
      MerchantName: { type: "string", valueString: "Corner Store", confidence: 0.95 },
      TransactionDate: { type: "date", valueDate: "2026-10-01", confidence: 0.95 },
      Total: currency(12.5, undefined),
    }),
  );
  assert.equal(normalized.currency, null);
  assert.equal(normalized.currencySymbol, "$");
  const issues = validateNormalizedReceipt(normalized, { confidenceThreshold: THRESHOLD });
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.severity, issue.actual]),
    [["currency_unread", "warning", "$"]],
  );
  const draft = draftExpenseLineFromReceipt({
    receipt: normalized,
    confidenceThreshold: THRESHOLD,
    reportCurrency: "USD",
    merchantPartyId: null,
    suggestedAccount: null,
  });
  assert.equal(draft.currency.value, null);
  assert.equal(draft.currency.needsReview, true);
  assert.equal(draft.currencyMatchesReport, null);
});

test("conflicting currency codes across amounts are surfaced, not reconciled", () => {
  const { normalized } = normalizeAzureReceipt(
    receipt({
      MerchantName: { type: "string", valueString: "Duty Free", confidence: 0.95 },
      TransactionDate: { type: "date", valueDate: "2026-10-01", confidence: 0.95 },
      Subtotal: currency(40, "USD"),
      Total: currency(54, "CAD"),
    }),
  );
  assert.equal(normalized.currency, null);
  assert.deepEqual(normalized.currencyReadings, ["CAD", "USD"]);
  const conflict = validateNormalizedReceipt(normalized, { confidenceThreshold: THRESHOLD }).find(
    (issue) => issue.code === "currency_conflict",
  );
  assert.equal(conflict?.severity, "blocking");
  assert.equal(conflict?.actual, "CAD, USD");
});

test("missing merchant, printed-only date and missing total are blocking review fields", () => {
  const { normalized } = normalizeAzureReceipt(
    receipt({
      TransactionDate: { type: "date", content: "03/04/26", confidence: 0.7 },
      Subtotal: currency(9.99, "USD"),
    }),
  );
  assert.equal(normalized.transactionDate, null);
  assert.equal(normalized.transactionDateText, "03/04/26");
  const issues = validateNormalizedReceipt(normalized, { confidenceThreshold: THRESHOLD });
  assert.deepEqual(
    issues
      .filter((issue) => issue.severity === "blocking")
      .map((issue) => [issue.code, issue.field]),
    [
      ["required_field", "merchantName"],
      ["invalid_date", "transactionDate"],
      ["required_field", "total"],
    ],
  );
  const draft = draftExpenseLineFromReceipt({
    receipt: normalized,
    confidenceThreshold: THRESHOLD,
    reportCurrency: "USD",
    merchantPartyId: null,
    suggestedAccount: null,
  });
  // Nothing is defaulted: no date guessed from "03/04/26", no zero total.
  assert.deepEqual(draft.transactionDate, {
    value: null,
    reading: "03/04/26",
    confidence: "0.7000",
    needsReview: true,
  });
  assert.deepEqual(draft.total, {
    value: null,
    reading: null,
    confidence: null,
    needsReview: true,
  });
  assert.deepEqual(draft.merchantName, {
    value: null,
    reading: null,
    confidence: null,
    needsReview: true,
  });
});

test("an impossible typed date is not a date", () => {
  const { normalized } = normalizeAzureReceipt(
    receipt({
      MerchantName: { type: "string", valueString: "Shell", confidence: 0.95 },
      TransactionDate: {
        type: "date",
        valueDate: "2026-02-30",
        content: "30/02/2026",
        confidence: 0.95,
      },
      Total: currency(61.2, "CAD"),
    }),
  );
  assert.equal(normalized.transactionDate, null);
  assert.equal(normalized.transactionDateText, "30/02/2026");
  assert.ok(
    validateNormalizedReceipt(normalized, { confidenceThreshold: THRESHOLD }).some(
      (issue) => issue.code === "invalid_date",
    ),
  );
});

test("low-confidence fields stay blank in the draft and are flagged", () => {
  const { normalized } = normalizeAzureReceipt(
    receipt({
      MerchantName: { type: "string", valueString: "Uber", confidence: 0.62 },
      TransactionDate: { type: "date", valueDate: "2026-10-05", confidence: 0.99 },
      TotalTax: currency(2.1, "USD", 0.41),
      Total: currency(24.1, "USD", 0.99),
    }),
  );
  const issues = validateNormalizedReceipt(normalized, { confidenceThreshold: THRESHOLD });
  assert.deepEqual(
    issues
      .filter((issue) => issue.code === "low_confidence")
      .map((issue) => [issue.field, issue.actual]),
    [
      ["merchantName", "0.6200"],
      ["taxTotal", "0.4100"],
    ],
  );
  const draft = draftExpenseLineFromReceipt({
    receipt: normalized,
    confidenceThreshold: THRESHOLD,
    reportCurrency: "USD",
    merchantPartyId: "party-uber",
    suggestedAccount: null,
  });
  assert.deepEqual(draft.merchantName, {
    value: null,
    reading: "Uber",
    confidence: "0.6200",
    needsReview: true,
  });
  // A vendor match is only offered for a confidently read merchant.
  assert.equal(draft.merchantPartyId, null);
  assert.deepEqual(draft.taxAmount, {
    value: null,
    reading: "2.1000",
    confidence: "0.4100",
    needsReview: true,
  });
  assert.deepEqual(draft.total, {
    value: "24.1000",
    reading: "24.1000",
    confidence: "0.9900",
    needsReview: false,
  });
  assert.deepEqual(draft.tip, { value: null, reading: null, confidence: null, needsReview: false });
});

test("refused amount text rides through verbatim and blocks with its cause", () => {
  const { normalized } = normalizeAzureReceipt(
    receipt({
      MerchantName: { type: "string", valueString: "Hornbach", confidence: 0.95 },
      TransactionDate: { type: "date", valueDate: "2026-10-02", confidence: 0.95 },
      Total: {
        type: "currency",
        content: "1.234.567",
        confidence: 0.95,
        valueCurrency: { currencyCode: "EUR" },
      },
    }),
  );
  assert.equal(normalized.total, "1.234.567");
  const refusal = validateNormalizedReceipt(normalized, { confidenceThreshold: THRESHOLD }).find(
    (issue) => issue.code === "invalid_amount",
  );
  assert.equal(refusal?.severity, "blocking");
  assert.equal(refusal?.field, "total");
  assert.equal(refusal?.actual, "1.234.567");
  const draft = draftExpenseLineFromReceipt({
    receipt: normalized,
    confidenceThreshold: THRESHOLD,
    reportCurrency: "EUR",
    merchantPartyId: null,
    suggestedAccount: null,
  });
  assert.equal(draft.total.value, null);
  assert.equal(draft.total.reading, "1.234.567");
});

test("cross-foot, tax detail and item mismatches surface as review warnings", () => {
  const base = normalizeAzureReceipt(restaurant).normalized;
  const mismatched: NormalizedReceipt = {
    ...base,
    total: "112.4900",
    taxDetails: [{ amount: "10.0000", rate: "13%", netAmount: null, description: "HST" }],
    items: [
      {
        description: "Sirloin",
        quantity: "1.0000",
        unitPrice: null,
        amount: "52.0000",
        confidence: "0.9500",
      },
    ],
  };
  const issues = validateNormalizedReceipt(mismatched, { confidenceThreshold: THRESHOLD });
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.severity, issue.expected, issue.actual]),
    [
      ["total_mismatch", "warning", "110.4900", "112.4900"],
      ["tax_detail_mismatch", "warning", "10.0000", "10.9900"],
      ["items_mismatch", "warning", "52.0000", "84.5000"],
    ],
  );
});

test("an unread tip is not assumed to be zero in the cross-foot", () => {
  const withoutTip: NormalizedReceipt = {
    ...normalizeAzureReceipt(restaurant).normalized,
    tip: null,
  };
  const mismatch = validateNormalizedReceipt(withoutTip, { confidenceThreshold: THRESHOLD }).find(
    (issue) => issue.code === "total_mismatch",
  );
  assert.equal(mismatch?.expected, "95.4900");
  assert.equal(mismatch?.actual, "110.4900");
});

test("future dates, non-ISO codes and non-positive totals are flagged", () => {
  const base = normalizeAzureReceipt(restaurant).normalized;
  const issues = validateNormalizedReceipt(
    {
      ...base,
      transactionDate: "2026-11-01",
      currency: "ZZZ",
      currencyReadings: ["ZZZ"],
      subtotal: null,
      taxTotal: null,
      tip: null,
      total: "-5.0000",
      taxDetails: [],
      items: [],
    },
    { confidenceThreshold: THRESHOLD, today: "2026-10-17" },
  );
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["future_date", "invalid_currency", "non_positive_total"],
  );
});

test("a confident receipt drafts every field and carries the suggestion only as a suggestion", () => {
  const { normalized } = normalizeAzureReceipt(restaurant);
  const draft = draftExpenseLineFromReceipt({
    receipt: normalized,
    confidenceThreshold: THRESHOLD,
    reportCurrency: "CAD",
    merchantPartyId: "party-keg",
    suggestedAccount: { accountId: "acct-meals", source: "employee_history" },
  });
  assert.equal(draft.transactionDate.value, "2026-10-03");
  assert.equal(draft.merchantName.value, "The Keg Steakhouse #214");
  assert.equal(draft.merchantPartyId, "party-keg");
  assert.equal(draft.currencyMatchesReport, true);
  assert.equal(draft.total.value, "110.4900");
  assert.equal(draft.taxAmount.value, "10.9900");
  assert.equal(draft.tip.value, "15.0000");
  assert.deepEqual(draft.suggestedAccount, { accountId: "acct-meals", source: "employee_history" });
});

test("merchant keys ignore case, accents, punctuation and store numbers but keep every script", () => {
  assert.equal(
    receiptMerchantKey("The Keg Steakhouse #214"),
    receiptMerchantKey("THE KEG STEAKHOUSE"),
  );
  assert.equal(receiptMerchantKey("Café de Flore"), "cafedeflore");
  assert.equal(receiptMerchantKey("スターバックス"), "スターバックス");
  assert.notEqual(receiptMerchantKey("スターバックス"), receiptMerchantKey("ドトール"));
  assert.equal(receiptMerchantKey("#12 — "), null);
  assert.equal(receiptMerchantKey(null), null);
});

test("account suggestion prefers the employee's history, then the organization's, then the vendor default", () => {
  const postable = new Set(["meals", "travel", "office"]);
  assert.deepEqual(
    chooseAccountSuggestion({
      employeeHistory: "meals",
      organizationHistory: "travel",
      vendorDefault: "office",
      postableAccountIds: postable,
    }),
    { accountId: "meals", source: "employee_history" },
  );
  assert.deepEqual(
    chooseAccountSuggestion({
      employeeHistory: null,
      organizationHistory: "travel",
      vendorDefault: "office",
      postableAccountIds: postable,
    }),
    { accountId: "travel", source: "organization_history" },
  );
  // A historical account that is no longer postable is skipped, not offered.
  assert.deepEqual(
    chooseAccountSuggestion({
      employeeHistory: "retired",
      organizationHistory: null,
      vendorDefault: "office",
      postableAccountIds: postable,
    }),
    { accountId: "office", source: "vendor_default" },
  );
  assert.equal(
    chooseAccountSuggestion({
      employeeHistory: null,
      organizationHistory: null,
      vendorDefault: null,
      postableAccountIds: postable,
    }),
    null,
  );
});

test("duplicate receipts warn once per report and reason, naming where the original is", () => {
  const issues = receiptDuplicateIssues([
    {
      captureId: "a",
      reason: "same_file",
      documentId: "r1",
      documentNumber: "EXP-0007",
      sameReport: false,
    },
    {
      captureId: "b",
      reason: "same_file",
      documentId: "r1",
      documentNumber: "EXP-0007",
      sameReport: false,
    },
    {
      captureId: "c",
      reason: "same_receipt",
      documentId: "r2",
      documentNumber: "EXP-0009",
      sameReport: true,
    },
  ]);
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.severity, issue.cause, issue.detail]),
    [
      ["possible_duplicate", "warning", "same_file", "EXP-0007"],
      ["possible_duplicate", "warning", "same_receipt", "EXP-0009"],
    ],
  );
  assert.match(issues[0]!.message!, /expense report EXP-0007/);
  assert.match(issues[1]!.message!, /this report/);
});

test("receipt uploads accept PDF and image formats only", () => {
  assert.equal(isReceiptContentType("image/jpeg"), true);
  assert.equal(isReceiptContentType("application/pdf"), true);
  assert.equal(isReceiptContentType("application/xml"), false);
  assert.equal(isReceiptContentType("image/gif"), false);
});

test("the Azure adapter submits the receipt model and normalizes the polled result", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fakeFetch: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), method: init?.method ?? "GET" });
    if (init?.method === "POST") {
      assert.equal(new Headers(init.headers).get("Content-Type"), "image/jpeg");
      return new Response(null, {
        status: 202,
        headers: {
          "operation-location":
            "https://demo.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/1",
        },
      });
    }
    return Response.json(restaurant);
  };
  const result = await extractAzureReceipt({
    endpoint: "https://demo.cognitiveservices.azure.com",
    apiKey: "secret",
    contentType: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    fetchImpl: fakeFetch,
    lookup: async () => ["20.50.100.1"],
  });
  assert.match(calls[0]!.url, /documentModels\/prebuilt-receipt:analyze\?api-version=2024-11-30$/);
  assert.equal(calls.length, 2);
  assert.equal(result.normalized.total, "110.4900");
});

test("the Azure adapter refuses a non-provider endpoint before sending the key", async () => {
  await assert.rejects(
    extractAzureReceipt({
      endpoint: "https://example.com",
      apiKey: "secret",
      contentType: "image/png",
      bytes: new Uint8Array(),
      fetchImpl: async () => {
        throw new Error("must not run");
      },
      lookup: async () => ["20.50.100.1"],
    }),
    /not an Azure Document Intelligence endpoint/,
  );
});

test("a provider failure surfaces the provider's structured message", async () => {
  await assert.rejects(
    extractAzureReceipt({
      endpoint: "https://demo.cognitiveservices.azure.com",
      apiKey: "secret",
      contentType: "image/png",
      bytes: new Uint8Array([0x89]),
      fetchImpl: async () =>
        Response.json({ error: { message: "Invalid subscription key" } }, { status: 401 }),
      lookup: async () => ["20.50.100.1"],
    }),
    /Document provider submission failed: Invalid subscription key/,
  );
});

test("an analysis with no recognized receipt is refused by name", () => {
  assert.throws(
    () => normalizeAzureReceipt({ status: "succeeded", analyzeResult: { documents: [] } }),
    /no recognized receipt/,
  );
});

const llmAnswer = {
  merchantName: { value: "Café de Flore", confidence: 0.97 },
  merchantAddress: { value: "172 Bd Saint-Germain, Paris", confidence: 0.9 },
  merchantPhone: { value: null, confidence: 0 },
  transactionDate: { value: "2026-09-28", text: "28/09/2026", confidence: 0.95 },
  currency: { value: "EUR", symbol: "€", confidence: 0.96 },
  subtotal: { value: "19.50", confidence: 0.93 },
  taxTotal: { value: "3.90", confidence: 0.92 },
  tip: { value: null, confidence: 0 },
  total: { value: "23.40", confidence: 0.98 },
  taxDetails: [{ amount: "3.90", rate: "20%", netAmount: "19.50", description: "TVA" }],
  items: [
    {
      description: "Croque monsieur",
      quantity: "1",
      unitPrice: "12.50",
      amount: "12.50",
      confidence: 0.9,
    },
    {
      description: "Café crème",
      quantity: "2",
      unitPrice: "3.50",
      amount: "7.00",
      confidence: 0.88,
    },
  ],
};

test("an AI model's receipt answer normalizes into the same contract with its stated confidence", () => {
  const { normalized, evidence, overallConfidence } = normalizeLlmReceipt(llmAnswer);
  assert.equal(normalized.merchantName, "Café de Flore");
  assert.equal(normalized.transactionDate, "2026-09-28");
  assert.equal(normalized.currency, "EUR");
  assert.deepEqual(normalized.currencyReadings, ["EUR"]);
  assert.equal(normalized.total, "23.4000");
  assert.equal(normalized.taxTotal, "3.9000");
  assert.equal(normalized.tip, null);
  assert.equal(normalized.items.length, 2);
  assert.equal(normalized.confidence.total, "0.9800");
  assert.equal(overallConfidence, "0.9500", "the weakest identifying field");
  assert.ok(
    evidence.every((field) => field.pageNumber === null && field.polygon === null),
    "a model gives no page geometry",
  );
  assert.deepEqual(
    validateNormalizedReceipt(normalized, { confidenceThreshold: THRESHOLD, today: "2026-10-17" }),
    [],
  );
});

test("an AI reading below the threshold or without a stated confidence stays blank and is flagged", () => {
  const { normalized } = normalizeLlmReceipt({
    ...llmAnswer,
    merchantName: { value: "Cafe de Flore", confidence: 0.42 },
    total: { value: "23.40" },
    currency: { value: null, symbol: "€", confidence: 0.9 },
  });
  assert.equal(normalized.confidence.merchantName, "0.4200");
  assert.equal(normalized.confidence.total, null);
  assert.equal(normalized.currency, null, "a symbol is never read as a currency code");
  assert.equal(normalized.currencySymbol, "€");
  const issues = validateNormalizedReceipt(normalized, { confidenceThreshold: THRESHOLD });
  assert.deepEqual(
    issues
      .filter((issue) => issue.code === "low_confidence")
      .map((issue) => issue.field)
      .sort(),
    ["merchantName", "total"],
  );
  const draft = draftExpenseLineFromReceipt({
    receipt: normalized,
    confidenceThreshold: THRESHOLD,
    reportCurrency: "CAD",
    merchantPartyId: null,
    suggestedAccount: null,
  });
  assert.equal(draft.merchantName.value, null);
  assert.equal(draft.merchantName.reading, "Cafe de Flore");
  assert.equal(draft.total.value, null);
  assert.equal(draft.total.needsReview, true);
});

test("an AI reading copies printed amounts exactly and refuses ambiguous text by name", () => {
  const { normalized } = normalizeLlmReceipt({
    ...llmAnswer,
    total: { value: "1.234.567", confidence: 0.99 },
    subtotal: { value: 19.5, confidence: 0.99 },
    taxTotal: { value: 0.1 + 0.2, confidence: 0.99 },
  });
  assert.equal(normalized.total, "1.234.567", "refused text rides through for the reviewer");
  assert.equal(normalized.subtotal, "19.5000", "a short exact number is kept");
  assert.equal(normalized.taxTotal, null, "a float that lost its digits is not read");
  const issues = validateNormalizedReceipt(normalized, { confidenceThreshold: THRESHOLD });
  assert.ok(
    issues.some(
      (issue) =>
        issue.code === "invalid_amount" && issue.field === "total" && issue.severity === "blocking",
    ),
  );
});

test("an answer that is not a receipt reading fails the capture instead of drafting", () => {
  assert.throws(() => normalizeLlmReceipt({ note: "I cannot read this" }), /not a receipt reading/);
});

test("the AI receipt adapter sends the image with the strict contract and reads the fenced answer", async () => {
  let body: Record<string, unknown> = {};
  let headers = new Headers();
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      content: [
        { type: "text", text: "Here you go:\n```json\n" + JSON.stringify(llmAnswer) + "\n```" },
      ],
    });
  };
  const result = await extractLlmReceipt({
    config: {
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
      baseUrl: null,
    },
    contentType: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    fetchImpl: fakeFetch,
  });
  assert.equal(headers.get("x-api-key"), "sk-ant-test");
  assert.equal(body.model, "claude-sonnet-4-6");
  const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
  assert.equal(content[0]!.type, "image");
  assert.deepEqual((content[0]!.source as Record<string, unknown>).media_type, "image/jpeg");
  assert.match(String(content[1]!.text), /ONLY a JSON object/);
  assert.match(String(content[1]!.text), /Never guess/);
  assert.equal(result.normalized.total, "23.4000");
});

test("an AI answer with no JSON object fails with a retryable reason", async () => {
  await assert.rejects(
    extractLlmReceipt({
      config: { provider: "openai", apiKey: "sk-test", model: "gpt-4o", baseUrl: null },
      contentType: "image/png",
      bytes: new Uint8Array([0x89]),
      fetchImpl: async () =>
        Response.json({ choices: [{ message: { content: "Sorry, the image is too blurry." } }] }),
    }),
    /did not answer with a receipt reading/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  ClosingFxEvidenceError,
  closingFxEvidenceFenceKey,
  closingFxEvidenceRate,
  closingFxEvidenceRequestSha256,
  parseClosingFxRateEvidenceInput,
  staleClosingFxEvidenceRefusal,
  type ClosingFxRateEvidenceRecord,
} from "./fx-revaluation-evidence.ts";

const IDS = {
  bookId: "11111111-1111-4111-8111-111111111111",
  subsidiaryId: "22222222-2222-4222-8222-222222222222",
  periodId: "33333333-3333-4333-8333-333333333333",
  accountId: "44444444-4444-4444-8444-444444444444",
  requestId: "55555555-5555-4555-8555-555555555555",
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...IDS,
    transactionCurrency: "EUR",
    measurementCurrency: "CAD",
    rateDate: "2026-07-31",
    rate: "1.1200000000",
    source: "  European Central Bank reference rate  ",
    reason: "  Period-end bulletin rate for the July close  ",
    expectedCurrentId: null,
    ...overrides,
  };
}

test("a recording request is normalized to its exact rate and trimmed source and reason", () => {
  const input = parseClosingFxRateEvidenceInput(request());
  assert.equal(input.rate, "1.12");
  assert.equal(input.source, "European Central Bank reference rate");
  assert.equal(input.reason, "Period-end bulletin rate for the July close");
  assert.equal(input.expectedCurrentId, null);
});

test("rates are exact positive decimals and never cross binary floating point", () => {
  assert.equal(closingFxEvidenceRate("0.0000000001"), "0.0000000001");
  assert.equal(closingFxEvidenceRate("0"), null);
  assert.equal(closingFxEvidenceRate("-1.12"), null);
  assert.equal(
    closingFxEvidenceRate("1.12345678901"),
    null,
    "eleven decimal places do not fit the stored rate",
  );
  assert.equal(
    closingFxEvidenceRate("1234567890.1"),
    null,
    "ten whole digits do not fit the stored rate",
  );
  assert.equal(closingFxEvidenceRate(1.12), null, "a JSON number is not an exact decimal");
  assert.throws(
    () => parseClosingFxRateEvidenceInput(request({ rate: "1e0" })),
    ClosingFxEvidenceError,
  );
});

test("the expected current quote is required: null opens a root, an id succeeds it, omission refuses", () => {
  const omitted = request();
  delete omitted.expectedCurrentId;
  assert.throws(() => parseClosingFxRateEvidenceInput(omitted), /state the current recorded quote/);
  assert.throws(
    () => parseClosingFxRateEvidenceInput(request({ expectedCurrentId: undefined })),
    /state the current recorded quote/,
  );
  assert.equal(
    parseClosingFxRateEvidenceInput(request({ expectedCurrentId: null })).expectedCurrentId,
    null,
  );
});

test("validated identities normalize to canonical UUID case before hashing and fencing", () => {
  const upper = parseClosingFxRateEvidenceInput(
    request({
      bookId: IDS.bookId.toUpperCase(),
      expectedCurrentId: "66666666-6666-4666-8666-666666666666".toUpperCase(),
    }),
  );
  assert.equal(upper.bookId, IDS.bookId);
  assert.equal(upper.expectedCurrentId, "66666666-6666-4666-8666-666666666666");
  const lower = parseClosingFxRateEvidenceInput(
    request({ expectedCurrentId: "66666666-6666-4666-8666-666666666666" }),
  );
  assert.equal(
    closingFxEvidenceRequestSha256(upper, IDS.subsidiaryId.toUpperCase()),
    closingFxEvidenceRequestSha256(lower, IDS.subsidiaryId),
    "case-only identity differences cannot split a replay",
  );
});

test("a recording names its position, currencies and audit reason or refuses", () => {
  assert.throws(
    () => parseClosingFxRateEvidenceInput(request({ source: "   " })),
    /where the closing exchange rate came from/,
  );
  assert.throws(
    () => parseClosingFxRateEvidenceInput(request({ reason: "short" })),
    /why this closing rate is recorded/,
  );
  assert.throws(
    () => parseClosingFxRateEvidenceInput(request({ measurementCurrency: "EUR" })),
    /no exchange rate to record/,
  );
  assert.throws(
    () => parseClosingFxRateEvidenceInput(request({ bookId: "not-a-uuid" })),
    /valid bookId/,
  );
  assert.throws(
    () => parseClosingFxRateEvidenceInput(request({ expectedCurrentId: "current" })),
    /current recorded quote/,
  );
  assert.throws(
    () => parseClosingFxRateEvidenceInput(request({ rateDate: "31/07/2026" })),
    /final day/,
  );
});

test("the replay fingerprint binds the expected current quote and the actor", () => {
  const root = parseClosingFxRateEvidenceInput(request());
  const successor = parseClosingFxRateEvidenceInput(
    request({
      expectedCurrentId: "66666666-6666-4666-8666-666666666666",
      rate: "1.1300000000",
    }),
  );
  const actor = "77777777-7777-4777-8777-777777777777";
  assert.notEqual(
    closingFxEvidenceRequestSha256(root, actor),
    closingFxEvidenceRequestSha256(successor, actor),
  );
  assert.notEqual(
    closingFxEvidenceRequestSha256(root, actor),
    closingFxEvidenceRequestSha256(root, "88888888-8888-4888-8888-888888888888"),
  );
  assert.equal(
    closingFxEvidenceRequestSha256(root, actor),
    closingFxEvidenceRequestSha256({ ...root }, actor),
  );
});

test("the position fence scopes one book, entity, period, account and currency", () => {
  const key = { ...IDS, transactionCurrency: "EUR" };
  assert.equal(
    closingFxEvidenceFenceKey("org-1", key),
    `fx-revaluation-evidence:org-1:${IDS.bookId}:${IDS.subsidiaryId}:${IDS.periodId}:${IDS.accountId}:EUR`,
  );
  assert.notEqual(
    closingFxEvidenceFenceKey("org-1", key),
    closingFxEvidenceFenceKey("org-1", { ...key, accountId: IDS.requestId }),
  );
});

test("a quote stale in measurement currency or rate date refuses instead of repricing", () => {
  const quote: ClosingFxRateEvidenceRecord = {
    id: IDS.requestId,
    ...IDS,
    transactionCurrency: "EUR",
    measurementCurrency: "CAD",
    rateDate: "2026-07-31",
    rate: "1.1200000000",
    source: "European Central Bank reference rate",
    reason: "Period-end bulletin rate for the July close",
    version: 1,
    supersedesId: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    createdBy: IDS.subsidiaryId,
  };
  assert.equal(staleClosingFxEvidenceRefusal(quote, "CAD", "2026-07-31"), null);
  assert.match(
    staleClosingFxEvidenceRefusal(quote, "USD", "2026-07-31")!,
    /record a successor closing rate/,
  );
  assert.match(
    staleClosingFxEvidenceRefusal(quote, "CAD", "2026-08-31")!,
    /record a successor closing rate/,
  );
});

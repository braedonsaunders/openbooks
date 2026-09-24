import assert from "node:assert/strict";
import test from "node:test";
import {
  filterDuplicateStatementLines,
  normalizeFingerprintText,
  statementSourceSha256,
  type ParsedStatementLine,
} from "./banking.ts";
import {
  bankFeedSourceEvidence,
  getBankFeedAdapter,
  plaidFetchAllTransactions,
} from "./bank-feed-providers.ts";

const line = (overrides: Partial<ParsedStatementLine> = {}): ParsedStatementLine => ({
  postedOn: "2026-08-01",
  amount: "-25.0000",
  description: "COFFEE SHOP",
  counterpartyRef: null,
  bankTransactionId: null,
  ...overrides,
});

// The filter primitive keys ONLY on transaction IDs, never on content: it
// cannot tell two ID-less lines apart, so every ID-less line passes through
// it untouched. Content overlap is partitioned at the import level, where a
// colliding tuple always imports flagged — only an exact source-byte replay
// or a bank-provided ID may auto-skip (see the re-import integration tests).
test("the filter primitive keys only on transaction IDs, not on content", () => {
  const first = filterDuplicateStatementLines([line()], new Set());
  assert.equal(first.lines.length, 1);
  assert.equal(first.lines[0]!.bankTransactionId, null);

  const persistedSourceIds = new Set(
    first.lines.flatMap((entry) =>
      entry.bankTransactionId ? [entry.bankTransactionId] : [],
    ),
  );
  const second = filterDuplicateStatementLines([line()], persistedSourceIds);
  assert.equal(second.lines.length, 1);
  assert.equal(second.duplicates, 0);
});

test("content-identical ID-less transactions within one filter pass are all retained", () => {
  const filtered = filterDuplicateStatementLines([line(), line(), line()], new Set());
  assert.equal(filtered.lines.length, 3);
  assert.equal(filtered.duplicates, 0);
});

test("content comparison ignores description case and spacing", () => {
  assert.equal(normalizeFingerprintText("  coffee   shop "), "COFFEE SHOP");
  assert.equal(normalizeFingerprintText(null), "");
  assert.notEqual(normalizeFingerprintText("COFFEE SHOP"), normalizeFingerprintText("TEA SHOP"));
});

test("exact retries of an ID-less statement source suppress every line", () => {
  const source = Buffer.from("Date,Amount,Description\n2026-08-01,-25.00,COFFEE SHOP\n");
  const importedSourceHashes = new Set([statementSourceSha256(source)]);
  const retryHash = statementSourceSha256(Buffer.from(source));
  const filtered = filterDuplicateStatementLines(
    [line(), line({ amount: "-10.0000" })],
    new Set(),
    importedSourceHashes.has(retryHash),
  );

  assert.deepEqual(filtered.lines, []);
  assert.equal(filtered.duplicates, 2);
});

test("one-byte-different sources do not suppress ID-less lines", () => {
  const importedHash = statementSourceSha256("date,amount\n2026-08-01,-25.00\n");
  const nextHash = statementSourceSha256("date,amount\n2026-08-01,-25.01\n");
  const filtered = filterDuplicateStatementLines(
    [line()],
    new Set(),
    importedHash === nextHash,
  );

  assert.equal(filtered.lines.length, 1);
  assert.equal(filtered.duplicates, 0);
});

test("source-provided transaction IDs still dedupe across and within imports", () => {
  const filtered = filterDuplicateStatementLines(
    [
      line({ bankTransactionId: "FITID-existing" }),
      line({ bankTransactionId: "FITID-new" }),
      line({ bankTransactionId: "FITID-new" }),
      line(),
    ],
    new Set(["FITID-existing"]),
  );
  assert.deepEqual(
    filtered.lines.map((entry) => entry.bankTransactionId),
    ["FITID-new", null],
  );
  assert.equal(filtered.duplicates, 2);
});

test("plaid pagination accumulates every page until has_more is false", async () => {
  const pages = [
    { transactions: [{ transaction_id: "t1" }, { transaction_id: "t2" }], has_more: true },
    { transactions: [{ transaction_id: "t3" }], has_more: true },
    { transactions: [], has_more: false },
  ];
  const offsetsSeen: number[] = [];
  const all = await plaidFetchAllTransactions(async (offset) => {
    offsetsSeen.push(offset);
    return pages[offsetsSeen.length - 1]!;
  });
  assert.deepEqual(offsetsSeen, [0, 500, 1000]);
  assert.deepEqual(all, pages.flatMap((p) => p.transactions));
});

test("plaid pagination aborts loudly past the hard page cap instead of truncating", async () => {
  let calls = 0;
  await assert.rejects(
    plaidFetchAllTransactions(async () => {
      calls += 1;
      return { transactions: [{ transaction_id: `t${calls}` }], has_more: true };
    }),
    /exceeded 20 pages/,
  );
  assert.equal(calls, 20);
});

test("live provider fetch retains exact response bytes for statement audit", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const rawResponse = `{
  "results": [{
    "transaction_id": "txn-audit-1",
    "timestamp": "2026-08-22T14:03:00Z",
    "amount": -12.34,
    "currency": "CAD",
    "description": "ORIGINAL PROVIDER PAYLOAD"
  }],
  "provider_request_id": "request-preserved-verbatim"
}\n`;
  globalThis.fetch = async () => new Response(rawResponse, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

  const adapter = getBankFeedAdapter("truelayer");
  assert.ok(adapter);
  const fetched = await adapter.fetch(
    { accessToken: "test-token" },
    "external-account-1",
    "2026-08-01",
    "2026-08-23",
  );

  const evidenceContent = fetched.sourceEvidence.content;
  const evidenceBytes = typeof evidenceContent === "string"
    ? Buffer.from(evidenceContent, "utf8")
    : Buffer.from(evidenceContent);
  assert.deepEqual(evidenceBytes, Buffer.from(rawResponse, "utf8"));
  assert.equal(fetched.sourceEvidence.contentType, "application/json");
});

test("paginated provider evidence keeps every response byte-for-byte recoverable", () => {
  const pages = [
    Buffer.from("{\n  \"transactions\": [{\"transaction_id\": \"page-1\"}], \"has_more\": true\n}\n"),
    Buffer.from("{\"transactions\":[],\"has_more\":false,\"request_id\":\"page-2\"}"),
  ];
  const evidence = bankFeedSourceEvidence("plaid", pages);
  assert.equal(typeof evidence.content, "string");
  const bundle = JSON.parse(evidence.content as string) as {
    format: string;
    provider: string;
    encoding: string;
    responses: string[];
  };

  assert.equal(bundle.format, "openbooks.bank-feed-response-bundle.v1");
  assert.equal(bundle.provider, "plaid");
  assert.equal(bundle.encoding, "base64");
  assert.deepEqual(
    bundle.responses.map((encoded) => Buffer.from(encoded, "base64")),
    pages,
  );
});

test("plaid adapter imports only settled transactions, never pending ones", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    transactions: [
      {
        transaction_id: "posted-1",
        date: "2026-08-10",
        amount: 42.5,
        name: "SETTLED GROCER",
        iso_currency_code: "CAD",
        pending: false,
      },
      {
        transaction_id: "pending-1",
        date: "2026-08-11",
        amount: 99.99,
        name: "PENDING HOTEL HOLD",
        iso_currency_code: "CAD",
        pending: true,
      },
    ],
    has_more: false,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const adapter = getBankFeedAdapter("plaid");
  assert.ok(adapter);
  const fetched = await adapter.fetch(
    { clientId: "c", secret: "s", accessToken: "t", env: "sandbox" },
    "external-account-1",
    "2026-08-01",
    "2026-08-23",
  );
  // Pending authorizations change amount, post under a new id, or vanish, so
  // they must never become statement truth (GoCardless already takes booked
  // only for exactly this reason).
  assert.deepEqual(
    fetched.lines.map((line) => line.bankTransactionId),
    ["posted-1"],
  );
});

test("gocardless adapter keys lines by the provider-unique transaction id", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/token/new/")) {
      return new Response(JSON.stringify({ access: "token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      transactions: {
        booked: [
          {
            transactionId: "BANK-SHARED-REF",
            internalTransactionId: "internal-aaa",
            bookingDate: "2026-08-10",
            transactionAmount: { amount: "-10.00", currency: "CAD" },
            remittanceInformationUnstructured: "FIRST BOOKING",
          },
          {
            transactionId: "BANK-SHARED-REF",
            internalTransactionId: "internal-bbb",
            bookingDate: "2026-08-11",
            transactionAmount: { amount: "-20.00", currency: "CAD" },
            remittanceInformationUnstructured: "SECOND BOOKING",
          },
        ],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const adapter = getBankFeedAdapter("gocardless");
  assert.ok(adapter);
  const fetched = await adapter.fetch(
    { secretId: "id", secretKey: "key" },
    "external-account-1",
    "2026-08-01",
    "2026-08-23",
  );
  // The bank-supplied transactionId is not unique per booking; the provider's
  // internal id is. Keying by the bank id silently drops the second booking.
  assert.deepEqual(
    fetched.lines.map((line) => line.bankTransactionId),
    ["internal-aaa", "internal-bbb"],
  );
  const filtered = filterDuplicateStatementLines(fetched.lines, new Set());
  assert.equal(filtered.lines.length, 2);
  assert.equal(filtered.duplicates, 0);
});

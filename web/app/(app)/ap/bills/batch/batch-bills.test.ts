import assert from "node:assert/strict";
import test from "node:test";
import type { TaxComponentConfig } from "@openbooks/engine/tax/tax";
import { normalizeDocumentReference } from "@openbooks/engine/records/document-reference";
import {
  applyVendorDefaults,
  batchDraftKey,
  batchEntered,
  fetchBatchTaxProfiles,
  batchRowIssues,
  batchRowPayload,
  batchRowTotal,
  blankBatchRow,
  clearFinishedRows,
  cloneBatchRow,
  controlVariance,
  hasUnsavedWork,
  inBatchDuplicates,
  inheritBillDates,
  normalizeVendorReference,
  parseBatchDraft,
  readBatchDraft,
  runWithConcurrency,
  saveBatchRow,
  writeBatchDraft,
  type BatchBillRow,
  type BatchSaveCopy,
  type DraftStorage,
} from "./batch-bills";

const VENDOR_A = "11111111-1111-4111-8111-111111111111";
const VENDOR_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const OTHER_ACCOUNT = "44444444-4444-4444-8444-444444444444";
const TAX_CODE = "55555555-5555-4555-8555-555555555555";
const TAX_GROUP = "66666666-6666-4666-8666-666666666666";
const SUBSIDIARY = "77777777-7777-4777-8777-777777777777";

const copy: BatchSaveCopy = {
  fallback: "Could not save",
  unavailable: "Server unreachable",
  conflict: "Already used",
};

function bill(overrides: Partial<BatchBillRow> = {}): BatchBillRow {
  return {
    ...blankBatchRow("2026-10-01"),
    partyId: VENDOR_A,
    referenceNumber: "INV-1",
    accountId: ACCOUNT,
    amount: "100",
    ...overrides,
  };
}

const hst: TaxComponentConfig[] = [
  { taxCodeId: TAX_CODE, code: "HST", sequence: 1, ratePercent: "13" },
];
const taxByProfile = new Map<string, readonly TaxComponentConfig[]>([[`code:${TAX_CODE}`, hst]]);

test("a row maps to the drawer create body for a one-line, amount-only bill", () => {
  const row = bill({
    amount: "1234.5",
    memo: " Office supplies ",
    taxProfileId: `code:${TAX_CODE}`,
    referenceNumber: " INV-9 ",
  });
  assert.deepEqual(batchRowPayload(row, { hasTax: true, subsidiaryId: SUBSIDIARY }), {
    partyId: VENDOR_A,
    documentDate: "2026-10-01",
    referenceNumber: "INV-9",
    memo: "Office supplies",
    subsidiaryId: SUBSIDIARY,
    lines: [
      {
        accountId: ACCOUNT,
        description: "Office supplies",
        quantity: null,
        unitPrice: null,
        amount: "1234.5000",
        taxCodeId: TAX_CODE,
        taxGroupId: null,
        taxOverridden: false,
        taxAmount: null,
      },
    ],
  });
});

test("a blank due date is omitted so the server derives it from terms; a typed one is sent", () => {
  const derived = batchRowPayload(bill(), { hasTax: false });
  assert.equal("dueDate" in derived, false);
  assert.equal("subsidiaryId" in derived, false, "single-entity organizations send no subsidiary");
  assert.equal(
    batchRowPayload(bill({ dueDate: "2026-11-15" }), { hasTax: false }).dueDate,
    "2026-11-15",
  );
});

test("tax groups map to taxGroupId, and tax is never sent when the organization has no tax codes", () => {
  const grouped = batchRowPayload(bill({ taxProfileId: `group:${TAX_GROUP}` }), {
    hasTax: true,
  }) as { lines: Record<string, unknown>[] };
  assert.equal(grouped.lines[0]!.taxGroupId, TAX_GROUP);
  assert.equal(grouped.lines[0]!.taxCodeId, null);
  const untaxed = batchRowPayload(bill({ taxProfileId: `code:${TAX_CODE}` }), {
    hasTax: false,
  }) as { lines: Record<string, unknown>[] };
  assert.equal(untaxed.lines[0]!.taxCodeId, null);
});

test("a bill total includes the tax its code computes, rounded as the tax engine rounds it", () => {
  assert.equal(
    batchRowTotal(bill({ amount: "100.10", taxProfileId: `code:${TAX_CODE}` }), taxByProfile),
    "113.1100",
  );
  assert.equal(batchRowTotal(bill({ amount: "100.10" }), taxByProfile), "100.1000");
  assert.equal(
    batchRowTotal(bill({ amount: "12,00" }), taxByProfile),
    null,
    "a separator is never coerced",
  );
});

test("control totals report the variance in bill count and in exact money", () => {
  const rows = [
    bill({ amount: "0.10" }),
    bill({ amount: "0.20", referenceNumber: "INV-2" }),
    bill({ amount: "100", referenceNumber: "INV-3", taxProfileId: `code:${TAX_CODE}` }),
    blankBatchRow("2026-10-01"),
  ];
  const entered = batchEntered(rows, taxByProfile);
  assert.deepEqual(entered, { count: 3, total: "113.3000" });

  const matched = controlVariance({ count: "3", total: "113.30" }, entered);
  assert.equal(matched.matched, true);
  assert.equal(matched.countDifference, 0);
  assert.equal(matched.totalDifference, "0.0000");

  const off = controlVariance({ count: "4", total: "113.25" }, entered);
  assert.equal(off.matched, false);
  assert.equal(off.countDifference, -1, "one bill fewer entered than counted");
  assert.equal(off.totalDifference, "0.0500", "entered exceeds the control total by five cents");

  const arithmetic = controlVariance({ count: "", total: "100+13.30" }, entered);
  assert.equal(
    arithmetic.matched,
    true,
    "the control total accepts the same arithmetic as amount cells",
  );

  const none = controlVariance({ count: "", total: "" }, entered);
  assert.equal(none.active, false);
  assert.equal(none.matched, true);

  const invalid = controlVariance({ count: "three", total: "1,13.30" }, entered);
  assert.equal(invalid.countInvalid, true);
  assert.equal(invalid.totalInvalid, true);
  assert.equal(invalid.matched, false, "an unreadable control never passes as matched");
});

test("in-batch duplicates match the same vendor and normalised invoice number only", () => {
  const rows = [
    bill({ referenceNumber: "INV-0042" }),
    bill({ referenceNumber: "inv 0042" }),
    bill({ referenceNumber: "#INV0042", partyId: VENDOR_B }),
    bill({ referenceNumber: "" }),
    bill({ referenceNumber: "--" }),
    bill({ referenceNumber: "INV-0043" }),
  ];
  const duplicates = inBatchDuplicates(rows);
  assert.deepEqual(duplicates.get(rows[0]!.key), [2]);
  assert.deepEqual(duplicates.get(rows[1]!.key), [1]);
  assert.equal(duplicates.has(rows[2]!.key), false, "another vendor may reuse the number");
  assert.equal(duplicates.has(rows[3]!.key), false, "a blank reference identifies nothing");
  assert.equal(duplicates.has(rows[4]!.key), false, "punctuation alone identifies nothing");
  assert.equal(duplicates.has(rows[5]!.key), false);
});

test("the batch reference rule agrees with the rule applied to stored bills", () => {
  for (const sample of ["INV-0042", " inv 0042 ", "#Inv/0042", "--", "", "Ab-12 c"]) {
    assert.equal(normalizeVendorReference(sample), normalizeDocumentReference(sample), sample);
  }
});

test("new rows inherit the bill date of the row above; the first row takes today", () => {
  const first = blankBatchRow("2026-10-03");
  const second = blankBatchRow();
  const third = blankBatchRow();
  const next = inheritBillDates([first], [first, second, third], "2026-10-21");
  assert.deepEqual(
    next.map((row) => row.documentDate),
    ["2026-10-03", "2026-10-03", "2026-10-03"],
  );

  const inserted = blankBatchRow();
  const pasted = { ...blankBatchRow(), documentDate: "2026-09-30" };
  const afterInsert = inheritBillDates(next, [inserted, ...next, pasted], "2026-10-21");
  assert.equal(afterInsert[0]!.documentDate, "2026-10-21", "a row inserted at the top takes today");
  assert.equal(afterInsert[4]!.documentDate, "2026-09-30", "a pasted date is kept");

  const cleared = { ...next[1]!, documentDate: "" };
  const unchanged = [next[0]!, cleared, next[2]!];
  assert.equal(
    inheritBillDates(next, unchanged, "2026-10-21"),
    unchanged,
    "a date the clerk cleared stays cleared",
  );
});

test("row issues name what blocks a save before any write", () => {
  assert.deepEqual(batchRowIssues(bill()), []);
  assert.deepEqual(batchRowIssues(bill({ partyId: "", accountId: "", amount: "" })), [
    "vendor",
    "amountMissing",
    "account",
  ]);
  assert.deepEqual(batchRowIssues(bill({ amount: "12,00" })), ["amountInvalid"]);
  assert.deepEqual(batchRowIssues(bill({ amount: "-5" })), ["amountNotPositive"]);
  assert.deepEqual(batchRowIssues(bill({ documentDate: "" })), ["billDate"]);
  assert.deepEqual(
    batchRowIssues(blankBatchRow("2026-10-01")),
    [],
    "an untouched row is ignored, not refused",
  );
  assert.deepEqual(
    batchRowIssues(bill({ documentId: VENDOR_B, accountId: "" })),
    [],
    "a saved bill is not re-validated",
  );
});

test("a duplicated row is a new bill with its own create key", () => {
  const saved = bill({ documentId: VENDOR_B, documentNumber: "BILL-1", outcome: "saved" });
  const copyRow = cloneBatchRow(saved);
  assert.notEqual(copyRow.key, saved.key);
  assert.notEqual(copyRow.idempotencyKey, saved.idempotencyKey);
  assert.equal(copyRow.documentId, "");
  assert.equal(copyRow.outcome, "");
  assert.equal(copyRow.partyId, saved.partyId);
});

test("vendor defaults fill blanks and follow the vendor, but never replace the clerk's choice", () => {
  const context = {
    accountIds: new Set([ACCOUNT, OTHER_ACCOUNT]),
    taxProfileValues: new Set([`code:${TAX_CODE}`]),
    hasTax: true,
  };
  const filled = applyVendorDefaults(
    bill({ accountId: "" }),
    { termsDueDate: null, accountId: ACCOUNT, taxCodeId: TAX_CODE, taxGroupId: null },
    context,
  );
  assert.equal(filled.accountId, ACCOUNT);
  assert.equal(filled.taxProfileId, `code:${TAX_CODE}`);
  assert.equal(filled.defaultsFor, VENDOR_A);

  const chosen = applyVendorDefaults(
    bill({ accountId: OTHER_ACCOUNT }),
    { termsDueDate: null, accountId: ACCOUNT, taxCodeId: null, taxGroupId: null },
    context,
  );
  assert.equal(chosen.accountId, OTHER_ACCOUNT, "an account the clerk chose is kept");

  const switched = applyVendorDefaults(
    { ...filled, partyId: VENDOR_B },
    { termsDueDate: null, accountId: OTHER_ACCOUNT, taxCodeId: null, taxGroupId: null },
    context,
  );
  assert.equal(
    switched.accountId,
    OTHER_ACCOUNT,
    "the previous vendor's default follows the new vendor",
  );
  assert.equal(switched.taxProfileId, "", "a stale default tax is cleared");

  const outOfScope = applyVendorDefaults(
    bill({ accountId: "" }),
    { termsDueDate: null, accountId: VENDOR_B, taxCodeId: null, taxGroupId: null },
    context,
  );
  assert.equal(outOfScope.accountId, "", "a default outside the page's choices is not applied");

  const grouped = applyVendorDefaults(
    bill({ accountId: "" }),
    { termsDueDate: null, accountId: ACCOUNT, taxCodeId: null, taxGroupId: TAX_GROUP },
    {
      ...context,
      taxProfileValues: new Set([`code:${TAX_CODE}`, `group:${TAX_GROUP}`]),
    },
  );
  assert.equal(
    grouped.taxProfileId,
    `group:${TAX_GROUP}`,
    "a tax group the vendor settles on is preselected like a code",
  );
});

// -- persistence ---------------------------------------------------------------

function memoryStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

test("an unsaved batch round-trips through storage, create keys included", () => {
  const storage = memoryStorage();
  const key = batchDraftKey("org-1", "user-1");
  const rows = [
    bill({ documentId: VENDOR_B, documentNumber: "BILL-7", outcome: "saved" }),
    bill({ referenceNumber: "INV-2", error: "Period closed" }),
    blankBatchRow("2026-10-01"),
  ];
  assert.equal(
    writeBatchDraft(storage, key, {
      rows,
      controlCount: "2",
      controlTotal: "200",
      subsidiaryId: SUBSIDIARY,
    }),
    true,
  );
  const restored = readBatchDraft(storage, key);
  assert.ok(restored);
  assert.deepEqual(restored.rows, rows);
  assert.equal(restored.controlCount, "2");
  assert.equal(restored.controlTotal, "200");
  assert.equal(restored.subsidiaryId, SUBSIDIARY);
});

test("a batch whose bills all saved is forgotten", () => {
  const storage = memoryStorage();
  const key = batchDraftKey("org-1", "user-1");
  writeBatchDraft(storage, key, {
    rows: [bill()],
    controlCount: "",
    controlTotal: "",
    subsidiaryId: "",
  });
  assert.equal(storage.data.has(key), true);
  const finished = [bill({ documentId: VENDOR_B, outcome: "posted" }), blankBatchRow("2026-10-01")];
  assert.equal(hasUnsavedWork(finished), false);
  writeBatchDraft(storage, key, {
    rows: finished,
    controlCount: "",
    controlTotal: "",
    subsidiaryId: "",
  });
  assert.equal(storage.data.has(key), false);
});

test("stored batches that cannot be read back exactly are not restored", () => {
  assert.equal(parseBatchDraft("not json"), null);
  assert.equal(
    parseBatchDraft(JSON.stringify({ version: 99, rows: [bill()] })),
    null,
    "another format version is ignored",
  );
  const tampered = JSON.parse(
    JSON.stringify({
      version: 1,
      rows: [bill(), { ...bill(), idempotencyKey: "x" }, { ...bill(), amount: 5 }],
    }),
  );
  const restored = parseBatchDraft(JSON.stringify(tampered));
  assert.equal(
    restored?.rows.length,
    1,
    "rows with an unreadable create key or a non-text field are dropped",
  );
  const failing: DraftStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {},
  };
  assert.equal(
    writeBatchDraft(failing, "k", {
      rows: [bill()],
      controlCount: "",
      controlTotal: "",
      subsidiaryId: "",
    }),
    false,
  );
});

test("clearing finished rows shrinks the control totals by the bills removed", () => {
  const rows = [
    bill({ amount: "100", documentId: VENDOR_B, outcome: "saved" }),
    bill({ amount: "50", referenceNumber: "INV-2" }),
  ];
  const cleared = clearFinishedRows(rows, { count: "2", total: "150" }, taxByProfile, "2026-10-21");
  assert.equal(cleared.rows.length, 1);
  assert.deepEqual(cleared.control, { count: "1", total: "50.0000" });

  const allDone = clearFinishedRows(
    [rows[0]!],
    { count: "1", total: "100" },
    taxByProfile,
    "2026-10-21",
  );
  assert.equal(allDone.rows.length, 1);
  assert.equal(allDone.rows[0]!.documentId, "");
  assert.equal(allDone.rows[0]!.documentDate, "2026-10-01", "the fresh row keeps the batch date");
  assert.deepEqual(allDone.control, { count: "", total: "" });
});

// -- save loop -----------------------------------------------------------------

type Call = {
  url: string;
  method: string;
  idempotencyKey: string | null;
  body: Record<string, unknown>;
};

function scriptedTransport(script: (call: Call, index: number) => Response | Error) {
  const calls: Call[] = [];
  const transport = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      idempotencyKey: headers.get("Idempotency-Key"),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    calls.push(call);
    const outcome = script(call, calls.length - 1);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { calls, transport };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const created = (id: string, number: string) =>
  json({ doc: { id, document_number: number }, lines: [] }, 201);

test("a retry after a lost response reuses the row's create key", async () => {
  const row = bill();
  const { calls, transport } = scriptedTransport((_call, index) =>
    index === 0 ? new TypeError("network down") : created(row.idempotencyKey, "BILL-00042"),
  );
  const first = await saveBatchRow(row, { post: false, hasTax: false, transport, copy });
  assert.deepEqual(first, {
    documentId: "",
    documentNumber: "",
    outcome: "",
    error: "Server unreachable",
    conflict: false,
  });
  const second = await saveBatchRow(row, { post: false, hasTax: false, transport, copy });
  assert.equal(second.outcome, "saved");
  assert.equal(second.documentNumber, "BILL-00042");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.idempotencyKey, row.idempotencyKey);
  assert.equal(
    calls[1]!.idempotencyKey,
    row.idempotencyKey,
    "the same key replays instead of creating a second bill",
  );
  assert.equal(calls[0]!.url, "/api/documents");
  assert.equal(calls[0]!.body.kind, "vendor_bill");
});

test("a refused row keeps its reason and the batch continues", async () => {
  const rows = [
    bill({ referenceNumber: "A" }),
    bill({ referenceNumber: "B" }),
    bill({ referenceNumber: "C" }),
  ];
  const { calls, transport } = scriptedTransport((call) =>
    call.body.referenceNumber === "B"
      ? json({ error: "Line 1 needs an account that accepts postings" }, 422)
      : created(call.idempotencyKey!, `BILL-${call.body.referenceNumber}`),
  );
  const progress: number[] = [];
  const results = await runWithConcurrency(
    rows,
    (row) => saveBatchRow(row, { post: false, hasTax: false, transport, copy }),
    {
      concurrency: 3,
      onSettled: (_row, _result, done) => progress.push(done),
    },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(
    results.map((result) => result.outcome),
    ["saved", "", "saved"],
  );
  assert.match(results[1]!.error, /needs an account/);
  assert.deepEqual(progress, [1, 2, 3]);
});

test("concurrency never exceeds its bound", async () => {
  let inFlight = 0;
  let peak = 0;
  await runWithConcurrency(
    Array.from({ length: 10 }, (_, index) => index),
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
    },
    { concurrency: 3 },
  );
  assert.equal(peak, 3);
});

test("posting uses the native atomic command on the bill the create returned", async () => {
  const row = bill();
  const { calls, transport } = scriptedTransport((call) =>
    call.url === "/api/documents" ? created(row.idempotencyKey, "BILL-00043") : json({ ok: true }),
  );
  const result = await saveBatchRow(row, { post: true, hasTax: false, transport, copy });
  assert.equal(result.outcome, "posted");
  assert.deepEqual(
    calls.map((call) => [call.url, call.body.action ?? null, call.body.documentId ?? null]),
    [
      ["/api/documents", null, null],
      ["/api/documents/actions", "post", row.idempotencyKey],
    ],
  );
});

test("a bill held for approval stops at pending and is never posted around it", async () => {
  const row = bill();
  const { calls, transport } = scriptedTransport((call) =>
    call.url === "/api/documents"
      ? created(row.idempotencyKey, "BILL-00044")
      : json({ ok: true, pendingApproval: true }, 202),
  );
  const result = await saveBatchRow(row, { post: true, hasTax: false, transport, copy });
  assert.equal(result.outcome, "pending");
  assert.equal(calls.filter((call) => call.body.action === "post").length, 1);
});

test("a refused post keeps the saved bill, and the retry resumes without creating again", async () => {
  const row = bill();
  let postRefused = false;
  const { calls, transport } = scriptedTransport((call) => {
    if (call.url === "/api/documents") return created(row.idempotencyKey, "BILL-00045");
    if (call.body.action === "post" && !postRefused) {
      postRefused = true;
      return json(
        {
          error: "The period is closed for posting",
          remedy: "Reopen the period or change the bill date",
        },
        409,
      );
    }
    return json({ ok: true });
  });
  const first = await saveBatchRow(row, { post: true, hasTax: false, transport, copy });
  assert.equal(first.outcome, "saved");
  assert.equal(first.documentId, row.idempotencyKey);
  assert.match(first.error, /period is closed/);

  const retry = await saveBatchRow(
    { ...row, ...first },
    { post: true, hasTax: false, transport, copy },
  );
  assert.equal(retry.outcome, "posted");
  assert.equal(retry.error, "");
  assert.equal(
    calls.filter((call) => call.url === "/api/documents").length,
    1,
    "the bill is created exactly once",
  );
});

test("a create key already used for different details is named as a conflict", async () => {
  const { transport } = scriptedTransport(() => json({ code: "document_create_conflict" }, 409));
  const result = await saveBatchRow(bill(), { post: false, hasTax: false, transport, copy });
  assert.equal(result.conflict, true);
  assert.equal(result.error, "Already used");
});

test("a success that names no bill is never shown as saved", async () => {
  const { transport } = scriptedTransport(() => json({ ok: true }, 201));
  const result = await saveBatchRow(bill(), { post: false, hasTax: false, transport, copy });
  assert.equal(result.documentId, "");
  assert.equal(result.outcome, "");
  assert.equal(result.error, "Could not save");
});

test("tax control totals resolve each bill at its own effective date and refuse missing rates", async () => {
  const row = {
    ...bill(),
    amount: "100.0000",
    taxProfileId: `code:${TAX_CODE}`,
    documentDate: "2025-01-01",
  };
  const older = new Map([[`code:${TAX_CODE}`, [{ ...hst[0]!, ratePercent: "5" }]]]);
  assert.equal(
    batchRowTotal(row, () => older),
    "105.0000",
  );
  assert.equal(batchRowTotal(row, new Map()), null);
  assert.equal(batchRowTotal(row, new Map([[`code:${TAX_CODE}`, []]])), null);
  const profiles = await fetchBatchTaxProfiles(async (url) => {
    assert.equal(new URL(url, "http://test").searchParams.get("documentDate"), "2025-01-01");
    return Response.json({
      taxes: { codes: { [TAX_CODE]: older.get(`code:${TAX_CODE}`) }, groups: {} },
    });
  }, row.documentDate);
  assert.ok(profiles);
  assert.equal(batchRowTotal(row, profiles), "105.0000");
  assert.equal(
    await fetchBatchTaxProfiles(async () => Response.json({}, { status: 403 }), row.documentDate),
    null,
  );
});

test("a changed server total keeps the saved draft and refuses automatic posting", async () => {
  const row = bill();
  const { transport, calls } = scriptedTransport(() =>
    json({ doc: { id: row.idempotencyKey, document_number: "BILL-90", total: "113.0000" } }, 201),
  );
  const result = await saveBatchRow(row, {
    post: true,
    hasTax: true,
    expectedTotal: "105.0000",
    transport,
    copy: { ...copy, totalChanged: "Review the saved bill total" },
  });
  assert.equal(result.documentId, row.idempotencyKey);
  assert.equal(result.savedTotal, "113.0000");
  assert.equal(result.outcome, "saved");
  assert.equal(result.error, "Review the saved bill total");
  assert.equal(calls.length, 1, "no lifecycle write runs after an amount mismatch");
  assert.equal(
    batchRowTotal({ ...row, ...result, taxProfileId: `code:${TAX_CODE}` }, new Map()),
    "113.0000",
    "the saved bill total remains authoritative even after effective rates change",
  );
});

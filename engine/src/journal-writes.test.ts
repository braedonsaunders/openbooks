// Run with:  node --import tsx --test engine/src/journal-writes.test.ts   (from repo root)
//
// Unit tests for the PURE validation half of governed journal writes — the
// gate every sandbox-originated ledger write passes before touching the DB —
// plus DB-gated lifecycle cases for createScriptJournal's atomic post:true
// contract (skipped unless OPENBOOKS_DB_URL is set).

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "./test-fixtures.ts";
import { createScriptJournal, validateJournalInput, JournalWriteError } from "./journal-writes.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("a balanced two-line journal validates and normalizes", () => {
  const v = validateJournalInput({
    documentDate: "2026-07-16",
    memo: "accrual",
    lines: [
      { accountId: A, amount: 100.5, description: "debit side" },
      { accountId: B, amount: -100.5 },
    ],
  });
  assert.equal(v.documentDate, "2026-07-16");
  assert.equal(v.totalDebits, "100.5000");
  assert.equal(v.lines[0]!.amount, "100.5000");
  assert.equal(v.lines[1]!.amount, "-100.5000");
});

test("account codes are accepted in place of ids", () => {
  const v = validateJournalInput({
    documentDate: "2026-07-16",
    lines: [
      { accountCode: "5100", amount: 10 },
      { accountCode: "2100", amount: -10 },
    ],
  });
  assert.equal(v.lines[0]!.accountCode, "5100");
});

test("an unbalanced journal is refused", () => {
  assert.throws(
    () => validateJournalInput({ documentDate: "2026-07-16", lines: [{ accountId: A, amount: 100 }, { accountId: B, amount: -99.99 }] }),
    (e: Error) => e instanceof JournalWriteError && /not balanced/.test(e.message),
  );
});

test("fewer than 2 lines is refused", () => {
  assert.throws(() => validateJournalInput({ documentDate: "2026-07-16", lines: [{ accountId: A, amount: 0 }] }), /at least 2 lines/);
});

test("zero and non-numeric amounts are refused", () => {
  assert.throws(
    () => validateJournalInput({ documentDate: "2026-07-16", lines: [{ accountId: A, amount: 0 }, { accountId: B, amount: 0 }] }),
    /nonzero number/,
  );
  assert.throws(
    () => validateJournalInput({ documentDate: "2026-07-16", lines: [{ accountId: A, amount: "abc" }, { accountId: B, amount: -1 }] }),
    /nonzero number/,
  );
});

test("a line without any account reference is refused", () => {
  assert.throws(
    () => validateJournalInput({ documentDate: "2026-07-16", lines: [{ amount: 5 }, { accountId: B, amount: -5 }] }),
    /accountId or accountCode required/,
  );
});

test("a malformed accountId is refused", () => {
  assert.throws(
    () => validateJournalInput({ documentDate: "2026-07-16", lines: [{ accountId: "nope", amount: 5 }, { accountId: B, amount: -5 }] }),
    /invalid accountId/,
  );
});

test("bad dates are refused; a missing date is refused rather than defaulted to UTC today", () => {
  assert.throws(
    () => validateJournalInput({ documentDate: "07/16/2026", lines: [{ accountId: A, amount: 1 }, { accountId: B, amount: -1 }] }),
    /invalid documentDate/,
  );
  assert.throws(
    () => validateJournalInput({ lines: [{ accountId: A, amount: 1 }, { accountId: B, amount: -1 }] }),
    /documentDate is required/,
  );
});

test("4dp rounding keeps a float-noise journal balanced", () => {
  // 0.1 + 0.2 - 0.3 = 5.55e-17 in floats; must still count as balanced.
  const v = validateJournalInput({
    documentDate: "2026-07-16",
    lines: [
      { accountId: A, amount: 0.1 },
      { accountId: A, amount: 0.2 },
      { accountId: B, amount: -0.3 },
    ],
  });
  assert.equal(v.totalDebits, "0.3000");
});

test("journal-line persist writes amount through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./journal-writes.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistJournalLineAmount");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistJournalLineAmount helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /JournalWriteError/);

  const start = source.indexOf("export function validateJournalInput");
  const next = source.indexOf("export async function createScriptJournal");
  const body = source.slice(start, next);
  assert.match(body, /persistJournalLineAmount\(l\.amount, i \+ 1\)/);
  assert.doesNotMatch(body, /normalizeMoney\(l\.amount\)/);
});

test("posting-rule control accounts load employeePayable via shared helper", () => {
  const helper = readFileSync(new URL("./control-accounts.ts", import.meta.url), "utf8");
  assert.match(helper, /export async function loadControlAccounts/);
  assert.match(helper, /employeePayable/);
  assert.match(helper, /settings->'controlAccounts'/);

  const journalWrites = readFileSync(new URL("./journal-writes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(journalWrites, /async function controlDeps/);
  assert.doesNotMatch(journalWrites, /settings->'controlAccounts'/);
  assert.match(journalWrites, /loadRequiredControlAccounts/);
});

test("line cap is enforced", () => {
  const lines = Array.from({ length: 201 }, (_, i) => ({ accountId: A, amount: i % 2 === 0 ? 1 : -1 }));
  assert.throws(() => validateJournalInput({ documentDate: "2026-07-16", lines }), /too many lines/);
});

// --- post:true atomicity + system provenance (fnd_mt97qyp4_telk90) --------

test("post:true writes the draft inside one withOrgTransaction and never refuses a missing actor", () => {
  const source = readFileSync(new URL("./journal-writes.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function createScriptJournal");
  const body = source.slice(start);
  // The old code committed the draft first and only then refused actor-less
  // callers — an orphan draft behind every scheduled post:true failure.
  assert.doesNotMatch(body, /requires an attributable actor/);
  // The draft insert and the submission both live inside the single atomic
  // unit, after the draft-only early return.
  assert.match(body, /if \(!opts\.post\)[\s\S]*?return insertScriptDraft/);
  assert.match(body, /withOrgTransaction\(orgId, async \(\) => \{[\s\S]*?insertScriptDraft\([\s\S]*?submitAndReleaseIfUngated/);
  // Actor-less callers stamp explicit system provenance instead of inventing
  // identity (engine-wide convention: null created_by always means "system").
  assert.match(source, /actorKind: "system"/);
});

test("a forced post:true failure commits zero documents or lines — no orphan draft", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    // The document date lands outside every accounting period, so the posting
    // engine rejects it — AFTER submission released the draft. The old split
    // transaction had already committed the draft by then; the atomic unit
    // must roll everything back.
    await assert.rejects(
      createScriptJournal(
        org.orgId,
        actors.submitterId,
        {
          documentDate: "2031-01-15",
          memo: "orphan probe",
          lines: [
            { accountId: org.accounts.bank, amount: 25 },
            { accountId: org.accounts.adjustment, amount: -25 },
          ],
        },
        { post: true },
      ),
      /no accounting period covers/,
    );
    const r = (await db.execute<{ docs: string; lines: string; effects: string }>(sql`
      select (select count(*) from documents where org_id = ${org.orgId})::text as docs,
             (select count(*) from document_lines where org_id = ${org.orgId})::text as lines,
             (select count(*) from posting_effects where org_id = ${org.orgId})::text as effects`));
    assert.deepEqual(r.rows[0], { docs: "0", lines: "0", effects: "0" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an actor-less scheduled script posts under explicit system provenance", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const res = await createScriptJournal(
      org.orgId,
      null,
      {
        documentDate: org.date,
        memo: "scheduled accrual",
        lines: [
          { accountId: org.accounts.deferred, amount: 40 },
          { accountId: org.accounts.recognized, amount: -40 },
        ],
      },
      { post: true },
    );
    assert.ok(res.entryId, "posting returned an entry id");
    const doc = (await db.execute<{ status: string; created_by: string | null; custom: Record<string, string> }>(sql`
      select status::text as status, created_by::text as created_by, custom
        from documents where id = ${res.id} and org_id = ${org.orgId}`)).rows[0]!;
    assert.equal(doc.status, "posted");
    assert.equal(doc.created_by, null);
    assert.equal(doc.custom.actorKind, "system");
    assert.ok(doc.custom.actorReason);
    const entry = await db.execute(sql`
      select id from journal_entries where id = ${res.entryId!} and org_id = ${org.orgId}`);
    assert.equal(entry.rows.length, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

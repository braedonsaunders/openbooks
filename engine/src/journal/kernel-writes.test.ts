import assert from "node:assert/strict";
import test from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SqlExecutor } from "../platform/db.ts";
import { insertAuditRecord } from "./kernel-audit.ts";
import { flipEntryToPosted, insertDraftEntry, insertKeyedDraftEntry } from "./kernel-entry.ts";
import { insertEntryLines, type JournalLineWrite } from "./kernel-lines.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dialect = new PgDialect();

/** The database boundary: records each statement and answers with scripted rows. */
function scriptedDatabase(answer: (statement: string) => unknown[]) {
  const statements: string[] = [];
  const executor = {
    execute: async (query: SQL) => {
      const statement = dialect.sqlToQuery(query).sql.replace(/\s+/g, " ").trim();
      statements.push(statement);
      return answer(statement);
    },
  } as unknown as SqlExecutor;
  return { executor, statements };
}

class Refused extends Error {}

const header = {
  orgId: id(1),
  bookId: id(2),
  subsidiaryId: id(3),
  entryNumber: "JE-1",
  postingDate: "2026-07-01",
  periodId: id(4),
  origin: "manual",
  custom: null,
  actorId: null,
};
const lines: JournalLineWrite[] = [
  {
    lineNumber: 1,
    accountId: id(5),
    subsidiaryId: id(3),
    amount: "10.0000",
    currency: "CAD",
    txnAmount: "10.0000",
    fxRate: "1",
  },
  {
    lineNumber: 2,
    accountId: id(6),
    subsidiaryId: id(3),
    amount: "-10.0000",
    currency: "CAD",
    txnAmount: "-10.0000",
    fxRate: "1",
  },
];

test("a kernel write the database does not retain raises the caller's refusal", async () => {
  const { executor } = scriptedDatabase(() => []);
  await assert.rejects(
    insertDraftEntry(executor, header, () => new Refused("header")),
    Refused,
  );
  await assert.rejects(
    flipEntryToPosted(
      executor,
      { orgId: id(1), entryId: id(7), actorId: null },
      () => new Refused("flip"),
    ),
    Refused,
  );
  await assert.rejects(
    insertAuditRecord(
      executor,
      {
        orgId: id(1),
        tableName: "journal_entries",
        rowId: id(7),
        action: "post",
        changes: {},
        actorId: null,
        requestId: null,
      },
      () => new Refused("audit"),
    ),
    Refused,
  );
  await assert.rejects(
    insertEntryLines(executor, { orgId: id(1), entryId: id(7) }, lines, {
      refusal: (inserted) => new Refused(`retained ${inserted} of ${lines.length}`),
    }),
    /retained 0 of 2/,
  );
  // A claimed idempotency key is the one benign empty result: the caller reads the holder back.
  assert.equal(
    await insertKeyedDraftEntry(executor, {
      ...header,
      custom: { idempotencyKey: "same-operation" },
    }),
    null,
  );
});

test("every line of an entry is one statement, bracketed only for historical inactive accounts", async () => {
  const answer = (statement: string) =>
    statement.startsWith("insert into journal_lines")
      ? lines.map((line) => ({ id: id(100 + line.lineNumber), line_number: line.lineNumber }))
      : [];
  const native = scriptedDatabase(answer);
  const inserted = await insertEntryLines(
    native.executor,
    { orgId: id(1), entryId: id(7) },
    lines,
    {
      refusal: () => new Refused("lines"),
    },
  );
  assert.deepEqual(inserted, [
    { id: id(101), lineNumber: 1 },
    { id: id(102), lineNumber: 2 },
  ]);
  assert.equal(native.statements.length, 1);

  const historical = scriptedDatabase(answer);
  await insertEntryLines(historical.executor, { orgId: id(1), entryId: id(7) }, lines, {
    admitInactiveAccounts: true,
    refusal: () => new Refused("lines"),
  });
  assert.deepEqual(
    historical.statements.map((statement) =>
      statement.startsWith("insert into journal_lines")
        ? "insert"
        : statement.match(/'(on|off)'/)?.[1],
    ),
    ["on", "insert", "off"],
  );
});

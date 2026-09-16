import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../test-fixtures.ts";
import { applySourceReconciliationEvidence } from "./source-evidence.ts";
import type { MigrationSource, SourceClearedLineState } from "./source.ts";
import type { NativeDocument } from "./native.ts";

/**
 * The mirror's source-evidence phase (0158): pulled markers stamp posted
 * lines, the connector's refresh overrides stale pulls, fully covered
 * accounts sign off, and partial ones stay open and reported.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function postEntry(org: ScratchOrg, actorId: string, bankAmount: string, label: string): Promise<string> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`SEV-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         ${`Source evidence ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate)
      values
        (${org.orgId}, ${entryId}, 1, ${org.accounts.bank},
         ${org.subsidiaryId}, ${bankAmount}, 'CAD', ${bankAmount}, 1),
        (${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment},
         ${org.subsidiaryId}, ${`-${bankAmount}`}, 'CAD', ${`-${bankAmount}`}, 1)
    `);
    await tx.execute(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`);
    return entryId;
  });
}

async function linkDocument(
  org: ScratchOrg,
  refKey: string,
  sourceRef: string,
  entryId: string,
  lines: { lineRef: string; accountId: string }[],
): Promise<void> {
  const docId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, document_date, currency, custom)
    values
      (${docId}, ${org.orgId}, 'journal', ${`SEV-${sourceRef}`}, ${org.date}, 'CAD',
       ${JSON.stringify({ [refKey]: sourceRef })}::jsonb)
  `);
  let n = 0;
  for (const line of lines) {
    n += 1;
    await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, amount, custom)
      values (${org.orgId}, ${docId}, ${n}, ${line.accountId}, 0,
              ${JSON.stringify({ sourceLineRef: line.lineRef })}::jsonb)
    `);
  }
  await db.execute(sql`
    update documents set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}
     where id = ${docId} and org_id = ${org.orgId}
  `);
}

function stubSource(refresh: SourceClearedLineState[] | undefined): MigrationSource {
  return {
    name: "test-connector",
    ...(refresh === undefined ? {} : { clearedLineStates: async () => refresh }),
  } as unknown as MigrationSource;
}

function nativeDoc(
  sourceRef: string,
  lines: { accountId: string; lineRef?: string; cleared: boolean; clearedDate: string | null }[],
): NativeDocument {
  return {
    sourceRef,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      sourceLineRef: l.lineRef ?? null,
      sourceCleared: l.cleared,
      sourceClearedDate: l.clearedDate,
    })),
  } as unknown as NativeDocument;
}

test(
  "the evidence phase stamps pulled markers and signs off covered accounts",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Evidence reviewer", "admin");
      await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where org_id = ${org.orgId} and id = ${org.accounts.bank}`);
      const entry = await postEntry(org, actor, "308", "full");
      await linkDocument(org, "testId", "DOC-1", entry, [{ lineRef: "L-1", accountId: org.accounts.bank }]);
      const outcome = await applySourceReconciliationEvidence({
        orgId: org.orgId,
        connector: "test-connector",
        actorId: actor,
        refKey: "testId",
        source: stubSource(undefined),
        documents: [nativeDoc("DOC-1", [{ accountId: org.accounts.bank, cleared: true, clearedDate: org.date }])],
      });
      assert.equal(outcome.linesStamped, 1);
      assert.equal(outcome.refreshedLines, 0);
      assert.equal(outcome.signedOff.length, 1);
      assert.equal(outcome.signedOff[0]!.throughDate, org.date);
      assert.deepEqual(outcome.skipped, []);
      const row = (await db.execute<{ evidence_kind: string }>(sql`
        select evidence_kind from reconciliations where id = ${outcome.signedOff[0]!.reconciliationId} and org_id = ${org.orgId}
      `)).rows[0]!;
      assert.equal(row.evidence_kind, "source");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "the evidence phase lets refresh states override stale pulls",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Evidence reviewer", "admin");
      await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where org_id = ${org.orgId} and id = ${org.accounts.bank}`);
      const entry = await postEntry(org, actor, "21", "stale");
      await linkDocument(org, "testId", "DOC-2", entry, [{ lineRef: "L-9", accountId: org.accounts.bank }]);
      // The pull predates the source-side clearing; the refresh is current truth.
      const outcome = await applySourceReconciliationEvidence({
        orgId: org.orgId,
        connector: "test-connector",
        actorId: actor,
        refKey: "testId",
        source: stubSource([{ docRef: "DOC-2", lineRef: "L-9", cleared: true, clearedDate: org.date }]),
        documents: [nativeDoc("DOC-2", [{ accountId: org.accounts.bank, lineRef: "L-9", cleared: false, clearedDate: null }])],
        refreshSinceForTest: org.date,
      });
      assert.equal(outcome.refreshedLines, 1);
      assert.equal(outcome.linesStamped, 1);
      assert.equal(outcome.signedOff.length, 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "the evidence phase leaves partial accounts open and reported",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Evidence reviewer", "admin");
      await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where org_id = ${org.orgId} and id = ${org.accounts.bank}`);
      const first = await postEntry(org, actor, "100", "a");
      const second = await postEntry(org, actor, "25", "b");
      await linkDocument(org, "testId", "DOC-A", first, [{ lineRef: "L-A", accountId: org.accounts.bank }]);
      await linkDocument(org, "testId", "DOC-B", second, [{ lineRef: "L-B", accountId: org.accounts.bank }]);
      const outcome = await applySourceReconciliationEvidence({
        orgId: org.orgId,
        connector: "test-connector",
        actorId: actor,
        refKey: "testId",
        source: stubSource(undefined),
        documents: [
          nativeDoc("DOC-A", [{ accountId: org.accounts.bank, cleared: true, clearedDate: org.date }]),
          nativeDoc("DOC-B", [{ accountId: org.accounts.bank, cleared: false, clearedDate: null }]),
        ],
      });
      assert.equal(outcome.signedOff.length, 0);
      assert.equal(outcome.skipped.length, 1);
      assert.equal(outcome.skipped[0]!.reason, "partially-cleared");
      assert.equal(outcome.skipped[0]!.clearedLines, 1);
      assert.equal(outcome.skipped[0]!.unclearedLines, 1);
      assert.equal(
        Number((await db.execute<{ n: string }>(sql`select count(*) as n from reconciliations where org_id = ${org.orgId}`)).rows[0]!.n),
        0,
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

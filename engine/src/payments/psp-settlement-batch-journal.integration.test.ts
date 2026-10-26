import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  clearSettlementBatchJournal,
  importSettlementBatch,
  markSettlementBatchJournal,
  postSettlementBatch,
  PspSettlementError,
  suggestSettlementBatchJournal,
  type ParsedSettlement,
} from "./psp-settlement.ts";
import { postEntry } from "../journal/post-entry.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedSaleEntry(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  date: string,
  periodId: string,
  actor: string,
  revenueTotal: string,
  tag: string,
  revenueAccountId: string,
  bankAccountId: string,
) {
  return postEntry(db, {
    orgId,
    bookId,
    subsidiaryId,
    entryNumber: `JE-SALE-${tag}`,
    postingDate: date,
    periodId,
    origin: "manual",
    idempotencyKey: `je-sale-${tag}`,
    currency: "CAD",
    actorId: actor,
    lines: [
      { accountId: bankAccountId, amount: revenueTotal, currency: "CAD", txnAmount: revenueTotal },
      {
        accountId: revenueAccountId,
        amount: `-${revenueTotal}`,
        currency: "CAD",
        txnAmount: `-${revenueTotal}`,
      },
    ],
  });
}

const CHARGES: ParsedSettlement = {
  provider: "stripe",
  externalRef: "payout-batch-journal",
  settlementDate: "2026-10-09",
  currency: "CAD",
  lines: [
    { kind: "charge", amount: "100.0000", currency: "CAD", externalRef: "charge-1" },
    { kind: "charge", amount: "100.0000", currency: "CAD", externalRef: "charge-2" },
    { kind: "charge", amount: "100.0000", currency: "CAD", externalRef: "charge-3" },
    { kind: "fee", amount: "3.0000", currency: "CAD", externalRef: "fee-1" },
  ],
};

async function seedPostedBatch(
  orgId: string,
  actor: string,
  accounts: Record<string, string>,
  subsidiaryId: string,
  tag: string,
  settlementDate: string,
) {
  const parsed: ParsedSettlement = {
    ...CHARGES,
    externalRef: `payout-batch-${tag}`,
    settlementDate,
  };
  const imported = await importSettlementBatch(orgId, actor, parsed, {
    bankAccountId: accounts.bank,
    feeAccountId: accounts.freight,
    disputeAccountId: accounts.adjustment,
    fxAccountId: accounts.fxGainLoss,
    clearingAccountId: accounts.clearing,
    subsidiaryId,
  });
  await postSettlementBatch(orgId, imported.batchId, actor, null);
  return imported.batchId;
}

test(
  "a batch-level journal recognition evidences every charge line, suggests by exact total, and reverses audited",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const sale = await seedSaleEntry(
        org.orgId,
        org.bookId,
        org.subsidiaryId,
        org.date,
        org.periodId,
        actor,
        "300.0000",
        `batch-${org.orgId.slice(0, 8)}`,
        org.accounts.revenue,
        org.accounts.bank,
      );
      const batchId = await seedPostedBatch(
        org.orgId,
        actor,
        org.accounts,
        org.subsidiaryId,
        org.orgId.slice(0, 8),
        org.date,
      );
      // The suggestion proposes the sales journal whose revenue lines total
      // exactly the batch's charge total — never the batch's own posting
      // journal, never a wrong total.
      const other = await seedSaleEntry(
        org.orgId,
        org.bookId,
        org.subsidiaryId,
        org.date,
        org.periodId,
        actor,
        "50.0000",
        `other-${org.orgId.slice(0, 8)}`,
        org.accounts.revenue,
        org.accounts.bank,
      );
      const suggestion = await suggestSettlementBatchJournal(org.orgId, batchId, null);
      assert.match(suggestion.chargeTotal, /300/);
      assert.equal(suggestion.excludedOtherCurrencyLines, 0);
      assert.ok(
        suggestion.candidates.some((candidate) => candidate.id === sale.entryId),
        `the sales journal must be suggested, got ${JSON.stringify(suggestion.candidates)}`,
      );
      assert.ok(
        suggestion.candidates.every((candidate) => candidate.id !== other.entryId),
        "a journal with the wrong revenue total must never be suggested",
      );
      assert.ok(
        suggestion.candidates.every((candidate) => /300/.test(candidate.revenueTotal)),
        "every suggestion must total exactly the batch's charges",
      );
      // One action evidences all three charge lines; the fee leg is not
      // order evidence and needs nothing.
      const marked = await markSettlementBatchJournal(
        org.orgId,
        batchId,
        sale.entryId,
        actor,
        null,
      );
      assert.equal(marked.marked, 3);
      assert.equal(marked.skippedLinked, 0);
      assert.equal(marked.skippedMarked, 0);
      const markers = await db.execute<{ via: string | null }>(
        sql`
        select meta->'recognizedByJournalEntry'->>'via' as via from psp_settlement_lines
         where batch_id = ${batchId} and org_id = ${org.orgId} and kind = 'charge'`,
        "objects",
      );
      assert.equal(markers.length, 3);
      assert.ok(markers.every((row) => row.via === "batch"));
      const batchAudit = await db.execute<{ count: number }>(
        sql`
        select count(*)::int as count from audit_log
         where org_id = ${org.orgId} and table_name = 'psp_settlement_batches'
           and row_id = ${batchId} and action = 'mark-batch-journal'`,
        "objects",
      );
      assert.equal(batchAudit[0]?.count, 1);
      // Re-marking is a no-op report, not a duplicate: every line already
      // carries the marker.
      const again = await markSettlementBatchJournal(org.orgId, batchId, sale.entryId, actor, null);
      assert.equal(again.marked, 0);
      assert.equal(again.skippedMarked, 3);
      // The reversal lifts exactly the batch markers, audited, and a second
      // reversal refuses instead of writing an empty audit row.
      const cleared = await clearSettlementBatchJournal(org.orgId, batchId, actor, null);
      assert.equal(cleared.cleared, 3);
      assert.deepEqual(cleared.journalEntryNumbers, [`JE-SALE-batch-${org.orgId.slice(0, 8)}`]);
      const remaining = await db.execute<{ count: number }>(
        sql`
        select count(*)::int as count from psp_settlement_lines
         where batch_id = ${batchId} and org_id = ${org.orgId}
           and meta->>'recognizedByJournalEntry' is not null`,
        "objects",
      );
      assert.equal(remaining[0]?.count, 0);
      await assert.rejects(
        clearSettlementBatchJournal(org.orgId, batchId, actor, null),
        /no batch-level journal recognition to reverse/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a batch reversal keeps hand-marked lines and refuses bad entries",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const sale = await seedSaleEntry(
        org.orgId,
        org.bookId,
        org.subsidiaryId,
        org.date,
        org.periodId,
        actor,
        "300.0000",
        `hand-${org.orgId.slice(0, 8)}`,
        org.accounts.revenue,
        org.accounts.bank,
      );
      const batchId = await seedPostedBatch(
        org.orgId,
        actor,
        org.accounts,
        org.subsidiaryId,
        `hand-${org.orgId.slice(0, 8)}`,
        org.date,
      );
      const lineRows = await db.execute<{ id: string }>(
        sql`
        select id from psp_settlement_lines
         where batch_id = ${batchId} and org_id = ${org.orgId} and kind = 'charge'
         order by line_number`,
        "objects",
      );
      // One line marked by hand (no via), two by the batch action.
      const { markSettlementLineJournal } = await import("./psp-settlement.ts");
      await markSettlementLineJournal(
        org.orgId,
        batchId,
        lineRows[0]!.id,
        sale.entryId,
        actor,
        null,
      );
      await markSettlementBatchJournal(org.orgId, batchId, sale.entryId, actor, null);
      const cleared = await clearSettlementBatchJournal(org.orgId, batchId, actor, null);
      assert.equal(cleared.cleared, 2);
      const hand = (
        await db.execute<{ marker: string | null }>(
          sql`
        select meta->>'recognizedByJournalEntry' as marker from psp_settlement_lines
         where id = ${lineRows[0]!.id} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0];
      assert.notEqual(hand?.marker, null);
      // Refusals name the remedy: unknown entries, drafts of history, and
      // unposted journals never evidence a batch.
      await assert.rejects(
        markSettlementBatchJournal(org.orgId, batchId, randomUUID(), actor, null),
        /does not belong to this organization/,
      );
      const draftId = (
        await db.execute<{ id: string }>(
          sql`
        insert into journal_entries (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`JE-DRAFT-${org.orgId.slice(0, 8)}`}, ${org.date}::date, ${org.periodId}, 'draft', 'manual')
        returning id`,
          "objects",
        )
      )[0]!.id;
      await assert.rejects(
        markSettlementBatchJournal(org.orgId, batchId, draftId, actor, null),
        (error: unknown) => error instanceof PspSettlementError && /not posted/.test(error.message),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

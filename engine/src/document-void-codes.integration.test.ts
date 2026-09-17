import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { setPeriodLockState } from "./close.ts";
import { db } from "./db.ts";
import { DocumentVoidError, requestDocumentVoid } from "./document-void.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * F-t06-021: voiding a posted JE in an OPEN period answered 422 with a bare
 * `{error}` the drawer swallowed. The refusal was the reversal leg, not the
 * source period: the UI sends no reversalDate, so the server reverses on the
 * business day — which can fall outside any accounting period (SIM
 * Ledgerline, 2026-09-17: JE-00009's source July period was open, September
 * had no period yet) or inside a locked one. Every void refusal now carries
 * a machine-readable code alongside the unchanged human message.
 */

/** A posted manual journal document with a balanced posted entry. */
async function seedPostedJournal(
  org: ScratchOrg,
  actorId: string,
  documentNumber: string,
): Promise<{ documentId: string; entryId: string }> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date,
       currency, status, subtotal, tax_total, total, created_by)
    values (
      ${documentId}, ${org.orgId}, 'journal', ${documentNumber},
      ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft',
      '25', '0', '25', ${actorId}
    )
  `);
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${documentNumber},
      ${org.date}, ${org.periodId}, ${documentNumber}, 'draft', 'manual'
    )
  `);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
    values
      (${org.orgId}, ${entryId}, 1, ${org.accounts.adjustment}, ${org.subsidiaryId}, null, '25', 'CAD', '25', '1'),
      (${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, null, '-25', 'CAD', '-25', '1')
  `);
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
  await db.execute(sql`
    update documents
       set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}
     where id = ${documentId} and org_id = ${org.orgId}
  `);
  return { documentId, entryId };
}

test("voiding into a date with no accounting period refuses with a typed code", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Void Code Controller", "admin");
    const { documentId } = await seedPostedJournal(org, actorId, "JE-VOID-CODE-1");
    await assert.rejects(
      requestDocumentVoid({
        documentId,
        orgId: org.orgId,
        actorId,
        reason: "Typed refusal for an uncovered reversal date",
        reversalDate: "2026-09-17",
        source: "api",
      }),
      (error: unknown) => {
        assert.ok(error instanceof DocumentVoidError);
        assert.match(error.message, /no accounting period covers 2026-09-17/);
        assert.equal(error.code, "reversal-period-uncovered");
        assert.equal(error.status, 422);
        return true;
      },
    );
    const doc = await db.execute<{ status: string; void_requested_at: Date | null }>(sql`
      select status, void_requested_at from documents where id = ${documentId} and org_id = ${org.orgId}
    `);
    assert.equal(doc.rows[0]?.status, "posted");
    assert.equal(doc.rows[0]?.void_requested_at, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("voiding into a locked reversal period refuses with a typed code", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Void Code Controller", "admin");
    const { documentId } = await seedPostedJournal(org, actorId, "JE-VOID-CODE-2");
    await setPeriodLockState({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      module: "gl",
      state: "closed",
      actorId,
      reason: "void code regression",
    });
    await assert.rejects(
      requestDocumentVoid({
        documentId,
        orgId: org.orgId,
        actorId,
        reason: "Typed refusal for a locked reversal period",
        reversalDate: org.date,
        source: "api",
      }),
      (error: unknown) => {
        assert.ok(error instanceof DocumentVoidError);
        assert.match(error.message, /is closed/);
        assert.equal(error.code, "reversal-period-closed");
        assert.equal(error.status, 422);
        return true;
      },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("voiding on a stale revision refuses 409 with a typed code", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Void Code Controller", "admin");
    const { documentId } = await seedPostedJournal(org, actorId, "JE-VOID-CODE-3");
    await assert.rejects(
      requestDocumentVoid({
        documentId,
        orgId: org.orgId,
        actorId,
        reason: "Typed refusal for a stale revision token",
        reversalDate: org.date,
        source: "api",
        expectedUpdatedAt: "999999999",
      }),
      (error: unknown) => {
        assert.ok(error instanceof DocumentVoidError);
        assert.equal(error.code, "stale-revision");
        assert.equal(error.status, 409);
        return true;
      },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

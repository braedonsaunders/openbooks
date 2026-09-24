import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { PaymentError } from "./payment-errors.ts";
import { updateDraftPayment } from "./payment-documents.ts";
import { postPaymentRun } from "./run-posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Seed one draft vendor payment claimed by one pending instruction of a run
 * in the given status. The document total is the caller-supplied cash frame;
 * the instruction amount is the run's approved plan.
 */
async function seedClaimedDraft(org: {
  orgId: string;
  subsidiaryId: string;
  vendorId: string;
  accounts: { bank: string };
  date: string;
}, userId: string, runStatus: string, docTotal: string, instructionAmount: string): Promise<{
  runId: string;
  runNumber: string;
  paymentId: string;
  instructionId: string;
}> {
  const runId = randomUUID();
  const runNumber = `FENCE-RUN-${runId.slice(0, 8)}`;
  const paymentId = randomUUID();
  const instructionId = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, subtotal, tax_total, total, created_by)
      values (${paymentId}, ${org.orgId}, 'vendor_payment', 'draft',
              ${`FENCE-PAY-${paymentId.slice(0, 8)}`}, ${org.subsidiaryId}, ${org.vendorId},
              ${org.date}, 'CAD', ${docTotal}, '0', ${docTotal}, ${userId})`);
    await db.execute(sql`
      insert into payment_runs
        (id, org_id, run_number, bank_account_id, method, direction, purpose,
         currency, status, payment_count, total_amount, created_by, updated_by)
      values (${runId}, ${org.orgId}, ${runNumber}, ${org.accounts.bank},
              'wire', 'outbound', 'vendor_payments', 'CAD', ${runStatus},
              1, ${instructionAmount}, ${userId}, ${userId})`);
    await db.execute(sql`
      insert into payment_instructions
        (id, org_id, payment_run_id, payee_party_id, amount, currency,
         payment_document_id, status, created_by, updated_by)
      values (${instructionId}, ${org.orgId}, ${runId}, ${org.vendorId},
              ${instructionAmount}, 'CAD', ${paymentId}, 'pending', ${userId}, ${userId})`);
  });
  return { runId, runNumber, paymentId, instructionId };
}

/**
 * A-S31 (edit guard): a draft claimed by an OPEN run refuses edits with the
 * run's identity and the release remedy, while a draft whose run has closed
 * edits normally — the guard fences open runs, not the document forever.
 */
test("editing a payment claimed by an open run refuses; a closed run releases it", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Treasurer", "admin"));
    const open = await seedClaimedDraft(org, userId, "generated", "25.0000", "25.0000");
    await assert.rejects(
      updateDraftPayment(open.paymentId, { memo: "edit under a live run" }, userId, org.orgId),
      (error: unknown) => {
        assert.ok(error instanceof PaymentError);
        assert.match(error.message, /claimed by open payment run/);
        assert.match(error.message, new RegExp(open.runNumber));
        assert.match(error.message, /generated/);
        assert.match(error.message, /reject, roll back, or cancel/);
        return true;
      },
    );
    const untouched = await withBypass(async () => (await db.execute<{ memo: string | null }>(sql`
      select memo from documents where id = ${open.paymentId} and org_id = ${org.orgId}
    `)).rows[0]);
    assert.equal(untouched?.memo, null);

    const closed = await seedClaimedDraft(org, userId, "confirmed", "25.0000", "25.0000");
    const edited = await updateDraftPayment(
      closed.paymentId,
      { memo: "edit after the run closed" },
      userId,
      org.orgId,
    );
    assert.ok(edited, "expected the released payment to save");
    assert.equal(edited.doc.memo, "edit after the run closed");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

/**
 * A-S31 (posting comparison): the run's amount is the approved plan but the
 * bank line carries the document's total, so a document edited under the run
 * must fail its instruction — naming the planned vs current amounts and the
 * re-plan remedy — instead of sending cash nobody approved. The instruction
 * stays pending, the run goes partially failed, and no journal posts.
 */
test("posting a run whose document drifted from its instruction fails loudly", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Treasurer", "admin"));
    const seeded = await seedClaimedDraft(org, userId, "generated", "30.0000", "25.0000");
    await withBypass(async () => {
      await db.execute(sql`
        update documents set status = 'approved', updated_at = now()
         where id = ${seeded.paymentId} and org_id = ${org.orgId}`);
    });
    const result = await postPaymentRun(seeded.runId, org.orgId, userId);
    assert.equal(result.posted, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!.error, /no longer matches its run instruction/);
    assert.match(result.failures[0]!.error, /25\.0000 CAD/);
    assert.match(result.failures[0]!.error, /30\.0000 CAD/);
    assert.match(result.failures[0]!.error, /re-plan/);
    const state = await withBypass(async () => (await db.execute<{
      instructionStatus: string;
      runStatus: string;
      entries: number;
    }>(sql`
      select (select status from payment_instructions where id = ${seeded.instructionId}) as "instructionStatus",
             (select status from payment_runs where id = ${seeded.runId}) as "runStatus",
             (select count(*)::int from journal_entries where source_document_id = ${seeded.paymentId}) as entries
    `)).rows[0]);
    assert.deepEqual(
      { instructionStatus: state?.instructionStatus, runStatus: state?.runStatus, entries: state?.entries },
      { instructionStatus: "pending", runStatus: "partially_failed", entries: 0 },
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

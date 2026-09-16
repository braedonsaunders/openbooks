import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  createPaymentDocument,
  postPaymentWithApplications,
  reversePaymentForReturn,
  updateDraftPayment,
} from "./payments.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function invoice(org: ScratchOrg, actor: string) {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
     currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${id}, ${org.subsidiaryId},
      ${org.customerId}, ${org.date}, 'CAD', 1, 100, 0, 100, ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, 1, 100, 100, 0, 100)`);
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`);
  const entry = await postDocument(id, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  const line = (
    await db.execute<{ id: string }>(sql`select id from journal_lines
    where entry_id = ${entry} and is_open_item`)
  ).rows[0]!.id;
  return { id, entry, line };
}

async function payment(org: ScratchOrg, actor: string, line: string) {
  const result = await createPaymentDocument({
    orgId: org.orgId,
    kind: "customer_payment",
    createdBy: actor,
    partyId: org.customerId,
    bankAccountId: org.accounts.bank,
    subsidiaryId: org.subsidiaryId,
    documentDate: org.date,
    currency: "CAD",
    fxRate: "1",
  });
  await updateDraftPayment(
    result.id,
    {
      bankAccountId: org.accounts.bank,
      allocations: [
        {
          openLineId: line,
          sourceTransactionAmount: "100",
          targetTransactionAmount: "100",
          settlementRate: "1",
          settlementRateSource: "same_currency",
          settlementRateReference: "VOID-COLLISION",
        },
      ],
    },
    actor,
    org.orgId,
  );
  await db.execute(
    sql`update documents set status = 'approved', submitted_by = ${actor}, submitted_at = now() where id = ${result.id}`,
  );
  await postPaymentWithApplications(result.id, undefined, actor);
  return result.id;
}

test("bank return supersedes a pending manual void with its own evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const requester = await createScratchUser(org.orgId, "Manual Requester", "accountant");
    const bankOps = await createScratchUser(org.orgId, "Bank Operator", "accountant");
    const inv = await invoice(org, bankOps);
    const pay = await payment(org, bankOps, inv.line);
    // A gated manual void request is pending approval: evidence belongs to
    // the requester and the document is still posted.
    await db.execute(sql`update documents
       set void_reason = 'Duplicate entry, still investigating',
           void_requested_at = now(),
           void_requested_by = ${requester},
           void_reversal_date = ${org.date},
           updated_by = ${requester}
     where id = ${pay} and org_id = ${org.orgId}`);
    const reversalId = await reversePaymentForReturn(pay, org.orgId, "NSF return", bankOps, org.date);
    assert.ok(reversalId);
    const doc = (
      await db.execute<{
        status: string;
        void_reason: string | null;
        voided_by: string | null;
      }>(sql`select status, void_reason, voided_by from documents where id = ${pay}`)
    ).rows[0]!;
    // The bank return defines the outcome: its own evidence must win, never
    // the pending manual request's reason. Completion carries the request
    // evidence into voided_by, so the bank operator lands there.
    assert.equal(doc.status, "voided");
    assert.equal(doc.void_reason, "Bank return: NSF return");
    assert.equal(doc.voided_by, bankOps);
    // Both evidences are preserved in the audit trail.
    const audit = (
      await db.execute<{ changes: unknown }>(sql`select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${pay}
         and changes->>'mode' = 'void_evidence_superseded'
       order by at desc limit 1`)
    ).rows[0];
    assert.ok(audit, "expected a void_evidence_superseded audit row recording both evidences");
    const changes = audit!.changes as Record<string, unknown>;
    assert.equal(
      (changes.superseded as Record<string, unknown>)?.reason,
      "Duplicate entry, still investigating",
    );
    assert.equal((changes.superseded as Record<string, unknown>)?.requestedBy, requester);
    // The manual requester is told their request was superseded.
    const notice = (
      await db.execute<{ id: string }>(sql`select id from notifications
       where org_id = ${org.orgId} and user_id = ${requester} and kind = 'void_superseded'
       order by created_at desc limit 1`)
    ).rows[0];
    assert.ok(notice, "expected a void_superseded notification for the manual requester");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

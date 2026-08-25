import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createDirectDebitRun } from "./direct-debit.ts";
import { db } from "./db.ts";
import { cancelPaymentRun, isPaymentRunSourceClaimConflict, PAYMENT_RUN_INTERNAL_CANCEL_REASONS, PAYMENT_RUN_SYSTEM_ACTOR_ID, PaymentError } from "./payments.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("payment-run source contention classification follows nested database causes exactly", () => {
  assert.equal(isPaymentRunSourceClaimConflict({
    code: "query_failed",
    cause: { code: "23505", constraint: "payment_run_items_live_source" },
  }), true);
  assert.equal(isPaymentRunSourceClaimConflict({
    code: "23505",
    constraint: "another_unique_constraint",
  }), false);
  assert.equal(isPaymentRunSourceClaimConflict(new Error("unrelated failure")), false);
});

test("direct-debit source contention is a domain failure with durable evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Collection Operator", "accountant");
    const formatId = randomUUID();
    const profileId = randomUUID();
    const partyBankAccountId = randomUUID();
    const mandateId = randomUUID();
    const invoiceId = randomUUID();

    await db.execute(sql`
      insert into payment_formats
        (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
      values
        (${formatId}, ${org.orgId}, 'NACHA-DD-TEST', 'NACHA debit test',
         'nacha_debit', 'debit', 'US', 'CAD', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into payment_bank_profiles
        (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id,
         currency, country, created_by, updated_by)
      values
        (${profileId}, ${org.orgId}, 'Collection profile', ${org.accounts.bank},
         ${org.subsidiaryId}, ${formatId}, 'CAD', 'CA', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into party_bank_accounts
        (id, org_id, party_id, bank_name, country, currency, routing,
         account_last_four, approved_at, approved_by, created_by, updated_by)
      values
        (${partyBankAccountId}, ${org.orgId}, ${org.customerId}, 'Customer bank',
         'CA', 'CAD', '{}'::jsonb, '1234', ${org.date}, ${actorId}, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into payment_mandates
        (id, org_id, party_id, party_bank_account_id, scheme, mandate_reference,
         status, signed_on, valid_from, created_by, updated_by)
      values
        (${mandateId}, ${org.orgId}, ${org.customerId}, ${partyBankAccountId},
         'nacha', 'MANDATE-CONTENTION', 'active', ${org.date}, ${org.date},
         ${actorId}, ${actorId})`);

    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values
        (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved', 'INV-CONTENTION',
         ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
         '125', '0', '125', ${actorId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price,
         amount, tax_amount, tax_input_amount)
      values
        (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '125',
         '125', '0', '125')`);
    await postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });

    const options = {
      orgId: org.orgId,
      createdBy: actorId,
      paymentBankProfileId: profileId,
      invoiceDocumentIds: [invoiceId],
      scheduledFor: org.date,
    };
    const outcomes = await Promise.allSettled([
      createDirectDebitRun(options),
      createDirectDebitRun(options),
    ]);
    const successes = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<{ id: string; runNumber: string }> =>
        outcome.status === "fulfilled",
    );
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );

    assert.equal(successes.length, 1, "exactly one collection run must win the source claim");
    assert.equal(failures.length, 1, "the competing collection run must fail");
    assert.ok(failures[0]!.reason instanceof PaymentError);
    assert.match(failures[0]!.reason.message, /invoice is already reserved by another live payment run/);

    const runState = (await db.execute<{
      id: string;
      status: string;
      instruction_count: number;
      receipt_count: number;
      item_count: number;
      selected_count: number;
      failed_event_count: number;
      failure_message: string | null;
    }>(sql`
      select run.id, run.status,
             (select count(*)::int from payment_instructions instruction
               where instruction.org_id = run.org_id and instruction.payment_run_id = run.id) as instruction_count,
             (select count(*)::int from documents receipt
               where receipt.org_id = run.org_id
                 and receipt.kind = 'customer_payment'
                 and receipt.memo = 'Collection run ' || run.run_number) as receipt_count,
             (select count(*)::int from payment_run_items item
               where item.org_id = run.org_id and item.payment_run_id = run.id) as item_count,
             (select count(*)::int from payment_run_items item
               where item.org_id = run.org_id and item.payment_run_id = run.id
                 and item.status = 'selected' and item.payment_instruction_id is not null) as selected_count,
             (select count(*)::int from payment_events event
               where event.org_id = run.org_id and event.payment_run_id = run.id
                 and event.event_type = 'run_creation_failed') as failed_event_count,
             (select event.details->>'error' from payment_events event
               where event.org_id = run.org_id and event.payment_run_id = run.id
                 and event.event_type = 'run_creation_failed'
               order by event.created_at desc limit 1) as failure_message
        from payment_runs run
       where run.org_id = ${org.orgId}
         and run.direction = 'inbound'
         and run.purpose = 'customer_collections'
       order by run.status, run.id
    `));

    assert.equal(runState.rows.length, 2, "the failed attempt remains as cancellation evidence");
    const cancelled = runState.rows.find((run) => run.status === "cancelled");
    const active = runState.rows.find((run) => run.status === "draft");
    assert.ok(cancelled);
    const { failure_message: failureMessage, ...cancelledState } = cancelled;
    assert.deepEqual(cancelledState, {
      id: cancelled.id,
      status: "cancelled",
      instruction_count: 0,
      receipt_count: 0,
      item_count: 0,
      selected_count: 0,
      failed_event_count: 1,
    });
    assert.match(failureMessage ?? "", /Failed query: insert into "payment_run_items"/);
    assert.deepEqual(active, {
      id: successes[0]!.value.id,
      status: "draft",
      instruction_count: 1,
      receipt_count: 1,
      item_count: 1,
      selected_count: 1,
      failed_event_count: 0,
      failure_message: null,
    });

    // The engine's own cleanup is attributable to the system actor with an
    // internal reason code — never to a user, never anonymous: the run row
    // carries the nil-UUID sentinel in updated_by, while the user-keyed
    // evidence surfaces record the null "system" actor.
    const cancelledRunActor = (await db.execute<{ updated_by: string | null }>(sql`
      select updated_by::text as updated_by
        from payment_runs
       where org_id = ${org.orgId} and id = ${cancelled.id}
    `)).rows[0]!.updated_by;
    assert.equal(cancelledRunActor, PAYMENT_RUN_SYSTEM_ACTOR_ID);
    const cleanupEvidence = (await db.execute<{ actor_id: string | null; from_status: string; to_status: string; details: Record<string, unknown> }>(sql`
      select actor_id::text as actor_id, from_status, to_status, details
        from payment_events
       where org_id = ${org.orgId} and payment_run_id = ${cancelled.id}
         and event_type = 'run_cancelled'
    `)).rows;
    assert.deepEqual(cleanupEvidence, [{
      actor_id: null,
      from_status: "draft",
      to_status: "cancelled",
      details: {
        reason: PAYMENT_RUN_INTERNAL_CANCEL_REASONS.directDebitCreationFailed,
        source: "system",
      },
    }]);

    // Cancellation is the reservation-release boundary. The same invoice can
    // be claimed again only after the winning draft is cancelled.
    await cancelPaymentRun(successes[0]!.value.id, org.orgId, actorId, "release for re-collection");
    const replacement = await createDirectDebitRun(options);
    const sourceLifecycle = (await db.execute<{ run_id: string; status: string }>(sql`
      select payment_run_id as run_id, status
        from payment_run_items
       where org_id = ${org.orgId}
         and source_document_id = ${invoiceId}
       order by created_at, id
    `));
    assert.deepEqual(sourceLifecycle.rows, [
      { run_id: successes[0]!.value.id, status: "excluded" },
      { run_id: replacement.id, status: "selected" },
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

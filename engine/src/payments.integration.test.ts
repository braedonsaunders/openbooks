import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "./db.ts";
import { recordPaymentSettlement } from "./payment-operations.ts";
import {
  cancelPaymentRun,
  createPaymentDocument,
  createPaymentRun,
  PaymentError,
  PaymentRevisionConflictError,
  postPaymentRun,
  postPaymentWithApplications,
  reversePaymentForReturn,
  updateDraftPayment,
} from "./payments.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** The storage-enforced duplicate-live-reservation violation, anywhere in a cause chain. */
function isLiveSourceConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === "payment_run_items_live_source") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** Poll until some session is blocked by the given backend, proving the two
 *  writers really contend instead of merely running near each other. */
async function waitForBlockedBy(blockerPid: number, minimum = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocked = await withBypass(() => db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from pg_stat_activity activity
       where ${blockerPid} = any(pg_blocking_pids(activity.pid))
    `));
    if ((blocked.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a query blocked by backend ${blockerPid}`);
}

/** Poll until the database reaches an expected committed state, so a slow
 *  writer under parallel-suite load cannot flake the observation window. */
async function waitForState<T>(probe: () => Promise<T>, expected: T): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      assert.deepEqual(await probe(), expected);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  // One final comparison outside the swallow-loop so the failure reports the
  // last observed state.
  assert.deepEqual(await probe(), expected);
}

interface SeededPostingClaimRun {
  runId: string;
  instructionId: string;
  instructionIds: string[];
  paymentDocumentId: string;
  paymentDocumentIds: string[];
}

/**
 * A generated wire run whose instructions point at ALREADY-posted payment
 * documents, so posting an instruction is purely the claim/fence/sent flip —
 * the minimal deterministic fixture for concurrency regressions.
 */
async function seedPostingClaimRun(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actorId: string,
  instructionCount = 1,
): Promise<SeededPostingClaimRun> {
  const runId = randomUUID();
  const formatId = randomUUID();
  const profileId = randomUUID();
  const instructionIds = Array.from({ length: instructionCount }, () => randomUUID()).sort();
  const paymentDocumentIds = Array.from({ length: instructionCount }, () => randomUUID());
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into payment_formats
        (id, org_id, code, name, rail, direction, file_extension, content_type,
         created_by, updated_by)
      values
        (${formatId}, ${org.orgId}, ${`CLAIM-${formatId.slice(0, 8)}`},
         'Posting claim wire', 'wire', 'credit', 'csv', 'text/csv',
         ${actorId}, ${actorId})
    `);
    await tx.execute(sql`
      insert into payment_bank_profiles
        (id, org_id, name, bank_account_id, payment_format_id, currency,
         require_run_approval, require_file_approval, auto_remittance,
         created_by, updated_by)
      values
        (${profileId}, ${org.orgId}, ${`Posting claim ${profileId}`},
         ${org.accounts.bank}, ${formatId}, 'CAD', false, false, false,
         ${actorId}, ${actorId})
    `);

    for (const paymentDocumentId of paymentDocumentIds) {
      const entryId = randomUUID();
      await tx.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, posting_date, currency, subtotal, tax_total, total,
           custom, created_by, updated_by)
        values
          (${paymentDocumentId}, ${org.orgId}, 'vendor_payment', 'approved',
           ${`CLAIM-PAY-${paymentDocumentId}`}, ${org.subsidiaryId}, ${org.vendorId},
           ${org.date}, ${org.date}, 'CAD', '25', '0', '25',
           ${JSON.stringify({ bankAccountId: org.accounts.bank, allocations: [] })}::jsonb,
           ${actorId}, ${actorId})
      `);
      await tx.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin, created_by, updated_by)
        values
          (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           ${`CLAIM-ENTRY-${entryId}`}, ${org.date}, ${org.periodId},
           'Posting-claim concurrency fixture', 'draft', ${paymentDocumentId},
           'document', ${actorId}, ${actorId})
      `);
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, fx_rate, party_id, is_open_item, memo)
        values
          (${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId},
           '25', 'CAD', '25', 1, ${org.vendorId}, true, 'Posting claim payment'),
          (${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId},
           '-25', 'CAD', '-25', 1, null, false, 'Posting claim payment')
      `);
      await tx.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${actorId}
         where id = ${entryId} and org_id = ${org.orgId}
      `);
      await tx.execute(sql`
        update documents
           set status = 'posted', posted_entry_id = ${entryId},
               posting_period_id = ${org.periodId}
         where id = ${paymentDocumentId} and org_id = ${org.orgId}
      `);
    }

    await tx.execute(sql`
      insert into payment_runs
        (id, org_id, run_number, bank_account_id, payment_bank_profile_id,
         subsidiary_id, method, direction, purpose, currency, status,
         payment_count, total_amount, created_by, updated_by)
      values
        (${runId}, ${org.orgId}, ${`CLAIM-RUN-${runId}`}, ${org.accounts.bank},
         ${profileId}, ${org.subsidiaryId}, 'wire', 'outbound', 'vendor_payments',
         'CAD', 'generated', ${instructionCount}, ${String(25 * instructionCount)},
         ${actorId}, ${actorId})
    `);
    for (let index = 0; index < instructionIds.length; index += 1) {
      await tx.execute(sql`
        insert into payment_instructions
          (id, org_id, payment_run_id, payee_party_id, amount, currency,
           payment_document_id, status, created_by, updated_by)
        values
          (${instructionIds[index]!}, ${org.orgId}, ${runId}, ${org.vendorId},
           '25', 'CAD', ${paymentDocumentIds[index]!}, 'pending', ${actorId}, ${actorId})
      `);
    }
  });
  return {
    runId,
    instructionId: instructionIds[0]!,
    instructionIds,
    paymentDocumentId: paymentDocumentIds[0]!,
    paymentDocumentIds,
  };
}

test("cross-currency payment, dual-amount application, realized FX, evidence, and reversal are atomic", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "FX Tester", "admin");

    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved', 'INV-FX-1',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'EUR', '1.2',
              '100', '0', '100', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '100')`);
    const invoiceEntryId = await postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
    const invoiceControl = (await db.execute<{ id: string }>(sql`
      select id from journal_lines where entry_id = ${invoiceEntryId} and account_id = ${org.accounts.ar}
    `));
    const targetLineId = invoiceControl.rows[0]!.id;

    const payment = await createPaymentDocument({
      orgId: org.orgId,
      kind: "customer_payment",
      createdBy: userId,
      partyId: org.customerId,
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      documentDate: org.date,
      currency: "USD",
      fxRate: "1.625",
    });
    await updateDraftPayment(payment.id, {
      allocations: [{
        openLineId: targetLineId,
        sourceTransactionAmount: "80",
        targetTransactionAmount: "100",
        settlementRate: "1.25",
        settlementRateSource: "manual",
        settlementRateReference: "BANK-SETTLEMENT-42",
      }],
      bankAccountId: org.accounts.bank,
    }, userId, org.orgId);
    await db.execute(sql`
      update documents
         set status = 'approved', submitted_by = ${userId}, submitted_at = now()
       where id = ${payment.id}
    `);

    // A missing realized-FX account must roll back the payment itself, not
    // leave a posted-but-unapplied transaction behind.
    await db.execute(sql`
      update orgs set settings = settings #- '{controlAccounts,fxRealizedGainLoss}' where id = ${org.orgId}`);
    await assert.rejects(postPaymentWithApplications(payment.id, undefined, userId), /realized FX gain\/loss account is not configured/);
    const afterFailure = (await db.execute<{ status: string; posted_entry_id: string | null; entries: number }>(sql`
      select status, posted_entry_id,
             (select count(*) from journal_entries where source_document_id = ${payment.id})::int as entries
        from documents where id = ${payment.id}
    `));
    assert.deepEqual(afterFailure.rows[0], { status: "approved", posted_entry_id: null, entries: 0 });

    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,fxRealizedGainLoss}', to_jsonb(${org.accounts.fxGainLoss}::text), true)
       where id = ${org.orgId}`);
    const { entryId: paymentEntryId } = await postPaymentWithApplications(payment.id, undefined, userId);
    const evidence = (await db.execute<{
      amount: string; source_amount: string;
      source_transaction_amount: string; source_transaction_currency: string;
      target_transaction_amount: string; target_transaction_currency: string;
      settlement_rate: string; settlement_rate_source: string; settlement_rate_reference: string;
      fx_gain_loss_entry_id: string; fx_status: string; fx_balance: string;
      control_adjustment: string; gain_loss: string;
    }>(sql`
      select a.amount, a.source_amount,
             a.source_transaction_amount, a.source_transaction_currency,
             a.target_transaction_amount, a.target_transaction_currency,
             a.settlement_rate, a.settlement_rate_source, a.settlement_rate_reference,
             a.fx_gain_loss_entry_id, fx.status as fx_status,
             (select coalesce(sum(amount), 0) from journal_lines where entry_id = a.fx_gain_loss_entry_id) as fx_balance,
             (select amount from journal_lines where entry_id = a.fx_gain_loss_entry_id and account_id = ${org.accounts.ar}) as control_adjustment,
             (select amount from journal_lines where entry_id = a.fx_gain_loss_entry_id and account_id = ${org.accounts.fxGainLoss}) as gain_loss
        from applications a join journal_entries fx on fx.id = a.fx_gain_loss_entry_id
       where a.from_line_id in (select id from journal_lines where entry_id = ${paymentEntryId})
    `));
    assert.deepEqual(evidence.rows[0], {
      amount: "120.0000",
      source_amount: "130.0000",
      source_transaction_amount: "80.0000",
      source_transaction_currency: "USD",
      target_transaction_amount: "100.0000",
      target_transaction_currency: "EUR",
      settlement_rate: "1.2500000000",
      settlement_rate_source: "manual",
      settlement_rate_reference: "BANK-SETTLEMENT-42",
      fx_gain_loss_entry_id: evidence.rows[0]!.fx_gain_loss_entry_id,
      fx_status: "posted",
      fx_balance: "0.0000",
      control_adjustment: "10.0000",
      gain_loss: "-10.0000",
    });

    const fxEntryId = evidence.rows[0]!.fx_gain_loss_entry_id;
    const reversalId = await reversePaymentForReturn(payment.id, org.orgId, "NSF", userId, org.date);
    assert.ok(reversalId);
    const reversed = (await db.execute<{ payment_status: string; fx_status: string; reversals: number; unapplied: number; document_status: string }>(sql`
      select
        (select status from journal_entries where id = ${paymentEntryId}) as payment_status,
        (select status from journal_entries where id = ${fxEntryId}) as fx_status,
        (select count(*) from journal_entries where reverses_entry_id in (${paymentEntryId}, ${fxEntryId}) and status = 'posted')::int as reversals,
        (select count(*) from applications where from_line_id in (select id from journal_lines where entry_id = ${paymentEntryId}) and unapplied_at is not null)::int as unapplied,
        (select status from documents where id = ${payment.id}) as document_status
    `));
    assert.deepEqual(reversed.rows[0], {
      payment_status: "reversed",
      fx_status: "reversed",
      reversals: 2,
      unapplied: 1,
      document_status: "voided",
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an open item can be reserved by only one live payment run at a time", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const options = await withBypass(async () => {
      const actorId = await createScratchUser(org.orgId, "Run Operator", "accountant");
      const formatId = randomUUID();
      const profileId = randomUUID();
      const billId = randomUUID();

      await db.execute(sql`
        insert into payment_formats
          (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
        values
          (${formatId}, ${org.orgId}, 'CPA005-RESERVE', 'CPA-005 credit reservation test',
           'cpa005_credit', 'credit', 'CA', 'CAD', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into payment_bank_profiles
          (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id,
           currency, country, created_by, updated_by)
        values
          (${profileId}, ${org.orgId}, 'Reservation run profile', ${org.accounts.bank},
           ${org.subsidiaryId}, ${formatId}, 'CAD', 'CA', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${billId}, ${org.orgId}, 'vendor_bill', 'approved', 'BILL-RESERVE-1',
                ${org.subsidiaryId}, ${org.vendorId}, ${org.date}, 'CAD', '1',
                '125', '0', '125', ${actorId})`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount)
        values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', '125',
                '125', '0')`);
      await postDocument(billId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });

      return { actorId, profileId, billId };
    });

    await withOrgContext(org.orgId, async () => {
      const openLineId = (await db.execute<{ id: string }>(sql`
        select jl.id as id
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
         where je.source_document_id = ${options.billId}
           and je.status = 'posted' and jl.is_open_item and jl.amount < 0
      `)).rows[0]!.id;

      const createRun = () =>
        createPaymentRun({
          orgId: org.orgId,
          createdBy: options.actorId,
          paymentBankProfileId: options.profileId,
          billDocumentIds: [options.billId],
          scheduledFor: org.date,
        });
      const itemStatuses = (runId: string) =>
        db.execute<{ status: string; n: number }>(sql`
          select status, count(*)::int as n
            from payment_run_items
           where org_id = ${org.orgId} and payment_run_id = ${runId}
             and source_open_line_id = ${openLineId}
           group by status`);

      // The first live run reserves the bill's payable line.
      const firstRun = await createRun();
      assert.deepEqual((await itemStatuses(firstRun.id)).rows, [{ status: "selected", n: 1 }]);

      // An overlapping selection of the reserved bill is refused while that
      // run is live.
      await assert.rejects(createRun, (error: unknown) => {
        assert.ok(error instanceof PaymentError);
        assert.match(error.message, /already selected in another live payment run/);
        return true;
      });

      // PostgreSQL — not the service-level selection filter — is the final
      // authority: a writer that skips the filter still cannot double-reserve.
      const ghostRunId = randomUUID();
      await db.execute(sql`
        insert into payment_runs
          (id, org_id, run_number, bank_account_id, payment_bank_profile_id,
           method, direction, purpose, currency, status, created_by)
        values (${ghostRunId}, ${org.orgId}, 'RUN-RESERVE-GHOST', ${org.accounts.bank},
                ${options.profileId}, 'eft', 'outbound', 'vendor_payments',
                'CAD', 'draft', ${options.actorId})`);
      await assert.rejects(
        db.execute(sql`
          insert into payment_run_items
            (org_id, payment_run_id, source_document_id, source_open_line_id, kind,
             gross_amount, payment_amount, currency, status, created_by)
          values (${org.orgId}, ${ghostRunId}, ${options.billId}, ${openLineId}, 'bill',
                  '125', '125', 'CAD', 'selected', ${options.actorId})`),
        isLiveSourceConflict,
      );

      // Cancelling the live run releases the reservation through the
      // lifecycle triggers...
      await cancelPaymentRun(firstRun.id, org.orgId);
      assert.deepEqual((await itemStatuses(firstRun.id)).rows, [{ status: "excluded", n: 1 }]);

      // ...and only a live (`selected`) item reserves its source line, so a
      // new run can reserve the released bill immediately while the excluded
      // history coexists.
      const secondRun = await createRun();
      assert.notEqual(secondRun.id, firstRun.id);
      assert.deepEqual((await itemStatuses(secondRun.id)).rows, [{ status: "selected", n: 1 }]);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("one concurrent payment-run poster owns the processing claim and its evidence", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  let releaseInstruction!: () => void;
  const instructionReleased = new Promise<void>((resolve) => { releaseInstruction = resolve; });
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Run poster", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId));
    let signalLocked!: (pid: number) => void;
    const instructionLocked = new Promise<number>((resolve) => { signalLocked = resolve; });
    const blocker = withOrgContext(org.orgId, () => db.transaction(async (tx) => {
      const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
      await tx.execute(sql`
        select id from payment_instructions
         where id = ${seeded.instructionId} and org_id = ${org.orgId}
         for update
      `);
      signalLocked(pid.rows[0]!.pid);
      await instructionReleased;
    }));
    const blockerPid = await instructionLocked;

    const winner = withOrgContext(org.orgId, () =>
      postPaymentRun(seeded.runId, org.orgId, actorId));
    await waitForBlockedBy(blockerPid);
    const claimed = await withOrgContext(org.orgId, async () =>
      (await db.execute<{ status: string; started: number; claims: number }>(sql`
        select run.status,
               (select count(*)::int from payment_events event
                 where event.payment_run_id = run.id and event.org_id = run.org_id
                   and event.event_type = 'run_posting_started') as started,
               (select count(*)::int from payment_events event
                 where event.payment_run_id = run.id and event.org_id = run.org_id
                   and event.event_type = 'run_posting_recovered') as claims
          from payment_runs run
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(claimed, { status: "processing", started: 1, claims: 0 });

    const loser = withOrgContext(org.orgId, () =>
      postPaymentRun(seeded.runId, org.orgId, actorId));
    releaseInstruction();
    await blocker;
    const results = await Promise.allSettled([winner, loser]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof postPaymentRun>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.deepEqual(fulfilled.map((result) => result.value), [{ posted: 1, failures: [] }]);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof PaymentError);
    assert.match(rejected[0]!.reason.message, /already being posted|already posted/);

    const final = await withOrgContext(org.orgId, async () =>
      (await db.execute<{
        run_status: string;
        instruction_status: string;
        claim_token: boolean;
        started: number;
        completed: number;
      }>(sql`
        select run.status as run_status, instruction.status as instruction_status,
               run.posting_claim_token is not null as claim_token,
               (select count(*)::int from payment_events event
                 where event.payment_run_id = run.id and event.org_id = run.org_id
                   and event.event_type = 'run_posting_started') as started,
               (select count(*)::int from payment_events event
                 where event.payment_run_id = run.id and event.org_id = run.org_id
                   and event.event_type = 'run_posting_completed') as completed
          from payment_runs run
          join payment_instructions instruction
            on instruction.payment_run_id = run.id and instruction.org_id = run.org_id
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(final, {
      run_status: "confirmed",
      instruction_status: "sent",
      claim_token: false,
      started: 1,
      completed: 1,
    });
  } finally {
    releaseInstruction?.();
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a terminal transition fences a stale payment-run worker before instruction mutation", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  let releaseProfileTable!: () => void;
  const profileTableReleased = new Promise<void>((resolve) => { releaseProfileTable = resolve; });
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Return racer", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId, 2));
    let signalLocked!: () => void;
    const profileTableLocked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const blocker = withOrgContext(org.orgId, () => db.transaction(async (tx) => {
      // The first instruction commits before automatic remittance is queried.
      // Holding this table gives the bank-return writer a causal window between
      // instructions without taking a row lock in the opposite aggregate order.
      await tx.execute(sql`lock table payment_bank_profiles in access exclusive mode`);
      signalLocked();
      await profileTableReleased;
    }));
    await profileTableLocked;

    const staleWorker = withOrgContext(org.orgId, () =>
      postPaymentRun(seeded.runId, org.orgId, actorId));
    await waitForState(async () =>
      withOrgContext(org.orgId, async () =>
        (await db.execute<{
          run_status: string;
          first_status: string;
          second_status: string;
          sent_events: number;
        }>(sql`
        select run.status as run_status,
               (select status from payment_instructions
                 where id = ${seeded.instructionIds[0]!}) as first_status,
               (select status from payment_instructions
                 where id = ${seeded.instructionIds[1]!}) as second_status,
               (select count(*)::int from payment_events event
                 where event.payment_run_id = run.id and event.org_id = run.org_id
                   and event.event_type = 'instruction_sent') as sent_events
          from payment_runs run
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]), {
      run_status: "processing",
      first_status: "sent",
      second_status: "pending",
      sent_events: 1,
    });

    await withOrgContext(org.orgId, () => recordPaymentSettlement({
      instructionId: seeded.instructionIds[0]!,
      orgId: org.orgId,
      userId: actorId,
      status: "returned",
      effectiveOn: org.date,
      returnCode: "R01",
      returnReason: "posting-claim concurrency regression",
    }));
    releaseProfileTable();
    await blocker;
    await assert.rejects(
      staleWorker,
      (error: Error) => error instanceof PaymentError && /no longer owns the run/.test(error.message),
    );
    const final = await withOrgContext(org.orgId, async () =>
      (await db.execute<{
        run_status: string;
        first_instruction_status: string;
        second_instruction_status: string;
        first_payment_status: string;
        second_payment_status: string;
        sent: number;
        returned: number;
        completed: number;
        failed: number;
        claim_token: boolean;
      }>(sql`
        select run.status as run_status,
               (select status from payment_instructions
                 where id = ${seeded.instructionIds[0]!}) as first_instruction_status,
               (select status from payment_instructions
                 where id = ${seeded.instructionIds[1]!}) as second_instruction_status,
               (select status from documents
                 where id = ${seeded.paymentDocumentIds[0]!}) as first_payment_status,
               (select status from documents
                 where id = ${seeded.paymentDocumentIds[1]!}) as second_payment_status,
               (select count(*)::int from payment_events event
                 where event.payment_run_id = run.id and event.org_id = run.org_id
                   and event.event_type = 'instruction_sent') as sent,
               (select count(*)::int from payment_events event
                 where event.payment_run_id = run.id and event.org_id = run.org_id
                   and event.event_type = 'instruction_returned') as returned,
               (select count(*)::int from payment_events event
                 where event.payment_run_id = run.id and event.org_id = run.org_id
                   and event.event_type = 'run_posting_completed') as completed,
               (select count(*)::int from payment_events event
                 where event.payment_run_id = run.id and event.org_id = run.org_id
                   and event.event_type = 'run_posting_failed') as failed,
               run.posting_claim_token is not null as claim_token
          from payment_runs run
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(final, {
      run_status: "returned",
      first_instruction_status: "returned",
      second_instruction_status: "pending",
      first_payment_status: "voided",
      second_payment_status: "posted",
      sent: 1,
      returned: 1,
      completed: 0,
      failed: 0,
      claim_token: false,
    });
  } finally {
    releaseProfileTable?.();
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a recovered stale posting claim resumes the run without double-posting", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Crash recovery", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId, 2));

    // Simulate a crashed poster: it claimed the run, committed the first
    // instruction as sent, then died without completing or releasing. The
    // lease has made no progress for far longer than the staleness window.
    await withOrgContext(org.orgId, () => db.execute(sql`
      update payment_runs
         set status = 'processing',
             posting_claim_token = gen_random_uuid(),
             posting_claimed_at = now() - interval '20 minutes',
             posting_claimed_by = ${actorId}
       where id = ${seeded.runId} and org_id = ${org.orgId}
    `));
    await withOrgContext(org.orgId, () => db.execute(sql`
      update payment_instructions
         set status = 'sent', updated_at = now(), updated_by = ${actorId}
       where id = ${seeded.instructionIds[0]!} and org_id = ${org.orgId}
    `));

    // A fresh claim while the abandoned one still reads recent is refused...
    await withOrgContext(org.orgId, () => db.execute(sql`
      update payment_runs
         set posting_claimed_at = now()
       where id = ${seeded.runId} and org_id = ${org.orgId}
    `));
    await assert.rejects(
      withOrgContext(org.orgId, () => postPaymentRun(seeded.runId, org.orgId, actorId)),
      (error: unknown) => {
        assert.ok(error instanceof PaymentError);
        assert.match(error.message, /run is already being posted/);
        return true;
      },
    );

    // ...but once the lease goes stale the next poster takes over, finishes
    // exactly the pending remainder, and retires the claim on completion.
    await withOrgContext(org.orgId, () => db.execute(sql`
      update payment_runs
         set posting_claimed_at = now() - interval '20 minutes'
       where id = ${seeded.runId} and org_id = ${org.orgId}
    `));
    const outcome = await withOrgContext(org.orgId, () =>
      postPaymentRun(seeded.runId, org.orgId, actorId));
    assert.deepEqual(outcome, { posted: 1, failures: [] });

    const final = await withOrgContext(org.orgId, async () =>
      (await db.execute<{
        run_status: string;
        sent: number;
        started: number;
        recovered: number;
        failed: number;
        completed: number;
        claim_token: boolean;
      }>(sql`
        select run.status as run_status,
             (select count(*)::int from payment_instructions i
               where i.payment_run_id = run.id and i.org_id = run.org_id
                 and i.status = 'sent') as sent,
             (select count(*)::int from payment_events e
               where e.payment_run_id = run.id and e.org_id = run.org_id
                 and e.event_type = 'run_posting_started') as started,
             (select count(*)::int from payment_events e
               where e.payment_run_id = run.id and e.org_id = run.org_id
                 and e.event_type = 'run_posting_recovered') as recovered,
             (select count(*)::int from payment_events e
               where e.payment_run_id = run.id and e.org_id = run.org_id
                 and e.event_type = 'run_posting_failed') as failed,
             (select count(*)::int from payment_events e
               where e.payment_run_id = run.id and e.org_id = run.org_id
                 and e.event_type = 'run_posting_completed') as completed,
             run.posting_claim_token is not null as claim_token
        from payment_runs run
       where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(final, {
      run_status: "confirmed",
      sent: 2,
      started: 0,
      recovered: 1,
      failed: 0,
      completed: 1,
      claim_token: false,
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("draft payment saves are fenced by the exact document revision", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Draft fence", "admin"));

    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'vendor_bill', 'approved', 'BILL-FENCE-1',
              ${org.subsidiaryId}, ${org.vendorId}, ${org.date}, 'CAD', '1',
              '40', '0', '40', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price,
         amount, tax_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.cogs}, '1', '40',
              '40', '0')`);
    const invoiceEntryId = await postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
    const openLineId = (await db.execute<{ id: string }>(sql`
      select id from journal_lines
       where entry_id = ${invoiceEntryId} and org_id = ${org.orgId}
         and is_open_item and amount < 0
    `)).rows[0]!.id;

    const payment = await createPaymentDocument({
      orgId: org.orgId,
      kind: "vendor_payment",
      createdBy: userId,
      partyId: org.vendorId,
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      documentDate: org.date,
      currency: "CAD",
      fxRate: "1",
    });

    const revision = async () => withOrgContext(org.orgId, async () =>
      (await db.execute<{ updatedAt: string }>(sql`
        select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
          from documents where id = ${payment.id} and org_id = ${org.orgId}
      `)).rows[0]!.updatedAt);

    const allocationSave = {
      partyId: org.vendorId,
      bankAccountId: org.accounts.bank,
      allocations: [{
        openLineId,
        sourceTransactionAmount: "40",
        targetTransactionAmount: "40",
        settlementRate: "1",
        settlementRateSource: "same_currency" as const,
        settlementRateReference: "same transaction currency",
      }],
    };

    // The first save under the caller's loaded revision goes through.
    const initialRevision = await revision();
    await withOrgContext(org.orgId, () => updateDraftPayment(payment.id, {
      ...allocationSave,
    }, userId, org.orgId, { expectedRevision: initialRevision }));
    const afterSave = await revision();
    assert.notEqual(afterSave, initialRevision);

    // The pre-save token is now stale: the whole save fences and nothing
    // about the draft moves.
    await assert.rejects(
      withOrgContext(org.orgId, () => updateDraftPayment(payment.id, {}, userId, org.orgId, {
        expectedRevision: initialRevision,
      })),
      (error: unknown) => error instanceof PaymentRevisionConflictError,
    );
    const afterConflict = await revision();
    assert.equal(afterConflict, afterSave);

    // A save without a token remains legal for internal callers (run
    // creation); the API contract requires one — covered by the route.
    await withOrgContext(org.orgId, () => updateDraftPayment(payment.id, {
      memo: "internal unfenced save",
    }, userId, org.orgId));
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

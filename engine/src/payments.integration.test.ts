import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql, type SQL } from "drizzle-orm";
import { db, withBypass, withOrgContext, withOrgTransaction } from "./db.ts";
import {
  generatePaymentFileArtifact,
  recordPaymentSettlement,
} from "./payment-operations.ts";
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

/** The storage-enforced cross-run-instruction-reference violation, anywhere in a cause chain. */
function isCrossRunInstructionConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === "23503" && candidate.constraint === "payment_run_items_instruction_run") {
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

interface SeedPostingClaimRunOptions {
  /** Turn on the bank profile's automatic remittance advice. */
  autoRemittance?: boolean;
}

interface PaymentRunSelectionFixture {
  actorId: string;
  profileId: string;
  billId: string;
}

/**
 * Install a posting claim exactly as a live poster would have it on the run,
 * and present its token the way every fenced writer must (the instruction
 * fence trigger rejects unclaimed mutations on processing runs).
 */
async function installPostingClaim(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  runId: string,
  actorId: string,
  claimedAt: SQL = sql`now()`,
): Promise<string> {
  const token = randomUUID();
  await withOrgContext(org.orgId, () => db.execute(sql`
    update payment_runs
       set status = 'processing',
           posting_claim_token = ${token}::uuid,
           posting_claimed_at = ${claimedAt},
           posting_claimed_by = ${actorId}
     where id = ${runId} and org_id = ${org.orgId}
  `));
  return token;
}

/** Run one statement batch as a writer holding the given claim token. */
async function withPostingClaim<T>(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  runId: string,
  token: string | null,
  work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return withOrgContext(org.orgId, () => db.transaction(async (tx) => {
    if (token !== null) {
      await tx.execute(sql`
        select set_config('openbooks.payment_run_claim', ${`${runId}:${token}`}, true)
      `);
    }
    return work(tx);
  }));
}

/** Assert the storage-level instruction fence rejected the write, wherever in
 *  the drizzle cause chain the PostgreSQL error surfaces. */
async function assertInstructionFenceRejected(attempt: Promise<unknown>): Promise<void> {
  await assert.rejects(attempt, (error: unknown) => {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      if (/only the current posting claim may mutate it/.test(current.message)) return true;
      current = (current as Error & { cause?: unknown }).cause;
    }
    return false;
  });
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
  options: SeedPostingClaimRunOptions = {},
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
         ${org.accounts.bank}, ${formatId}, 'CAD', false, false,
         ${options.autoRemittance ?? false},
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

async function seedPaymentRunSelectionFixture(org: Awaited<ReturnType<typeof createScratchOrg>>): Promise<PaymentRunSelectionFixture> {
  return withBypass(async () => {
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
}

test("an open item can be reserved by only one live payment run at a time", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const options = await seedPaymentRunSelectionFixture(org);

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

test("one run's instruction lifecycle cannot release another run's live reservation", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const options = await seedPaymentRunSelectionFixture(org);

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
      const liveReservation = () =>
        db.execute<{ status: string; n: number }>(sql`
          select status, count(*)::int as n
            from payment_run_items
           where org_id = ${org.orgId} and source_open_line_id = ${openLineId}
           group by status`);

      // The live run reserves the bill's payable line.
      const liveRun = await createRun();
      assert.deepEqual((await liveReservation()).rows, [{ status: "selected", n: 1 }]);
      const liveInstructionId = (await db.execute<{ id: string }>(sql`
        select id from payment_instructions
         where payment_run_id = ${liveRun.id} and org_id = ${org.orgId}
      `)).rows[0]!.id;
      const liveItemId = (await db.execute<{ id: string }>(sql`
        select id from payment_run_items
         where payment_run_id = ${liveRun.id} and org_id = ${org.orgId}
           and source_open_line_id = ${openLineId}
      `)).rows[0]!.id;

      // A second run with its own instruction must never touch the first
      // run's reservation, however its lifecycle advances.
      const otherRunId = randomUUID();
      await db.execute(sql`
        insert into payment_runs
          (id, org_id, run_number, bank_account_id, payment_bank_profile_id,
           method, direction, purpose, currency, status, created_by)
        values (${otherRunId}, ${org.orgId}, 'RUN-RESERVE-OTHER', ${org.accounts.bank},
                ${options.profileId}, 'eft', 'outbound', 'vendor_payments',
                'CAD', 'draft', ${options.actorId})`);
      const otherInstructionId = randomUUID();
      await db.execute(sql`
        insert into payment_instructions
          (id, org_id, payment_run_id, payee_party_id, amount, currency,
           status, created_by)
        values (${otherInstructionId}, ${org.orgId}, ${otherRunId}, ${org.vendorId},
                '125', 'CAD', 'pending', ${options.actorId})`);

      // Even with the corrupt legacy shape physically present — planted here
      // inside a deferred-constraint probe that always rolls back — cancelling
      // the foreign instruction leaves the live reservation standing. The old
      // instruction-id-only fan-out released it right here.
      class ProbeComplete extends Error {}
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(sql`set constraints payment_run_items_instruction_run deferred`);
          await tx.execute(sql`
            update payment_run_items
               set payment_instruction_id = ${otherInstructionId}, updated_at = now(),
                   updated_by = ${options.actorId}
             where id = ${liveItemId} and org_id = ${org.orgId}
          `);
          await tx.execute(sql`
            update payment_instructions
               set status = 'cancelled', updated_at = now(), updated_by = ${options.actorId}
             where id = ${otherInstructionId} and org_id = ${org.orgId}
          `);
          const probed = await tx.execute<{ status: string; n: number }>(sql`
            select status, count(*)::int as n
              from payment_run_items
             where id = ${liveItemId} and org_id = ${org.orgId}
            group by status`);
          assert.deepEqual(probed.rows, [{ status: "selected", n: 1 }]);
          throw new ProbeComplete("probe observed — roll the corruption back");
        }),
        ProbeComplete,
      );
      assert.deepEqual((await liveReservation()).rows, [{ status: "selected", n: 1 }]);

      // Storage makes the corruption unrepresentable for committed data: no
      // writer can wire one run's item to another run's instruction.
      await assert.rejects(
        db.execute(sql`
          update payment_run_items
             set payment_instruction_id = ${otherInstructionId}, updated_at = now(),
                 updated_by = ${options.actorId}
           where id = ${liveItemId} and org_id = ${org.orgId}
        `),
        isCrossRunInstructionConflict,
      );
      await assert.rejects(
        db.execute(sql`
          insert into payment_run_items
            (org_id, payment_run_id, payment_instruction_id, source_document_id,
             source_open_line_id, kind, gross_amount, discount_amount, credit_amount,
             payment_amount, currency, status, created_by)
          values (${org.orgId}, ${otherRunId}, ${liveInstructionId}, ${options.billId},
                  ${openLineId}, 'bill', '125', '0', '0', '125', 'CAD',
                  'excluded', ${options.actorId})
        `),
        isCrossRunInstructionConflict,
      );

      // The other run going terminal releases only its own items — the live
      // reservation survives to be paid by its own run's lifecycle.
      await cancelPaymentRun(otherRunId, org.orgId);
      assert.deepEqual((await liveReservation()).rows, [{ status: "selected", n: 1 }]);

      // And the owning run's own cancellation still releases normally.
      await cancelPaymentRun(liveRun.id, org.orgId);
      assert.deepEqual((await liveReservation()).rows, [{ status: "excluded", n: 1 }]);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("run creation turns a storage source-claim conflict into its domain failure without drafts", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  let releaseSequence!: () => void;
  const sequenceReleased = new Promise<void>((resolve) => { releaseSequence = resolve; });
  try {
    const options = await seedPaymentRunSelectionFixture(org);

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

      // The constructor owns its transaction by contract. A nested caller is
      // refused before any artifact exists: the conflict translation below is
      // only sound when it judges failures of the whole atomic unit.
      await withOrgTransaction(org.orgId, () =>
        assert.rejects(createRun(), (error: unknown) => {
          assert.ok(error instanceof PaymentError);
          assert.match(error.message, /cannot be nested in another database transaction/);
          return true;
        }),
      );

      // Park the changed constructor after its reservation filter read the
      // bill as unreserved but before it inserts any item: number_sequences
      // (the run number) is that window's first write.
      let signalLocked!: (pid: number) => void;
      const sequenceLocked = new Promise<number>((resolve) => { signalLocked = resolve; });
      const holder = withOrgContext(org.orgId, () => db.transaction(async (tx) => {
        const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
        await tx.execute(sql`lock table number_sequences in exclusive mode`);
        signalLocked(pid.rows[0]!.pid);
        await sequenceReleased;
      }));
      const holderPid = await sequenceLocked;

      const creation = createRun();
      await waitForBlockedBy(holderPid);

      // Inside that window another live run reserves the same open line —
      // committed state the filter can no longer see, so only PostgreSQL's
      // partial unique index stands between the run and a double reservation.
      const ghostRunId = randomUUID();
      await db.execute(sql`
        insert into payment_runs
          (id, org_id, run_number, bank_account_id, payment_bank_profile_id,
           method, direction, purpose, currency, status, created_by)
        values (${ghostRunId}, ${org.orgId}, 'RUN-RESERVE-RACER', ${org.accounts.bank},
                ${options.profileId}, 'eft', 'outbound', 'vendor_payments',
                'CAD', 'draft', ${options.actorId})`);
      await db.execute(sql`
        insert into payment_run_items
          (org_id, payment_run_id, source_document_id, source_open_line_id, kind,
           gross_amount, payment_amount, currency, status, created_by)
        values (${org.orgId}, ${ghostRunId}, ${options.billId}, ${openLineId}, 'bill',
                '125', '125', 'CAD', 'selected', ${options.actorId})`);

      releaseSequence();
      await holder;
      await assert.rejects(creation, (error: unknown) => {
        assert.ok(error instanceof PaymentError);
        assert.match(
          error.message,
          /a selected bill or credit is already reserved by another live payment run/,
        );
        return true;
      });

      // The losing attempt is fully atomic — no draft artifacts survive — and
      // the winner's reservation stands untouched.
      const aftermath = (await db.execute<{
        runs: number; instructions: number; payments: number;
        items: number; selected: number; sequences: number;
      }>(sql`
        select
          (select count(*)::int from payment_runs where org_id = ${org.orgId}) as runs,
          (select count(*)::int from payment_instructions where org_id = ${org.orgId}) as instructions,
          (select count(*)::int from documents where org_id = ${org.orgId} and kind = 'vendor_payment') as payments,
          (select count(*)::int from payment_run_items where org_id = ${org.orgId}) as items,
          (select count(*)::int from payment_run_items where org_id = ${org.orgId} and status = 'selected') as selected,
          (select count(*)::int from number_sequences where org_id = ${org.orgId}
             and document_kind in ('payment_run', 'vendor_payment')) as sequences
      `));
      assert.deepEqual(aftermath.rows[0], {
        runs: 1,
        instructions: 0,
        payments: 0,
        items: 1,
        selected: 1,
        sequences: 0,
      });
    });
  } finally {
    releaseSequence?.();
    await withBypass(() => dropScratchOrg(org.orgId));
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

test("the instruction fence is enforced by storage: superseded claim tokens cannot mutate instructions", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Storage fence", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId, 3));

    // A live poster holds the lease and advances its first instruction.
    const liveToken = await installPostingClaim(org, seeded.runId, actorId);
    await withPostingClaim(org, seeded.runId, liveToken, (tx) => tx.execute(sql`
      update payment_instructions
         set status = 'sent', updated_at = now(), updated_by = ${actorId}
        where id = ${seeded.instructionIds[0]!} and org_id = ${org.orgId}
    `));

    // A new poster recovers the lease: the previous token is now superseded.
    const supersededToken = liveToken;
    const currentToken = await installPostingClaim(org, seeded.runId, actorId);
    assert.notEqual(currentToken, supersededToken);

    // The superseded worker can neither advance lifecycle state…
    await assertInstructionFenceRejected(
      withPostingClaim(org, seeded.runId, supersededToken, (tx) => tx.execute(sql`
        update payment_instructions
           set status = 'sent', updated_at = now(), updated_by = ${actorId}
          where id = ${seeded.instructionIds[1]!} and org_id = ${org.orgId}
      `)),
    );
    // …nor touch instruction metadata…
    await assertInstructionFenceRejected(
      withPostingClaim(org, seeded.runId, supersededToken, (tx) => tx.execute(sql`
        update payment_instructions
           set remittance_email_sent_at = now(), updated_at = now(), updated_by = ${actorId}
          where id = ${seeded.instructionIds[1]!} and org_id = ${org.orgId}
      `)),
    );
    // …nor remove rows.
    await assertInstructionFenceRejected(
      withPostingClaim(org, seeded.runId, supersededToken, (tx) => tx.execute(sql`
        delete from payment_instructions
         where id = ${seeded.instructionIds[2]!} and org_id = ${org.orgId}
      `)),
    );

    // An unclaimed writer is equally powerless: the posting advance and
    // metadata edits are refused…
    await assertInstructionFenceRejected(
      withPostingClaim(org, seeded.runId, null, (tx) => tx.execute(sql`
        update payment_instructions
           set status = 'sent', updated_at = now(), updated_by = ${actorId}
          where id = ${seeded.instructionIds[1]!} and org_id = ${org.orgId}
      `)),
    );
    await assertInstructionFenceRejected(
      withPostingClaim(org, seeded.runId, null, (tx) => tx.execute(sql`
        update payment_instructions
           set remittance_email_sent_at = now(), updated_at = now(), updated_by = ${actorId}
          where id = ${seeded.instructionIds[0]!} and org_id = ${org.orgId}
      `)),
    );
    // …while the settlement-style lifecycle retreat stays available to the
    // bank-outcome writer, which serializes on the run row itself.
    await withPostingClaim(org, seeded.runId, null, (tx) => tx.execute(sql`
      update payment_instructions
         set status = 'returned', updated_at = now(), updated_by = ${actorId}
        where id = ${seeded.instructionIds[0]!} and org_id = ${org.orgId}
    `));

    // The current claim holder advances the very row the superseded token
    // was refused: authority, not row state, decides.
    await withPostingClaim(org, seeded.runId, currentToken, (tx) => tx.execute(sql`
      update payment_instructions
         set status = 'sent', updated_at = now(), updated_by = ${actorId}
        where id = ${seeded.instructionIds[1]!} and org_id = ${org.orgId}
    `));

    const final = await withBypass(async () =>
      (await db.execute<{ statuses: string[]; stamped: number }>(sql`
        select array_agg(status order by id) as statuses,
               count(*) filter (where remittance_email_sent_at is not null)::int as stamped
          from payment_instructions
         where payment_run_id = ${seeded.runId} and org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(final, { statuses: ["returned", "sent", "pending"], stamped: 0 });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a terminal transition fences a stale payment-run worker before downstream instruction or remittance mutation", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  let secondInstructionReleased!: () => void;
  const instructionReleased = new Promise<void>((resolve) => { secondInstructionReleased = resolve; });
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Return racer", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId, 2, { autoRemittance: true }));
    let signalLocked!: (pid: number) => void;
    const secondInstructionLocked = new Promise<number>((resolve) => { signalLocked = resolve; });
    const blocker = withOrgContext(org.orgId, () => db.transaction(async (tx) => {
      // Parking the stale worker on the second instruction's row lock holds
      // the run mid-flight (`processing`, first instruction sent) while the
      // bank-return writer queues behind the worker's own run-row lock — the
      // documented shared lock order, so the terminal transition can only
      // land after the worker's current instruction commits.
      const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
      await tx.execute(sql`
        select id from payment_instructions
         where id = ${seeded.instructionIds[1]!} and org_id = ${org.orgId}
         for update
      `);
      signalLocked(pid.rows[0]!.pid);
      await instructionReleased;
    }));
    const blockerPid = await secondInstructionLocked;

    const staleWorker = withOrgContext(org.orgId, () =>
      postPaymentRun(seeded.runId, org.orgId, actorId));
    await waitForBlockedBy(blockerPid);

    // The bank return for the first instruction queues behind the parked
    // worker; releasing the instruction lets the worker commit its send,
    // then the settlement lands and fences everything the worker does next.
    const settlement = withOrgContext(org.orgId, () => recordPaymentSettlement({
      instructionId: seeded.instructionIds[0]!,
      orgId: org.orgId,
      userId: actorId,
      status: "returned",
      effectiveOn: org.date,
      returnCode: "R01",
      returnReason: "posting-claim concurrency regression",
    }));
    secondInstructionReleased();
    await blocker;
    await settlement;
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
        remittances: number;
        second_remittance_stamped: boolean;
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
                exists (
                  select 1 from payment_instructions
                   where id = ${seeded.instructionIds[1]!}
                     and remittance_email_sent_at is not null
                ) as second_remittance_stamped,
                run.posting_claim_token is not null as claim_token
           from payment_runs run
          where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
       `)).rows[0]);
    assert.deepEqual(final, {
      run_status: "returned",
      first_instruction_status: "returned",
      second_instruction_status: "sent",
      first_payment_status: "voided",
      second_payment_status: "posted",
      sent: 2,
      returned: 1,
      completed: 0,
      failed: 0,
      // The worker staged remittance evidence only for instructions it sent
      // while its heartbeat still proved ownership: always the first one, and
      // possibly also the sibling when the worker's post-commit fence won the
      // race against the settlement that was queuing on the run row — a claim
      // that was still valid in storage at that instant. What authority loss
      // forbids everywhere is completion: no superseded write may stamp
      // instruction metadata or mark advice sent.
      second_remittance_stamped: false,
      claim_token: false,
    });
    // Advice evidence exists for the first instruction always, and at most
    // one more row when the sibling's staging won its pre-supersession race.
    const remittanceCounts = await withOrgContext(org.orgId, async () =>
      (await db.execute<{ first: number; second: number }>(sql`
        select count(*) filter (where payment_instruction_id = ${seeded.instructionIds[0]!})::int as first,
               count(*) filter (where payment_instruction_id = ${seeded.instructionIds[1]!})::int as second
          from payment_remittances
         where org_id = ${org.orgId}
           and payment_instruction_id in (${seeded.instructionIds[0]!}, ${seeded.instructionIds[1]!})
      `)).rows[0]);
    const counts = remittanceCounts!;
    assert.ok(counts.first === 1, `expected advice staged once for the authoritatively sent instruction, got ${counts.first}`);
    assert.ok(counts.second >= 0 && counts.second <= 1);
    const secondRemittanceStatuses = (await withOrgContext(org.orgId, async () =>
      (await db.execute<{ statuses: string[] | null }>(sql`
        select coalesce(array_agg(distinct status), '{}') as statuses
          from payment_remittances
         where payment_instruction_id = ${seeded.instructionIds[1]!} and org_id = ${org.orgId}
      `)).rows[0]))?.statuses ?? [];
    assert.ok(
      secondRemittanceStatuses.every((status) => status === "failed"),
      `a superseded worker must never complete advice for work it lost: ${JSON.stringify(secondRemittanceStatuses)}`,
    );
  } finally {
    secondInstructionReleased?.();
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a bank-return transition cannot strand a returned run's pending instructions", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Return resume", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId, 2));

    // A partial release followed by a bank return: the first instruction went
    // out and came back while the second never left. The settlement writer
    // stamps the whole run `returned`, which used to wall the unsent
    // instruction off behind a terminal status forever.
    await withOrgContext(org.orgId, () => db.execute(sql`
      update payment_instructions
         set status = 'sent', updated_at = now(), updated_by = ${actorId}
       where id = ${seeded.instructionIds[0]!} and org_id = ${org.orgId}
    `));
    await withOrgContext(org.orgId, () => recordPaymentSettlement({
      instructionId: seeded.instructionIds[0]!,
      orgId: org.orgId,
      userId: actorId,
      status: "returned",
      effectiveOn: org.date,
      returnCode: "R01",
      returnReason: "stranded pending instruction regression",
    }));
    const stranded = await withOrgContext(org.orgId, async () =>
      (await db.execute<{
        run_status: string;
        first_status: string;
        second_status: string;
        first_payment_status: string;
      }>(sql`
        select run.status as run_status,
               (select status from payment_instructions
                  where id = ${seeded.instructionIds[0]!}) as first_status,
               (select status from payment_instructions
                  where id = ${seeded.instructionIds[1]!}) as second_status,
               (select status from documents
                  where id = ${seeded.paymentDocumentIds[0]!}) as first_payment_status
          from payment_runs run
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(stranded, {
      run_status: "returned",
      first_status: "returned",
      second_status: "pending",
      first_payment_status: "voided",
    });

    // Posting resumes exactly the outstanding work: the returned instruction
    // is never touched again, and its sibling finally reaches `sent`.
    const outcome = await withOrgContext(org.orgId, () =>
      postPaymentRun(seeded.runId, org.orgId, actorId));
    assert.deepEqual(outcome, { posted: 1, failures: [] });

    const final = await withOrgContext(org.orgId, async () =>
      (await db.execute<{
        run_status: string;
        first_status: string;
        second_status: string;
        second_payment_status: string;
        started: number;
        completed: number;
        failed: number;
        sent_events: number;
        claim_token: boolean;
      }>(sql`
        select run.status as run_status,
               (select status from payment_instructions
                  where id = ${seeded.instructionIds[0]!}) as first_status,
               (select status from payment_instructions
                  where id = ${seeded.instructionIds[1]!}) as second_status,
               (select status from documents
                  where id = ${seeded.paymentDocumentIds[1]!}) as second_payment_status,
               (select count(*)::int from payment_events event
                  where event.payment_run_id = run.id and event.org_id = run.org_id
                    and event.event_type = 'run_posting_started') as started,
               (select count(*)::int from payment_events event
                  where event.payment_run_id = run.id and event.org_id = run.org_id
                    and event.event_type = 'run_posting_completed') as completed,
               (select count(*)::int from payment_events event
                  where event.payment_run_id = run.id and event.org_id = run.org_id
                    and event.event_type = 'run_posting_failed') as failed,
               (select count(*)::int from payment_events event
                  where event.payment_run_id = run.id and event.org_id = run.org_id
                    and event.event_type = 'instruction_sent') as sent_events,
               run.posting_claim_token is not null as claim_token
          from payment_runs run
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(final, {
      // Completing the remainder does not rebrand a run that carries a bank
      // return as fully confirmed: the aggregate marker survives.
      run_status: "returned",
      first_status: "returned",
      second_status: "sent",
      second_payment_status: "posted",
      started: 1,
      completed: 1,
      failed: 0,
      sent_events: 1,
      claim_token: false,
    });

    // With nothing left pending the terminal door closes again.
    await assert.rejects(
      withOrgContext(org.orgId, () => postPaymentRun(seeded.runId, org.orgId, actorId)),
      (error: unknown) => {
        assert.ok(error instanceof PaymentError);
        assert.match(error.message, /run is already posted/);
        return true;
      },
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a recovered stale posting claim resumes the run without double-posting", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Crash recovery", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId, 2));

    // Simulate a crashed poster: it claimed the run, committed the first
    // instruction as sent under its then-live claim, then died without
    // completing or releasing. The lease has made no progress for far longer
    // than the staleness window.
    const crashedToken = await installPostingClaim(org, seeded.runId, actorId, sql`now() - interval '20 minutes'`);
    await withPostingClaim(org, seeded.runId, crashedToken, (tx) => tx.execute(sql`
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

test("concurrent payment-file reprocessing cannot clobber an in-flight posting or its terminal result", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  let releaseSecondInstruction!: () => void;
  const secondInstructionReleased = new Promise<void>((resolve) => { releaseSecondInstruction = resolve; });
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Reprocess racer", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId, 2));
    let signalLocked!: () => void;
    const secondInstructionLocked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const blocker = withOrgContext(org.orgId, () => db.transaction(async (tx) => {
      // Parking the poster on the second instruction's row lock holds the run
      // mid-flight (`processing`, one instruction sent) so the reprocess
      // attempts land in a real causal window without starving any reader.
      await tx.execute(sql`
        select id from payment_instructions
         where id = ${seeded.instructionIds[1]!} and org_id = ${org.orgId}
         for update
      `);
      signalLocked();
      await secondInstructionReleased;
    }));
    await secondInstructionLocked;

    const poster = withOrgContext(org.orgId, () =>
      postPaymentRun(seeded.runId, org.orgId, actorId));
    await waitForState(async () =>
      withOrgContext(org.orgId, async () =>
        (await db.execute<{
          run_status: string;
          first_status: string;
          second_status: string;
        }>(sql`
          select run.status as run_status,
                 (select status from payment_instructions where id = ${seeded.instructionIds[0]!}) as first_status,
                 (select status from payment_instructions where id = ${seeded.instructionIds[1]!}) as second_status
            from payment_runs run
           where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
        `)).rows[0]), {
      run_status: "processing",
      first_status: "sent",
      second_status: "pending",
    });

    // Both reprocessing entry points refuse while a posting claim owns the
    // lifecycle: neither may drag the run back to `generated` mid-posting.
    await assert.rejects(
      withOrgContext(org.orgId, () => generatePaymentFileArtifact(seeded.runId, org.orgId, actorId)),
      (error: unknown) => {
        assert.ok(error instanceof PaymentError);
        assert.match(error.message, /approve the payment run before generating its file/);
        return true;
      },
    );
    await assert.rejects(
      withOrgContext(org.orgId, () => generatePaymentFileArtifact(seeded.runId, org.orgId, actorId, { reprocessFileId: randomUUID() })),
      (error: unknown) => {
        assert.ok(error instanceof PaymentError);
        assert.match(error.message, /approve the payment run before generating its file/);
        return true;
      },
    );
    const duringPosting = await withOrgContext(org.orgId, async () =>
      (await db.execute<{ run_status: string; artifacts: number }>(sql`
        select run.status as run_status,
               (select count(*)::int from payment_files f
                 where f.payment_run_id = run.id and f.org_id = run.org_id) as artifacts
          from payment_runs run
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(duringPosting, { run_status: "processing", artifacts: 0 });

    releaseSecondInstruction();
    await blocker;
    const outcome = await poster;
    assert.deepEqual(outcome, { posted: 2, failures: [] });

    // The terminal result stands and no artifact was written behind it.
    const final = await withOrgContext(org.orgId, async () =>
      (await db.execute<{
        run_status: string;
        claim_token: boolean;
        artifacts: number;
        file_events: number;
        completed: number;
      }>(sql`
        select run.status as run_status,
               run.posting_claim_token is not null as claim_token,
               (select count(*)::int from payment_files f
                 where f.payment_run_id = run.id and f.org_id = run.org_id) as artifacts,
               (select count(*)::int from payment_events e
                 where e.payment_run_id = run.id and e.org_id = run.org_id
                   and e.event_type in ('file_generated', 'file_reprocessed')) as file_events,
               (select count(*)::int from payment_events e
                 where e.payment_run_id = run.id and e.org_id = run.org_id
                   and e.event_type = 'run_posting_completed') as completed
          from payment_runs run
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(final, {
      run_status: "confirmed",
      claim_token: false,
      artifacts: 0,
      file_events: 0,
      completed: 1,
    });
  } finally {
    releaseSecondInstruction?.();
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("payment-file reprocessing cannot drag a settled or returned run out of its terminal state", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Terminal guard", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId));
    await withOrgContext(org.orgId, () => postPaymentRun(seeded.runId, org.orgId, actorId));

    // The bank confirms settlement: another lifecycle path has preserved the
    // instruction and driven the run into its terminal `settled` state.
    await withOrgContext(org.orgId, () => recordPaymentSettlement({
      instructionId: seeded.instructionId,
      orgId: org.orgId,
      userId: actorId,
      status: "settled",
      effectiveOn: org.date,
      bankReference: "BANK-SETTLE-1",
    }));
    const expectGenerationRefused = (attempt: Promise<unknown>) =>
      assert.rejects(attempt, (error: unknown) => {
        assert.ok(error instanceof PaymentError);
        assert.match(error.message, /approve the payment run before generating its file/);
        return true;
      });
    const terminalState = async () => withOrgContext(org.orgId, async () =>
      (await db.execute<{ run_status: string; artifacts: number }>(sql`
        select run.status as run_status,
               (select count(*)::int from payment_files f
                 where f.payment_run_id = run.id and f.org_id = run.org_id) as artifacts
          from payment_runs run
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);

    await expectGenerationRefused(withOrgContext(org.orgId, () =>
      generatePaymentFileArtifact(seeded.runId, org.orgId, actorId)));
    await expectGenerationRefused(withOrgContext(org.orgId, () =>
      generatePaymentFileArtifact(seeded.runId, org.orgId, actorId, { reprocessFileId: randomUUID() })));
    assert.deepEqual(await terminalState(), { run_status: "settled", artifacts: 0 });

    // A late bank return moves the run to its other terminal state; the same
    // refusals hold there and nothing regresses.
    await withOrgContext(org.orgId, () => recordPaymentSettlement({
      instructionId: seeded.instructionId,
      orgId: org.orgId,
      userId: actorId,
      status: "returned",
      effectiveOn: org.date,
      returnCode: "R01",
      returnReason: "terminal-state regression coverage",
    }));
    await expectGenerationRefused(withOrgContext(org.orgId, () =>
      generatePaymentFileArtifact(seeded.runId, org.orgId, actorId, { reprocessFileId: randomUUID() })));
    assert.deepEqual(await terminalState(), { run_status: "returned", artifacts: 0 });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a partially failed run still accepts legitimate file regeneration and reprocessing lineage", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Regen operator", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId));
    // A prior posting attempt left the run retryable.
    await withOrgContext(org.orgId, () => db.execute(sql`
      update payment_runs set status = 'partially_failed', updated_by = ${actorId}
       where id = ${seeded.runId} and org_id = ${org.orgId}
    `));

    const first = await withOrgContext(org.orgId, () =>
      generatePaymentFileArtifact(seeded.runId, org.orgId, actorId));
    assert.match(first.filename, /\.csv$/);
    const firstState = await withOrgContext(org.orgId, async () =>
      (await db.execute<{ run_status: string; file_status: string; sequence: number }>(sql`
        select run.status as run_status, f.status as file_status, f.sequence_number as sequence
          from payment_runs run join payment_files f
            on f.payment_run_id = run.id and f.org_id = run.org_id
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(firstState, { run_status: "generated", file_status: "approved", sequence: 1 });

    // Reprocessing supersedes the prior artifact and keeps the run generable.
    const second = await withOrgContext(org.orgId, () =>
      generatePaymentFileArtifact(seeded.runId, org.orgId, actorId, { reprocessFileId: first.id }));
    assert.notEqual(second.id, first.id);
    const lineage = await withOrgContext(org.orgId, async () =>
      (await db.execute<{ statuses: string[]; sequences: number[]; parents: (string | null)[] }>(sql`
        select array_agg(status order by sequence_number) as statuses,
               array_agg(sequence_number order by sequence_number) as sequences,
               array_agg(parent_payment_file_id order by sequence_number) as parents
          from payment_files
         where payment_run_id = ${seeded.runId} and org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(lineage, {
      statuses: ["superseded", "approved"],
      sequences: [1, 2],
      parents: [null, first.id],
    });
  } finally {
    // The scratch-org teardown does not know about payment artifacts; drop
    // them under the same teardown grants (the append-only evidence guards
    // require the sandbox flag), evidence first.
    await withBypass(() => db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('openbooks.amend', 'on', true),
               set_config('openbooks.sandbox_wipe', 'on', true),
               set_config('app.bypass_rls', 'on', true)`);
      await tx.execute(sql`update orgs set env_kind = 'sandbox' where id = ${org.orgId} and name like 'Scratch %'`);
      await tx.execute(sql`delete from payment_events where org_id = ${org.orgId} and payment_file_id is not null`);
      await tx.execute(sql`delete from payment_files where org_id = ${org.orgId}`);
    }));
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("cancellation judges the run under its row lock, not the caller's stale read", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  let releaseHolder!: (() => void) | undefined;
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Cancel racer", "admin"));
    const seeded = await withOrgContext(org.orgId, () => seedPostingClaimRun(org, actorId, 2));
    // The caller's preflight sees a cancellable draft whose payments are
    // still drafts — nothing but the lifecycle gate itself may stop it. The
    // wire-fixture payments are demoted to plain draft documents (their
    // posting evidence removed under the amend kernel bypass) so every child
    // mutation a stale cancellation attempts is actually available to it.
    await withOrgContext(org.orgId, () => db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('openbooks.amend', 'on', true),
               set_config('app.bypass_rls', 'on', true)`);
      await tx.execute(sql`
        update documents set status = 'draft', posted_entry_id = null
         where org_id = ${org.orgId}
           and id in (select payment_document_id from payment_instructions
                      where payment_run_id = ${seeded.runId} and org_id = ${org.orgId})
      `);
      await tx.execute(sql`
        delete from journal_lines
         where org_id = ${org.orgId}
           and entry_id in (
             select id from journal_entries
              where org_id = ${org.orgId}
                and source_document_id in (
                  select payment_document_id from payment_instructions
                   where payment_run_id = ${seeded.runId} and org_id = ${org.orgId}
                )
           )
      `);
      await tx.execute(sql`
        delete from journal_entries
         where org_id = ${org.orgId}
           and source_document_id in (
             select payment_document_id from payment_instructions
              where payment_run_id = ${seeded.runId} and org_id = ${org.orgId}
           )
      `);
    }));
    await withOrgContext(org.orgId, () => db.execute(sql`
      update payment_runs set status = 'draft', updated_by = ${actorId}
       where id = ${seeded.runId} and org_id = ${org.orgId}
    `));

    let signalLocked!: (pid: number) => void;
    const runRowLocked = new Promise<number>((resolve) => { signalLocked = resolve; });
    const raceObserved = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withOrgContext(org.orgId, () => db.transaction(async (tx) => {
      const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
      await tx.execute(sql`
        select id from payment_runs
         where id = ${seeded.runId} and org_id = ${org.orgId}
         for update
      `);
      signalLocked(pid.rows[0]!.pid);
      await raceObserved;
      // While the cancellation is fenced out on the row lock, another
      // lifecycle path installs a non-cancellable state — exactly the
      // overwrite window this control owns.
      await tx.execute(sql`
        update payment_runs set status = 'generated', updated_at = now(), updated_by = ${actorId}
         where id = ${seeded.runId} and org_id = ${org.orgId}
      `);
    }));
    const holderPid = await runRowLocked;

    const cancellation = withOrgContext(org.orgId, () => cancelPaymentRun(seeded.runId, org.orgId));
    // The cancellation must contend on the run row before mutating anything.
    await waitForBlockedBy(holderPid);
    releaseHolder?.();
    await holder;

    await assert.rejects(cancellation, (error: unknown) => {
      assert.ok(error instanceof PaymentError);
      assert.match(error.message, /cannot be cancelled/);
      return true;
    });
    const final = await withOrgContext(org.orgId, async () =>
      (await db.execute<{ run_status: string; pending: number; documents: number }>(sql`
        select run.status as run_status,
               (select count(*)::int from payment_instructions i
                 where i.payment_run_id = run.id and i.org_id = run.org_id
                   and i.status = 'pending') as pending,
               (select count(*)::int from documents d
                where d.id in (
                  select i.payment_document_id from payment_instructions i
                   where i.payment_run_id = run.id and i.org_id = run.org_id
                )) as documents
          from payment_runs run
         where run.id = ${seeded.runId} and run.org_id = ${org.orgId}
      `)).rows[0]);
    assert.deepEqual(final, { run_status: "generated", pending: 2, documents: 2 });
  } finally {
    releaseHolder?.();
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

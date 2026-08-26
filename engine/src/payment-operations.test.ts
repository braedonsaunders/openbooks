import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "./db.ts";
import {
  decidePaymentFile,
  decidePaymentRun,
  generatePaymentFileArtifact,
  nachaOriginator,
  recordPaymentFileDownload,
  recordPaymentSettlement,
  rollbackPaymentRun,
  sepaOriginator,
} from "./payment-operations.ts";
import {
  createPaymentDocument,
  PaymentError,
  postPaymentWithApplications,
  sameCurrencyAllocation,
  updateDraftPayment,
} from "./payments.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const paymentOperationsSource = readFileSync(new URL("./payment-operations.ts", import.meta.url), "utf8");
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function postgresFailure(error: unknown): { code?: string; constraint?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code) return candidate;
    current = candidate.cause;
  }
  return null;
}

test("settlement upserts pin the known tenant on the payment_instruction_id conflict write", () => {
  assert.match(
    paymentOperationsSource,
    /insert into payment_settlements[\s\S]*?on conflict \(payment_instruction_id\) do update set[\s\S]*?where payment_settlements\.org_id = \$\{opts\.orgId\}/,
  );
});

test(
  "a failed bank-return settlement rolls its payment reversal back atomically",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Settlement operator", "admin"),
      );
      const seeded = await withOrgContext(org.orgId, async () => {
        const invoiceId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, subsidiary_id, party_id,
             document_date, currency, subtotal, tax_total, total, created_by)
          values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved',
                  ${`INV-RETURN-${invoiceId}`}, ${org.subsidiaryId}, ${org.customerId},
                  ${org.date}, 'CAD', '100', '0', '100', ${actorId})
        `);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, quantity, unit_price,
             amount, tax_amount, tax_input_amount)
          values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1',
                  '100', '100', '0', '100')
        `);
        const invoiceEntryId = await postDocument(invoiceId, {
          control: {
            ar: org.accounts.ar,
            ap: org.accounts.ap,
            bank: org.accounts.bank,
          },
        });
        const invoiceControl = await db.execute<{ id: string }>(sql`
          select id
            from journal_lines
           where entry_id = ${invoiceEntryId} and account_id = ${org.accounts.ar}
        `);

        const payment = await createPaymentDocument({
          orgId: org.orgId,
          kind: "customer_payment",
          createdBy: actorId,
          partyId: org.customerId,
          bankAccountId: org.accounts.bank,
          subsidiaryId: org.subsidiaryId,
          documentDate: org.date,
          currency: "CAD",
        });
        await updateDraftPayment(
          payment.id,
          {
            allocations: [sameCurrencyAllocation(invoiceControl.rows[0]!.id, "100")],
            bankAccountId: org.accounts.bank,
          },
          actorId,
          org.orgId,
        );
        await db.execute(sql`
          update documents
             set status = 'approved', submitted_by = ${actorId}, submitted_at = now()
           where id = ${payment.id} and org_id = ${org.orgId}
        `);
        const paymentPosting = await postPaymentWithApplications(
          payment.id,
          undefined,
          actorId,
          "ui",
          { deferEffects: true },
        );

        const runId = randomUUID();
        const instructionId = randomUUID();
        await db.execute(sql`
          insert into payment_runs
            (id, org_id, run_number, bank_account_id, subsidiary_id, method,
             direction, purpose, currency, status, payment_count, total_amount,
             created_by, updated_by)
          values (${runId}, ${org.orgId}, ${`RETURN-${runId}`},
                  ${org.accounts.bank}, ${org.subsidiaryId}, 'direct_debit',
                  'inbound', 'customer_collections', 'CAD', 'confirmed', 1,
                  '100', ${actorId}, ${actorId})
        `);
        await db.execute(sql`
          insert into payment_instructions
            (id, org_id, payment_run_id, payee_party_id, amount, currency,
             payment_document_id, status, created_by, updated_by)
          values (${instructionId}, ${org.orgId}, ${runId}, ${org.customerId},
                  '100', 'CAD', ${payment.id}, 'sent', ${actorId}, ${actorId})
        `);
        return {
          instructionId,
          paymentDocumentId: payment.id,
          paymentEntryId: paymentPosting.entryId,
          runId,
        };
      });

      // This missing bank-statement line is first referenced by the settlement
      // insert, after reversePaymentForReturn has voided the document and
      // created its correcting journal entry inside the same transaction.
      await assert.rejects(
        () =>
          recordPaymentSettlement({
            instructionId: seeded.instructionId,
            orgId: org.orgId,
            userId: actorId,
            status: "returned",
            effectiveOn: org.date,
            bankStatementLineId: randomUUID(),
            returnCode: "NSF",
            returnReason: "Insufficient funds",
          }),
        (error: unknown) => {
          const failure = postgresFailure(error);
          assert.equal(failure?.code, "23503");
          assert.equal(
            failure?.constraint,
            "payment_settlements_bank_statement_line_id_fkey",
          );
          return true;
        },
      );

      const state = await withOrgContext(org.orgId, async () =>
        db.execute<{
          document_status: string;
          document_reversal_entry_id: string | null;
          void_requested: boolean;
          payment_entry_status: string;
          reversal_entries: number;
          live_applications: number;
          unapplied_applications: number;
          instruction_status: string;
          settlements: number;
          run_status: string;
          events: number;
        }>(sql`
          select
            (select status from documents where id = ${seeded.paymentDocumentId}) as document_status,
            (select reversal_entry_id from documents where id = ${seeded.paymentDocumentId}) as document_reversal_entry_id,
            (select void_requested_at is not null from documents where id = ${seeded.paymentDocumentId}) as void_requested,
            (select status from journal_entries where id = ${seeded.paymentEntryId}) as payment_entry_status,
            (select count(*)::int from journal_entries where reverses_entry_id = ${seeded.paymentEntryId}) as reversal_entries,
            (select count(*)::int
               from applications
              where org_id = ${org.orgId}
                and from_line_id in (
                  select id from journal_lines where entry_id = ${seeded.paymentEntryId}
                )
                and unapplied_at is null) as live_applications,
            (select count(*)::int
               from applications
              where org_id = ${org.orgId}
                and from_line_id in (
                  select id from journal_lines where entry_id = ${seeded.paymentEntryId}
                )
                and unapplied_at is not null) as unapplied_applications,
            (select status from payment_instructions where id = ${seeded.instructionId}) as instruction_status,
            (select count(*)::int from payment_settlements where payment_instruction_id = ${seeded.instructionId}) as settlements,
            (select status from payment_runs where id = ${seeded.runId}) as run_status,
            (select count(*)::int from payment_events where payment_instruction_id = ${seeded.instructionId}) as events
        `),
      );
      assert.deepEqual(state.rows[0], {
        document_status: "posted",
        document_reversal_entry_id: null,
        void_requested: false,
        payment_entry_status: "posted",
        reversal_entries: 0,
        live_applications: 1,
        unapplied_applications: 0,
        instruction_status: "sent",
        settlements: 0,
        run_status: "confirmed",
        events: 0,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test("built-in payment format upserts pin the known tenant on the org_id/code conflict write", () => {
  assert.match(
    paymentOperationsSource,
    /insert into payment_formats[\s\S]*?on conflict \(org_id, code\) do update set[\s\S]*?where payment_formats\.org_id = \$\{orgId\}/,
  );
});

test("payment approval fails closed when the maker is not identified", () => {
  assert.match(
    paymentOperationsSource,
    /if \(makerId === null\) throw new PaymentError\(`\$\{subject\} approval requires an identified \$\{maker\}`\)/,
  );
  // Runs: a null submitter is a system submission (the payment scheduler) —
  // its maker is the system itself, so the approval predicate lets any
  // authenticated human through and the self-approval guard below rejects only
  // a submitter approving their own run. Files still require an identified
  // human maker: a system-generated file cannot be approved.
  assert.match(
    paymentOperationsSource,
    /submitted_by is null\s+or submitted_by <> \$\{userId\}/,
  );
  assert.match(
    paymentOperationsSource,
    /the payment run submitter cannot approve the same run/,
  );
  assert.match(
    paymentOperationsSource,
    /generated_by is not null and generated_by <> \$\{userId\}/,
  );
});

test("artifact generation re-judges the run lifecycle under a row lock inside the tenant transaction", () => {
  // loadFormatContext reads outside any transaction, so the pre-render status
  // check is advisory only. The committed state must be re-judged under the
  // run's row lock before any artifact row is written.
  const gate = paymentOperationsSource.match(
    /select status from payment_runs[\s\S]*?status in \('approved', 'generated', 'delivered', 'partially_failed'\)[\s\S]*?for update/,
  );
  assert.ok(gate, "generation must gate on select ... for update over generable statuses");
});

test("the generated-file transition cannot resurrect a run that left the generable states", () => {
  assert.match(
    paymentOperationsSource,
    /update payment_runs set status = 'generated'[\s\S]*?and status in \('approved', 'generated', 'delivered', 'partially_failed'\)\s*returning status/,
  );
});

test("delivery recording refuses a file that is no longer approved at write time", () => {
  const statements = paymentOperationsSource.match(
    /update payment_files set status = 'delivered'[\s\S]*?returning id/g,
  ) ?? [];
  assert.equal(statements.length, 2, "download and sftp delivery must both use guarded updates");
  for (const statement of statements) {
    assert.match(statement, /status in \('approved', 'delivered'\)/);
  }
});

async function seedPaymentRun(
  org: ScratchOrg,
  submitterId: string,
  opts?: {
    profileId?: string;
    status?: "pending_approval" | "generated";
    approvedBy?: string;
  },
): Promise<string> {
  const runId = randomUUID();
  const status = opts?.status ?? "pending_approval";
  await db.execute(sql`
    insert into payment_runs
      (id, org_id, run_number, bank_account_id, payment_bank_profile_id, method,
       currency, status, payment_count, total_amount, submitted_at, submitted_by,
       approved_at, approved_by, created_by, updated_by)
    values
      (${runId}, ${org.orgId}, ${`RUN-${runId.slice(0, 8)}`}, ${org.accounts.bank},
       ${opts?.profileId ?? null}, 'wire', 'CAD', ${status}, 1, '25', now(),
       ${submitterId}, ${opts?.approvedBy ? sql`now()` : null}, ${opts?.approvedBy ?? null},
       ${submitterId}, ${submitterId})
  `);
  return runId;
}

async function seedPendingPaymentFile(
  org: ScratchOrg,
  generatorId: string,
  runApproverId: string,
  opts?: { generatedBy?: string | null },
): Promise<{ fileId: string; runId: string }> {
  const formatId = randomUUID();
  const profileId = randomUUID();
  const folderId = randomUUID();
  const storedFileId = randomUUID();
  const versionId = randomUUID();
  const fileId = randomUUID();
  const hash = "0".repeat(64);
  const generatedBy = opts?.generatedBy === undefined ? generatorId : opts.generatedBy;

  await db.execute(sql`
    insert into payment_formats
      (id, org_id, code, name, rail, direction, file_extension, content_type,
       created_by, updated_by)
    values
      (${formatId}, ${org.orgId}, ${`TEST-${formatId.slice(0, 8)}`}, 'Test wire',
       'wire', 'credit', 'txt', 'text/plain', ${generatorId}, ${generatorId})
  `);
  await db.execute(sql`
    insert into payment_bank_profiles
      (id, org_id, name, bank_account_id, payment_format_id, currency,
       require_run_approval, require_file_approval, created_by, updated_by)
    values
      (${profileId}, ${org.orgId}, ${`Approval test profile ${profileId}`}, ${org.accounts.bank},
       ${formatId}, 'CAD', true, true, ${generatorId}, ${generatorId})
  `);
  const runId = await seedPaymentRun(org, generatorId, {
    profileId,
    status: "generated",
    approvedBy: runApproverId,
  });
  await db.execute(sql`
    insert into folders (id, org_id, name, created_by, updated_by)
    values (${folderId}, ${org.orgId}, 'Payment approval test', ${generatorId}, ${generatorId})
  `);
  await db.execute(sql`
    insert into files
      (id, org_id, folder_id, name, extension, file_type, content_type, size_bytes,
       storage_kind, content_hash, created_by, updated_by)
    values
      (${storedFileId}, ${org.orgId}, ${folderId}, 'payment-test.txt', 'txt', 'other',
       'text/plain', 4, 'db', ${hash}, ${generatorId}, ${generatorId})
  `);
  await db.execute(sql`
    insert into file_versions
      (id, file_id, version_number, size_bytes, content_type, storage_kind,
       content_hash, created_by)
    values (${versionId}, ${storedFileId}, 1, 4, 'text/plain', 'db', ${hash}, ${generatorId})
  `);
  await db.execute(sql`
    update files set current_version_id = ${versionId}
     where id = ${storedFileId} and org_id = ${org.orgId}
  `);
  await db.execute(sql`
    insert into payment_files
      (id, org_id, payment_run_id, payment_bank_profile_id, payment_format_id,
       sequence_number, filename, content_type, content_hash, file_id,
       file_version_id, payment_count, total_amount, currency, status,
       generated_by, created_by, updated_by)
    values
      (${fileId}, ${org.orgId}, ${runId}, ${profileId}, ${formatId}, 1,
       'payment-test.txt', 'text/plain', ${hash}, ${storedFileId}, ${versionId},
       1, '25', 'CAD', 'pending_approval', ${generatedBy},
       ${generatorId}, ${generatorId})
  `);
  return { fileId, runId };
}

async function removePaymentFileFixture(orgId: string, fileId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId}`);
    await tx.execute(sql`
      select set_config('openbooks.sandbox_wipe', 'on', true),
             set_config('app.bypass_rls', 'on', true)
    `);
    await tx.execute(sql`
      delete from payment_events
       where org_id = ${orgId} and payment_file_id = ${fileId}
    `);
    await tx.execute(sql`
      delete from payment_files
       where org_id = ${orgId} and id = ${fileId}
    `);
  });
}

/**
 * Seed an approved run on an active wire-format profile with no instructions:
 * the minimal shape `generatePaymentFileArtifact` accepts (the generic
 * register renders fine with zero payments).
 */
async function seedGeneratableRun(org: ScratchOrg, actorId: string): Promise<string> {
  const formatId = randomUUID();
  const profileId = randomUUID();
  await db.execute(sql`
    insert into payment_formats
      (id, org_id, code, name, rail, direction, file_extension, content_type,
       created_by, updated_by)
    values
      (${formatId}, ${org.orgId}, ${`GEN-${formatId.slice(0, 8)}`}, 'Generation test wire',
       'wire', 'credit', 'txt', 'text/plain', ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into payment_bank_profiles
      (id, org_id, name, bank_account_id, payment_format_id, currency,
       require_run_approval, require_file_approval, created_by, updated_by)
    values
      (${profileId}, ${org.orgId}, ${`Generation test profile ${profileId}`}, ${org.accounts.bank},
       ${formatId}, 'CAD', false, false, ${actorId}, ${actorId})
  `);
  const runId = randomUUID();
  await db.execute(sql`
    insert into payment_runs
      (id, org_id, run_number, bank_account_id, payment_bank_profile_id, method,
       currency, status, payment_count, total_amount, created_by, updated_by)
    values
      (${runId}, ${org.orgId}, ${`GEN-${runId.slice(0, 8)}`}, ${org.accounts.bank},
       ${profileId}, 'wire', 'CAD', 'approved', 1, '25', ${actorId}, ${actorId})
  `);
  return runId;
}

interface GenerationOutcomeSnapshot {
  [key: string]: unknown;
  live_files: number;
  generated_events: number;
  run_status: string;
}

async function generationOutcomeSnapshot(
  orgId: string,
  runId: string,
): Promise<GenerationOutcomeSnapshot | undefined> {
  return (await db.execute<GenerationOutcomeSnapshot>(sql`
    select (select count(*)::int from payment_files pf
             where pf.payment_run_id = ${runId} and pf.org_id = ${orgId}
               and pf.status not in ('superseded', 'voided', 'rejected')) as live_files,
           (select count(*)::int from payment_events e
              where e.payment_run_id = ${runId} and e.org_id = ${orgId}
                and e.event_type = 'file_generated') as generated_events,
           (select status from payment_runs r
             where r.id = ${runId} and r.org_id = ${orgId}) as run_status
  `)).rows[0];
}

interface PaymentDecisionAuditSnapshot {
  [key: string]: unknown;
  status: string;
  maker_at: Date;
  maker_by: string | null;
  approved_at: Date | null;
  approved_by: string | null;
  rejected_at: Date | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  created_at: Date;
  created_by: string | null;
  updated_at: Date;
  updated_by: string | null;
  event_count: number;
}

async function paymentRunDecisionAuditSnapshot(
  orgId: string,
  runId: string,
): Promise<PaymentDecisionAuditSnapshot | undefined> {
  return (await db.execute<PaymentDecisionAuditSnapshot>(sql`
    select r.status, r.submitted_at as maker_at, r.submitted_by as maker_by,
           r.approved_at, r.approved_by, r.rejected_at, r.rejected_by,
           r.rejection_reason, r.created_at, r.created_by, r.updated_at, r.updated_by,
           (select count(*)::int from payment_events e
             where e.payment_run_id = r.id and e.org_id = r.org_id) as event_count
      from payment_runs r
     where r.id = ${runId} and r.org_id = ${orgId}
  `)).rows[0];
}

async function paymentFileDecisionAuditSnapshot(
  orgId: string,
  fileId: string,
): Promise<PaymentDecisionAuditSnapshot | undefined> {
  return (await db.execute<PaymentDecisionAuditSnapshot>(sql`
    select pf.status, pf.generated_at as maker_at, pf.generated_by as maker_by,
           pf.approved_at, pf.approved_by, pf.rejected_at, pf.rejected_by,
           pf.rejection_reason, pf.created_at, pf.created_by, pf.updated_at, pf.updated_by,
           (select count(*)::int from payment_events e
             where e.payment_file_id = pf.id and e.org_id = pf.org_id) as event_count
      from payment_files pf
     where pf.id = ${fileId} and pf.org_id = ${orgId}
  `)).rows[0];
}

test(
  "payment run decisions enforce maker-checker and record canonical decision events",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const submitterId = await withBypass(() =>
        createScratchUser(org.orgId, "Payment Run Submitter", "payment_run_submitter"),
      );
      const approverId = await withBypass(() =>
        createScratchUser(org.orgId, "Payment Run Approver", "payment_run_approver"),
      );
      const runId = await withOrgContext(org.orgId, () => seedPaymentRun(org, submitterId));
      const rejectedRunId = await withOrgContext(org.orgId, () =>
        seedPaymentRun(org, submitterId),
      );
      const unidentifiedRunId = await withOrgContext(org.orgId, async () => {
        const id = await seedPaymentRun(org, submitterId);
        await db.execute(sql`
          update payment_runs set submitted_by = null
           where id = ${id} and org_id = ${org.orgId}
        `);
        return id;
      });

      const beforeSelfAttempt = await withOrgContext(org.orgId, () =>
        paymentRunDecisionAuditSnapshot(org.orgId, runId),
      );
      assert.equal(beforeSelfAttempt?.event_count, 0);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          decidePaymentRun(runId, org.orgId, submitterId, "approve"),
        ),
        (error: Error) =>
          error instanceof PaymentError
          && error.message === "the payment run submitter cannot approve the same run",
      );
      const afterSelfAttempt = await withOrgContext(org.orgId, () =>
        paymentRunDecisionAuditSnapshot(org.orgId, runId),
      );
      assert.deepEqual(afterSelfAttempt, beforeSelfAttempt);

      const beforeMissingSubmitterAttempt = await withOrgContext(org.orgId, () =>
        paymentRunDecisionAuditSnapshot(org.orgId, unidentifiedRunId),
      );
      assert.ok(beforeMissingSubmitterAttempt);
      assert.equal(beforeMissingSubmitterAttempt.maker_by, null);
      // A null submitter is a system submission (the payment scheduler): the
      // maker is the system itself, so any authenticated human is an
      // independent checker and the approval succeeds.
      await withOrgContext(org.orgId, () =>
        decidePaymentRun(unidentifiedRunId, org.orgId, approverId, "approve"),
      );
      const afterSystemSubmissionApproval = await withOrgContext(org.orgId, () =>
        paymentRunDecisionAuditSnapshot(org.orgId, unidentifiedRunId),
      );
      assert.equal(afterSystemSubmissionApproval?.status, "approved");
      assert.equal(afterSystemSubmissionApproval?.maker_by, null);
      assert.equal(afterSystemSubmissionApproval?.event_count, 1);

      await withOrgContext(org.orgId, () =>
        decidePaymentRun(runId, org.orgId, approverId, "approve"),
      );
      const afterIndependentApproval = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          status: string;
          approved_by: string | null;
          approved_at: boolean;
          approval_events: number;
          event_actor_id: string | null;
        }>(sql`
          select r.status, r.approved_by, r.approved_at is not null as approved_at,
                 (select count(*)::int from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_approved') as approval_events,
                 (select e.actor_id from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_approved'
                   order by e.created_at desc limit 1) as event_actor_id
            from payment_runs r
           where r.id = ${runId} and r.org_id = ${org.orgId}
        `)).rows[0]
      );
      assert.deepEqual(afterIndependentApproval, {
        status: "approved",
        approved_by: approverId,
        approved_at: true,
        approval_events: 1,
        event_actor_id: approverId,
      });

      const rejectionReason = "duplicate payment batch";
      await withOrgContext(org.orgId, () =>
        decidePaymentRun(rejectedRunId, org.orgId, approverId, "reject", rejectionReason),
      );
      const afterIndependentRejection = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          status: string;
          rejected_by: string | null;
          rejected_at: boolean;
          rejection_reason: string | null;
          rejection_events: number;
          malformed_rejection_events: number;
          event_actor_id: string | null;
          event_from_status: string | null;
          event_to_status: string | null;
          event_reason: string | null;
        }>(sql`
          select r.status, r.rejected_by, r.rejected_at is not null as rejected_at,
                 r.rejection_reason,
                 (select count(*)::int from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejected') as rejection_events,
                 (select count(*)::int from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejectd') as malformed_rejection_events,
                 (select e.actor_id from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejected'
                   order by e.created_at desc limit 1) as event_actor_id,
                 (select e.from_status from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejected'
                   order by e.created_at desc limit 1) as event_from_status,
                 (select e.to_status from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejected'
                   order by e.created_at desc limit 1) as event_to_status,
                 (select e.details ->> 'reason' from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejected'
                   order by e.created_at desc limit 1) as event_reason
            from payment_runs r
           where r.id = ${rejectedRunId} and r.org_id = ${org.orgId}
        `)).rows[0]
      );
      assert.deepEqual(afterIndependentRejection, {
        status: "rejected",
        rejected_by: approverId,
        rejected_at: true,
        rejection_reason: rejectionReason,
        rejection_events: 1,
        malformed_rejection_events: 0,
        event_actor_id: approverId,
        event_from_status: "pending_approval",
        event_to_status: "rejected",
        event_reason: rejectionReason,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "payment file decisions enforce maker-checker and record canonical decision events",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const fileIds: string[] = [];
    try {
      const generatorId = await withBypass(() =>
        createScratchUser(org.orgId, "Payment File Generator", "payment_file_generator"),
      );
      const approverId = await withBypass(() =>
        createScratchUser(org.orgId, "Payment File Approver", "payment_file_approver"),
      );
      const seeded = await withOrgContext(org.orgId, () =>
        seedPendingPaymentFile(org, generatorId, approverId),
      );
      fileIds.push(seeded.fileId);
      const rejected = await withOrgContext(org.orgId, () =>
        seedPendingPaymentFile(org, generatorId, approverId),
      );
      fileIds.push(rejected.fileId);
      const unidentified = await withOrgContext(org.orgId, () =>
        seedPendingPaymentFile(org, generatorId, approverId, { generatedBy: null }),
      );
      fileIds.push(unidentified.fileId);

      const beforeSelfAttempt = await withOrgContext(org.orgId, () =>
        paymentFileDecisionAuditSnapshot(org.orgId, seeded.fileId),
      );
      assert.equal(beforeSelfAttempt?.event_count, 0);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          decidePaymentFile(seeded.fileId, org.orgId, generatorId, "approve"),
        ),
        (error: Error) =>
          error instanceof PaymentError
          && error.message === "the payment file generator cannot approve the same file",
      );
      const afterSelfAttempt = await withOrgContext(org.orgId, () =>
        paymentFileDecisionAuditSnapshot(org.orgId, seeded.fileId),
      );
      assert.deepEqual(afterSelfAttempt, beforeSelfAttempt);

      const beforeMissingGeneratorAttempt = await withOrgContext(org.orgId, () =>
        paymentFileDecisionAuditSnapshot(org.orgId, unidentified.fileId),
      );
      assert.ok(beforeMissingGeneratorAttempt);
      assert.equal(beforeMissingGeneratorAttempt.maker_by, null);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          decidePaymentFile(unidentified.fileId, org.orgId, approverId, "approve"),
        ),
        (error: Error) =>
          error instanceof PaymentError
          && error.message === "payment file approval requires an identified generator",
      );
      // Same causal contract as the run: the named refusal leaves every
      // column — including updated_at/updated_by — exactly as it found them,
      // and writes no event.
      const afterMissingGeneratorAttempt = await withOrgContext(org.orgId, () =>
        paymentFileDecisionAuditSnapshot(org.orgId, unidentified.fileId),
      );
      assert.deepEqual(afterMissingGeneratorAttempt, beforeMissingGeneratorAttempt);

      await withOrgContext(org.orgId, () =>
        decidePaymentFile(seeded.fileId, org.orgId, approverId, "approve"),
      );
      const afterIndependentApproval = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          status: string;
          approved_by: string | null;
          approved_at: boolean;
          approval_events: number;
          event_actor_id: string | null;
          event_run_id: string | null;
        }>(sql`
          select pf.status, pf.approved_by, pf.approved_at is not null as approved_at,
                 (select count(*)::int from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_approved') as approval_events,
                 (select e.actor_id from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_approved'
                   order by e.created_at desc limit 1) as event_actor_id,
                 (select e.payment_run_id from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_approved'
                   order by e.created_at desc limit 1) as event_run_id
            from payment_files pf
           where pf.id = ${seeded.fileId} and pf.org_id = ${org.orgId}
        `)).rows[0]
      );
      assert.deepEqual(afterIndependentApproval, {
        status: "approved",
        approved_by: approverId,
        approved_at: true,
        approval_events: 1,
        event_actor_id: approverId,
        event_run_id: seeded.runId,
      });

      const rejectionReason = "incorrect beneficiary details";
      await withOrgContext(org.orgId, () =>
        decidePaymentFile(rejected.fileId, org.orgId, approverId, "reject", rejectionReason),
      );
      const afterIndependentRejection = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          status: string;
          rejected_by: string | null;
          rejected_at: boolean;
          rejection_reason: string | null;
          rejection_events: number;
          malformed_rejection_events: number;
          event_actor_id: string | null;
          event_run_id: string | null;
          event_from_status: string | null;
          event_to_status: string | null;
          event_reason: string | null;
        }>(sql`
          select pf.status, pf.rejected_by, pf.rejected_at is not null as rejected_at,
                 pf.rejection_reason,
                 (select count(*)::int from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected') as rejection_events,
                 (select count(*)::int from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejectd') as malformed_rejection_events,
                 (select e.actor_id from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected'
                   order by e.created_at desc limit 1) as event_actor_id,
                 (select e.payment_run_id from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected'
                   order by e.created_at desc limit 1) as event_run_id,
                 (select e.from_status from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected'
                   order by e.created_at desc limit 1) as event_from_status,
                 (select e.to_status from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected'
                   order by e.created_at desc limit 1) as event_to_status,
                 (select e.details ->> 'reason' from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected'
                   order by e.created_at desc limit 1) as event_reason
            from payment_files pf
           where pf.id = ${rejected.fileId} and pf.org_id = ${org.orgId}
        `)).rows[0]
      );
      assert.deepEqual(afterIndependentRejection, {
        status: "rejected",
        rejected_by: approverId,
        rejected_at: true,
        rejection_reason: rejectionReason,
        rejection_events: 1,
        malformed_rejection_events: 0,
        event_actor_id: approverId,
        event_run_id: rejected.runId,
        event_from_status: "pending_approval",
        event_to_status: "rejected",
        event_reason: rejectionReason,
      });
    } finally {
      for (const fileId of fileIds) {
        await withBypass(() => removePaymentFileFixture(org.orgId, fileId));
      }
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a payment run decision whose evidence write fails rolls the whole decision back",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const submitterId = await withBypass(() =>
        createScratchUser(org.orgId, "Run Evidence Submitter", "payment_run_submitter"),
      );
      const approverId = await withBypass(() =>
        createScratchUser(org.orgId, "Run Evidence Approver", "payment_run_approver"),
      );
      const runId = await withOrgContext(org.orgId, () => seedPaymentRun(org, submitterId));
      // No users row identifies this approver. payment_runs pins no foreign
      // key on approved_by, so the decision UPDATE itself succeeds; the
      // approval then dies at the payment_events evidence insert
      // (actor_id -> users), which is sequenced strictly after the status
      // flip inside the same tenant transaction. The failure must carry the
      // status flip back with it: an approved run without its approval event
      // would be an unauditable transition.
      const unrecordedApproverId = randomUUID();
      const beforeFailedDecision = await withOrgContext(org.orgId, () =>
        paymentRunDecisionAuditSnapshot(org.orgId, runId),
      );
      assert.ok(beforeFailedDecision);
      assert.equal(beforeFailedDecision.event_count, 0);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          decidePaymentRun(runId, org.orgId, unrecordedApproverId, "approve"),
        ),
        (error: unknown) => {
          const failure = postgresFailure(error);
          assert.equal(failure?.code, "23503");
          assert.equal(failure?.constraint, "payment_events_actor_id_fkey");
          return true;
        },
      );
      const afterFailedDecision = await withOrgContext(org.orgId, () =>
        paymentRunDecisionAuditSnapshot(org.orgId, runId),
      );
      assert.deepEqual(afterFailedDecision, beforeFailedDecision);

      // The rolled-back decision left a decidable run: the identified,
      // independent approver can still approve it, and that success records
      // exactly one canonical approval event naming them.
      await withOrgContext(org.orgId, () =>
        decidePaymentRun(runId, org.orgId, approverId, "approve"),
      );
      const afterRecoveredApproval = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          status: string;
          approved_by: string | null;
          approved_at: boolean;
          approval_events: number;
          event_actor_id: string | null;
        }>(sql`
          select r.status, r.approved_by, r.approved_at is not null as approved_at,
                 (select count(*)::int from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_approved') as approval_events,
                 (select e.actor_id from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_approved'
                   order by e.created_at desc limit 1) as event_actor_id
            from payment_runs r
           where r.id = ${runId} and r.org_id = ${org.orgId}
        `)).rows[0]
      );
      assert.deepEqual(afterRecoveredApproval, {
        status: "approved",
        approved_by: approverId,
        approved_at: true,
        approval_events: 1,
        event_actor_id: approverId,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a rolled-back run cannot gain a bank-file artifact",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Generation Operator", "admin"),
      );
      const runId = await withOrgContext(org.orgId, () => seedGeneratableRun(org, actorId));
      await withOrgContext(org.orgId, () =>
        rollbackPaymentRun(runId, org.orgId, actorId, "duplicate submission"),
      );
      await assert.rejects(
        withOrgContext(org.orgId, () => generatePaymentFileArtifact(runId, org.orgId, actorId)),
        (error: Error) =>
          error instanceof PaymentError
          && error.message === "approve the payment run before generating its file",
      );
      assert.deepEqual(await withOrgContext(org.orgId, () => generationOutcomeSnapshot(org.orgId, runId)), {
        live_files: 0,
        generated_events: 0,
        run_status: "rolled_back",
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a payment file decision whose evidence write fails rolls the whole decision back",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const fileIds: string[] = [];
    try {
      const generatorId = await withBypass(() =>
        createScratchUser(org.orgId, "File Evidence Generator", "payment_file_generator"),
      );
      const approverId = await withBypass(() =>
        createScratchUser(org.orgId, "File Evidence Approver", "payment_file_approver"),
      );
      const seeded = await withOrgContext(org.orgId, () =>
        seedPendingPaymentFile(org, generatorId, approverId),
      );
      fileIds.push(seeded.fileId);
      // Same injection as the run rail: no users row identifies this
      // approver, payment_files pins no foreign key on its decision columns,
      // so only the payment_events evidence insert can fail — and the status
      // flip must not outlive it.
      const unrecordedApproverId = randomUUID();
      const beforeFailedDecision = await withOrgContext(org.orgId, () =>
        paymentFileDecisionAuditSnapshot(org.orgId, seeded.fileId),
      );
      assert.ok(beforeFailedDecision);
      assert.equal(beforeFailedDecision.event_count, 0);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          decidePaymentFile(seeded.fileId, org.orgId, unrecordedApproverId, "approve"),
        ),
        (error: unknown) => {
          const failure = postgresFailure(error);
          assert.equal(failure?.code, "23503");
          assert.equal(failure?.constraint, "payment_events_actor_id_fkey");
          return true;
        },
      );
      const afterFailedDecision = await withOrgContext(org.orgId, () =>
        paymentFileDecisionAuditSnapshot(org.orgId, seeded.fileId),
      );
      assert.deepEqual(afterFailedDecision, beforeFailedDecision);

      await withOrgContext(org.orgId, () =>
        decidePaymentFile(seeded.fileId, org.orgId, approverId, "approve"),
      );
      const afterRecoveredApproval = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          status: string;
          approved_by: string | null;
          approved_at: boolean;
          approval_events: number;
          event_actor_id: string | null;
        }>(sql`
          select pf.status, pf.approved_by, pf.approved_at is not null as approved_at,
                 (select count(*)::int from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_approved') as approval_events,
                 (select e.actor_id from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_approved'
                   order by e.created_at desc limit 1) as event_actor_id
            from payment_files pf
           where pf.id = ${seeded.fileId} and pf.org_id = ${org.orgId}
        `)).rows[0]
      );
      assert.deepEqual(afterRecoveredApproval, {
        status: "approved",
        approved_by: approverId,
        approved_at: true,
        approval_events: 1,
        event_actor_id: approverId,
      });
    } finally {
      for (const fileId of fileIds) {
        await withBypass(() => removePaymentFileFixture(org.orgId, fileId));
      }
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an identified submitter may reject their own pending run, and the rejection names them",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const submitterId = await withBypass(() =>
        createScratchUser(org.orgId, "Run Self Rejection Submitter", "payment_run_submitter"),
      );
      const runId = await withOrgContext(org.orgId, () => seedPaymentRun(org, submitterId));
      // The maker-checker guard exists to stop an artifact's maker moving it
      // FORWARD; refusing it is fail-safe and needs no second person. A
      // rejection that succeeds is still fully evidenced — it must record a
      // canonical run_rejected event carrying the maker's own identity.
      const reason = "selected the wrong bank account";
      await withOrgContext(org.orgId, () =>
        decidePaymentRun(runId, org.orgId, submitterId, "reject", reason),
      );
      const state = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          status: string;
          approved_by: string | null;
          rejected_by: string | null;
          rejected_at: boolean;
          rejection_reason: string | null;
          rejection_events: number;
          event_actor_id: string | null;
          event_from_status: string | null;
          event_to_status: string | null;
          event_reason: string | null;
        }>(sql`
          select r.status, r.approved_by, r.rejected_by,
                 r.rejected_at is not null as rejected_at, r.rejection_reason,
                 (select count(*)::int from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejected') as rejection_events,
                 (select e.actor_id from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejected'
                   order by e.created_at desc limit 1) as event_actor_id,
                 (select e.from_status from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejected'
                   order by e.created_at desc limit 1) as event_from_status,
                 (select e.to_status from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejected'
                   order by e.created_at desc limit 1) as event_to_status,
                 (select e.details ->> 'reason' from payment_events e
                   where e.payment_run_id = r.id and e.org_id = r.org_id
                     and e.event_type = 'run_rejected'
                   order by e.created_at desc limit 1) as event_reason
            from payment_runs r
           where r.id = ${runId} and r.org_id = ${org.orgId}
        `)).rows[0]
      );
      assert.deepEqual(state, {
        status: "rejected",
        approved_by: null,
        rejected_by: submitterId,
        rejected_at: true,
        rejection_reason: reason,
        rejection_events: 1,
        event_actor_id: submitterId,
        event_from_status: "pending_approval",
        event_to_status: "rejected",
        event_reason: reason,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an identified generator may reject their own pending file, and the rejection names them",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const fileIds: string[] = [];
    try {
      const generatorId = await withBypass(() =>
        createScratchUser(org.orgId, "File Self Rejection Generator", "payment_file_generator"),
      );
      const runApproverId = await withBypass(() =>
        createScratchUser(org.orgId, "File Self Rejection Run Approver", "payment_run_approver"),
      );
      const seeded = await withOrgContext(org.orgId, () =>
        seedPendingPaymentFile(org, generatorId, runApproverId),
      );
      fileIds.push(seeded.fileId);
      const reason = "beneficiary details changed after generation";
      await withOrgContext(org.orgId, () =>
        decidePaymentFile(seeded.fileId, org.orgId, generatorId, "reject", reason),
      );
      const state = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          status: string;
          approved_by: string | null;
          rejected_by: string | null;
          rejected_at: boolean;
          rejection_reason: string | null;
          rejection_events: number;
          event_actor_id: string | null;
          event_from_status: string | null;
          event_to_status: string | null;
          event_reason: string | null;
        }>(sql`
          select pf.status, pf.approved_by, pf.rejected_by,
                 pf.rejected_at is not null as rejected_at, pf.rejection_reason,
                 (select count(*)::int from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected') as rejection_events,
                 (select e.actor_id from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected'
                   order by e.created_at desc limit 1) as event_actor_id,
                 (select e.from_status from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected'
                   order by e.created_at desc limit 1) as event_from_status,
                 (select e.to_status from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected'
                   order by e.created_at desc limit 1) as event_to_status,
                 (select e.details ->> 'reason' from payment_events e
                   where e.payment_file_id = pf.id and e.org_id = pf.org_id
                     and e.event_type = 'file_rejected'
                   order by e.created_at desc limit 1) as event_reason
            from payment_files pf
           where pf.id = ${seeded.fileId} and pf.org_id = ${org.orgId}
        `)).rows[0]
      );
      assert.deepEqual(state, {
        status: "rejected",
        approved_by: null,
        rejected_by: generatorId,
        rejected_at: true,
        rejection_reason: reason,
        rejection_events: 1,
        event_actor_id: generatorId,
        event_from_status: "pending_approval",
        event_to_status: "rejected",
        event_reason: reason,
      });
    } finally {
      for (const fileId of fileIds) {
        await withBypass(() => removePaymentFileFixture(org.orgId, fileId));
      }
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "concurrent generation of one run yields exactly one live artifact",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    let artifactId: string | undefined;
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Concurrent Operator", "admin"),
      );
      const runId = await withOrgContext(org.orgId, () => seedGeneratableRun(org, actorId));
      const [first, second] = await withOrgContext(org.orgId, () =>
        Promise.all([
          generatePaymentFileArtifact(runId, org.orgId, actorId),
          generatePaymentFileArtifact(runId, org.orgId, actorId),
        ]),
      );
      assert.equal(first.id, second.id);
      artifactId = first.id;
      assert.equal(first.filename, second.filename);
      assert.deepEqual(await withOrgContext(org.orgId, () => generationOutcomeSnapshot(org.orgId, runId)), {
        live_files: 1,
        generated_events: 1,
        run_status: "generated",
      });
    } finally {
      if (artifactId) {
        const cleanupArtifactId = artifactId;
        await withBypass(() => removePaymentFileFixture(org.orgId, cleanupArtifactId));
      }
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "delivery recording fails closed when a rollback voided the file",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    let seeded: { fileId: string; runId: string } | undefined;
    try {
      const generatorId = await withBypass(() =>
        createScratchUser(org.orgId, "Voided Delivery Generator", "payment_file_generator"),
      );
      const approverId = await withBypass(() =>
        createScratchUser(org.orgId, "Voided Delivery Approver", "payment_file_approver"),
      );
      seeded = await withOrgContext(org.orgId, () =>
        seedPendingPaymentFile(org, generatorId, approverId),
      );
      const seededFileId = seeded.fileId;
      const seededRunId = seeded.runId;
      await withOrgContext(org.orgId, () =>
        decidePaymentFile(seededFileId, org.orgId, approverId, "approve"),
      );
      await withOrgContext(org.orgId, () =>
        rollbackPaymentRun(seededRunId, org.orgId, approverId, "run recalled before dispatch"),
      );
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          recordPaymentFileDownload(seededFileId, org.orgId, approverId),
        ),
        (error: Error) =>
          error instanceof PaymentError
          && error.message === "payment file is not approved for delivery",
      );
      const state = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          file_status: string;
          deliveries: number;
          run_status: string;
        }>(sql`
          select pf.status as file_status,
                 (select count(*)::int from payment_file_deliveries d
                   where d.payment_file_id = pf.id and d.org_id = pf.org_id) as deliveries,
                 (select r.status from payment_runs r where r.id = pf.payment_run_id) as run_status
            from payment_files pf
           where pf.id = ${seededFileId} and pf.org_id = ${org.orgId}
        `)).rows[0]
      );
      assert.deepEqual(state, { file_status: "voided", deliveries: 0, run_status: "rolled_back" });
    } finally {
      if (seeded) {
        const cleanupFileId = seeded.fileId;
        await withBypass(() => removePaymentFileFixture(org.orgId, cleanupFileId));
      }
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

/**
 * A debit profile's originator settings arrive as decrypted tenant JSON, so the
 * debit rails have to hold the same line the credit rails hold in
 * `validateNachaSettings`: nothing is a string until it is shown to be one, an
 * unfinished profile is a named refusal, and the ODFI routing is exactly nine
 * digits before the writer slices it to eight.
 */

const NACHA_ORIGINATOR = {
  odfiRouting: "021000021",
  immediateDestination: " 021000021",
  immediateOrigin: "1234567890",
  destinationName: "BANK OF EXAMPLE",
  originName: "EXAMPLE CONSTRUCTION",
  companyName: "EXAMPLE CONST",
  companyId: "1123456789",
};

test("a complete NACHA debit originator parses, trimmed, with the corporate SEC default", () => {
  const settings = nachaOriginator({ ...NACHA_ORIGINATOR, companyName: "  EXAMPLE CONST  " });
  assert.equal(settings.odfiRouting, "021000021");
  assert.equal(settings.companyName, "EXAMPLE CONST");
  assert.equal(settings.entryClassCode, undefined);
  assert.equal(settings.entryDescription, undefined);
});

test("an unfinished NACHA debit profile is named, never written into a file", () => {
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, companyId: "FILL-ME" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("companyId"),
  );
});

test("a NACHA debit field that is not a string counts as missing rather than stringifying", () => {
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, originName: { toString: () => "EXAMPLE" } }),
    (error: Error) => error instanceof PaymentError && error.message.includes("originName"),
  );
});

test("an over-long odfiRouting is refused rather than truncated to the wrong institution", () => {
  // The writer slices odfiRouting to 8 characters for the batch and file
  // trailers, so 13 digits would still produce a well-formed 94-character file
  // — addressed to an originating bank the tenant never named.
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, odfiRouting: "0210000219999" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("9-digit"),
  );
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, odfiRouting: "02100" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("9-digit"),
  );
});

test("an unrecognised SEC code falls back to CCD instead of reaching the 3-character field", () => {
  assert.equal(nachaOriginator({ ...NACHA_ORIGINATOR, entryClassCode: "WEB" }).entryClassCode, undefined);
  assert.equal(nachaOriginator({ ...NACHA_ORIGINATOR, entryClassCode: "PPD" }).entryClassCode, "PPD");
});

const SEPA_ORIGINATOR = {
  originatorName: "EXAMPLE CONSTRUCTION",
  originatorIban: "DE89370400440532013000",
  originatorBic: "COBADEFFXXX",
  creditorId: "DE98ZZZ09999999999",
};

test("a complete SEPA debit originator parses, trimmed", () => {
  const settings = sepaOriginator({ ...SEPA_ORIGINATOR, originatorBic: " COBADEFFXXX " });
  assert.equal(settings.originatorBic, "COBADEFFXXX");
  assert.equal(settings.creditorId, "DE98ZZZ09999999999");
});

test("an unfinished SEPA debit profile is named, never collected against", () => {
  assert.throws(
    () => sepaOriginator({ ...SEPA_ORIGINATOR, creditorId: "FILL-ME" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("creditorId"),
  );
  assert.throws(
    () => sepaOriginator({ ...SEPA_ORIGINATOR, originatorIban: "   " }),
    (error: Error) => error instanceof PaymentError && error.message.includes("originatorIban"),
  );
});

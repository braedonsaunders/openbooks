import { routeSubjectSubmission } from "../flows/submission-policy.ts";
import { sql } from "drizzle-orm";
import { completedGateAllowsSelfApproval } from "../flows/approval-decision-policy.ts";
import { cancelDispatchRuns, dispatchFailureReason } from "../flows/dispatch-result.ts";
import { paymentRunSubjectKind } from "../flows/payment-runs-adapter.ts";

import { PaymentError } from "../payments-core/payment-errors.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { event } from "./operations-shared.ts";
import { reversePaymentForReturn } from "./payment-return.ts";

/**
 * Submit a draft payment run. Approval is owned by Flows: the submit fires
 * `on_submit` for the run's subject (outbound or inbound payment run), and an
 * enabled flow that raises a gate parks the run in `pending_approval` until
 * the flow decides. With no gating flow the organization has no payment-run
 * approval, and the run is released to `approved` at once.
 *
 * `userId` is the gate user for an interactive submission, or null for the
 * payment scheduler: a scheduled submission is system provenance and never
 * impersonates the schedule's author. The submitted tenant Flow determines
 * whether the run's maker may decide an assigned gate.
 *
 * A flow that matched but failed refuses the submission by name and leaves the
 * run in draft; whatever the dispatch opened is cancelled, and the failed flow
 * run is kept as retry evidence.
 */
export async function submitPaymentRun(
  runId: string,
  orgId: string,
  userId: string | null,
): Promise<{ status: "pending_approval" | "approved"; gated: boolean }> {
  const outcome = await withOrgTransaction(orgId, async () => {
    const run = (
      await db.execute<{ direction: string }>(
        sql`
      select r.direction from payment_runs r
        join payment_bank_profiles p on p.id = r.payment_bank_profile_id and p.org_id = r.org_id
       where r.id = ${runId} and r.org_id = ${orgId} and r.status = 'draft'
         and p.is_active and r.payment_count > 0 and r.total_amount > 0
       for update of r
    `,
        "objects",
      )
    )[0];
    if (!run)
      throw new PaymentError("only a non-empty draft run with an active profile can be submitted");
    const subjectKind = paymentRunSubjectKind(run.direction);
    const dispatch = (
      await routeSubjectSubmission({
        orgId,
        actorId: userId,
        subjectKind,
        subjectId: runId,
        source: userId === null ? "schedule" : "ui",
      })
    ).dispatch;
    if (dispatch.failed) {
      await cancelDispatchRuns(
        orgId,
        dispatch.runs.map((item) => item.runId),
        { actorId: userId },
      );
      return {
        refusal: `payment run approval routing failed: ${dispatchFailureReason(dispatch)}`,
      } as const;
    }
    const gated = dispatch.gatesCreated > 0;
    const status = gated ? "pending_approval" : "approved";
    const submitted = (
      await db.execute<{ id: string }>(
        sql`
      update payment_runs set
        status = ${status},
        submitted_at = now(), submitted_by = ${userId},
        approved_at = ${gated ? null : sql`now()`},
        approved_by = null,
        updated_at = now(), updated_by = ${userId}
      where id = ${runId} and org_id = ${orgId} and status = 'draft'
      returning id
    `,
        "objects",
      )
    )[0];
    if (!submitted) throw new PaymentError("the payment run changed while it was being submitted");
    await event({
      orgId,
      runId,
      eventType: "run_submitted",
      actorId: userId,
      fromStatus: "draft",
      toStatus: status,
      details: {
        source: userId === null ? "system" : "user",
        approval: gated ? "flow" : "not_required",
        ...(gated
          ? {
              flowRuns: dispatch.runs
                .filter((item) => item.gatesCreated > 0)
                .map((item) => item.runId),
            }
          : {}),
      },
    });
    return { status, gated } as const;
  });
  if ("refusal" in outcome) throw new PaymentError(outcome.refusal);
  return outcome;
}

/**
 * Release a payment run's Flows approval. Called by the registered handler
 * inside decideGate's transaction once the subject's approval resolves, so a
 * refusal here rolls the gate decision back with it.
 *
 * Only a run still awaiting approval is released; a run that left
 * `pending_approval` some other way is refused rather than overwritten. The
 * Self-approval requires a decided gate on this exact run with an explicit
 * frozen policy permitting it. A rejection carries its reason onto the run.
 */
export async function releasePaymentRunApproval(args: {
  orgId: string;
  runId: string;
  actorId: string | null;
  outcome: "approved" | "rejected";
  comment?: string | null;
  approvalRunId?: string;
}): Promise<void> {
  const { orgId, runId, actorId, outcome } = args;
  if (!actorId)
    throw new PaymentError("a payment run approval must be decided by a signed-in user");
  const run = (
    await db.execute<{
      status: string;
      direction: string;
      created_by: string | null;
      submitted_by: string | null;
    }>(
      sql`
    select status, direction, created_by, submitted_by from payment_runs
     where id = ${runId} and org_id = ${orgId}
     for update
  `,
      "objects",
    )
  )[0];
  if (!run) throw new PaymentError("payment run not found");
  if (run.status !== "pending_approval") {
    throw new PaymentError(`the payment run is ${run.status}, not awaiting approval`);
  }
  if (actorId === run.submitted_by || actorId === run.created_by) {
    if (
      !(await completedGateAllowsSelfApproval(db, {
        orgId,
        subjectKind: paymentRunSubjectKind(run.direction),
        subjectId: runId,
        approvalRunId: args.approvalRunId,
        actorId,
        outcome,
      }))
    ) {
      throw new PaymentError(
        "The payment run author or submitter cannot decide its approval without an explicit frozen self-approval policy and completed gate decision — use the configured approval gate.",
      );
    }
  }
  const reason = args.comment?.trim() || null;
  if (outcome === "rejected" && !reason) throw new PaymentError("a rejection reason is required");
  const next = outcome === "approved" ? "approved" : "rejected";
  const released = (
    await db.execute<{ id: string }>(
      sql`
    update payment_runs set
      status = ${next},
      approved_at = ${outcome === "approved" ? sql`now()` : null},
      approved_by = ${outcome === "approved" ? actorId : null}::uuid,
      rejected_at = ${outcome === "rejected" ? sql`now()` : null},
      rejected_by = ${outcome === "rejected" ? actorId : null}::uuid,
      rejection_reason = ${outcome === "rejected" ? reason : null},
      updated_at = now(), updated_by = ${actorId}
    where id = ${runId} and org_id = ${orgId} and status = 'pending_approval'
    returning id
  `,
      "objects",
    )
  )[0];
  if (!released)
    throw new PaymentError("the payment run changed while its approval was being released");
  await event({
    orgId,
    runId,
    eventType: outcome === "approved" ? "run_approved" : "run_rejected",
    actorId,
    fromStatus: "pending_approval",
    toStatus: next,
    details: { source: "flow", ...(reason ? { reason } : {}) },
  });
}

export async function rollbackPaymentRun(
  runId: string,
  orgId: string,
  userId: string,
  reason: string,
  opts: { bankNotProcessedAttestation?: string | null } = {},
): Promise<void> {
  if (!reason.trim()) throw new PaymentError("a rollback reason is required");
  await withOrgTransaction(orgId, async () => {
    const locked = (
      await db.execute<{ run_number: string; status: string }>(
        sql`
      select run_number::text as run_number, status from payment_runs
       where id = ${runId} and org_id = ${orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!locked) throw new PaymentError("payment run not found");
    // Rolling back releases every bill the run reserved, so another run (or an
    // ad-hoc payment) can pay them. Once a file has reached the bank that is a
    // double payment unless the bank did not process it — knowledge only the
    // operator has. Require it as an explicit, recorded attestation: the run
    // number typed back, so a reason alone can never release delivered bills.
    const deliveries = await db.execute<{
      file_id: string;
      channel: string;
      status: string;
      delivered_at: string | null;
    }>(
      sql`
      select delivery.payment_file_id as file_id, delivery.channel, delivery.status,
             delivery.delivered_at::text as delivered_at
        from payment_file_deliveries delivery
        join payment_files file on file.id = delivery.payment_file_id and file.org_id = delivery.org_id
       where file.payment_run_id = ${runId} and file.org_id = ${orgId}
         and delivery.status in ('delivered', 'acknowledged')
       order by delivery.created_at, delivery.id
    `,
      "objects",
    );
    const attestation = opts.bankNotProcessedAttestation?.trim() ?? "";
    if (deliveries.length > 0 && attestation !== locked.run_number) {
      throw new PaymentError(
        `payment run ${locked.run_number} has a file delivered to the bank; rolling it back releases its bills for payment again. ` +
          `Confirm with the bank that the delivered file was not and will not be processed, then type ${locked.run_number} to attest it — ` +
          `otherwise keep the run and record the bank's settlement, return or rejection of each payment instead`,
      );
    }
    const result = await db.execute<{ status: string }>(
      sql`
      update payment_runs r set status = 'rolled_back', updated_at = now(), updated_by = ${userId}
       where r.id = ${runId} and r.org_id = ${orgId} and r.status in ('approved', 'generated', 'delivered', 'partially_failed')
         and not exists (select 1 from payment_instructions i where i.payment_run_id = r.id and i.org_id = r.org_id and i.status in ('sent', 'settled', 'returned', 'reversed'))
       returning r.status
    `,
      "objects",
    );
    if (!result[0])
      throw new PaymentError(
        "a run can only be rolled back before any payment is posted or settled",
      );
    // Lock every file of the run: a delivery claimed (or parked uncertain)
    // while its bytes may be at the bank must refuse the void — voiding
    // would destroy the only evidence of what the bank may hold. Already
    // delivered files keep their existing void semantics: their delivery is
    // confirmed and recorded, so the evidence survives the void.
    const files = await db.execute<{ id: string; status: string }>(
      sql`
      select id, status from payment_files
       where payment_run_id = ${runId} and org_id = ${orgId}
       for update
    `,
      "objects",
    );
    const inFlight = files.filter(
      (f) => f.status === "delivering" || f.status === "delivery_uncertain",
    );
    if (inFlight.length > 0) {
      throw new PaymentError(
        `cannot roll back the run while file ${inFlight[0]!.id} has an in-flight SFTP delivery (${inFlight[0]!.status}); wait for the delivery to complete or expire, or resolve the uncertain delivery first`,
      );
    }
    const voidable = files.filter((f) => f.status !== "superseded" && f.status !== "voided");
    if (voidable.length > 0) {
      const voided = await db.execute<{ id: string }>(
        sql`
        update payment_files set status = 'voided', updated_at = now(), updated_by = ${userId}
         where payment_run_id = ${runId} and org_id = ${orgId} and status not in ('superseded', 'voided')
        returning id
      `,
        "objects",
      );
      // Locked above, so every voidable row must move: a short count means
      // a concurrent lifecycle transition raced the rollback — fail closed.
      if (voided.length !== voidable.length) {
        throw new PaymentError(
          "cannot roll back the run: a payment file moved while it was locked; reload and retry",
        );
      }
    }
    await event({
      orgId,
      runId,
      actorId: userId,
      eventType: "run_rolled_back",
      fromStatus: locked.status,
      toStatus: "rolled_back",
      details:
        deliveries.length > 0
          ? {
              reason,
              bankNotProcessedAttestation: {
                attestedBy: userId,
                typedConfirmation: attestation,
                statement:
                  "The bank did not process the delivered payment file and will not process it.",
                deliveries,
              },
            }
          : { reason },
    });
  });
}

export async function recordPaymentSettlement(opts: {
  instructionId: string;
  orgId: string;
  userId: string;
  status: "settled" | "returned" | "rejected";
  effectiveOn: string;
  bankReference?: string | null;
  bankStatementLineId?: string | null;
  returnCode?: string | null;
  returnReason?: string | null;
}): Promise<void> {
  // The document-void helper participates in this tenant transaction, so its
  // journal reversal cannot commit unless the settlement projection does too.
  await withOrgTransaction(opts.orgId, async () => {
    const candidate = await db.execute<{ payment_run_id: string }>(
      sql`
      select payment_run_id
        from payment_instructions
       where id = ${opts.instructionId} and org_id = ${opts.orgId}
    `,
      "objects",
    );
    const paymentRunId = candidate[0]?.payment_run_id;
    if (!paymentRunId) throw new PaymentError("payment instruction not found");
    // Keep the aggregate lock order identical to posting: run first, then the
    // instruction, then the payment document/reversal work. Opposite ordering
    // lets a return and a poster deadlock while each holds the row the other
    // needs to establish the terminal boundary.
    const lockedRun = await db.execute<{
      status: string;
      bank_account_id: string;
    }>(
      sql`
      select status, bank_account_id
        from payment_runs
       where id = ${paymentRunId} and org_id = ${opts.orgId}
       for update
    `,
      "objects",
    );
    if (!lockedRun[0]) throw new PaymentError("payment run not found");
    const row = await db.execute<{
      payment_run_id: string;
      payment_document_id: string | null;
      amount: string;
      currency: string;
      status: string;
    }>(
      sql`
      select i.payment_run_id, i.payment_document_id, i.amount, i.currency, i.status
        from payment_instructions i
       where i.id = ${opts.instructionId} and i.org_id = ${opts.orgId}
         and i.payment_run_id = ${paymentRunId}
       for update of i
    `,
      "objects",
    );
    const instruction = row[0];
    if (!instruction) throw new PaymentError("payment instruction not found");
    if (["returned", "reversed"].includes(instruction.status) && opts.status === "settled") {
      throw new PaymentError("a returned or reversed payment instruction cannot be settled");
    }
    if (!["sent", "settled", "returned"].includes(instruction.status)) {
      throw new PaymentError("only a sent payment can be settled or returned");
    }
    if (opts.bankStatementLineId) {
      const bankLine = await db.execute<{ id: string }>(
        sql`
        select id
          from bank_statement_lines
         where id = ${opts.bankStatementLineId}
           and org_id = ${opts.orgId}
           and account_id = ${lockedRun[0]!.bank_account_id}
      `,
        "objects",
      );
      if (!bankLine[0]) {
        throw new PaymentError(
          "bank statement line does not belong to the payment run's bank account",
        );
      }
    }
    let reversalEntryId: string | null = null;
    if (
      (opts.status === "returned" || opts.status === "rejected") &&
      instruction.status !== "returned"
    ) {
      if (!instruction.payment_document_id)
        throw new PaymentError("returned instruction has no payment document");
      reversalEntryId = await reversePaymentForReturn(
        instruction.payment_document_id,
        opts.orgId,
        opts.returnReason ?? opts.returnCode ?? "payment returned by bank",
        opts.userId,
        opts.effectiveOn,
      );
    }
    await db.execute(sql`
      insert into payment_settlements
        (org_id, payment_instruction_id, bank_statement_line_id, status, amount, currency,
         effective_on, bank_reference, return_code, return_reason, reversal_entry_id, created_by, updated_by)
      values (${opts.orgId}, ${opts.instructionId}, ${opts.bankStatementLineId ?? null}, ${opts.status},
              ${instruction.amount}, ${instruction.currency}, ${opts.effectiveOn}, ${opts.bankReference ?? null},
              ${opts.returnCode ?? null}, ${opts.returnReason ?? null}, ${reversalEntryId}, ${opts.userId}, ${opts.userId})
      on conflict (payment_instruction_id) do update set
        bank_statement_line_id = excluded.bank_statement_line_id, status = excluded.status,
        effective_on = excluded.effective_on, bank_reference = excluded.bank_reference,
        return_code = excluded.return_code, return_reason = excluded.return_reason,
        reversal_entry_id = coalesce(excluded.reversal_entry_id, payment_settlements.reversal_entry_id),
        updated_at = now(), updated_by = excluded.updated_by
      where payment_settlements.org_id = ${opts.orgId}
    `);
    await db.execute(
      sql`update payment_instructions set status = ${opts.status}, updated_at = now(), updated_by = ${opts.userId} where id = ${opts.instructionId} and org_id = ${opts.orgId}`,
    );
    if (opts.status === "returned") {
      await db.execute(
        sql`update payment_run_items set status = 'returned', updated_at = now(), updated_by = ${opts.userId} where payment_instruction_id = ${opts.instructionId} and org_id = ${opts.orgId}`,
      );
    }
    await db.execute(sql`
      update payment_runs r set
        status = case
          when exists (select 1 from payment_instructions i where i.payment_run_id = r.id and i.org_id = r.org_id and i.status in ('returned', 'rejected')) then 'returned'
          when not exists (select 1 from payment_instructions i where i.payment_run_id = r.id and i.org_id = r.org_id and i.status not in ('settled', 'cancelled')) then 'settled'
          else r.status end,
        settled_at = case when not exists (select 1 from payment_instructions i where i.payment_run_id = r.id and i.org_id = r.org_id and i.status not in ('settled', 'cancelled')) then now() else settled_at end,
        posting_claim_token = case when r.status = 'processing' then null else posting_claim_token end,
        posting_claimed_at = case when r.status = 'processing' then null else posting_claimed_at end,
        posting_claimed_by = case when r.status = 'processing' then null else posting_claimed_by end,
        updated_at = now(), updated_by = ${opts.userId}
      where r.id = ${instruction.payment_run_id} and r.org_id = ${opts.orgId}
    `);
    await event({
      orgId: opts.orgId,
      runId: instruction.payment_run_id,
      instructionId: opts.instructionId,
      actorId: opts.userId,
      eventType: `instruction_${opts.status}`,
      fromStatus: instruction.status,
      toStatus: opts.status,
      details: {
        bankReference: opts.bankReference,
        returnCode: opts.returnCode,
        returnReason: opts.returnReason,
      },
    });
  });
}

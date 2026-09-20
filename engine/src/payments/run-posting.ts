import { sql } from "drizzle-orm";
import { db, orgContext, schema, withOrgTransaction } from "../platform/db.ts";
import { runPostDocumentEffects } from "../ledger/posting-dispatch.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { recordReleaseCheck, type BillReleaseDecision } from "../compliance/compliance.ts";
import { PaymentError, PaymentRunPostingClaimFencedError } from "./payment-errors.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { paymentRunComplianceDecisions } from "./run-readiness.ts";
import { type PostingClaim, assertPostingClaimLive } from "./run-claim.ts";
import { queueAutomaticRemittance } from "./run-remittance.ts";
/**
 * A posting claim that has made no progress for this long is treated as
 * abandoned: a new poster may recover it, fencing the old worker at its next
 * completion write. Mirrors the durable-work lease window.
 */
export const PAYMENT_RUN_POSTING_CLAIM_STALE_MS = 15 * 60_000;

/**
 * Take exclusive ownership of a run's posting lifecycle.
 *
 * The run row is the single claim primitive: `processing` plus a random
 * per-claim token. A fresh claim fences every prior worker; a stale claim
 * (no heartbeat within the window) is recovered by replacing its token, so a
 * crashed poster can never wedge the run — and can never double-post either,
 * because instructions already committed as `sent` are not pending anymore.
 * A run parked in a terminal status by an out-of-band settlement writer is
 * claimable only while pending instructions remain (see the gate below).
 */
async function claimPaymentRunForPosting(
  runId: string,
  orgId: string,
  userId: string,
): Promise<PostingClaim> {
  return withOrgTransaction(orgId, async () => {
    const locked = (await db.execute<{
      status: string;
      token: string | null;
    }>(sql`
      select status, posting_claim_token as token
        from payment_runs
       where id = ${runId} and org_id = ${orgId}
       for update
    `)).rows[0];
    if (!locked) throw new PaymentError("payment run not found");

    if (locked.status === "processing") {
      // Recovery path: only an abandoned lease may be taken over. The
      // staleness judgement uses the database clock so app-side skew cannot
      // resurrect a live worker's claim.
      const stale = (await db.execute<{ stale: boolean }>(sql`
        select (posting_claimed_at is null or
                posting_claimed_at <= now() - ${PAYMENT_RUN_POSTING_CLAIM_STALE_MS} * interval '1 millisecond') as stale
          from payment_runs
         where id = ${runId} and org_id = ${orgId} and status = 'processing'
      `)).rows[0]?.stale;
      if (!stale) throw new PaymentError("run is already being posted");
      const recovered = await db.execute<{ token: string }>(sql`
        update payment_runs
           set posting_claim_token = gen_random_uuid(),
               posting_claimed_at = now(),
               posting_claimed_by = ${userId},
               updated_at = now(),
               updated_by = ${userId}
         where id = ${runId} and org_id = ${orgId} and status = 'processing'
         returning posting_claim_token as token
      `);
      const recovery = recovered.rows[0];
      if (!recovery?.token) throw new PaymentRunPostingClaimFencedError(runId);
      await db.insert(schema.paymentEvents).values({
        orgId,
        paymentRunId: runId,
        eventType: "run_posting_recovered",
        fromStatus: "processing",
        toStatus: "processing",
        details: { reason: "the previous posting claim stopped making progress" },
        actorId: userId,
      });
      return { token: recovery.token };
    }

    if (!["generated", "delivered", "partially_failed"].includes(locked.status)) {
      if (!["confirmed", "settled", "returned"].includes(locked.status)) {
        throw new PaymentError("generate and download the EFT file before posting the run");
      }
      // A bank-return settlement stamps the WHOLE run terminal even while
      // sibling instructions are still pending — a return racing a mid-flight
      // poster fences it and leaves the rest unsent behind a status the claim
      // gate used to treat as "already posted" forever. Completion is judged
      // by the actual remainder under this lock, never by the label alone:
      // with nothing pending the refusal stands; with work left, the run is
      // re-claimed and exactly the outstanding instructions are finished.
      const pending = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from payment_instructions
         where payment_run_id = ${runId} and org_id = ${orgId} and status = 'pending'
      `)).rows[0]!.n;
      if (pending === 0) throw new PaymentError("run is already posted");
    }
    const claimed = await db.execute<{ token: string }>(sql`
      update payment_runs
         set status = 'processing',
             posting_claim_token = gen_random_uuid(),
             posting_claimed_at = now(),
             posting_claimed_by = ${userId},
             updated_at = now(),
             updated_by = ${userId}
       where id = ${runId} and org_id = ${orgId} and status = ${locked.status}
       returning posting_claim_token as token
    `);
    const fresh = claimed.rows[0];
    if (!fresh?.token) throw new PaymentRunPostingClaimFencedError(runId);
    await db.insert(schema.paymentEvents).values({
      orgId,
      paymentRunId: runId,
      eventType: "run_posting_started",
      fromStatus: locked.status,
      toStatus: "processing",
      actorId: userId,
    });
    return { token: fresh.token };
  });
}

type ClaimedPaymentInstructionResult =
  | { status: "sent"; paymentDocumentId: string; runEffects: boolean }
  | { status: "failed"; error: string };

/**
 * Post one instruction of a claimed run as a single atomic unit: the claim
 * fence (+ heartbeat), the document's approval submission, the journal post
 * with applications, the instruction flip to `sent`, and its evidence either
 * all commit or none do. Every later writer on the run takes the run row
 * first in the same order, so settlement chooses one side of this commit:
 * before it (which fences this worker), or after it.
 */
async function postClaimedPaymentInstruction(
  runId: string,
  orgId: string,
  userId: string,
  instructionId: string,
  claim: PostingClaim,
): Promise<ClaimedPaymentInstructionResult> {
  return withOrgTransaction(orgId, async () => {
    await assertPostingClaimLive(runId, orgId, claim);

    const instruction = (await db.execute<{
      id: string;
      payment_document_id: string | null;
      status: string;
      document_status: string | null;
    }>(sql`
      select instruction.id, instruction.payment_document_id, instruction.status,
             document.status as document_status
        from payment_instructions instruction
        left join documents document
          on document.id = instruction.payment_document_id
         and document.org_id = instruction.org_id
       where instruction.id = ${instructionId}
         and instruction.payment_run_id = ${runId}
         and instruction.org_id = ${orgId}
       for update of instruction
    `)).rows[0];
    if (!instruction || instruction.status !== "pending") {
      return { status: "failed", error: "payment instruction changed while its run was being posted" };
    }
    if (!instruction.payment_document_id) {
      return { status: "failed", error: "instruction has no payment document" };
    }

    // A payment posted individually from its own flyout only needs its run
    // instruction advanced. Every other document still passes through the
    // ordinary approval and posting boundaries.
    if (instruction.document_status !== "posted") {
      if (instruction.document_status === "draft") {
        const submission = await submitAndReleaseIfUngated(
          "vendor_payment",
          instruction.payment_document_id,
          userId,
        );
        if (submission.flowError) {
          return { status: "failed", error: `approval could not be routed: ${submission.flowError}` };
        }
        if (submission.gated) {
          return {
            status: "failed",
            error: "the payment was submitted for transaction approval and has not been sent",
          };
        }
      } else if (instruction.document_status !== "approved") {
        return {
          status: "failed",
          error: `the payment document is ${instruction.document_status}; only an approved payment can be sent`,
        };
      }
      await postPaymentWithApplications(
        instruction.payment_document_id,
        undefined,
        userId,
        "ui",
        { deferEffects: true },
      );
    }
    const sent = await db.execute<{ id: string }>(sql`
      update payment_instructions
         set status = 'sent', updated_at = now(), updated_by = ${userId}
       where id = ${instruction.id} and payment_run_id = ${runId}
         and org_id = ${orgId} and status = 'pending'
       returning id
    `);
    if (!sent.rows[0]) {
      throw new PaymentError("payment instruction changed while its run was being posted");
    }
    await db.insert(schema.paymentEvents).values({
      orgId,
      paymentRunId: runId,
      paymentInstructionId: instruction.id,
      eventType: "instruction_sent",
      fromStatus: "pending",
      toStatus: "sent",
      actorId: userId,
    });
    return {
      status: "sent",
      paymentDocumentId: instruction.payment_document_id,
      runEffects: instruction.document_status !== "posted",
    };
  });
}

/**
 * Complete a claimed run under its claim. Instruction completeness is judged
 * here rather than trusted from the caller's tally: a confirmed verdict is
 * only available when no instruction is left pending, otherwise the run ends
 * partially failed (and retryable) instead of pretending everything sent.
 * A run whose instructions include bank returns keeps the aggregate
 * `returned` marker the settlement writer installed — completing the leftover
 * work must not quietly rebrand a returned run as fully confirmed.
 */
async function finishPaymentRunPosting(
  runId: string,
  orgId: string,
  userId: string,
  requestedStatus: "confirmed" | "partially_failed",
  details: Record<string, unknown>,
  claim: PostingClaim,
): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    await assertPostingClaimLive(runId, orgId, claim);
    // Email delivery is confirmed by the worker after provider acceptance, so
    // reconcile any remittance rows that became sent while this run was
    // posting before the instruction/run terminal transition commits.
    await db.execute(sql`
      update payment_instructions instruction
         set remittance_email_sent_at = coalesce(instruction.remittance_email_sent_at, remittance.sent_at),
             updated_at = now(),
             updated_by = ${userId}
        from payment_remittances remittance
       where remittance.payment_instruction_id = instruction.id
         and remittance.org_id = instruction.org_id
         and remittance.status = 'sent'
         and instruction.payment_run_id = ${runId}
         and instruction.org_id = ${orgId}
         and instruction.remittance_email_sent_at is null
    `);
    const tally = (await db.execute<{ pending: number; returned: number }>(sql`
      select count(*) filter (where status = 'pending')::int as pending,
             count(*) filter (where status in ('returned', 'rejected'))::int as returned
        from payment_instructions
       where payment_run_id = ${runId} and org_id = ${orgId}
    `)).rows[0]!;
    const status = tally.pending > 0
      ? "partially_failed"
      : tally.returned > 0 && requestedStatus === "confirmed"
        ? "returned"
        : requestedStatus;
    const completed = await db.execute<{ id: string }>(sql`
      update payment_runs
         set status = ${status},
             posting_claim_token = null,
             posting_claimed_at = null,
             posting_claimed_by = null,
             updated_at = now(),
             updated_by = ${userId}
       where id = ${runId} and org_id = ${orgId}
         and status = 'processing'
         and posting_claim_token = ${claim.token}
       returning id
    `);
    if (!completed.rows[0]) throw new PaymentRunPostingClaimFencedError(runId);
    await db.insert(schema.paymentEvents).values({
      orgId,
      paymentRunId: runId,
      eventType: status === "partially_failed" ? "run_posting_failed" : "run_posting_completed",
      fromStatus: "processing",
      toStatus: status,
      details: tally.pending > 0 ? { ...details, incompleteInstructions: tally.pending } : details,
      actorId: userId,
    });
  });
}

/**
 * Best-effort release when a claimed run dies unexpectedly between
 * instructions. Returns false — without writing anything — when the claim no
 * longer exists, leaving whatever terminal state another writer installed.
 */
async function releaseFailedPaymentRunPosting(
  runId: string,
  orgId: string,
  userId: string,
  error: unknown,
  claim: PostingClaim,
): Promise<boolean> {
  return withOrgTransaction(orgId, async () => {
    const released = await db.execute<{ id: string }>(sql`
      update payment_runs
         set status = 'partially_failed',
             posting_claim_token = null,
             posting_claimed_at = null,
             posting_claimed_by = null,
             updated_at = now(),
             updated_by = ${userId}
       where id = ${runId} and org_id = ${orgId}
         and status = 'processing'
         and posting_claim_token = ${claim.token}
       returning id
    `);
    if (!released.rows[0]) return false;
    await db.insert(schema.paymentEvents).values({
      orgId,
      paymentRunId: runId,
      eventType: "run_posting_failed",
      fromStatus: "processing",
      toStatus: "partially_failed",
      details: { error: error instanceof Error ? error.message : String(error) },
      actorId: userId,
    });
    return true;
  });
}

/**
 * Post every pending instruction's payment document (+ applications).
 *
 * The run's explicit `processing` state plus its per-claim token is the sole
 * posting claim: each instruction commits only while that claim is still
 * owned (fencing terminal transitions and recovered claims), effects drain
 * after the instruction commits with the outbox row written in-transaction as
 * the durable retry, and final status plus its evidence commit together under
 * the same claim. A crashed poster leaves the run resumable — the next
 * attempt recovers the stale claim and completes exactly the still-pending
 * instructions; the same holds for a run a bank-return settlement drove to a
 * terminal label while instructions were still pending.
 */
export async function postPaymentRun(
  runId: string,
  orgId: string,
  userId: string,
): Promise<{ posted: number; failures: { payee: string; error: string }[] }> {
  // This command owns a lifecycle that spans several separate transactions:
  // the claim must commit durably before any instruction work begins, every
  // instruction commits under the still-live claim, and completion (or
  // release) commits last. Joined to an ambient transaction, the claim would
  // stay invisible to other workers until that outer unit ended — inviting a
  // second poster through the claim gate — the per-step fencing would collapse
  // into one transaction, and an outer rollback would erase instruction sends
  // whose post-commit effects already ran. Fail closed instead.
  if (orgContext.getStore()?.txDb) {
    throw new PaymentError("payment run posting cannot be nested in another database transaction");
  }
  const claim = await claimPaymentRunForPosting(runId, orgId, userId);
  try {
    const instructions = await db.execute<{ id: string; payee: string }>(sql`
      select instruction.id, party.display_name as payee
        from payment_instructions instruction
        join parties party
          on party.id = instruction.payee_party_id
         and party.org_id = instruction.org_id
       where instruction.payment_run_id = ${runId}
         and instruction.org_id = ${orgId}
         and instruction.status = 'pending'
       order by party.display_name, instruction.id
    `);

    // Final compliance gate. Posting is the irreversible step, so the control
    // runs once more against today's evidence and blocks one instruction rather
    // than stranding every other payee in the run.
    const complianceByInstruction = new Map<string, (BillReleaseDecision & { instructionId: string })[]>();
    for (const decision of await paymentRunComplianceDecisions(runId, orgId)) {
      const list = complianceByInstruction.get(decision.instructionId) ?? [];
      list.push(decision);
      complianceByInstruction.set(decision.instructionId, list);
    }

    let posted = 0;
    const failures: { payee: string; error: string }[] = [];
    for (const instruction of instructions.rows) {
      try {
        const decisions = complianceByInstruction.get(instruction.id) ?? [];
        for (const decision of decisions) {
          if (decision.decision === "cleared") continue;
          await recordReleaseCheck({
            orgId,
            partyId: decision.partyId,
            documentId: decision.documentId,
            paymentRunId: runId,
            paymentInstructionId: instruction.id,
            stage: "run_posted",
            decision: decision.decision,
            snapshot: { compliance: decision.compliance, lienWaiver: decision.lienWaiver, reasons: decision.reasons },
            checkedBy: userId,
          });
        }
        const blocked = decisions.filter((decision) => decision.decision === "blocked");
        if (blocked.length > 0) {
          failures.push({
            payee: instruction.payee,
            error: `subcontractor compliance blocks release: ${blocked
              .map((decision) => `${decision.documentNumber} — ${decision.reasons.join("; ")}`)
              .join(" | ")}`,
          });
          continue;
        }

        const result = await postClaimedPaymentInstruction(
          runId,
          orgId,
          userId,
          instruction.id,
          claim,
        );
        if (result.status === "failed") {
          failures.push({ payee: instruction.payee, error: result.error });
          continue;
        }
        if (result.runEffects) {
          try {
            await runPostDocumentEffects(result.paymentDocumentId, "approved");
          } catch (error) {
            // Effects are at-least-once: enqueuePostingEffects wrote the
            // outbox row inside the posting transaction, so processDuePostingEffects
            // redrives anything this best-effort drain could not finish.
            console.error(
              `[payments] post-commit effects failed for payment ${result.paymentDocumentId}:`,
              error,
            );
          }
        }
        try {
          await queueAutomaticRemittance(runId, instruction.id, orgId, userId, claim);
        } catch (error) {
          if (error instanceof PaymentRunPostingClaimFencedError) throw error;
          console.error(`[payments] automatic remittance failed for instruction ${instruction.id}:`, error);
        }
        posted += 1;
      } catch (error) {
        if (error instanceof PaymentRunPostingClaimFencedError) throw error;
        failures.push({
          payee: instruction.payee,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const finalStatus = failures.length === 0 ? "confirmed" : "partially_failed";
    // The per-instruction reasons persist on the run event — not just in the
    // POST response — so the activity feed can name them after the toast
    // dismisses and the clerk can fix and retry (F-t03-005). Counts alone
    // left "0 sent · N failed" with no reason anywhere.
    await finishPaymentRunPosting(runId, orgId, userId, finalStatus, {
      posted,
      failureCount: failures.length,
      failures,
    }, claim);
    return { posted, failures };
  } catch (error) {
    if (error instanceof PaymentRunPostingClaimFencedError) throw error;
    if (!(await releaseFailedPaymentRunPosting(runId, orgId, userId, error, claim))) {
      throw new PaymentRunPostingClaimFencedError(runId);
    }
    throw error;
  }
}

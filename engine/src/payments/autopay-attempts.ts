import { sql } from "drizzle-orm";
import { lockAutopayEnrollmentAuthority } from "./autopay-enrollment.ts";
import { db, withOrg, withOrgContext } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { type AcceptanceProvider, type OffSessionChargeOutcome } from "./acceptance.ts";
import {
  AutopayError,
  type ChargeFn,
  classifyDecline,
  type AutopayPolicy,
  resolveAutopayPolicy,
  requireAutopayFeature,
  auditAutopay,
} from "./autopay-policy.ts";
import {
  adapterCharge,
  type AutopayRunResult,
  emptyRunResult,
  type CollectionCandidate,
  collectionIdempotencyKey,
  REPLAY_WINDOW_HOURS,
  errorMessage,
  committed,
  candidateFailed,
  refuseInsideTransaction,
  withCollectionClaim,
  requireCollectingProvider,
  type ChainLink,
  type OpenAttempt,
  sendCharge,
  insertCollectionAttempt,
  lockCollectionRetryAuthority,
  uncollectibleReason,
} from "./autopay-collection-state.ts";
import { postCollectedReceipt, recordDecline } from "./autopay-settlement.ts";

/** Collection attempt lifecycle: claiming an attempt, charging it, recording the outcome, resuming interrupted attempts and operator retries. */

/**
 * Charge one invoice at one schedule position. Each step commits on its own:
 * the attempt row commits BEFORE the provider is called (it is the record
 * that a charge was sent), the provider call runs outside any transaction,
 * and the outcome and the receipt each commit separately — so a later
 * failure never erases earlier evidence, and no other invoice's failure can
 * roll this one back. The invoice is re-read under its row lock as each
 * attempt is claimed: anything paid, voided, disputed or credited since
 * selection refuses the charge instead of taking money no longer owed.
 */
export async function collectCandidate(
  orgId: string,
  candidate: CollectionCandidate,
  position: number,
  today: string,
  policy: AutopayPolicy,
  charge: ChargeFn,
  result: AutopayRunResult,
  actorId: string | null = null,
  requestedScope?: ReadonlySet<string> | null,
): Promise<void> {
  const claimed = await withCollectionClaim(orgId, candidate.invoiceId, async () => {
    const chain = await collectionChain(orgId, candidate, result);
    if (!chain) return;
    let fallbackPosition = position;
    for (const [index, link] of chain.entries()) {
      if (!link.providerMethodId) {
        result.skipped += 1;
        result.notices.push({
          invoiceId: candidate.invoiceId,
          attemptId: null,
          status: "skipped",
          detail: "a backup method has no provider token yet; finish its setup first",
        });
        continue;
      }
      const claim = await withOrg(orgId, () =>
        claimAttempt(orgId, candidate, link, fallbackPosition, actorId, requestedScope),
      );
      if ("skip" in claim) {
        result.skipped += 1;
        result.notices.push({
          invoiceId: candidate.invoiceId,
          attemptId: null,
          status: "skipped",
          detail: claim.skip,
        });
        return;
      }
      result.charged += 1;
      const outcome = await sendCharge(charge, claim.attempt, {
        providerCustomerId: link.providerCustomerId,
        providerMethodId: link.providerMethodId,
      });
      const next = await recordChargeOutcome(
        orgId,
        candidate,
        claim.attempt,
        outcome,
        today,
        policy,
        result,
        index < chain.length - 1,
      );
      if (next === "done") return;
      fallbackPosition += 1;
    }
  });
  if (claimed === null) {
    result.skipped += 1;
    result.notices.push({
      invoiceId: candidate.invoiceId,
      attemptId: null,
      status: "skipped",
      detail: "another collection run is charging this invoice right now",
    });
  }
}

/**
 * The methods to try, in order: the enrollment method, then backups — the
 * default first, then the customer's other active methods by fallback
 * priority. At most three backups charge per tick — a customer with more
 * simply keeps the rest for the next retry, so one invoice can never fan out
 * into a charge storm. Null (with the reason recorded) when the invoice or
 * enrollment is no longer collectible.
 */
async function collectionChain(
  orgId: string,
  candidate: CollectionCandidate,
  result: AutopayRunResult,
): Promise<ChainLink[] | null> {
  const invoice = (
    await db.execute<{ status: string; open_balance: string }>(
      sql`
    select status, open_balance from documents where id = ${candidate.invoiceId} and org_id = ${orgId}
  `,
      "objects",
    )
  )[0];
  if (!invoice) {
    result.skipped += 1;
    result.notices.push({
      invoiceId: candidate.invoiceId,
      attemptId: null,
      status: "skipped",
      detail: "invoice is gone; nothing to collect",
    });
    return null;
  }
  const skipReason = await uncollectibleReason(
    orgId,
    candidate.invoiceId,
    invoice.status,
    invoice.open_balance,
  );
  if (skipReason) {
    result.skipped += 1;
    result.notices.push({
      invoiceId: candidate.invoiceId,
      attemptId: null,
      status: "skipped",
      detail: skipReason,
    });
    return null;
  }
  // The enrollment and method were live at selection; recheck — a removed
  // method or paused enrollment must refuse with its remedy.
  const live = (
    await db.execute<{ enrollmentId: string; methodId: string }>(
      sql`
    select e.id as "enrollmentId", m.id as "methodId"
      from autopay_enrollments e
      join customer_payment_methods m on m.id = coalesce(e.payment_method_id,
        (select id from customer_payment_methods dd
          where dd.org_id = e.org_id and dd.party_id = e.party_id
            and dd.status = 'active' and dd.is_default limit 1))
     where e.id = ${candidate.enrollmentId} and e.org_id = ${orgId} and e.status = 'active'
       and m.org_id = ${orgId} and m.status = 'active'
  `,
      "objects",
    )
  )[0];
  if (!live) {
    result.skipped += 1;
    result.notices.push({
      invoiceId: candidate.invoiceId,
      attemptId: null,
      status: "skipped",
      detail:
        "enrollment paused or no active method; link a payment method or resume autopay first",
    });
    return null;
  }
  const backups = await db.execute<{
    methodId: string;
    provider: AcceptanceProvider;
    providerCustomerId: string | null;
    providerMethodId: string | null;
  }>(
    sql`
    select id as "methodId", provider,
           provider_customer_id as "providerCustomerId",
           provider_method_id as "providerMethodId"
      from customer_payment_methods
     where org_id = ${orgId} and party_id = ${candidate.partyId}
       and status = 'active' and id <> ${candidate.methodId}
     order by fallback_priority asc, created_at asc
     limit 3
  `,
    "objects",
  );
  return [
    {
      methodId: candidate.methodId,
      provider: candidate.provider,
      providerCustomerId: candidate.providerCustomerId,
      providerMethodId: candidate.providerMethodId,
      fallbackOf: null,
    },
    ...backups.map((backup) => ({ ...backup, fallbackOf: candidate.methodId })),
  ];
}

/**
 * Claim one schedule position: lock the invoice, recheck that it is still
 * owed, and insert the 'initiated' attempt. Runs in its own transaction, so
 * the attempt is committed before any charge is sent.
 */
async function claimAttempt(
  orgId: string,
  candidate: CollectionCandidate,
  link: ChainLink,
  position: number,
  actorId: string | null,
  requestedScope?: ReadonlySet<string> | null,
): Promise<{ attempt: OpenAttempt } | { skip: string }> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "autopay"))) {
    return {
      skip: "autopay was turned off in Company Settings → Features; nothing is charged while it is off",
    };
  }
  const invoice = (
    await db.execute<{
      status: string;
      open_balance: string;
      currency: string;
      document_number: string;
      subsidiary_id: string | null;
    }>(
      sql`
    select status, open_balance, currency, document_number, subsidiary_id
      from documents where id = ${candidate.invoiceId} and org_id = ${orgId}
     for update
  `,
      "objects",
    )
  )[0];
  if (!invoice) return { skip: "invoice is gone; nothing to collect" };
  await lockAutopayEnrollmentAuthority(orgId, candidate.enrollmentId, invoice.subsidiary_id);
  if (actorId !== null)
    await lockCollectionRetryAuthority(orgId, actorId, invoice.subsidiary_id, requestedScope);
  const skipReason = await uncollectibleReason(
    orgId,
    candidate.invoiceId,
    invoice.status,
    invoice.open_balance,
  );
  if (skipReason) return { skip: skipReason };
  await requireCollectingProvider(orgId, link.provider);
  const attemptId = await insertCollectionAttempt(
    orgId,
    candidate,
    link.methodId,
    link.provider,
    link.fallbackOf,
    invoice.open_balance,
    invoice.currency,
    position,
    actorId,
  );
  if (!attemptId) return { skip: "another tick is already collecting this position" };
  return {
    attempt: {
      id: attemptId,
      invoiceId: candidate.invoiceId,
      position,
      amount: invoice.open_balance,
      currency: invoice.currency,
      provider: link.provider,
      documentNumber: invoice.document_number,
      fallbackOf: link.fallbackOf,
    },
  };
}

/**
 * Record what the provider answered, each write in its own transaction.
 * "next" means the primary declined hard and a backup method follows. When
 * the write itself fails the attempt stays 'initiated' with no provider
 * reference, so the next run replays it under the same idempotency key and
 * the provider returns this same answer; the failure is reported by name.
 */
async function recordChargeOutcome(
  orgId: string,
  candidate: CollectionCandidate,
  attempt: OpenAttempt,
  outcome: OffSessionChargeOutcome,
  today: string,
  policy: AutopayPolicy,
  result: AutopayRunResult,
  backupFollows: boolean,
): Promise<"done" | "next"> {
  let collectedRef: string | null = null;
  try {
    if (outcome.status === "succeeded") {
      // The provider reference commits first and alone: if the receipt
      // below fails, the next run finds the reference and posts the receipt
      // without charging again.
      await withOrg(orgId, async () => {
        const kept = await db.execute<{ id: string }>(
          sql`
          update collection_attempts set provider_ref = ${outcome.providerRef}, updated_at = now()
           where id = ${attempt.id} and org_id = ${orgId} and status = 'initiated'
           returning id
        `,
          "objects",
        );
        if (!kept[0])
          throw new AutopayError(
            "collection attempt changed underfoot; refusing to record over it",
          );
      });
      collectedRef = outcome.providerRef;
    } else if (outcome.status === "processing") {
      await withOrg(orgId, async () => {
        const kept = await db.execute<{ id: string }>(
          sql`
          update collection_attempts
             set status = 'processing', provider_ref = ${outcome.providerRef}, updated_at = now()
           where id = ${attempt.id} and org_id = ${orgId} and status = 'initiated'
           returning id
        `,
          "objects",
        );
        if (!kept[0])
          throw new AutopayError(
            "collection attempt changed underfoot; refusing to record over it",
          );
      });
      result.notices.push({
        invoiceId: candidate.invoiceId,
        attemptId: attempt.id,
        status: "processing",
        detail: "provider is still collecting; the webhook settles this attempt",
      });
      return "done";
    } else if (outcome.status === "requires_action") {
      await committed(orgId, result, (local) =>
        recordDecline(
          orgId,
          candidate,
          attempt.id,
          attempt.position,
          today,
          policy,
          outcome.declineCode ?? "authentication_required",
          local,
          { authUrl: outcome.authUrl },
        ),
      );
      return "done";
    } else {
      const kind = classifyDecline(outcome.declineCode) ?? "soft";
      if (kind === "hard" && backupFollows) {
        // The primary is dead but a backup is on file: park this row as a
        // hard failure without running the final action, and charge the
        // next method immediately. The final action runs only when every
        // method on file has declined hard.
        await withOrg(orgId, async () => {
          const parked = await db.execute<{ id: string }>(
            sql`
            update collection_attempts
               set status = 'failed', decline_code = ${outcome.declineCode}, decline_kind = 'hard',
                   next_retry_on = null, updated_at = now()
             where id = ${attempt.id} and org_id = ${orgId} and status = 'initiated'
             returning id
          `,
            "objects",
          );
          if (!parked[0])
            throw new AutopayError(
              "collection attempt changed underfoot; refusing to record over it",
            );
        });
        result.failed += 1;
        result.notices.push({
          invoiceId: candidate.invoiceId,
          attemptId: attempt.id,
          status: "failed",
          detail: `primary method declined (${outcome.declineCode ?? "unknown reason"}); trying the backup method`,
        });
        return "next";
      }
      await committed(orgId, result, (local) =>
        recordDecline(
          orgId,
          candidate,
          attempt.id,
          attempt.position,
          today,
          policy,
          outcome.declineCode ?? null,
          local,
        ),
      );
      return "done";
    }
  } catch (error) {
    const message = `${attempt.provider} answered "${outcome.status}" for invoice ${attempt.documentNumber}, but the outcome could not be recorded (${errorMessage(error)}); the attempt stays open and the next run resolves it under the same idempotency key, so the customer cannot be charged twice`;
    result.orgErrors.push({ orgId, error: message.slice(0, 1000) });
    throw new AutopayError(message);
  }
  await postCollectedReceipt(orgId, candidate, attempt, collectedRef, result);
  return "done";
}

/**
 * Finish attempts an earlier run committed but never resolved — it died, or
 * its provider call or outcome write failed. Each is handled under its
 * invoice's claim, so an attempt still in flight in another run is left
 * alone. An attempt carrying a provider reference was collected, so only its
 * receipt posts; one without is replayed with the request and idempotency key
 * it was first sent with, so the provider returns the original result
 * instead of charging again. An attempt that cannot be replayed safely is
 * closed for operator review — never re-sent under a new key.
 */
export async function resumeInterruptedAttempts(
  orgId: string,
  today: string,
  policy: AutopayPolicy,
  charge: ChargeFn,
  result: AutopayRunResult,
): Promise<void> {
  const open = await db.execute<{ id: string; invoice_id: string }>(
    sql`
    select id, invoice_id from collection_attempts
     where org_id = ${orgId} and (status='initiated' or (status='processing' and receipt_document_id is not null))
     order by created_at, id
  `,
    "objects",
  );
  for (const row of open) {
    const claimed = await withCollectionClaim(orgId, row.invoice_id, () =>
      resumeAttempt(orgId, row.id, today, policy, charge, result),
    ).catch((error: unknown) => {
      candidateFailed(result, row.invoice_id)(error);
      return { value: undefined };
    });
    if (claimed === null) {
      result.skipped += 1;
      result.notices.push({
        invoiceId: row.invoice_id,
        attemptId: row.id,
        status: "skipped",
        detail: "another collection run is charging this invoice right now",
      });
    }
  }
}

async function resumeAttempt(
  orgId: string,
  attemptId: string,
  today: string,
  policy: AutopayPolicy,
  charge: ChargeFn,
  result: AutopayRunResult,
): Promise<void> {
  const row = (
    await db.execute<{
      invoiceId: string;
      position: number;
      amount: string;
      currency: string;
      provider: AcceptanceProvider;
      providerRef: string | null;
      fallbackOf: string | null;
      enrollmentId: string | null;
      methodId: string | null;
      replayable: boolean;
      documentNumber: string | null;
      invoiceStatus: string | null;
      openBalance: string | null;
      partyId: string | null;
      subsidiaryId: string | null;
      subscriptionId: string | null;
      methodLive: boolean;
      providerCustomerId: string | null;
      providerMethodId: string | null;
    }>(
      sql`
    select a.invoice_id as "invoiceId", a.retry_position as "position", a.amount, a.currency,
           a.provider, a.provider_ref as "providerRef", a.fallback_method_id as "fallbackOf",
           a.enrollment_id as "enrollmentId", a.payment_method_id as "methodId",
           a.created_at > now() - make_interval(hours => ${REPLAY_WINDOW_HOURS}) as "replayable",
           d.document_number as "documentNumber", d.status as "invoiceStatus",
           d.open_balance as "openBalance", d.party_id as "partyId", d.subsidiary_id as "subsidiaryId",
           e.subscription_id as "subscriptionId",
           coalesce(e.status = 'active' and m.status = 'active' and m.provider_method_id is not null, false) as "methodLive",
           m.provider_customer_id as "providerCustomerId", m.provider_method_id as "providerMethodId"
      from collection_attempts a
      left join documents d on d.id = a.invoice_id and d.org_id = a.org_id
      left join autopay_enrollments e on e.id = a.enrollment_id and e.org_id = a.org_id
      left join customer_payment_methods m on m.id = a.payment_method_id and m.org_id = a.org_id
     where a.id = ${attemptId} and a.org_id = ${orgId}
       and (a.status='initiated' or (a.status='processing' and a.receipt_document_id is not null))
  `,
      "objects",
    )
  )[0];
  // Settled since it was listed: a provider webhook or another run got there first.
  if (!row) return;
  const attempt: OpenAttempt = {
    id: attemptId,
    invoiceId: row.invoiceId,
    position: row.position,
    amount: row.amount,
    currency: row.currency,
    provider: row.provider,
    documentNumber: row.documentNumber ?? row.invoiceId,
    fallbackOf: row.fallbackOf,
  };
  const candidate: CollectionCandidate = {
    invoiceId: row.invoiceId,
    documentNumber: attempt.documentNumber,
    openBalance: row.openBalance ?? "0",
    currency: row.currency,
    partyId: row.partyId ?? "",
    subsidiaryId: row.subsidiaryId,
    documentDate: null,
    dueDate: null,
    enrollmentId: row.enrollmentId ?? "",
    subscriptionId: row.subscriptionId,
    methodId: row.methodId ?? "",
    provider: row.provider,
    providerCustomerId: row.providerCustomerId,
    providerMethodId: row.providerMethodId,
  };
  if (row.providerRef) {
    await postCollectedReceipt(orgId, candidate, attempt, row.providerRef, result);
    return;
  }
  const blocker =
    row.invoiceStatus === null || row.openBalance === null
      ? "the invoice is gone"
      : !row.replayable
        ? `it is older than ${REPLAY_WINDOW_HOURS} hours, past the time providers keep idempotency keys`
        : ((await uncollectibleReason(orgId, row.invoiceId, row.invoiceStatus, row.openBalance)) ??
          (row.methodLive && row.providerMethodId
            ? null
            : "its enrollment or payment method is no longer active"));
  if (blocker || !row.providerMethodId) {
    await closeInterruptedAttempt(
      orgId,
      attempt,
      blocker ?? "its payment method has no provider token",
      result,
    );
    return;
  }
  result.charged += 1;
  const outcome = await sendCharge(charge, attempt, {
    providerCustomerId: row.providerCustomerId,
    providerMethodId: row.providerMethodId,
  });
  await recordChargeOutcome(orgId, candidate, attempt, outcome, today, policy, result, false);
}

/**
 * Close an interrupted attempt that cannot be replayed safely. Whether the
 * provider took the money is unknown, so the attempt is kept as evidence,
 * autopay stops charging the invoice, and the operator is told exactly what
 * to look up.
 */
async function closeInterruptedAttempt(
  orgId: string,
  attempt: OpenAttempt,
  blocker: string,
  result: AutopayRunResult,
): Promise<void> {
  const key = collectionIdempotencyKey(attempt.invoiceId, attempt.position);
  const detail = `collection on invoice ${attempt.documentNumber} was interrupted before ${attempt.provider} confirmed it and is not replayed because ${blocker}; check ${attempt.provider} for a payment with idempotency key ${key}: if it was taken, record it as a customer payment on the invoice or refund it, otherwise nothing was charged. Autopay no longer charges this invoice; collect any balance still owed another way`;
  await withOrg(orgId, async () => {
    const closed = await db.execute<{ id: string }>(
      sql`
      update collection_attempts
         set status = 'canceled', decline_code = 'outcome_unknown', next_retry_on = null, updated_at = now()
       where id = ${attempt.id} and org_id = ${orgId} and status = 'initiated' and provider_ref is null
       returning id
    `,
      "objects",
    );
    if (!closed[0])
      throw new AutopayError("collection attempt changed underfoot; refusing to record over it");
    await auditAutopay(
      orgId,
      "collection_attempts",
      attempt.id,
      {
        event: "interrupted_attempt_closed",
        before: { status: "initiated" },
        after: { status: "canceled", declineCode: "outcome_unknown" },
        idempotencyKey: key,
        reason: detail,
      },
      null,
    );
  });
  result.failed += 1;
  result.notices.push({
    invoiceId: attempt.invoiceId,
    attemptId: attempt.id,
    status: "canceled",
    detail: detail.slice(0, 500),
  });
  result.orgErrors.push({ orgId, error: detail.slice(0, 1000) });
}

/**
 * Operator "retry now": an immediate charge outside the schedule for a
 * soft-declined attempt (the customer just updated the method, the operator
 * does not wait for tomorrow). Hard declines refuse — they never clear on
 * retry. A success reactivates exactly like a scheduled one. The request is
 * validated and audited in one transaction; the charge then follows the
 * same commit-before-charge path as a scheduled collection.
 */
export async function retryAttemptNow(
  orgId: string,
  attemptId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  chargeFn?: ChargeFn,
): Promise<AutopayRunResult> {
  refuseInsideTransaction();
  const result = emptyRunResult();
  await withOrgContext(orgId, async () => {
    const prepared = await withOrg(orgId, async () => {
      await requireAutopayFeature(orgId);
      const attempt = (
        await db.execute<{
          invoice_id: string;
          enrollment_id: string;
          method_id: string;
          retry_position: number;
          decline_kind: string | null;
          status: string;
          subsidiary_id: string | null;
        }>(
          sql`
        select a.invoice_id, a.enrollment_id, a.payment_method_id as "method_id",
               a.retry_position, a.decline_kind, a.status, d.subsidiary_id
          from collection_attempts a
          join documents d on d.org_id = a.org_id and d.id = a.invoice_id
         where a.id = ${attemptId} and a.org_id = ${orgId}
         for update of d
      `,
          "objects",
        )
      )[0];
      if (!attempt) throw new ScopeNotFoundError();
      await lockCollectionRetryAuthority(
        orgId,
        actorId,
        attempt.subsidiary_id,
        allowedSubsidiaryIds,
      );
      if (attempt.status !== "failed")
        throw new AutopayError(
          "only a failed attempt can be retried; this one already settled or never failed",
        );
      if (attempt.decline_kind === "hard") {
        throw new AutopayError(
          "this decline will not clear on retry; ask the customer to update the payment method instead",
        );
      }
      const candidate = (
        await db.execute<CollectionCandidate>(
          sql`
        select d.id as "invoiceId", d.document_number as "documentNumber",
               d.open_balance as "openBalance", d.currency,
               d.party_id as "partyId", d.subsidiary_id as "subsidiaryId",
               d.document_date::text as "documentDate", d.due_date::text as "dueDate",
               e.id as "enrollmentId", e.subscription_id as "subscriptionId",
               m.id as "methodId", m.provider, m.provider_customer_id as "providerCustomerId",
               m.provider_method_id as "providerMethodId"
          from documents d
          join autopay_enrollments e on e.id = ${attempt.enrollment_id} and e.org_id = ${orgId} and e.status = 'active'
          join customer_payment_methods m on m.id = ${attempt.method_id} and m.org_id = ${orgId} and m.status = 'active'
         where d.id = ${attempt.invoice_id} and d.org_id = ${orgId}
      `,
          "objects",
        )
      )[0];
      if (!candidate) {
        throw new AutopayError(
          "the enrollment or method is no longer active; link a payment method first",
        );
      }
      const today = await businessToday(orgId);
      const policy = await resolveAutopayPolicy(orgId);
      await auditAutopay(
        orgId,
        "collection_attempts",
        attemptId,
        {
          event: "retry_now",
          reason:
            "Operator retried the collection immediately instead of waiting for the schedule.",
        },
        actorId,
      );
      return { candidate, position: attempt.retry_position + 1, today, policy };
    });
    const charge = chargeFn ?? ((provider, req) => adapterCharge(orgId, provider, req));
    result.scanned += 1;
    await collectCandidate(
      orgId,
      prepared.candidate,
      prepared.position,
      prepared.today,
      prepared.policy,
      charge,
      result,
      actorId,
      allowedSubsidiaryIds,
    );
  });
  return result;
}

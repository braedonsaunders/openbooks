import { lockApprovalSubject, requestNativeCommandApproval } from "../platform/approval-routing.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { canonicalPeriodLabel } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { BankingError, type BankingContext } from "./banking-core.ts";
import { lockReconciliationAccount, requireSessionRowInScope } from "./reconcilable-account.ts";
import { reconciliationBookId, reconciliationTotals } from "./reconciliation.ts";
import {
  assertNeutralReviewProof,
  currentSignOffRevalidation,
  reconciliationReviewProof,
  type ReconciliationReviewProof,
  type SignedReviewSubject,
  type SignOffRevalidationCertificate,
} from "./reconciliation-review-proof.ts";

type SignedReviewRow = {
  id: string;
  account_id: string;
  through_date: string;
  currency: string;
  statement_balance: string;
  status: string;
  evidence_kind: string;
  signed_off_at: string | null;
  signed_off_by: string | null;
  subsidiary_id: string | null;
};
export type SignOffRevalidationPreview = {
  reconciliationId: string;
  throughDate: string;
  currency: string;
  statementBalance: string;
  originalSignedOffAt: string;
  originalSignedOffBy: string;
  proof: ReconciliationReviewProof;
  originalApprovalAuditId: string;
  alreadyReviewed: SignOffRevalidationCertificate | null;
};

async function reviewInTransaction(
  tx: SqlExecutor,
  id: string,
  ctx: BankingContext,
): Promise<{
  preview: SignOffRevalidationPreview;
  subject: SignedReviewSubject;
  subsidiaryId: string | null;
  periods: { id: string; label: string; subsidiaryId: string | null }[];
}> {
  if (!isUuid(id)) throw new ScopeNotFoundError();
  await acquireOrgFeatureGateLock(tx, ctx.orgId);
  if (!(await lockAndCheckOrgFeature(tx, ctx.orgId, "banking"))) throw new ScopeNotFoundError();
  const active = (
    await tx.execute(
      sql`select id from users where org_id=${ctx.orgId} and id=${ctx.userId} and is_active for share`,
      "objects",
    )
  )[0];
  if (!active) throw new ScopeNotFoundError();
  const head = (
    await tx.execute<{ account_id: string; subsidiary_id: string | null }>(
      sql`
    select r.account_id,a.subsidiary_id from reconciliations r
      join accounts a on a.org_id=r.org_id and a.id=r.account_id
     where r.org_id=${ctx.orgId} and r.id=${id}
  `,
      "objects",
    )
  )[0];
  requireSessionRowInScope(head, ctx.allowedSubsidiaryIds);
  // Existing reconciliation authority still covers review; the narrower
  // duty can certify evidence without conferring other bank mutations.
  const permission = (await actorHasPermission(
    tx,
    ctx.orgId,
    ctx.userId,
    "banking.review_sign_off",
  ))
    ? "banking.review_sign_off"
    : "banking.reconcile";
  const actualScope = await lockActorCommandAuthority(
    tx,
    ctx.orgId,
    ctx.userId,
    head.subsidiary_id,
    permission,
  );
  requireSessionRowInScope(head, actualScope);
  const bookId = await reconciliationBookId(tx, ctx.orgId);
  await lockReconciliationAccount(tx, ctx.orgId, head.account_id);
  const row = (
    await tx.execute<SignedReviewRow>(
      sql`
    select r.id,r.account_id,r.through_date::text as through_date,r.currency,
           r.statement_balance::text as statement_balance,r.status,r.evidence_kind,
           r.signed_off_at::text as signed_off_at,r.signed_off_by,a.subsidiary_id
      from reconciliations r join accounts a on a.org_id=r.org_id and a.id=r.account_id
     where r.org_id=${ctx.orgId} and r.id=${id} for update of r for share of a
  `,
      "objects",
    )
  )[0];
  requireSessionRowInScope(row, ctx.allowedSubsidiaryIds);
  requireSessionRowInScope(row, actualScope);
  if (
    row.status !== "signed_off" ||
    !row.signed_off_at ||
    !row.signed_off_by ||
    row.evidence_kind !== "statement"
  ) {
    throw new BankingError(
      "Review requires an existing statement-backed sign-off. Source-only or unsigned sessions use their ordinary reconciliation workflow.",
    );
  }
  const affected = await tx.execute<{ subsidiaryId: string | null }>(
    sql`
    select distinct jl.subsidiary_id as "subsidiaryId" from journal_lines jl
      join journal_entries je on je.org_id=jl.org_id and je.id=jl.entry_id
     where jl.org_id=${ctx.orgId} and jl.account_id=${row.account_id} and jl.currency=${row.currency}
      and je.book_id=${bookId} and je.status in ('posted','reversed')
      and je.posting_date<=${row.through_date}::date
      and (je.posted_at>${row.signed_off_at}::timestamptz or jl.reconciled_at is null)
  `,
    "objects",
  );
  const entities = [
    ...new Set([row.subsidiary_id, ...affected.map((effect) => effect.subsidiaryId)]),
  ];
  const periods: { id: string; label: string; subsidiaryId: string | null }[] = [];
  for (const entity of entities) {
    if (
      !subsidiaryScopeAllows(actualScope, entity) ||
      !subsidiaryScopeAllows(ctx.allowedSubsidiaryIds, entity)
    )
      throw new ScopeNotFoundError();
    const period = await resolveCoveringPeriod(tx, ctx.orgId, row.through_date, entity);
    if (!period)
      throw new BankingError(
        "Configure a covering accounting period for every affected legal entity before recording this review.",
      );
    periods.push({
      id: period.id,
      label: canonicalPeriodLabel({
        fiscalYear: period.fiscal_year,
        periodNumber: period.period_number,
        adjustment: false,
      }),
      subsidiaryId: entity,
    });
  }
  // Share each affected calendar's native close fence in a stable order,
  // before taking journal evidence locks, and retain it through the decision.
  for (const id of [...new Set(periods.map((period) => period.id))].sort()) {
    await tx.execute(sql`select period_posting_fence(${ctx.orgId},${id},${bookId})`);
  }
  const approval = await tx.execute<{
    id: string;
    changes: {
      operation?: unknown;
      bookId?: unknown;
      throughDate?: unknown;
      currency?: unknown;
      statementBalance?: unknown;
      matchedJournalLines?: unknown;
      excludedStatementLines?: unknown;
      openingCarriedForward?: unknown;
      difference?: unknown;
    };
  }>(
    sql`
    select al.id,al.changes from audit_log al
     where al.org_id=${ctx.orgId} and al.table_name='reconciliations' and al.row_id=${id}
       and al.action='approve' and al.actor_id=${row.signed_off_by}
       and al.at=${row.signed_off_at}::timestamptz and al.changes->>'operation'='sign_off'
     order by al.id limit 2
  `,
    "objects",
  );
  const original = approval[0];
  if (
    approval.length !== 1 ||
    !original ||
    original.changes.bookId !== bookId ||
    original.changes.throughDate !== row.through_date ||
    original.changes.currency !== row.currency ||
    typeof original.changes.statementBalance !== "string" ||
    toUnits(original.changes.statementBalance) !== toUnits(row.statement_balance) ||
    original.changes.difference !== "0.0000"
  ) {
    throw new BankingError(
      "The immutable original sign-off audit does not establish this session and book. Review its source evidence before changing reconciliation history.",
    );
  }
  const subject: SignedReviewSubject = {
    orgId: ctx.orgId,
    id,
    accountId: row.account_id,
    bookId,
    currency: row.currency,
    throughDate: row.through_date,
    statementBalance: fromUnits(toUnits(row.statement_balance)),
    signedOffAt: row.signed_off_at,
    signedOffBy: row.signed_off_by,
  };
  const proof = await reconciliationReviewProof(tx, subject);
  const previous = (
    await tx.execute<{
      proof: {
        ledgerDigest?: string;
        completeLedgerDigest?: string;
        outstandingLegalEntityEffects?: { subsidiaryId: string | null; amount: string }[];
      };
    }>(
      sql`
    select changes->'proof' as proof from audit_log where org_id=${ctx.orgId} and table_name='reconciliations'
      and row_id=${id} and action='update' and changes->>'operation'='revalidate_sign_off'
      and changes->>'originalSignedOffAt'=${row.signed_off_at}
     order by at desc,id desc limit 1
  `,
      "objects",
    )
  )[0]?.proof;
  if (
    previous?.ledgerDigest === proof.ledgerDigest &&
    previous.completeLedgerDigest !== proof.completeLedgerDigest &&
    Array.isArray(previous.outstandingLegalEntityEffects) &&
    canonicalJson(
      previous.outstandingLegalEntityEffects.filter((effect) => toUnits(effect.amount) !== 0n),
    ) !==
      canonicalJson(
        proof.outstandingLegalEntityEffects.filter((effect) => toUnits(effect.amount) !== 0n),
      )
  ) {
    throw new BankingError(
      "The uncleared balance changed outside the identified late movements. Review the new ledger sources before recording another neutral-history review.",
    );
  }
  assertNeutralReviewProof(proof);
  if (
    [...proof.legalEntityEffects, ...proof.outstandingLegalEntityEffects].some(
      (effect) => !entities.includes(effect.subsidiaryId),
    )
  ) {
    throw new BankingError(
      "The affected legal entities changed during review. Reload its current evidence before confirming.",
    );
  }
  if (
    [...proof.legalEntityEffects, ...proof.outstandingLegalEntityEffects].some(
      (effect) =>
        !subsidiaryScopeAllows(actualScope, effect.subsidiaryId) ||
        !subsidiaryScopeAllows(ctx.allowedSubsidiaryIds, effect.subsidiaryId),
    )
  )
    throw new ScopeNotFoundError();
  const excluded = (
    await tx.execute<{ count: number }>(
      sql`
    select count(*)::int as count from bank_statement_lines where org_id=${ctx.orgId}
      and account_id=${row.account_id} and currency=${row.currency}
      and posted_on<=${row.through_date}::date and match_status='excluded'
  `,
      "objects",
    )
  )[0]?.count;
  const totals = await reconciliationTotals(id, ctx);
  if (
    proof.journalLines !== original.changes.matchedJournalLines ||
    excluded !== original.changes.excludedStatementLines ||
    totals.unmatchedStatementLines !== 0 ||
    toUnits(totals.difference) !== 0n ||
    toUnits(totals.statementBalance) !== toUnits(row.statement_balance)
  ) {
    throw new BankingError(
      "The original statement, matches or zero-difference position no longer agrees. A neutral-history review cannot replace reconciliation correction.",
    );
  }
  const alreadyReviewed = await currentSignOffRevalidation(tx, subject, proof);
  return {
    subject,
    subsidiaryId: row.subsidiary_id,
    periods,
    preview: {
      reconciliationId: id,
      throughDate: row.through_date,
      currency: row.currency,
      statementBalance: fromUnits(toUnits(row.statement_balance)),
      originalSignedOffAt: row.signed_off_at,
      originalSignedOffBy: row.signed_off_by,
      proof,
      originalApprovalAuditId: original.id,
      alreadyReviewed,
    },
  };
}

/** Read the exact review basis before requesting a reasoned independent
 * certificate. Preview does not change matches, stamps, locks or sign-offs. */
export async function previewSignOffRevalidation(
  id: string,
  ctx: BankingContext,
): Promise<SignOffRevalidationPreview> {
  return withOrgTransaction(
    ctx.orgId,
    async () => (await reviewInTransaction(db, id, ctx)).preview,
  );
}

/** Append review evidence for unchanged signed balances and neutral late
 * history. The original sign-off and every statement/match/GL row remain
 * unchanged; late ledger lines are not declared bank-cleared by this review. */
export async function revalidateReconciliationSignOff(
  id: string,
  input: {
    expectedDigest: string;
    reason: string;
    approvalRunId?: string;
  },
  ctx: BankingContext,
): Promise<
  | {
      status: "recorded";
      certificate: SignOffRevalidationCertificate;
      replayed: boolean;
    }
  | { status: "pending_approval" }
> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500 || !/^[a-f0-9]{64}$/.test(input.expectedDigest)) {
    throw new BankingError(
      "Review the current sign-off evidence and supply a 10–500 character reason.",
    );
  }
  return withOrgTransaction(ctx.orgId, async () => {
    await lockApprovalSubject(ctx.orgId, "bank_reconciliation_review", id);
    const review = await reviewInTransaction(db, id, ctx);
    if (review.preview.proof.digest !== input.expectedDigest) {
      throw new BankingError(
        "The reviewed evidence changed. Reload the neutral-history review before confirming it.",
      );
    }
    if (review.preview.alreadyReviewed)
      return {
        status: "recorded" as const,
        certificate: review.preview.alreadyReviewed,
        replayed: true,
      };
    for (const period of review.periods) {
      const blocked = (
        await db.execute<{ blocked: boolean }>(
          sql`
        select period_module_blocks_write(${ctx.orgId},${period.id},${review.subject.bookId},
          ${period.subsidiaryId},'banking',false) as blocked
      `,
          "objects",
        )
      )[0]?.blocked;
      if (blocked !== false)
        throw new BankingError(
          `Banking is closed for ${period.label}. Request its controlled reopening before recording the independent review.`,
        );
    }
    if (
      await requestNativeCommandApproval({
        orgId: ctx.orgId,
        actorId: ctx.userId,
        subjectKind: "bank_reconciliation_review",
        subjectId: id,
        command: { expectedDigest: input.expectedDigest, reason },
        approvalRunId: input.approvalRunId,
      })
    )
      return { status: "pending_approval" as const };
    const audit = (
      await db.execute<{ id: string; at: string }>(
        sql`
      insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${ctx.orgId},'reconciliations',${id},'update',${JSON.stringify({
        operation: "revalidate_sign_off",
        reason,
        originalApprovalAuditId: review.preview.originalApprovalAuditId,
        originalSignedOffAt: review.subject.signedOffAt,
        originalSignedOffBy: review.subject.signedOffBy,
        proof: review.preview.proof,
        statementBalance: review.preview.statementBalance,
        throughDate: review.subject.throughDate,
        currency: review.subject.currency,
        lateLinesRemainUncleared:
          review.preview.proof.lateUnclearedJournalLines === review.preview.proof.lateJournalLines,
        clearingStampsUnchanged: true,
        neutralBasis: review.preview.proof.neutralBasis,
        originalEvidenceUnchanged: true,
      })}::jsonb,${ctx.userId}) returning id,at::text as at
    `,
        "objects",
      )
    )[0];
    if (!audit) throw new BankingError("The review certificate was not recorded. Nothing changed.");
    return {
      status: "recorded" as const,
      replayed: false,
      certificate: {
        auditId: audit.id,
        reviewedAt: audit.at,
        reviewedBy: ctx.userId,
        reason,
        originalSignedOffAt: review.subject.signedOffAt,
        reviewedReconciliationId: id,
        appliesFromThroughDate: review.subject.throughDate,
        inherited: false,
        proof: review.preview.proof,
      },
    };
  });
}

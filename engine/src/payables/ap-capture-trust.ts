import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import type { CaptureIssue } from "./ap-capture.ts";

/**
 * Earned vendor trust and the auto-post policy that consumes it.
 *
 * Trust is never a flag someone sets. It is read from capture history every
 * time it is needed: a vendor is trusted when its most recent captures that
 * a person reviewed were each accepted exactly as read (no review
 * correction, no edit to the draft bill) and then posted, with none voided.
 * One edit or one void ends the streak, and the next clean reviewed
 * captures must earn it back.
 *
 * Bills the auto-post policy created never count as evidence, so trust
 * cannot renew itself through its own postings: a clean automated posting
 * neither extends nor ends the streak. A void or edit of an automated bill
 * still ends it, because it shows the trust was misplaced.
 */

/** Streak length used to describe trust when no policy version is in force. */
export const DEFAULT_TRUST_STREAK = 3;

export type AutoPostPolicy = {
  id: string;
  effectiveFrom: string;
  enabled: boolean;
  cleanStreak: number;
  maxAmount: string | null;
  maxAmountCurrency: string | null;
};

/** The policy version in force on a date; null (no version) reads as off. */
export async function resolveAutoPostPolicy(
  exec: SqlExecutor,
  orgId: string,
  onDate: string,
): Promise<AutoPostPolicy | null> {
  const row = (
    await exec.execute<{
      id: string;
      effectiveFrom: string;
      enabled: boolean;
      cleanStreak: number;
      maxAmount: string | null;
      maxAmountCurrency: string | null;
    }>(
      sql`
    select id, effective_from::text as "effectiveFrom", enabled, clean_streak as "cleanStreak",
           max_amount::text as "maxAmount", max_amount_currency as "maxAmountCurrency"
      from ap_capture_autopost_policies
     where org_id = ${orgId} and effective_from <= ${onDate}::date
     order by effective_from desc
     limit 1
  `,
      "objects",
    )
  )[0];
  return row ? { ...row, cleanStreak: Number(row.cleanStreak) } : null;
}

/** One materialized capture for a vendor, newest first, with the evidence trust reads. */
export type VendorCaptureEvidence = {
  captureItemId: string;
  documentId: string;
  /** Review corrections recorded before the draft was created. */
  corrected: boolean;
  /** A material change to the draft bill after it was created. */
  draftEdited: boolean;
  documentStatus: string;
  /** A void requested or completed against the bill. */
  voided: boolean;
  /** The draft was created and submitted or posted by the auto-post policy, not by a reviewer. */
  automated: boolean;
};

export type BrokenStreakReason = "edited" | "voided" | "not_posted";

export type VendorTrust = {
  trusted: boolean;
  /** Consecutive clean captures, newest first. */
  cleanStreak: number;
  threshold: number;
  /** The capture ids that earned trust (exactly `threshold` of them when trusted). */
  evidence: string[];
  /** The newest capture that ended the streak, when one did. */
  brokenBy: { captureItemId: string; reason: BrokenStreakReason } | null;
};

function streakBreak(entry: VendorCaptureEvidence): BrokenStreakReason | null {
  if (entry.voided || entry.documentStatus === "voided") return "voided";
  if (entry.corrected || entry.draftEdited) return "edited";
  if (entry.documentStatus !== "posted") return "not_posted";
  return null;
}

/** Pure trust derivation over the newest-first capture history. */
export function evaluateVendorTrust(
  history: readonly VendorCaptureEvidence[],
  threshold: number,
): VendorTrust {
  if (!Number.isSafeInteger(threshold) || threshold < 1)
    throw new Error("trust threshold must be a positive integer");
  const evidence: string[] = [];
  let brokenBy: VendorTrust["brokenBy"] = null;
  for (const entry of history) {
    const reason = streakBreak(entry);
    if (entry.automated) {
      if (reason === "voided" || reason === "edited") {
        brokenBy = { captureItemId: entry.captureItemId, reason };
        break;
      }
      continue;
    }
    if (reason) {
      brokenBy = { captureItemId: entry.captureItemId, reason };
      break;
    }
    evidence.push(entry.captureItemId);
  }
  const trusted = evidence.length >= threshold;
  return {
    trusted,
    cleanStreak: evidence.length,
    threshold,
    evidence: trusted ? evidence.slice(0, threshold) : evidence,
    brokenBy,
  };
}

/**
 * The vendor's most recent materialized captures with their trust evidence.
 * `limit` counts reviewed captures: the streak to evaluate plus one, so a
 * break just past a full streak is still reported. Automated captures newer
 * than the last of those are included only when they end the streak (voided
 * or edited); clean ones are not evidence either way. An optional exclusion
 * leaves out the capture being decided on.
 */
export async function loadVendorCaptureHistory(
  exec: SqlExecutor,
  orgId: string,
  vendorId: string,
  limit: number,
  excludeCaptureItemId: string | null = null,
): Promise<VendorCaptureEvidence[]> {
  const rows = await exec.execute<{
    captureItemId: string;
    documentId: string;
    corrected: boolean;
    draftEdited: boolean;
    documentStatus: string | null;
    voided: boolean;
    automated: boolean;
  }>(
    sql`
    with history as (
      select ci.id, ci.document_id, ci.materialized_at,
             exists (select 1 from ap_capture_corrections cc
                      where cc.org_id = ci.org_id and cc.capture_item_id = ci.id) as corrected,
             exists (select 1 from audit_log al
                      where al.org_id = ci.org_id and al.table_name = 'documents'
                        and al.row_id = ci.document_id and al.action = 'update') as draft_edited,
             d.status as document_status,
             (d.status = 'voided' or d.void_requested_at is not null) as voided,
             exists (select 1 from ap_capture_events ev
                      where ev.org_id = ci.org_id and ev.capture_item_id = ci.id
                        and ev.event_kind in ('auto_posted', 'auto_post_submitted')) as automated
        from ap_capture_items ci
        join documents d on d.org_id = ci.org_id and d.id = ci.document_id
       where ci.org_id = ${orgId} and ci.vendor_candidate_id = ${vendorId}
         and ci.status = 'materialized' and ci.document_id is not null
         and (${excludeCaptureItemId}::uuid is null or ci.id <> ${excludeCaptureItemId}::uuid)
    ), ranked as (
      select h.*, count(*) filter (where not h.automated)
                    over (order by h.materialized_at desc nulls last, h.id desc) as reviewed_rank
        from history h
    )
    select id as "captureItemId", document_id as "documentId", corrected, draft_edited as "draftEdited",
           document_status as "documentStatus", voided, automated
      from ranked
     where (not automated and reviewed_rank <= ${limit})
        or (automated and reviewed_rank < ${limit} and (voided or corrected or draft_edited))
     order by materialized_at desc nulls last, id desc
  `,
    "objects",
  );
  return rows.map((row) => ({
    captureItemId: row.captureItemId,
    documentId: row.documentId,
    corrected: Boolean(row.corrected),
    draftEdited: Boolean(row.draftEdited),
    documentStatus: row.documentStatus ?? "missing",
    voided: Boolean(row.voided),
    automated: Boolean(row.automated),
  }));
}

/** Trust for one vendor against a streak length, read from capture history. */
export async function vendorCaptureTrust(
  exec: SqlExecutor,
  orgId: string,
  vendorId: string,
  threshold: number,
  excludeCaptureItemId: string | null = null,
): Promise<VendorTrust> {
  const history = await loadVendorCaptureHistory(
    exec,
    orgId,
    vendorId,
    threshold + 1,
    excludeCaptureItemId,
  );
  return evaluateVendorTrust(history, threshold);
}

export type AutoPostSkipReason =
  | "policy_off"
  | "unsigned_email"
  | "not_a_bill"
  | "needs_review"
  | "duplicate"
  | "vendor_unmatched"
  | "vendor_not_trusted"
  | "amount_unreadable"
  | "over_limit"
  | "currency_differs";

export type AutoPostDecision = { eligible: true } | { eligible: false; reason: AutoPostSkipReason };

/**
 * Whether an amount fits the policy's limit. A limit stated in one currency
 * never compares against another, and an unreadable amount never passes.
 */
export function autoPostAmountDecision(
  policy: Pick<AutoPostPolicy, "maxAmount" | "maxAmountCurrency">,
  amount: { total: string | null; currency: string | null },
): AutoPostDecision {
  const total = canonicalDecimal(amount.total, 4);
  if (total === null) return { eligible: false, reason: "amount_unreadable" };
  if (policy.maxAmount !== null) {
    if (!amount.currency || amount.currency !== policy.maxAmountCurrency) {
      return { eligible: false, reason: "currency_differs" };
    }
    if (cmp(total, policy.maxAmount) > 0) return { eligible: false, reason: "over_limit" };
  }
  return { eligible: true };
}

/**
 * Whether a freshly extracted capture may post without review. Every gate
 * fails closed: a capture from any channel other than an upload or a
 * signature-verified email, a capture with any open issue (low-confidence
 * vendor or field, purchase-order exception, math mismatch), a duplicate
 * flag, an unreadable total, or a total over the limit stays in the review
 * queue. The extracted amount is a first screen; the created draft's own
 * total and currency are checked again before it posts.
 */
export function autoPostEligibility(input: {
  policy: AutoPostPolicy | null;
  trust: Pick<VendorTrust, "trusted"> | null;
  capture: {
    status: string;
    documentKind: string;
    /** Intake channel: `upload` (an authenticated user) or `email`. */
    source: string;
    /** For email: the receiving address has a signing secret and this delivery's signature verified. */
    emailVerified: boolean | null;
    vendorId: string | null;
    issues: readonly CaptureIssue[];
    total: string | null;
    currency: string | null;
  };
}): AutoPostDecision {
  const { policy, capture } = input;
  if (!policy?.enabled) return { eligible: false, reason: "policy_off" };
  // The address token alone does not prove who sent an email; only a
  // provider signature does, so unsigned mail always goes to review.
  if (capture.source !== "upload" && capture.emailVerified !== true)
    return { eligible: false, reason: "unsigned_email" };
  if (capture.documentKind !== "vendor_bill") return { eligible: false, reason: "not_a_bill" };
  if (
    capture.status === "duplicate" ||
    capture.issues.some((issue) => issue.code === "possible_duplicate")
  ) {
    return { eligible: false, reason: "duplicate" };
  }
  if (!capture.vendorId) return { eligible: false, reason: "vendor_unmatched" };
  if (capture.status !== "ready" || capture.issues.length > 0)
    return { eligible: false, reason: "needs_review" };
  if (!input.trust?.trusted) return { eligible: false, reason: "vendor_not_trusted" };
  return autoPostAmountDecision(policy, capture);
}

export type VendorTrustSummary = {
  trusted: boolean;
  cleanStreak: number;
  threshold: number;
  policyEnabled: boolean;
  brokenBy: BrokenStreakReason | null;
};

/**
 * A vendor's trust as the vendor record shows it: measured against the
 * streak of the policy version in force, or the default streak when none
 * is. Null when the vendor is not an active vendor of the organization or
 * sits outside the caller's legal-entity scope (org-wide vendors are
 * visible to every scope), so a hidden vendor is indistinguishable from a
 * missing one.
 */
export async function vendorTrustSummary(
  exec: SqlExecutor,
  orgId: string,
  vendorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  onDate: string,
): Promise<VendorTrustSummary | null> {
  const vendor = (
    await exec.execute<{ subsidiaryId: string | null }>(
      sql`
    select p.subsidiary_id as "subsidiaryId" from parties p
      join vendor_roles vr on vr.org_id = p.org_id and vr.party_id = p.id
     where p.org_id = ${orgId} and p.id = ${vendorId}
  `,
      "objects",
    )
  )[0];
  if (!vendor) return null;
  if (
    allowedSubsidiaryIds !== null &&
    vendor.subsidiaryId !== null &&
    !allowedSubsidiaryIds.has(vendor.subsidiaryId)
  )
    return null;
  const policy = await resolveAutoPostPolicy(exec, orgId, onDate);
  const threshold = policy?.cleanStreak ?? DEFAULT_TRUST_STREAK;
  const trust = await vendorCaptureTrust(exec, orgId, vendorId, threshold);
  return {
    trusted: trust.trusted,
    cleanStreak: trust.cleanStreak,
    threshold,
    policyEnabled: policy?.enabled === true,
    brokenBy: trust.brokenBy?.reason ?? null,
  };
}

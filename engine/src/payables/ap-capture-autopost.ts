import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { submitAndReleaseIfUngated } from "../flows/index.ts";
import type { CaptureIssue } from "./ap-capture.ts";
import {
  autoPostAmountDecision,
  autoPostEligibility,
  resolveAutoPostPolicy,
  vendorCaptureTrust,
  type AutoPostPolicy,
  type AutoPostSkipReason,
} from "./ap-capture-trust.ts";

/**
 * Earned auto-post for captured bills.
 *
 * When the organization's policy is on and the vendor has earned trust, a
 * clean capture becomes a draft and then goes through the same submit and
 * post commands a person would use: an approval Flow that gates the bill
 * holds it for approval, and a posting refusal (a closed period, a missing
 * control account) leaves the draft in place with the refusal recorded on
 * the capture. Nothing here posts by a side door.
 *
 * Posting belongs to the ledger, which depends on this module, so the
 * ledger's posting command is registered here at composition time rather
 * than imported. Without a registration the policy refuses explicitly and
 * the bill stays a draft.
 */
export interface CaptureBillPoster {
  /** Post an approved document inside the caller's open organization transaction; returns the journal entry id. */
  post(input: { orgId: string; documentId: string; actorId: string }): Promise<string>;
  /** Run the posting's deferred effects after the transaction commits. */
  afterCommit(documentId: string): Promise<void>;
}

let registeredPoster: CaptureBillPoster | null = null;

export function registerCaptureBillPoster(poster: CaptureBillPoster | null): void {
  registeredPoster = poster;
}

/** The audit reason every auto-post names, so the trail reads without the policy table. */
export function autoPostReason(
  policy: Pick<AutoPostPolicy, "effectiveFrom" | "cleanStreak">,
): string {
  return `Auto-post policy effective ${policy.effectiveFrom}: the vendor's last ${policy.cleanStreak} captured bills were accepted unchanged and posted`;
}

export type CaptureAutoPostOutcome =
  /** No policy version in force, or the version is off: the capture follows the normal path. */
  | { kind: "not_applicable" }
  /** The policy is on but this capture does not qualify; it stays in review. */
  | { kind: "skipped"; reason: AutoPostSkipReason | "actor_not_permitted" }
  | { kind: "posted"; documentId: string; entryId: string }
  | { kind: "pending_approval"; documentId: string; runId: string | null }
  /** Draft creation or posting refused; a created draft remains for review. */
  | { kind: "refused"; documentId: string | null; message: string };

class AutoPostRefusal extends Error {}

/** The created draft's own total or currency falls outside the policy limit. */
class AutoPostLimitRefusal extends AutoPostRefusal {
  constructor(
    readonly reason: AutoPostSkipReason,
    message: string,
  ) {
    super(message);
  }
}

function limitRefusalMessage(
  reason: AutoPostSkipReason,
  draft: { total: string | null; currency: string | null },
  policy: AutoPostPolicy,
): string {
  const amount = `${draft.total ?? "?"} ${draft.currency ?? ""}`.trim();
  const limit = `${policy.maxAmount ?? ""} ${policy.maxAmountCurrency ?? ""}`.trim();
  if (reason === "currency_differs") {
    return `The draft bill is in ${draft.currency ?? "an unknown currency"}, not the policy limit currency ${policy.maxAmountCurrency ?? ""}; it was left as a draft for review.`;
  }
  if (reason === "over_limit")
    return `The draft bill total ${amount} is over the auto-post limit of ${limit}; it was left as a draft for review.`;
  return "The draft bill total could not be read; it was left as a draft for review.";
}

async function recordEvent(
  orgId: string,
  captureItemId: string,
  kind: string,
  detail: Record<string, unknown>,
  actorId: string | null,
) {
  await db.execute(sql`
    insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
    values (${orgId}, ${captureItemId}, ${kind}, ${JSON.stringify(detail)}::jsonb, ${actorId})
  `);
}

/**
 * Decide and, when eligible, carry out the auto-post for one freshly
 * extracted capture. `materialize` is the capture's own draft command, so
 * every draft-creation guard (scope, duplicates, purchase-order match,
 * receiving entity) applies unchanged.
 */
export async function considerCaptureAutoPost(input: {
  orgId: string;
  captureItemId: string;
  actorId: string | null;
  materialize: () => Promise<{ documentId: string }>;
  onDate?: string;
}): Promise<CaptureAutoPostOutcome> {
  const onDate = input.onDate ?? (await businessToday(input.orgId));
  const policy = await resolveAutoPostPolicy(db, input.orgId, onDate);
  if (!policy?.enabled) return { kind: "not_applicable" };
  // An emailed capture is verified only when its delivery's signature
  // verified and the receiving address still has a signing secret.
  const capture = (
    await db.execute<{
      status: string;
      documentKind: string;
      source: string;
      emailVerified: boolean | null;
      vendorId: string | null;
      issues: CaptureIssue[] | null;
      total: string | null;
      currency: string | null;
    }>(
      sql`
    select ci.status, ci.document_kind as "documentKind", ci.source,
           (select im.signature_verified
                   and exists (select 1 from ap_capture_mailbox_credentials c
                                where c.org_id = im.org_id and c.mailbox_id = im.mailbox_id)
              from ap_capture_events ev
              join ap_capture_inbound_messages im
                on im.org_id = ev.org_id and im.id::text = ev.detail->>'inboundMessageId'
             where ev.org_id = ci.org_id and ev.capture_item_id = ci.id and ev.event_kind = 'email_received'
             order by ev.at limit 1) as "emailVerified",
           ci.vendor_candidate_id as "vendorId",
           ci.validation_issues as issues, ci.normalized->>'total' as total, ci.normalized->>'currency' as currency
      from ap_capture_items ci
     where ci.org_id = ${input.orgId} and ci.id = ${input.captureItemId}
  `,
      "objects",
    )
  )[0];
  if (!capture) return { kind: "not_applicable" };
  const trust = capture.vendorId
    ? await vendorCaptureTrust(
        db,
        input.orgId,
        capture.vendorId,
        policy.cleanStreak,
        input.captureItemId,
      )
    : null;
  const decision = autoPostEligibility({
    policy,
    trust,
    capture: {
      ...capture,
      emailVerified: capture.emailVerified === true,
      issues: Array.isArray(capture.issues) ? capture.issues : [],
    },
  });
  const policyEvidence = {
    policyId: policy.id,
    effectiveFrom: policy.effectiveFrom,
    cleanStreak: policy.cleanStreak,
  };
  if (!decision.eligible) {
    await recordEvent(
      input.orgId,
      input.captureItemId,
      "auto_post_skipped",
      {
        ...policyEvidence,
        reason: decision.reason,
        vendorStreak: trust?.cleanStreak ?? 0,
      },
      input.actorId,
    );
    return { kind: "skipped", reason: decision.reason };
  }
  // The capture's owner posts. A policy cannot grant authority the owner
  // lacks: without create and post grants the bill stays in review.
  const actorId = input.actorId;
  if (
    !actorId ||
    !(await actorHasPermission(db, input.orgId, actorId, "ap.create")) ||
    !(await actorHasPermission(db, input.orgId, actorId, "ap.post"))
  ) {
    await recordEvent(
      input.orgId,
      input.captureItemId,
      "auto_post_skipped",
      {
        ...policyEvidence,
        reason: "actor_not_permitted",
      },
      actorId,
    );
    return { kind: "skipped", reason: "actor_not_permitted" };
  }
  const evidence = { ...policyEvidence, trustedCaptureIds: trust!.evidence };
  let documentId: string;
  try {
    documentId = (await input.materialize()).documentId;
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "The draft could not be created";
    await recordEvent(
      input.orgId,
      input.captureItemId,
      "auto_post_refused",
      { ...evidence, stage: "draft", message },
      actorId,
    );
    return { kind: "refused", documentId: null, message };
  }
  const poster = registeredPoster;
  if (!poster) {
    const message =
      "Automatic posting is not available in this process; the bill was left as a draft for review.";
    await recordEvent(
      input.orgId,
      input.captureItemId,
      "auto_post_refused",
      { ...evidence, stage: "post", documentId, message },
      actorId,
    );
    return { kind: "refused", documentId, message };
  }
  const reason = autoPostReason(policy);
  try {
    const outcome = await withOrgTransaction(input.orgId, async () => {
      const locked = (
        await db.execute<{ status: string; total: string | null; currency: string | null }>(
          sql`
        select status, total::text as total, currency from documents
         where org_id = ${input.orgId} and id = ${documentId} for update
      `,
          "objects",
        )
      )[0];
      if (locked?.status !== "draft") {
        throw new AutoPostRefusal(
          `The bill is ${locked?.status ?? "missing"}, not a draft, and was not posted automatically.`,
        );
      }
      // The draft's total and currency come from the capture's own draft
      // command (purchase-order currency, recalculated tax), not the
      // extraction the eligibility screen read; the limit binds what posts.
      const limit = autoPostAmountDecision(policy, locked);
      if (!limit.eligible)
        throw new AutoPostLimitRefusal(
          limit.reason,
          limitRefusalMessage(limit.reason, locked, policy),
        );
      const submission = await submitAndReleaseIfUngated("vendor_bill", documentId, actorId);
      // A Flow that matched but could not route never auto-approves: the
      // rollback leaves the draft untouched and the refusal names the Flow.
      if (submission.flowError) throw new AutoPostRefusal(submission.flowError);
      if (submission.gated) {
        await db.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${input.orgId}, 'documents', ${documentId}, 'submit',
                  ${JSON.stringify({ from: "draft", to: "pending_approval", run_id: submission.runId, auto: true, reason, ...evidence })}::jsonb,
                  ${actorId})
        `);
        await recordEvent(
          input.orgId,
          input.captureItemId,
          "auto_post_submitted",
          { ...evidence, documentId, runId: submission.runId },
          actorId,
        );
        return { kind: "pending_approval" as const, documentId, runId: submission.runId };
      }
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${input.orgId}, 'documents', ${documentId}, 'submit',
                ${JSON.stringify({ from: "draft", to: "approved", auto_approved: true, auto: true, reason, ...evidence })}::jsonb, ${actorId}),
               (${input.orgId}, 'documents', ${documentId}, 'approve',
                ${JSON.stringify({ from: "draft", to: "approved", auto: true, reason: `released without approval: no applicable Flow approval gates. ${reason}`, ...evidence })}::jsonb, ${actorId})
      `);
      const entryId = await poster.post({ orgId: input.orgId, documentId, actorId });
      await recordEvent(
        input.orgId,
        input.captureItemId,
        "auto_posted",
        { ...evidence, documentId, entryId },
        actorId,
      );
      return { kind: "posted" as const, documentId, entryId };
    });
    if (outcome.kind === "posted") {
      // The posting committed; its deferred effects retry through the
      // posting-effects ledger, so a failure here is reported, not undone.
      try {
        await poster.afterCommit(documentId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message.slice(0, 500) : "Posting effects did not complete";
        await recordEvent(
          input.orgId,
          input.captureItemId,
          "auto_post_effects_pending",
          { documentId, message },
          actorId,
        );
      }
    }
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Posting was refused";
    const limitDetail =
      error instanceof AutoPostLimitRefusal
        ? { stage: "limit", reason: error.reason }
        : { stage: "post" };
    await recordEvent(
      input.orgId,
      input.captureItemId,
      "auto_post_refused",
      { ...evidence, ...limitDetail, documentId, message },
      actorId,
    );
    return { kind: "refused", documentId, message };
  }
}

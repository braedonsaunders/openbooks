import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import {
  HrmAuthorizationError,
  requireHrmSelfRead,
  requireHrmSelfRequest,
} from "../authorization.ts";
import {
  createChangeRequestDraft,
  HrmChangeRequestError,
  submitChangeRequest,
  type ChangeRequestDTO,
} from "../change-requests.ts";
import {
  actorPartyOf,
  assertHrmFeatureOn,
  ownEmploymentOrHireRemedy,
  SelfServiceError,
} from "./actor.ts";

import {
  profileChangePayloadSchema,
  type ProfileAddress,
  type ProfileChangePayload,
} from "./profile-schema.ts";
import { inputGuards } from "../input-guards.ts";

/**
 * Self-service profile changes (HR-9).
 *
 * A person proposes changes to their OWN contact fields — phone, personal
 * email, postal address, emergency contact — as a profile_change request
 * through the existing change-request service: same draft lifecycle, same
 * native Flows approval by HR, same decision snapshot. Approval applies
 * the proposal onto the party (and the profile address row) in the same
 * transaction as the approved → applied flip (see applyProfileChange in
 * engine/src/hrm/change-requests.ts), evidenced by a profile_changed
 * employment_changes event carrying exact before-images.
 *
 * The proposal binds one of the actor's OWN employments (for org scope,
 * revision binding, and the approval routing every other kind rides);
 * the party written at apply time is that employment's worker party,
 * re-resolved in-transaction — never a caller-supplied party.
 */

export type { ProfileAddress, ProfileChangePayload };
export { profileChangePayloadSchema };

const { requireOrgId, requireActorId, requireId } = inputGuards(
  (message) => new SelfServiceError("REFUSED", message),
);

function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new SelfServiceError(
      "REFUSED",
      "a profile change needs a reason — HR approves people, not diffs; say what changed",
    );
  }
  return reason.trim();
}

/**
 * Validate a raw profile proposal. Pure: unit-tested without a database.
 * Unknown shapes refuse by name; every zod failure names its field.
 */
export function validateProfileChange(raw: unknown): ProfileChangePayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SelfServiceError(
      "REFUSED",
      "profile changes carry phone, email, address, or emergencyContact — file one of those",
    );
  }
  const parsed = profileChangePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.map(String).join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
    throw new SelfServiceError("REFUSED", `profile change refused: ${fields}`);
  }
  return parsed.data;
}

export interface FileProfileChangeQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly changes: unknown;
  readonly reason: unknown;
}

export interface FileProfileChangeResult {
  readonly request: ChangeRequestDTO;
}

/**
 * The submit-step refusal for a stored profile draft. Curated domain
 * refusals (self-service, authorization, change-request) carry their
 * remedy, so they keep it beside the saved-draft framing. Anything else —
 * a driver or constraint failure — must never render table names,
 * parameters, or snapshots to the employee: it is logged server-side and
 * refused with one stable message naming the draft to retry.
 */
export function profileSubmitRefusal(requestId: string, error: unknown): SelfServiceError {
  if (
    error instanceof SelfServiceError ||
    error instanceof HrmAuthorizationError ||
    error instanceof HrmChangeRequestError
  ) {
    return new SelfServiceError(
      "REFUSED",
      `the profile draft ${requestId} is saved but submission was refused: ${error.message}`,
    );
  }
  console.error("[hrm] profile change submission failed:", error);
  return new SelfServiceError(
    "REFUSED",
    `the profile draft ${requestId} is saved but the change could not be filed — retry the submission, and ask HR if it keeps failing`,
  );
}

/**
 * File a profile proposal and submit it for HR approval in one user
 * action. Two governed steps in two transactions: the draft commits
 * first, then the submit binds the approval run in its own transaction.
 * A submit refusal (an invalid configured Flow or a race on the
 * employment) does NOT roll the stored draft back with it: the throw
 * names the remedy and carries the draft id, so the caller renders the
 * refusal beside the saved draft instead of losing the person's work —
 * one user action, no silent partial effect.
 */
export async function fileProfileChangeRequest(
  query: FileProfileChangeQuery,
): Promise<FileProfileChangeResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  const changes = validateProfileChange(query.changes);
  const reason = requireReason(query.reason);
  // The draft commits on its own so a later submit refusal keeps the
  // person's work: the submit below runs outside this transaction, in
  // the transaction submitChangeRequest opens itself.
  const request = await withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId, actorId);
    await requireHrmSelfRequest(db, orgId, actorId);
    await actorPartyOf(db, orgId, actorId);
    // The service re-checks the self.request gate and the own-employment
    // binding kind-aware at create and at submit; this pre-check fails
    // fast with the self-service remedy before any draft exists.
    await ownEmploymentOrHireRemedy(db, { orgId, actorId, employmentId });
    return createChangeRequestDraft({
      orgId,
      actorId,
      employmentId,
      payload: { ...changes },
    });
  });
  try {
    const submitted = await submitChangeRequest({ orgId, actorId, requestId: request.id, reason });
    return { request: submitted };
  } catch (error) {
    throw profileSubmitRefusal(request.id, error);
  }
}

// --- Application contract (implemented in change-requests.ts) --------------
//
// applyProfileChange (in the change-request service, beside every other
// apply branch) resolves the request employment's worker party
// in-transaction and writes:
//   parties.phone / parties.email / parties.emergency_contact — scalar per
//     the payload (a provided null clears; a missing key is untouched),
//     each conditional write asserting its row count;
//   addresses — the profile address row (the same default-billing-else-
//     latest pick loadMyAddress makes): updated in place when one exists,
//     inserted when none does, full replacement of the six fields;
//   one employment_changes event (change_kind 'profile_changed', 0198)
//     with the exact party/address before-images, then the applied link
//     and the aggregate revision bump — all in the one approval
//     transaction, so a throw rolls the party write back with the flip.

export interface ProfileApplication {
  readonly phone: string | null | undefined;
  readonly email: string | null | undefined;
  readonly address: ProfileAddress | undefined;
  readonly emergencyContact:
    { name: string | null; relationship: string | null; phone: string | null } | null | undefined;
}

/** The current profile state an application diffs against. */

/** Today's civil date for the team/self as-of reads that share it. */

/** The self.read gate for route-level composition. */
export async function requireSelfRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<void> {
  await requireHrmSelfRead(exec, orgId, actorId);
}

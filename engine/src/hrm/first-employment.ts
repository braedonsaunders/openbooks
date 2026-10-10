import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  createChangeRequestDraft,
  HrmChangeRequestError,
  submitChangeRequest,
} from "./change-requests.ts";
import { inputGuards } from "./input-guards.ts";
import { isCivilDate, makeEffectiveInterval } from "./temporal.ts";

/**
 * A person's first employment (the Hire action).
 *
 * Employee parties exist before employments do: the roster shows the
 * person while headcount, assignments, leave, and payroll wait for the
 * governed employment record. No change request can name an employment
 * that does not exist yet, so this service mints the version-less
 * reserved identity (worker_party_id plus the employing legal entity at
 * revision 1, exactly as the recruiting hire does) and files the hire
 * through the existing change-request service in ONE transaction — a
 * refusal rolls the identity, the draft, and the submission back together,
 * so a failed hire leaves no reserved shell behind.
 *
 * Approval stays native: the draft submits through Flows exactly as a
 * manually proposed hire. A flow with approval steps gates it
 * (pending_approval, decided in the queue); a flow with the
 * apply-without-approval outcome applies it at once with an automatic
 * snapshot; with no flow configured the submission refuses NO_FLOW naming
 * the remedy, like every other change kind. Every application runs the
 * same canonical writer with its reason, so the first effective version,
 * the onboarding checklist, and the employment change event are identical
 * however the request was decided.
 */

const HIRE_STATUSES = ["offered", "active", "on_leave", "suspended"] as const;

export type FirstHireStatus = (typeof HIRE_STATUSES)[number];

export interface ProposeFirstEmploymentQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** The employee person this hire records — an active party with the employee role. */
  readonly workerPartyId: string;
  /** The employing legal entity — required; the employment model carries no default. */
  readonly employerSubsidiaryId: string;
  readonly status?: FirstHireStatus | string;
  /** First effective day, a real YYYY-MM-DD calendar date. */
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  /** Why the person is hired — required; evidence without a reason never applies. */
  readonly reason: unknown;
  readonly action?: string | null;
  readonly reasonCode?: string | null;
}

export interface FirstEmploymentResult {
  readonly employmentId: string;
  readonly workerPartyId: string;
  readonly changeRequestId: string;
  readonly status: "pending_approval" | "applied";
  /** True once an effective version is readable through the native record path. */
  readonly applied: boolean;
}

const { requireOrgId, requireActorId, requireUuid } = inputGuards(
  (message) => new HrmChangeRequestError("REFUSED", message),
);

function requireHireStatus(value: unknown): FirstHireStatus {
  if (typeof value !== "string" || !(HIRE_STATUSES as readonly string[]).includes(value)) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      `status must be one of ${(HIRE_STATUSES as readonly string[]).join(", ")} — hire as offered or active, then file a status change or termination`,
    );
  }
  return value as FirstHireStatus;
}

function requireEffectiveWindow(effectiveFrom: unknown, effectiveTo: unknown): { from: string; to: string | null } {
  if (typeof effectiveFrom !== "string" || !isCivilDate(effectiveFrom)) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "effectiveFrom must be a real YYYY-MM-DD calendar date in years 0001 through 9999 — name the person's first effective day",
    );
  }
  const to = effectiveTo === undefined ? null : effectiveTo;
  if (to !== null && (typeof to !== "string" || !isCivilDate(to))) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "effectiveTo must be a real YYYY-MM-DD calendar date in years 0001 through 9999, or omitted for an open-ended employment",
    );
  }
  try {
    makeEffectiveInterval(effectiveFrom, to);
  } catch (error) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      `${error instanceof Error ? error.message : String(error)} — fix the effective window and hire again`,
    );
  }
  return { from: effectiveFrom, to };
}

function requireHireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "a hire carries a non-blank reason — record why the person is hired",
    );
  }
  return reason.trim();
}

export async function proposeFirstEmployment(query: ProposeFirstEmploymentQuery): Promise<FirstEmploymentResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const workerPartyId = requireUuid(query.workerPartyId, "workerPartyId");
  const employerSubsidiaryId = requireUuid(query.employerSubsidiaryId, "employerSubsidiaryId");
  const status = query.status === undefined ? "active" : requireHireStatus(query.status);
  const window = requireEffectiveWindow(query.effectiveFrom, query.effectiveTo);
  const reason = requireHireReason(query.reason);

  return withOrgTransaction(orgId, async () => {
    const party = (await db.execute<{ id: string; kind: string; isActive: boolean }>(sql`
      select id, kind, is_active as "isActive" from parties
       where org_id = ${orgId} and id = ${workerPartyId}
    `)).rows[0];
    if (!party || !party.isActive) {
      throw new HrmChangeRequestError(
        "NOT_FOUND",
        "the person was not found in this organization — open the employee record and hire from there",
      );
    }
    if (party.kind !== "person") {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "a hire records a person — company parties cannot hold employments; open the person's employee record instead",
      );
    }
    const role = (await db.execute<{ one: number }>(sql`
      select 1 as one from employee_roles
       where org_id = ${orgId} and party_id = ${workerPartyId} and is_active
    `)).rows[0];
    if (!role) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this person holds no active employee role — give the party the employee role, then hire",
      );
    }
    const subsidiary = (await db.execute<{ id: string; isActive: boolean }>(sql`
      select id, is_active as "isActive" from subsidiaries
       where org_id = ${orgId} and id = ${employerSubsidiaryId}
    `)).rows[0];
    if (!subsidiary || !subsidiary.isActive) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "the legal entity is not visible in this organization — choose an employing entity of this organization",
      );
    }
    // A duplicate active employment is a refusal, never a second row: an
    // employment with live non-terminated history already answers headcount,
    // leave, and payroll for this person. Fully terminated history (or a
    // version-less shell from an interrupted hire) is not active — a rehire
    // mints or reuses an identity below.
    const duplicate = (await db.execute<{ id: string }>(sql`
      select e.id from worker_employments e
       where e.org_id = ${orgId} and e.worker_party_id = ${workerPartyId}
         and exists (
           select 1 from worker_employment_versions v
            where v.org_id = e.org_id and v.employment_id = e.id
              and v.recorded_until is null and v.status <> 'terminated'
         )
       limit 1
    `)).rows[0];
    if (duplicate) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "this person already has an active employment — open the employment record and file a status change instead of hiring again",
      );
    }
    // Reuse a version-less shell for the same entity (an interrupted hire
    // left exactly this behind); otherwise mint the reserved identity the
    // hire change requires. A shell for another entity stays untouched —
    // the hire names its own employer.
    const shell = (await db.execute<{ id: string }>(sql`
      select e.id from worker_employments e
       where e.org_id = ${orgId} and e.worker_party_id = ${workerPartyId}
         and e.employer_subsidiary_id = ${employerSubsidiaryId}
         and not exists (
           select 1 from worker_employment_versions v
            where v.org_id = e.org_id and v.employment_id = e.id
         )
       limit 1
    `)).rows[0];
    let employmentId = shell?.id ?? null;
    if (employmentId === null) {
      employmentId = randomUUID();
      const reserved = (await db.execute<{ id: string }>(sql`
        insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision, created_by, updated_by)
        values (${employmentId}, ${orgId}, ${workerPartyId}, ${employerSubsidiaryId}, 1, ${actorId}, ${actorId})
        returning id
      `)).rows[0];
      if (!reserved) {
        throw new HrmChangeRequestError(
          "REFUSED",
          "the employment was not stored — no row was written; retry the hire",
        );
      }
      const audited = (await db.execute<{ id: string }>(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'worker_employments', ${employmentId}, 'insert',
                ${JSON.stringify({
                  before: null,
                  after: { workerPartyId, employerSubsidiaryId },
                  reason,
                })}::jsonb, ${actorId})
        returning id
      `)).rows;
      if (audited.length !== 1) {
        throw new HrmChangeRequestError(
          "REFUSED",
          "the employment could not be audited — nothing was stored; retry the hire",
        );
      }
    } else {
      const openProposal = (await db.execute<{ id: string }>(sql`
        select id from hrm_employment_change_requests
         where org_id = ${orgId} and employment_id = ${employmentId}
           and status in ('draft', 'pending_approval')
           and payload ->> 'kind' = 'hire'
         limit 1
      `)).rows[0];
      if (openProposal) {
        throw new HrmChangeRequestError(
          "BAD_STATE",
          "a hire proposal is already open for this person — continue it from the change-request queue instead of filing again",
        );
      }
    }
    // The hire itself rides the existing service: draft, then submit through
    // Flows exactly as a manually proposed hire. Both join THIS transaction,
    // so a refusal rolls the identity, the draft, and the submission back
    // together — a failed hire leaves no shell behind.
    const draft = await createChangeRequestDraft({
      orgId,
      actorId,
      employmentId,
      payload: { kind: "hire", status, effectiveFrom: window.from, effectiveTo: window.to },
      ...(query.action !== undefined ? { action: query.action } : {}),
      ...(query.reasonCode !== undefined ? { reasonCode: query.reasonCode } : {}),
    });
    const submitted = await submitChangeRequest({ orgId, actorId, requestId: draft.id, reason });
    if (submitted.status !== "pending_approval" && submitted.status !== "applied") {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the hire change request reached an unexpected state — reload the employee record and try again",
      );
    }
    const statusAfter = submitted.status === "applied" ? "applied" : "pending_approval";
    return {
      employmentId,
      workerPartyId,
      changeRequestId: submitted.id,
      status: statusAfter,
      applied: statusAfter === "applied",
    };
  });
}

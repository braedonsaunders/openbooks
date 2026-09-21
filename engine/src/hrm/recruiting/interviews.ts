import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import {
  requireHrmRecruitingManage,
  requireOwnRequisitionForHiringManager,
} from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { requireActorId, requireId, requireOrgId } from "./input.ts";
import { loadApplication } from "./applications.ts";

/**
 * Canonical recruiting interview service (HR-6, 0195): one sitting per row
 * with a panel, an outcome on completion, and optional scorecard. The
 * application must be active; every panel member must be an employee the
 * actor can see (a worker_employment in the org whose legal entity is
 * inside the actor's subsidiary scope). Completed interviews are immutable
 * except a pure audit touch; deletes only on the governed amend path.
 */

export const INTERVIEW_KINDS = ["phone", "video", "onsite", "panel", "assessment"] as const;
export type InterviewKind = (typeof INTERVIEW_KINDS)[number];

export const INTERVIEW_STATUSES = ["scheduled", "completed", "cancelled", "no_show"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const INTERVIEW_OUTCOMES = ["advance", "hold", "reject"] as const;
export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number];

export interface InterviewDTO {
  readonly id: string;
  readonly applicationId: string;
  readonly kind: InterviewKind;
  readonly scheduledAt: string;
  readonly durationMinutes: number | null;
  readonly location: string | null;
  readonly status: InterviewStatus;
  readonly outcome: InterviewOutcome | null;
  readonly feedback: string | null;
  readonly scorecard: unknown;
  readonly completedAt: string | null;
  readonly panelPartyIds: readonly string[];
}

type InterviewRow = {
  id: string;
  applicationId: string;
  kind: string;
  scheduledAt: string;
  durationMinutes: number | null;
  location: string | null;
  status: string;
  outcome: string | null;
  feedback: string | null;
  scorecard: unknown;
  completedAt: string | null;
};

const INTERVIEW_COLUMNS = sql`
  id, application_id as "applicationId", kind,
  scheduled_at as "scheduledAt", duration_minutes as "durationMinutes",
  location, status, outcome, feedback, scorecard,
  completed_at as "completedAt"
`;

async function panelFor(exec: SqlExecutor, orgId: string, interviewId: string): Promise<string[]> {
  const rows = (await exec.execute<{ partyId: string }>(sql`
    select party_id as "partyId" from hrm_interview_panel
     where org_id = ${orgId} and interview_id = ${interviewId} order by party_id
  `)).rows;
  return rows.map((row) => row.partyId);
}

function toDTO(row: InterviewRow, panelPartyIds: readonly string[]): InterviewDTO {
  if (!(INTERVIEW_KINDS as readonly string[]).includes(row.kind)) {
    throw new RecruitingError("REFUSED", `interview ${row.id} carries unknown kind ${row.kind} — refusing a sitting the service cannot resolve`);
  }
  if (!(INTERVIEW_STATUSES as readonly string[]).includes(row.status)) {
    throw new RecruitingError("REFUSED", `interview ${row.id} carries unknown status ${row.status} — refusing a lifecycle the service cannot resolve`);
  }
  return {
    ...row,
    kind: row.kind as InterviewKind,
    status: row.status as InterviewStatus,
    outcome: (row.outcome ?? null) as InterviewOutcome | null,
    panelPartyIds,
  };
}

async function requireInterviewManage(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  requisitionId: string,
): Promise<void> {
  try {
    await requireHrmRecruitingManage(exec, orgId, actorId, requisitionId);
  } catch {
    await requireOwnRequisitionForHiringManager(exec, orgId, actorId, requisitionId);
  }
}

/**
 * Prove every panel member is an employee the actor can see: a
 * worker_employments row in the org whose employer sits inside the actor's
 * subsidiary scope (null scope = unrestricted). A panel of strangers is
 * refused by name, never scheduled around.
 */
async function assertPanelVisible(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  panelPartyIds: readonly string[],
): Promise<void> {
  if (panelPartyIds.length === 0) return;
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  for (const partyId of panelPartyIds) {
    const row = (await exec.execute<{ employerSubsidiaryId: string | null }>(sql`
      select employer_subsidiary_id as "employerSubsidiaryId"
        from worker_employments
       where org_id = ${orgId} and worker_party_id = ${partyId}
       order by created_at limit 1
    `)).rows[0];
    if (!row?.employerSubsidiaryId) {
      throw new RecruitingError(
        "REFUSED",
        "a panel member is not an employee in this organization — seat only employees the interview can be shared with",
      );
    }
    if (allowed !== null && !allowed.has(row.employerSubsidiaryId)) {
      throw new RecruitingError(
        "REFUSED",
        "a panel member sits in a legal entity outside your scope — seat only employees visible to you",
      );
    }
  }
}

export interface ScheduleInterviewQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly applicationId: string;
  readonly kind: unknown;
  readonly scheduledAt: unknown;
  readonly durationMinutes?: unknown;
  readonly location?: unknown;
  readonly panelPartyIds?: unknown;
  // HR-18: the structured-interview kit this sitting runs (optional; when
  // set, draft scorecards are created for each panel member).
  readonly kitId?: unknown;
  // HR-18: per-panelist focus attribute pins (party id → attribute ids).
  readonly panelFocus?: Readonly<Record<string, readonly string[]>>;
}

/** Schedule a sitting on an active application (event recorded in the same transaction). */
export async function scheduleInterview(query: ScheduleInterviewQuery): Promise<InterviewDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const applicationId = requireId(query.applicationId, "applicationId");
  if (typeof query.kind !== "string" || !(INTERVIEW_KINDS as readonly string[]).includes(query.kind)) {
    throw new RecruitingError("INVALID_INPUT", `interview kind must be one of ${INTERVIEW_KINDS.join(", ")} — check the kind`);
  }
  if (typeof query.scheduledAt !== "string" || query.scheduledAt.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "scheduledAt must be a non-empty instant");
  }
  const durationMinutes =
    query.durationMinutes === undefined || query.durationMinutes === null
      ? null
      : typeof query.durationMinutes === "number" && Number.isInteger(query.durationMinutes) && query.durationMinutes > 0
        ? query.durationMinutes
        : (() => {
            throw new RecruitingError("INVALID_INPUT", "durationMinutes is a positive integer of minutes when sent");
          })();
  const location =
    query.location === undefined || query.location === null || query.location === ""
      ? null
      : typeof query.location === "string" && query.location.trim().length > 0
        ? query.location.trim()
        : (() => {
            throw new RecruitingError("INVALID_INPUT", "location must be non-blank when sent");
          })();
  const panelPartyIds =
    query.panelPartyIds === undefined || query.panelPartyIds === null
      ? []
      : Array.isArray(query.panelPartyIds) &&
          query.panelPartyIds.every((id) => typeof id === "string" && id.length > 0)
        ? [...new Set(query.panelPartyIds as string[])]
        : (() => {
            throw new RecruitingError("INVALID_INPUT", "panelPartyIds must be an array of party ids");
          })();

  return withOrgTransaction(orgId, async () => {
    const application = await loadApplication(db, orgId, applicationId);
    if (!application) {
      throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    }
    await requireInterviewManage(db, orgId, actorId, application.requisitionId);
    if (application.status !== "active") {
      throw new RecruitingError(
        "BAD_STATE",
        `a ${application.status} application takes no new interviews — only active candidacies interview`,
      );
    }
    await assertPanelVisible(db, orgId, actorId, panelPartyIds);
    // HR-18: an optional kit pins the sitting's scorecard vocabulary. The
    // kit must be live and visible; focus pins must name attributes of
    // that kit (validated against the subject — the kit — not only the
    // declaration).
    const kitId = query.kitId == null ? null : requireId(query.kitId, "kitId");
    if (kitId) {
      const { loadKit, listKitAttributes } = await import("./kits.ts");
      const kit = await loadKit(db, orgId, kitId);
      if (!kit) {
        throw new RecruitingError("NOT_FOUND", "interview kit is not visible in this organization");
      }
      if (!kit.isActive) {
        throw new RecruitingError(
          "REFUSED",
          `kit ${kit.name} is retired — reactivate it in Setup or schedule without a kit instead of running a retired kit`,
        );
      }
      const valid = new Set((await listKitAttributes(db, orgId, kitId)).map((attr) => attr.id));
      for (const focusIds of Object.values(query.panelFocus ?? {})) {
        for (const attributeId of focusIds ?? []) {
          if (!valid.has(attributeId)) {
            throw new RecruitingError(
              "INVALID_INPUT",
              `focus attribute ${attributeId} is not on kit ${kit.name} — pin the kit's attributes instead of inventing one`,
            );
          }
        }
      }
    }
    const inserted = (await db.execute<InterviewRow>(sql`
      insert into hrm_interviews
        (org_id, application_id, kind, scheduled_at, duration_minutes, location,
         kit_id, status, created_by, updated_by)
      values (${orgId}, ${applicationId}, ${query.kind as string},
              ${query.scheduledAt as string}::timestamptz, ${durationMinutes}, ${location},
              ${kitId}, 'scheduled', ${actorId}, ${actorId})
      returning ${INTERVIEW_COLUMNS}
    `)).rows[0];
    if (!inserted) {
      throw new RecruitingError("REFUSED", "the interview was not stored — no row was written; retry the request");
    }
    for (const partyId of panelPartyIds) {
      const focusIds = query.panelFocus?.[partyId] ?? null;
      const { pgUuidArray } = await import("./depth.ts");
      await db.execute(sql`
        insert into hrm_interview_panel (org_id, interview_id, party_id, focus_attribute_ids, created_by, updated_by)
        values (${orgId}, ${inserted.id}, ${partyId}, ${focusIds === null ? null : pgUuidArray([...focusIds])}::uuid[], ${actorId}, ${actorId})
      `);
    }
    // HR-18: scorecard shells for every panel member, same transaction —
    // a sitting with a kit always has its verdict rows; a sitting without
    // a kit keeps the HR-6 shape (no shells).
    if (kitId && panelPartyIds.length > 0) {
      const { ensurePanelScorecards } = await import("./scorecards.ts");
      await ensurePanelScorecards({ orgId, actorId, interviewId: inserted.id });
    }
    return toDTO(inserted, panelPartyIds);
  });
}

export interface CompleteInterviewQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly interviewId: string;
  readonly outcome: unknown;
  readonly feedback?: unknown;
  readonly scorecard?: unknown;
}

/** Complete a sitting with its verdict (event-free: the verdict lives on the row). */
export async function completeInterview(query: CompleteInterviewQuery): Promise<InterviewDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const interviewId = requireId(query.interviewId, "interviewId");
  if (typeof query.outcome !== "string" || !(INTERVIEW_OUTCOMES as readonly string[]).includes(query.outcome)) {
    throw new RecruitingError("INVALID_INPUT", `interview outcome must be one of ${INTERVIEW_OUTCOMES.join(", ")} — check the outcome`);
  }
  return withOrgTransaction(orgId, async () => {
    const row = (await db.execute<InterviewRow & { requisitionId: string }>(sql`
      select i.id, i.application_id as "applicationId", i.kind,
             i.scheduled_at as "scheduledAt", i.duration_minutes as "durationMinutes",
             i.location, i.status, i.outcome, i.feedback, i.scorecard,
             i.completed_at as "completedAt", a.requisition_id as "requisitionId"
        from hrm_interviews i
        join hrm_applications a on a.org_id = i.org_id and a.id = i.application_id
       where i.org_id = ${orgId} and i.id = ${interviewId} for update
    `)).rows[0];
    if (!row) {
      throw new RecruitingError("NOT_FOUND", "interview is not visible in this organization");
    }
    await requireInterviewManage(db, orgId, actorId, row.requisitionId);
    if (row.status !== "scheduled") {
      throw new RecruitingError(
        "BAD_STATE",
        `a ${row.status} interview cannot be completed — only scheduled sittings complete`,
      );
    }
    const updated = (await db.execute<InterviewRow>(sql`
      update hrm_interviews
         set status = 'completed', outcome = ${query.outcome as string},
             feedback = ${typeof query.feedback === "string" ? query.feedback : null},
             scorecard = ${query.scorecard === undefined ? null : JSON.stringify(query.scorecard)}::jsonb,
             completed_at = now(), updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${interviewId} and status = 'scheduled'
      returning ${INTERVIEW_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError("STALE_REVISION", "the interview changed while completing — reload it and try again");
    }
    return toDTO(updated, await panelFor(db, orgId, interviewId));
  });
}

export interface CancelInterviewQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly interviewId: string;
}

/** Cancel a scheduled sitting (completed sittings stand as recorded). */
export async function cancelInterview(query: CancelInterviewQuery): Promise<InterviewDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const interviewId = requireId(query.interviewId, "interviewId");
  return withOrgTransaction(orgId, async () => {
    const row = (await db.execute<InterviewRow & { requisitionId: string }>(sql`
      select i.id, i.application_id as "applicationId", i.kind,
             i.scheduled_at as "scheduledAt", i.duration_minutes as "durationMinutes",
             i.location, i.status, i.outcome, i.feedback, i.scorecard,
             i.completed_at as "completedAt", a.requisition_id as "requisitionId"
        from hrm_interviews i
        join hrm_applications a on a.org_id = i.org_id and a.id = i.application_id
       where i.org_id = ${orgId} and i.id = ${interviewId} for update
    `)).rows[0];
    if (!row) {
      throw new RecruitingError("NOT_FOUND", "interview is not visible in this organization");
    }
    await requireInterviewManage(db, orgId, actorId, row.requisitionId);
    if (row.status !== "scheduled") {
      throw new RecruitingError(
        "BAD_STATE",
        `a ${row.status} interview cannot be cancelled — completed sittings stand as recorded`,
      );
    }
    const updated = (await db.execute<InterviewRow>(sql`
      update hrm_interviews
         set status = 'cancelled', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${interviewId} and status = 'scheduled'
      returning ${INTERVIEW_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError("STALE_REVISION", "the interview changed while cancelling — reload it and try again");
    }
    return toDTO(updated, await panelFor(db, orgId, interviewId));
  });
}

import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { businessToday } from "../../platform/business-date.ts";
import { requireHrmPerformanceOnEmployment, requireHrmRetentionRead } from "../authorization.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { HrmPerformanceError, isUniqueViolationOn, mathRefusal } from "./errors.ts";
import { parseCivilDay } from "./performance-math.ts";

/**
 * Governed HRM exit records (0196, HR-7): one per terminated employment.
 * Recorded by HR (hrm.performance.manage over the employment's employer);
 * read through hrm.retention.read (see performance-read.ts). Refused when
 * the employment has no termination version as of today — the exit record
 * describes a termination, and an unterminated employment has none to
 * describe. Correct the record with an update; deletes are refused by
 * trigger.
 *
 * The offboarding checklist link the brief asks for was checked and is NOT
 * wired: 0193's step evidence vocabulary is none/acknowledgement/
 * attachment, and making an "exit interview" step consult this record would
 * change 0193's completion semantics from inside another slice. The
 * retention panel surfaces terminated employments without an exit record
 * and exit records without an interview instead — the same gap, visible
 * without touching the checklist contract.
 *
 * Do not touch packages/payroll. Existing refusal classes are untouched.
 */

export type ExitReasonKind =
  | "resignation"
  | "retirement"
  | "end_of_contract"
  | "dismissal"
  | "redundancy"
  | "mutual"
  | "death"
  | "other";

const EXIT_REASONS = [
  "resignation",
  "retirement",
  "end_of_contract",
  "dismissal",
  "redundancy",
  "mutual",
  "death",
  "other",
] as const;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a uuid`);
  }
  return value;
}

async function assertPerformanceFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before recording exits",
    );
  }
}

export interface ExitRecordDTO {
  readonly id: string;
  readonly employmentId: string;
  readonly terminationChangeId: string | null;
  readonly reasonKind: ExitReasonKind;
  readonly isVoluntary: boolean;
  readonly isRegrettable: boolean | null;
  readonly wouldRehire: boolean | null;
  readonly interviewHeldOn: string | null;
  readonly interviewerPartyId: string | null;
  readonly destination: string | null;
  readonly notes: string | null;
  readonly recordedBy: string | null;
  readonly recordedAt: string;
}

type StoredExit = {
  id: string;
  employmentId: string;
  employerSubsidiaryId: string;
  terminationChangeId: string | null;
  reasonKind: string;
  isVoluntary: boolean;
  isRegrettable: boolean | null;
  wouldRehire: boolean | null;
  interviewHeldOn: string | null;
  interviewerPartyId: string | null;
  destination: string | null;
  notes: string | null;
  recordedBy: string | null;
  recordedAt: string;
};

function toExitDTO(row: StoredExit): ExitRecordDTO {
  if (!(EXIT_REASONS as readonly string[]).includes(row.reasonKind)) {
    throw new HrmPerformanceError("BAD_STATE", `exit record ${row.id} carries an unknown reason`);
  }
  return {
    id: row.id,
    employmentId: row.employmentId,
    terminationChangeId: row.terminationChangeId,
    reasonKind: row.reasonKind as ExitReasonKind,
    isVoluntary: row.isVoluntary,
    isRegrettable: row.isRegrettable,
    wouldRehire: row.wouldRehire,
    interviewHeldOn: row.interviewHeldOn,
    interviewerPartyId: row.interviewerPartyId,
    destination: row.destination,
    notes: row.notes,
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt,
  };
}

async function loadExit(exec: SqlExecutor, orgId: string, exitId: string): Promise<StoredExit> {
  const row = (await exec.execute<StoredExit>(sql`
    select x.id,
           x.employment_id as "employmentId",
           e.employer_subsidiary_id as "employerSubsidiaryId",
           x.termination_change_id as "terminationChangeId",
           x.reason_kind as "reasonKind",
           x.is_voluntary as "isVoluntary",
           x.is_regrettable as "isRegrettable",
           x.would_rehire as "wouldRehire",
           x.interview_held_on::text as "interviewHeldOn",
           x.interviewer_party_id as "interviewerPartyId",
           x.destination, x.notes,
           x.recorded_by as "recordedBy",
           x.recorded_at as "recordedAt"
      from hrm_exit_records x
      join worker_employments e
        on e.org_id = x.org_id and e.id = x.employment_id
     where x.org_id = ${orgId} and x.id = ${exitId}
  `)).rows[0];
  if (!row) {
    throw new HrmPerformanceError(
      "NOT_FOUND",
      `exit record ${exitId} is not visible in this organization — check the id or the organization`,
    );
  }
  return row;
}

/**
 * Retention reads act through the retention grant, so the exit's
 * employment must sit inside the actor's allowed subsidiary set — a
 * legal-entity-restricted HR reads only the exits they cover. Answered
 * NOT_FOUND uniformly, so an out-of-scope id is indistinguishable from a
 * missing one.
 */
function assertExitInScope(allowed: Set<string> | null, exit: StoredExit): void {
  if (allowed === null) return;
  if (!allowed.has(exit.employerSubsidiaryId)) {
    throw new HrmPerformanceError(
      "NOT_FOUND",
      `exit record ${exit.id} is not visible in this organization — check the id or the organization`,
    );
  }
}

/**
 * The employment's currently-asserted termination as of today: exactly one
 * applicable version and its status is terminated. Anything else refuses by
 * name — the exit record describes a termination that does not exist yet.
 */
async function requireTerminatedAsOfToday(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  today: string,
): Promise<void> {
  const versions = (await exec.execute<{ status: string }>(sql`
    select status from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
       and recorded_until is null
       and effective_from <= ${today}::date
       and (effective_to is null or effective_to > ${today}::date)
  `)).rows;
  if (versions.length === 0) {
    throw new HrmPerformanceError(
      "REFUSED",
      `employment ${employmentId} has no applicable version as of ${today} — resolve its employment history before recording an exit`,
    );
  }
  if (versions.length > 1) {
    throw new HrmPerformanceError(
      "REFUSED",
      `employment ${employmentId} has ${versions.length} applicable versions as of ${today} — correct the overlapping versions with an HRM employment change request before recording an exit; refusing to pick one`,
    );
  }
  if (versions[0]!.status !== "terminated") {
    throw new HrmPerformanceError(
      "REFUSED",
      `employment ${employmentId} is ${versions[0]!.status} as of ${today}, not terminated — terminate it through an approved HRM employment change request before recording an exit`,
    );
  }
}

export interface RecordExitInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly terminationChangeId?: string | null;
  readonly reasonKind: ExitReasonKind;
  readonly isVoluntary: boolean;
  readonly isRegrettable?: boolean | null;
  readonly wouldRehire?: boolean | null;
  readonly interviewHeldOn?: string | null;
  readonly interviewerPartyId?: string | null;
  readonly destination?: string | null;
  readonly notes?: string | null;
}

/** Record the exit for a terminated employment. One per employment. */
export async function recordExit(input: RecordExitInput): Promise<ExitRecordDTO> {
  const orgId = requireId("orgId", input.orgId);
  const actorId = requireId("actorId", input.actorId);
  const employmentId = requireId("employmentId", input.employmentId);
  if (!(EXIT_REASONS as readonly string[]).includes(input.reasonKind)) {
    throw new HrmPerformanceError(
      "INVALID_INPUT",
      `reasonKind must be one of ${EXIT_REASONS.join(", ")}, got ${JSON.stringify(input.reasonKind)}`,
    );
  }
  if (typeof input.isVoluntary !== "boolean") {
    throw new HrmPerformanceError("INVALID_INPUT", "isVoluntary must be a boolean");
  }
  const interviewHeldOn =
    input.interviewHeldOn == null
      ? null
      : mathRefusal("INVALID_INPUT", () => parseCivilDay(input.interviewHeldOn as string, "interview date"));
  const interviewerPartyId =
    input.interviewerPartyId == null ? null : requireId("interviewerPartyId", input.interviewerPartyId);
  // The interview is a pair (held date with interviewer): a date without a
  // named interviewer, or an interviewer without a date, is refused by name
  // before storage pins it.
  if ((interviewHeldOn === null) !== (interviewerPartyId === null)) {
    throw new HrmPerformanceError(
      "REFUSED",
      `exit interview needs both the held date and the interviewer — record them together, or neither when no interview was held`,
    );
  }
  const terminationChangeId =
    input.terminationChangeId == null ? null : requireId("terminationChangeId", input.terminationChangeId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    await requireHrmPerformanceOnEmployment(db, orgId, actorId, employmentId, "hrm.performance.manage");
    const today = await businessToday(orgId);
    await requireTerminatedAsOfToday(db, orgId, employmentId, today);
    if (terminationChangeId !== null) {
      const change = (await db.execute<{ id: string }>(sql`
        select id from employment_changes where org_id = ${orgId} and id = ${terminationChangeId}
      `)).rows[0];
      if (!change) {
        throw new HrmPerformanceError(
          "NOT_FOUND",
          `employment change ${terminationChangeId} is not visible in this organization — link the terminating change, or leave it unlinked`,
        );
      }
      // The link is provenance for THIS exit: the change must belong to
      // the same employment and must itself be the termination — linking
      // another employment's change, or a non-terminating change, would
      // misattribute the exit forever.
      const terminating = (await db.execute<{ id: string }>(sql`
        select id from employment_changes
         where org_id = ${orgId} and id = ${terminationChangeId}
           and employment_id = ${employmentId} and change_kind = 'terminated'
      `)).rows[0];
      if (!terminating) {
        throw new HrmPerformanceError(
          "REFUSED",
          `employment change ${terminationChangeId} is not the termination of employment ${employmentId} — link the terminating change for this employment, or leave it unlinked`,
        );
      }
    }
    if (interviewerPartyId !== null) {
      const party = (await db.execute<{ id: string }>(sql`
        select id from parties where org_id = ${orgId} and id = ${interviewerPartyId}
      `)).rows[0];
      if (!party) {
        throw new HrmPerformanceError(
          "NOT_FOUND",
          `interviewer ${interviewerPartyId} is not visible in this organization — pick a party of this org`,
        );
      }
    }
    let row: StoredExit;
    try {
      row = (await db.execute<StoredExit>(sql`
        insert into hrm_exit_records
          (org_id, employment_id, termination_change_id, reason_kind, is_voluntary,
           is_regrettable, would_rehire, interview_held_on, interviewer_party_id,
           destination, notes, recorded_by, created_by, updated_by)
        values (${orgId}, ${employmentId}, ${terminationChangeId}, ${input.reasonKind},
          ${input.isVoluntary}, ${input.isRegrettable ?? null}, ${input.wouldRehire ?? null},
          ${interviewHeldOn}::date, ${interviewerPartyId}, ${input.destination ?? null},
          ${input.notes ?? null}, ${actorId}, ${actorId}, ${actorId})
        returning id,
          employment_id as "employmentId",
          termination_change_id as "terminationChangeId",
          reason_kind as "reasonKind",
          is_voluntary as "isVoluntary",
          is_regrettable as "isRegrettable",
          would_rehire as "wouldRehire",
          interview_held_on::text as "interviewHeldOn",
          interviewer_party_id as "interviewerPartyId",
          destination, notes,
          recorded_by as "recordedBy",
          recorded_at as "recordedAt"
      `)).rows[0]!;
    } catch (e) {
      // The one-per-employment unique is the authority: a second record is
      // a correction of the first, made by updating it. The constraint
      // name rides the pg cause chain, never the driver message.
      if (isUniqueViolationOn(e, "hrm_exit_records_org_employment_unique")) {
        throw new HrmPerformanceError(
          "DUPLICATE",
          `employment ${employmentId} already has an exit record — correct it with an update instead of recording a second one`,
        );
      }
      throw e;
    }
    return toExitDTO(row);
  });
}

export interface UpdateExitInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly exitId: string;
  readonly reasonKind?: ExitReasonKind;
  readonly isVoluntary?: boolean;
  readonly isRegrettable?: boolean | null;
  readonly wouldRehire?: boolean | null;
  readonly interviewHeldOn?: string | null;
  readonly interviewerPartyId?: string | null;
  readonly destination?: string | null;
  readonly notes?: string | null;
}

/** Correct the one exit record for its employment. */
export async function updateExitRecord(input: UpdateExitInput): Promise<ExitRecordDTO> {
  const orgId = requireId("orgId", input.orgId);
  const actorId = requireId("actorId", input.actorId);
  const exitId = requireId("exitId", input.exitId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const current = await loadExit(db, orgId, exitId);
    await requireHrmPerformanceOnEmployment(db, orgId, actorId, current.employmentId, "hrm.performance.manage");
    const reasonKind = input.reasonKind ?? current.reasonKind;
    if (!(EXIT_REASONS as readonly string[]).includes(reasonKind)) {
      throw new HrmPerformanceError(
        "INVALID_INPUT",
        `reasonKind must be one of ${EXIT_REASONS.join(", ")}, got ${JSON.stringify(input.reasonKind)}`,
      );
    }
    const interviewHeldOn =
      input.interviewHeldOn === undefined
        ? current.interviewHeldOn
        : input.interviewHeldOn == null
          ? null
          : mathRefusal("INVALID_INPUT", () => parseCivilDay(input.interviewHeldOn as string, "interview date"));
    const interviewerPartyId =
      input.interviewerPartyId === undefined
        ? current.interviewerPartyId
        : input.interviewerPartyId == null
          ? null
          : requireId("interviewerPartyId", input.interviewerPartyId);
    if ((interviewHeldOn === null) !== (interviewerPartyId === null)) {
      throw new HrmPerformanceError(
        "REFUSED",
        `exit interview needs both the held date and the interviewer — record them together, or clear both when no interview was held`,
      );
    }
    // Omitted keeps, explicit null clears: ?? would mistake a clear for
    // an omission and pin the old value in place.
    const isVoluntary = input.isVoluntary === undefined ? current.isVoluntary : input.isVoluntary;
    const isRegrettable = input.isRegrettable === undefined ? current.isRegrettable : input.isRegrettable;
    const wouldRehire = input.wouldRehire === undefined ? current.wouldRehire : input.wouldRehire;
    const destination = input.destination === undefined ? current.destination : input.destination;
    const notes = input.notes === undefined ? current.notes : input.notes;
    const moved = (await db.execute(sql`
      update hrm_exit_records
         set reason_kind = ${reasonKind},
             is_voluntary = ${isVoluntary},
             is_regrettable = ${isRegrettable},
             would_rehire = ${wouldRehire},
             interview_held_on = ${interviewHeldOn}::date,
             interviewer_party_id = ${interviewerPartyId},
             destination = ${destination},
             notes = ${notes},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${exitId}
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "NOT_FOUND",
        `exit record ${exitId} is not visible in this organization — check the id or the organization`,
      );
    }
    return toExitDTO(await loadExit(db, orgId, exitId));
  });
}

/**
 * One exit record through the retention read gate (HR only). Writes stay
 * on hrm.performance.manage above; reads never do.
 */
export async function getExitRecord(args: {
  orgId: string;
  actorId: string;
  exitId: string;
}): Promise<ExitRecordDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const exitId = requireId("exitId", args.exitId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireHrmRetentionRead(db, orgId, actorId);
    const exit = await loadExit(db, orgId, exitId);
    assertExitInScope(allowed, exit);
    return toExitDTO(exit);
  });
}

/**
 * Exit records, newest first, through the retention read gate (HR only,
 * inside their legal-entity scope): a restricted HR lists only the exits
 * whose employments sit in their allowed subsidiaries.
 */
export async function listExitRecords(args: {
  orgId: string;
  actorId: string;
  employmentId?: string;
}): Promise<ExitRecordDTO[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const employmentId =
    args.employmentId == null ? null : requireId("employmentId", args.employmentId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireHrmRetentionRead(db, orgId, actorId);
    if (allowed !== null && allowed.size === 0) return [];
    // One parameter per id: bare JS arrays must never be interpolated into
    // ANY() (they bind as row constructors, not PostgreSQL arrays).
    const scopeFilter =
      allowed === null
        ? sql``
        : sql`and e.employer_subsidiary_id in (${sql.join(
            [...allowed].map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
    const rows = (await db.execute<StoredExit>(sql`
      select x.id,
             x.employment_id as "employmentId",
             e.employer_subsidiary_id as "employerSubsidiaryId",
             x.termination_change_id as "terminationChangeId",
             x.reason_kind as "reasonKind",
             x.is_voluntary as "isVoluntary",
             x.is_regrettable as "isRegrettable",
             x.would_rehire as "wouldRehire",
             x.interview_held_on::text as "interviewHeldOn",
             x.interviewer_party_id as "interviewerPartyId",
             x.destination, x.notes,
             x.recorded_by as "recordedBy",
             x.recorded_at as "recordedAt"
        from hrm_exit_records x
        join worker_employments e
          on e.org_id = x.org_id and e.id = x.employment_id
       where x.org_id = ${orgId}
         ${employmentId === null ? sql`` : sql`and x.employment_id = ${employmentId}`}
         ${scopeFilter}
       order by x.recorded_at desc
    `)).rows;
    return rows.map(toExitDTO);
  });
}

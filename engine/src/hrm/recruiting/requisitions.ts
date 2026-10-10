import { canonicalNonNegativeDecimal, compareDecimal, isPositiveDecimal } from "../../money/exact-decimal.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import {
  requireHrmPositionRead,
  requireHrmRecruitingManage,
  requireRecruitingManageForEmployer,
} from "../authorization.ts";
import { loadVacancyAsOf } from "../positions-read.ts";
import { RecruitingError } from "./errors.ts";
import { optionalCivilDate, requireActorId, requireCivilDate, requireId, requireOrgId, requireReason } from "./input.ts";
import { ensureDefaultPipelineTemplate, loadPipelineTemplate } from "./pipeline.ts";
import { loadJobDescriptionForRequisition } from "./job-descriptions.ts";

/**
 * Canonical recruiting requisition service (HR-6, 0195): the vacancy to
 * fill. A requisition opens AGAINST a position (or a planned headcount),
 * carries headcount versus filled_count, and fills ONLY through hire — the
 * hire transaction bumps filled_count with the aggregate revision and flips
 * status to filled when headcount is met. Every conditional write asserts
 * its affected row count.
 */

export const REQUISITION_STATUSES = ["draft", "open", "on_hold", "filled", "cancelled"] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

export const COMPENSATION_BASES = ["hourly", "annual"] as const;

export interface RequisitionCompensation {
  readonly min: string;
  readonly max: string;
  readonly currency: string;
  readonly basis: "hourly" | "annual";
}

export interface RequisitionDTO {
  readonly id: string;
  readonly requisitionNumber: string;
  readonly positionId: string | null;
  readonly title: string;
  readonly employerSubsidiaryId: string;
  readonly departmentId: string | null;
  readonly locationId: string | null;
  readonly hiringManagerPartyId: string | null;
  readonly recruiterUserId: string | null;
  readonly headcount: number;
  readonly filledCount: number;
  readonly employmentKind: string | null;
  readonly targetStartOn: string | null;
  readonly compensation: RequisitionCompensation | null;
  readonly status: RequisitionStatus;
  readonly openedOn: string | null;
  readonly closedOn: string | null;
  readonly closeReason: string | null;
  readonly pipelineTemplateId: string | null;
  readonly description: string | null;
  readonly jobDescriptionId: string | null;
  readonly revision: number;
}

type RequisitionRow = {
  id: string;
  requisitionNumber: string;
  positionId: string | null;
  title: string;
  employerSubsidiaryId: string;
  departmentId: string | null;
  locationId: string | null;
  hiringManagerPartyId: string | null;
  recruiterUserId: string | null;
  headcount: number;
  filledCount: number;
  employmentKind: string | null;
  targetStartOn: string | null;
  compensationMin: string | null;
  compensationMax: string | null;
  compensationCurrency: string | null;
  compensationBasis: string | null;
  status: string;
  openedOn: string | null;
  closedOn: string | null;
  closeReason: string | null;
  pipelineTemplateId: string | null;
  description: string | null;
  jobDescriptionId: string | null;
  revision: number;
};

const REQUISITION_COLUMNS = sql`
  id, requisition_number as "requisitionNumber", position_id as "positionId",
  title, employer_subsidiary_id as "employerSubsidiaryId",
  department_id as "departmentId", location_id as "locationId",
  hiring_manager_party_id as "hiringManagerPartyId",
  recruiter_user_id as "recruiterUserId", headcount, filled_count as "filledCount",
  employment_kind as "employmentKind", target_start_on as "targetStartOn",
  compensation_min as "compensationMin", compensation_max as "compensationMax",
  compensation_currency as "compensationCurrency",
  compensation_basis as "compensationBasis", status,
  opened_on as "openedOn", closed_on as "closedOn",
  close_reason as "closeReason",
  pipeline_template_id as "pipelineTemplateId", description,
  job_description_id as "jobDescriptionId", revision
`;

function toDTO(row: RequisitionRow): RequisitionDTO {
  if (!(REQUISITION_STATUSES as readonly string[]).includes(row.status)) {
    throw new RecruitingError("REFUSED", `requisition ${row.id} carries unknown status ${row.status} — refusing a lifecycle the service cannot resolve`);
  }
  return {
    ...row,
    status: row.status as RequisitionStatus,
    compensation:
      row.compensationMin !== null &&
      row.compensationMax !== null &&
      row.compensationCurrency !== null &&
      row.compensationBasis !== null
        ? {
            min: row.compensationMin,
            max: row.compensationMax,
            currency: row.compensationCurrency,
            basis: row.compensationBasis as "hourly" | "annual",
          }
        : null,
  };
}

/**
 * The requisition number allocator: one org-wide counter on the shared
 * number_sequences row (org_id, 'hrm_requisition', NULL), the same
 * serialized upsert the document allocator uses — concurrent openers take
 * the row lock and receive distinct, strictly increasing numbers. A
 * requisition number is an organization-wide identity like a document
 * number, so exactly one org-wide row hands them out (never per-subsidiary
 * rows, which would each hand out the same number).
 */
async function allocateRequisitionNumber(exec: SqlExecutor, orgId: string): Promise<string> {
  const seq = (await exec.execute<{ prefix: string; next_number: number; padding: number }>(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, 'hrm_requisition', null, 'REQ-')
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    where number_sequences.org_id = ${orgId}
    returning prefix, next_number, padding
  `)).rows[0];
  if (!seq) {
    throw new RecruitingError("REFUSED", "the requisition number was not allocated — no sequence row was written; retry the request");
  }
  return `${seq.prefix}${String(seq.next_number).padStart(seq.padding, "0")}`;
}

async function assertRefVisible(
  exec: SqlExecutor,
  orgId: string,
  table: "subsidiaries" | "departments" | "locations" | "parties",
  id: string,
  label: string,
): Promise<void> {
  const found = (await exec.execute<{ one: number }>(sql`
    select 1 as one from ${table === "subsidiaries" ? sql`subsidiaries` : table === "departments" ? sql`departments` : table === "locations" ? sql`locations` : sql`parties`}
     where org_id = ${orgId} and id = ${id} limit 1
  `)).rows.length > 0;
  if (!found) {
    throw new RecruitingError("NOT_FOUND", `${label} is not visible in this organization — check the reference`);
  }
}

async function assertUserVisible(exec: SqlExecutor, orgId: string, userId: string): Promise<void> {
  const found = (await exec.execute<{ one: number }>(sql`
    select 1 as one from users where org_id = ${orgId} and id = ${userId} limit 1
  `)).rows.length > 0;
  if (!found) {
    throw new RecruitingError("NOT_FOUND", "recruiter is not visible in this organization — check the reference");
  }
}

function requireHeadcount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RecruitingError("INVALID_INPUT", "headcount is an integer of at least 1 — the opening fills at least one hire");
  }
  return value;
}



export function requireCompensation(value: unknown): RequisitionCompensation | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") {
    throw new RecruitingError("INVALID_INPUT", "compensation travels as an all-or-nothing range (min, max, currency, basis) — send all four or none");
  }
  const { min, max, currency, basis } = value as Record<string, unknown>;
  if (typeof min !== "string" || canonicalNonNegativeDecimal(min, 4) === null) {
    throw new RecruitingError("INVALID_INPUT", "compensation min must be a decimal with up to 4 fraction digits");
  }
  if (typeof max !== "string" || canonicalNonNegativeDecimal(max, 4) === null) {
    throw new RecruitingError("INVALID_INPUT", "compensation max must be a decimal with up to 4 fraction digits");
  }
  if (compareDecimal(canonicalNonNegativeDecimal(min, 4)!, canonicalNonNegativeDecimal(max, 4)!) > 0) {
    throw new RecruitingError("INVALID_INPUT", "compensation min exceeds max — enter a range where the minimum is no greater than the maximum");
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new RecruitingError("INVALID_INPUT", "compensation currency must be a 3-letter code");
  }
  if (basis !== "hourly" && basis !== "annual") {
    throw new RecruitingError("INVALID_INPUT", "compensation basis must be hourly or annual — check the basis");
  }
  return { min, max, currency, basis };
}

export interface CreateRequisitionQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** Optional when a job description supplies it. */
  readonly title?: unknown;
  readonly positionId?: unknown;
  readonly employerSubsidiaryId: unknown;
  readonly departmentId?: unknown;
  readonly locationId?: unknown;
  readonly hiringManagerPartyId?: unknown;
  readonly recruiterUserId?: unknown;
  readonly headcount: unknown;
  readonly employmentKind?: unknown;
  readonly targetStartOn?: unknown;
  readonly compensation?: unknown;
  readonly pipelineTemplateId?: unknown;
  readonly description?: unknown;
  /**
   * Library entry the opening starts from. Its title, employment kind, pay
   * range and description are copied for every field the request leaves
   * unset; the copy is the requisition's own content from then on.
   */
  readonly jobDescriptionId?: unknown;
}

/** Posting descriptions are long-form text; the bound keeps one opening a reasonable row. */
export const REQUISITION_DESCRIPTION_MAX_LENGTH = 20_000;

function optionalDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new RecruitingError("INVALID_INPUT", "description must be text");
  }
  if (value.length > REQUISITION_DESCRIPTION_MAX_LENGTH) {
    throw new RecruitingError(
      "INVALID_INPUT",
      `description is ${value.length} characters — shorten it to at most ${REQUISITION_DESCRIPTION_MAX_LENGTH}`,
    );
  }
  return value.trim().length === 0 ? null : value;
}

function optionalText(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", `${name} must be non-blank when sent`);
  }
  return value.trim();
}

/** Open a draft requisition (status draft, no number consumed until open). */
export async function createRequisition(query: CreateRequisitionQuery): Promise<RequisitionDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestedTitle = optionalText(query.title, "requisition title");
  if (typeof query.employerSubsidiaryId !== "string" || query.employerSubsidiaryId.length === 0) {
    throw new RecruitingError("INVALID_INPUT", "employerSubsidiaryId must be a non-empty string — a vacancy belongs to a legal entity");
  }
  const headcount = requireHeadcount(query.headcount);
  const requestedCompensation = requireCompensation(query.compensation);
  const positionId = query.positionId === undefined || query.positionId === null ? null : requireId(query.positionId, "positionId");
  const departmentId = query.departmentId === undefined || query.departmentId === null ? null : requireId(query.departmentId, "departmentId");
  const locationId = query.locationId === undefined || query.locationId === null ? null : requireId(query.locationId, "locationId");
  const hiringManagerPartyId =
    query.hiringManagerPartyId === undefined || query.hiringManagerPartyId === null
      ? null
      : requireId(query.hiringManagerPartyId, "hiringManagerPartyId");
  const recruiterUserId =
    query.recruiterUserId === undefined || query.recruiterUserId === null
      ? null
      : requireId(query.recruiterUserId, "recruiterUserId");
  const targetStartOn = optionalCivilDate(query.targetStartOn, "targetStartOn");
  const requestedEmploymentKind = optionalText(query.employmentKind, "employmentKind");
  const pipelineTemplateId =
    query.pipelineTemplateId === undefined || query.pipelineTemplateId === null
      ? null
      : requireId(query.pipelineTemplateId, "pipelineTemplateId");
  const requestedDescription = optionalDescription(query.description);
  const jobDescriptionId =
    query.jobDescriptionId === undefined || query.jobDescriptionId === null
      ? null
      : requireId(query.jobDescriptionId, "jobDescriptionId");
  if (requestedTitle === null && jobDescriptionId === null) {
    throw new RecruitingError("INVALID_INPUT", "requisition title must be non-blank — enter a title or start from a job description");
  }

  return withOrgTransaction(orgId, async () => {
    // Authority first, against the DECLARED employer: no planting vacancies
    // in a legal entity the actor cannot see.
    await requireRecruitingManageForEmployer(db, orgId, actorId, query.employerSubsidiaryId as string);
    if (positionId) {
      // The actor must at least see the position to recruit against it.
      await requireHrmPositionRead(db, orgId, actorId, positionId);
    }
    await assertRefVisible(db, orgId, "subsidiaries", query.employerSubsidiaryId as string, "employer subsidiary");
    if (departmentId) await assertRefVisible(db, orgId, "departments", departmentId, "department");
    if (locationId) await assertRefVisible(db, orgId, "locations", locationId, "location");
    if (hiringManagerPartyId) await assertRefVisible(db, orgId, "parties", hiringManagerPartyId, "hiring manager");
    if (recruiterUserId) await assertUserVisible(db, orgId, recruiterUserId);
    if (pipelineTemplateId) {
      const template = await loadPipelineTemplate(db, orgId, pipelineTemplateId);
      if (!template) throw new RecruitingError("NOT_FOUND", "pipeline template is not visible in this organization — check the reference");
    }
    const source = jobDescriptionId ? await loadJobDescriptionForRequisition(db, orgId, jobDescriptionId) : null;
    const title = requestedTitle ?? source!.title;
    const employmentKind = requestedEmploymentKind ?? source?.employmentKind ?? null;
    const compensation = requestedCompensation ?? source?.compensation ?? null;
    const description = requestedDescription ?? source?.description ?? null;
    const number = await allocateRequisitionNumber(db, orgId);
    const inserted = (await db.execute<RequisitionRow>(sql`
      insert into hrm_requisitions
        (org_id, requisition_number, position_id, title, employer_subsidiary_id,
         department_id, location_id, hiring_manager_party_id, recruiter_user_id,
         headcount, employment_kind, target_start_on,
         compensation_min, compensation_max, compensation_currency, compensation_basis,
         status, pipeline_template_id, description, job_description_id, created_by, updated_by)
      values (${orgId}, ${number}, ${positionId}, ${title},
              ${query.employerSubsidiaryId as string}, ${departmentId}, ${locationId},
              ${hiringManagerPartyId}, ${recruiterUserId}, ${headcount},
              ${employmentKind}, ${targetStartOn},
              ${compensation?.min ?? null}, ${compensation?.max ?? null},
              ${compensation?.currency ?? null}, ${compensation?.basis ?? null},
              'draft', ${pipelineTemplateId}, ${description}, ${jobDescriptionId}, ${actorId}, ${actorId})
      returning ${REQUISITION_COLUMNS}
    `)).rows[0];
    if (!inserted) {
      throw new RecruitingError("REFUSED", "the requisition was not stored — no row was written; retry the request");
    }
    return toDTO(inserted);
  });
}

async function loadRequisitionForUpdate(
  exec: SqlExecutor,
  orgId: string,
  requisitionId: string,
): Promise<RequisitionRow> {
  const row = (await exec.execute<RequisitionRow>(sql`
    select ${REQUISITION_COLUMNS} from hrm_requisitions
     where org_id = ${orgId} and id = ${requisitionId} for update
  `)).rows[0];
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "requisition is not visible in this organization");
  }
  return row;
}

export interface OpenRequisitionQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requisitionId: string;
  readonly targetStartOn?: unknown;
  /** Refused shape without this flag when the position shows no vacant FTE. */
  readonly overEstablishment?: unknown;
}

/**
 * Open a draft (or resume an on-hold) requisition. Refused when the employer
 * subsidiary is not visible to the actor, when the position is closed, or
 * when the position's vacant FTE as of the target start is zero without the
 * over-establishment flag: over-establishment is refused, never silently
 * allowed. Names the default pipeline template when none was named.
 */
export async function openRequisition(query: OpenRequisitionQuery): Promise<RequisitionDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requisitionId = requireId(query.requisitionId, "requisitionId");
  const targetStartOn =
    query.targetStartOn === undefined || query.targetStartOn === null
      ? null
      : requireCivilDate(query.targetStartOn, "targetStartOn");
  const overEstablishment = query.overEstablishment === true;
  return withOrgTransaction(orgId, async () => {
    const subject = await requireHrmRecruitingManage(db, orgId, actorId, requisitionId);
    const current = await loadRequisitionForUpdate(db, orgId, requisitionId);
    if (current.status !== "draft" && current.status !== "on_hold") {
      throw new RecruitingError(
        "BAD_STATE",
        `a ${current.status} requisition cannot be opened — only drafts open and on-hold openings resume`,
      );
    }
    const effectiveTarget = targetStartOn ?? current.targetStartOn;
    if (current.positionId) {
      await assertPositionOpenable(db, orgId, actorId, current.positionId, effectiveTarget, overEstablishment);
    }
    let templateId = current.pipelineTemplateId;
    if (!templateId) {
      const seed = await ensureDefaultPipelineTemplate(db, orgId, actorId);
      templateId = seed.id;
    }
    const today = (await db.execute<{ today: string }>(sql`select current_date::text as today`)).rows[0]!.today;
    const updated = (await db.execute<RequisitionRow>(sql`
      update hrm_requisitions
         set status = 'open', opened_on = coalesce(opened_on, ${today}::date),
             target_start_on = coalesce(${effectiveTarget}::date, target_start_on),
             pipeline_template_id = ${templateId},
             closed_on = null, close_reason = null,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requisitionId}
         and status in ('draft', 'on_hold')
      returning ${REQUISITION_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError(
        "STALE_REVISION",
        `requisition ${subject.requisitionNumber} changed while opening — reload it and try again`,
      );
    }
    return toDTO(updated);
  });
}

/**
 * Prove the position can take this opening: visible to the actor, not
 * closed, and vacant as of the target start — or explicitly opened over
 * establishment. Over-establishment is a named decision, never a default.
 */
async function assertPositionOpenable(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  positionId: string,
  targetStartOn: string | null,
  overEstablishment: boolean,
): Promise<void> {
  const live = (await exec.execute<{ status: string }>(sql`
    select v.status from position_versions v
     where v.org_id = ${orgId} and v.position_id = ${positionId}
       and v.recorded_until is null
     order by v.version_no desc limit 1
  `)).rows[0];
  if (!live) {
    throw new RecruitingError("NOT_FOUND", "the requisition's position has no live version — resolve the position before opening");
  }
  if (live.status === "closed") {
    throw new RecruitingError(
      "REFUSED",
      "the requisition's position is closed — open a new position instead of recruiting against a retired establishment",
    );
  }
  const asOf = targetStartOn ?? (await exec.execute<{ today: string }>(sql`select current_date::text as today`)).rows[0]!.today;
  const vacancy = await loadVacancyAsOf(exec, {
    orgId,
    actorId,
    effectiveDate: asOf,
    knownAt: new Date().toISOString(),
  });
  const row = vacancy.positions.find((position) => position.id === positionId);
  if (!row) {
    throw new RecruitingError(
      "REFUSED",
      "the requisition's position shows no vacancy row as of the target start — resolve the position before opening",
    );
  }
  if (row.vacancy.refusal) {
    throw new RecruitingError("REFUSED", row.vacancy.refusal.message);
  }
  if (!isPositiveDecimal(row.vacancy.vacantFte) && !overEstablishment) {
    throw new RecruitingError(
      "REFUSED",
      `the position shows no vacant FTE as of ${asOf} — open over establishment explicitly (overEstablishment) instead of recruiting silently past the plan`,
    );
  }
}

export interface HoldResumeCancelQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requisitionId: string;
  readonly reason: unknown;
}

/** Hold an open requisition (reason required — a hold without a why is not recorded). */
export async function holdRequisition(query: HoldResumeCancelQuery): Promise<RequisitionDTO> {
  return transitionRequisition(query, "hold");
}

/** Resume an on-hold requisition to open. */
export async function resumeRequisition(query: HoldResumeCancelQuery): Promise<RequisitionDTO> {
  return transitionRequisition(query, "resume");
}

/** Cancel a requisition with a reason; the opening is retained as history. */
export async function cancelRequisition(query: HoldResumeCancelQuery): Promise<RequisitionDTO> {
  return transitionRequisition(query, "cancel");
}

async function transitionRequisition(
  query: HoldResumeCancelQuery,
  action: "hold" | "resume" | "cancel",
): Promise<RequisitionDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requisitionId = requireId(query.requisitionId, "requisitionId");
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    const subject = await requireHrmRecruitingManage(db, orgId, actorId, requisitionId);
    const expected = action === "hold" ? "open" : action === "resume" ? "on_hold" : "open";
    const next = action === "hold" ? "on_hold" : action === "resume" ? "open" : "cancelled";
    const today = (await db.execute<{ today: string }>(sql`select current_date::text as today`)).rows[0]!.today;
    const updated =
      action === "cancel"
        ? (await db.execute<RequisitionRow>(sql`
            update hrm_requisitions
               set status = 'cancelled', closed_on = ${today}::date, close_reason = ${reason},
                   updated_by = ${actorId}, updated_at = now()
             where org_id = ${orgId} and id = ${requisitionId} and status = ${expected}
            returning ${REQUISITION_COLUMNS}
          `)).rows[0]
        : (await db.execute<RequisitionRow>(sql`
            update hrm_requisitions
               set status = ${next}, updated_by = ${actorId}, updated_at = now()
             where org_id = ${orgId} and id = ${requisitionId} and status = ${expected}
            returning ${REQUISITION_COLUMNS}
          `)).rows[0];
    if (!updated) {
      const current = await loadRequisitionForUpdate(db, orgId, requisitionId);
      throw new RecruitingError(
        "BAD_STATE",
        `requisition ${subject.requisitionNumber} is ${current.status} — ${action} needs a ${expected} opening`,
      );
    }
    return toDTO(updated);
  });
}

export interface ReviseRequisitionQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requisitionId: string;
  /** The revision the editor read; a concurrent change refuses instead of being overwritten. */
  readonly expectedRevision: unknown;
  /** Omitted fields are unchanged; null clears every field except the title. */
  readonly title?: unknown;
  readonly employmentKind?: unknown;
  readonly compensation?: unknown;
  readonly description?: unknown;
}

const REVISABLE_STATUSES: readonly RequisitionStatus[] = ["draft", "open", "on_hold"];

/**
 * Revise an opening's posting content (title, employment kind, pay range,
 * description) while it is still recruiting. Filled and cancelled openings
 * are history and refuse. The write is guarded by the revision the editor
 * read, bumps it, and records the before/after content in the audit log in
 * the same transaction.
 */
export async function reviseRequisition(query: ReviseRequisitionQuery): Promise<RequisitionDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requisitionId = requireId(query.requisitionId, "requisitionId");
  if (typeof query.expectedRevision !== "number" || !Number.isInteger(query.expectedRevision) || query.expectedRevision < 1) {
    throw new RecruitingError("INVALID_INPUT", "expectedRevision is the positive integer revision the edit was made against — reload the opening");
  }
  const expectedRevision = query.expectedRevision;
  if (query.title === null) {
    throw new RecruitingError("INVALID_INPUT", "requisition title must be non-blank — an opening always has a title");
  }
  const title = query.title === undefined ? undefined : optionalText(query.title, "requisition title");
  const employmentKind = query.employmentKind === undefined ? undefined : optionalText(query.employmentKind, "employmentKind");
  const compensation = query.compensation === undefined ? undefined : requireCompensation(query.compensation);
  const description = query.description === undefined ? undefined : optionalDescription(query.description);

  return withOrgTransaction(orgId, async () => {
    const subject = await requireHrmRecruitingManage(db, orgId, actorId, requisitionId);
    const current = await loadRequisitionForUpdate(db, orgId, requisitionId);
    if (!(REVISABLE_STATUSES as readonly string[]).includes(current.status)) {
      throw new RecruitingError(
        "BAD_STATE",
        `requisition ${subject.requisitionNumber} is ${current.status} — only draft, open and on-hold openings take posting edits`,
      );
    }
    if (current.revision !== expectedRevision) {
      throw new RecruitingError(
        "STALE_REVISION",
        `requisition ${subject.requisitionNumber} changed since it was read (revision ${current.revision}, edited against ${expectedRevision}) — reload it and reapply the edit`,
      );
    }
    const before = toDTO(current);
    const next = {
      title: title ?? before.title,
      employmentKind: employmentKind === undefined ? before.employmentKind : employmentKind,
      compensation: compensation === undefined ? before.compensation : compensation,
      description: description === undefined ? before.description : description,
    };
    const prior = {
      title: before.title,
      employmentKind: before.employmentKind,
      compensation: before.compensation,
      description: before.description,
    };
    if (JSON.stringify(next) === JSON.stringify(prior)) return before;
    const updated = (await db.execute<RequisitionRow>(sql`
      update hrm_requisitions
         set title = ${next.title}, employment_kind = ${next.employmentKind},
             compensation_min = ${next.compensation?.min ?? null},
             compensation_max = ${next.compensation?.max ?? null},
             compensation_currency = ${next.compensation?.currency ?? null},
             compensation_basis = ${next.compensation?.basis ?? null},
             description = ${next.description},
             revision = revision + 1,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requisitionId}
         and revision = ${expectedRevision}
         and status in ('draft', 'open', 'on_hold')
      returning ${REQUISITION_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError(
        "STALE_REVISION",
        `requisition ${subject.requisitionNumber} changed while saving — reload it and reapply the edit`,
      );
    }
    const audited = (await db.execute<{ id: string }>(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'hrm_requisitions', ${requisitionId}, 'requisition_posting_revised',
              ${JSON.stringify({ before: prior, after: next })}::jsonb, ${actorId})
      returning id
    `)).rows[0];
    if (!audited) {
      throw new RecruitingError("REFUSED", "the posting edit was not audited — no audit row was written; retry the request");
    }
    return toDTO(updated);
  });
}

/**
 * The hire fill: filled_count + 1 with the aggregate revision, flipping to
 * filled when headcount is met. Called ONLY from the hire transaction (which
 * holds the requisition row lock through loadRequisitionForUpdate first, so
 * concurrent hires serialize instead of over-filling). A zero-row write is
 * a refusal — the opening filled under us.
 */
export async function bumpFillForHire(
  exec: SqlExecutor,
  args: { orgId: string; actorId: string; requisitionId: string; expectedRevision: number },
): Promise<RequisitionDTO> {
  const updated = (await exec.execute<RequisitionRow>(sql`
    update hrm_requisitions
       set filled_count = filled_count + 1,
           revision = revision + 1,
           status = case when filled_count + 1 >= headcount then 'filled' else status end,
           closed_on = case when filled_count + 1 >= headcount then current_date else closed_on end,
           updated_by = ${args.actorId}, updated_at = now()
     where org_id = ${args.orgId} and id = ${args.requisitionId}
       and revision = ${args.expectedRevision}
       and status = 'open'
       and filled_count < headcount
    returning ${REQUISITION_COLUMNS}
  `)).rows[0];
  if (!updated) {
    throw new RecruitingError(
      "REFUSED",
      "the requisition filled while this hire was in flight — the hire is refused rather than recruited past the plan",
    );
  }
  return toDTO(updated);
}

/** Read one requisition row (the composed drawer resolves through recruiting-read). */

import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import {
  actorHoldsRecruitingRead,
  actorOnInterviewPanel,
  requireAggregateRecruitingRead,
  requireHrmRecruitingRead,
  requireOwnRequisitionForHiringManager,
} from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { effectiveOfferStatus, funnelCounts, timeToFillDays } from "./funnel.ts";
import { requireActorId, requireId, requireOrgId } from "./input.ts";
import { loadPipelineTemplate } from "./pipeline.ts";
import type { OfferStatus } from "./offers.ts";
import type { RequisitionStatus } from "./requisitions.ts";

/**
 * Canonical recruiting read service (HR-6, 0195): every list, drawer, and
 * overview panel resolves through here — never raw SQL at the surface.
 *
 * Confidentiality is load-bearing: candidate contact PII (email, phone,
 * resume) is returned ONLY to holders of hrm.recruiting.read. A hiring
 * manager on their own requisitions sees the funnel (names, stages,
 * interviews, offers) without the PII; an interviewer on the panel sees
 * the candidate NAME and the interview, nothing else.
 */

export interface RequisitionListRow {
  readonly id: string;
  readonly requisitionNumber: string;
  readonly title: string;
  readonly positionCode: string | null;
  readonly departmentName: string | null;
  readonly headcount: number;
  readonly filledCount: number;
  readonly hiringManagerName: string | null;
  readonly openedOn: string | null;
  readonly status: RequisitionStatus;
  readonly href: string;
}

export interface CandidateView {
  readonly id: string;
  readonly displayName: string;
  /** Null unless the viewer holds hrm.recruiting.read. */
  readonly email: string | null;
  /** Null unless the viewer holds hrm.recruiting.read. */
  readonly phone: string | null;
  readonly source: string | null;
  /** Null unless the viewer holds hrm.recruiting.read. */
  readonly resumeAttachmentId: string | null;
  readonly isInternal: boolean;
  readonly href: string;
}

export interface ApplicationFunnelRow {
  readonly id: string;
  readonly candidate: CandidateView;
  readonly stageId: string;
  readonly stageKey: string;
  readonly stageName: string;
  readonly status: string;
  readonly appliedOn: string;
  readonly lastEventKind: string | null;
  readonly lastEventAt: string | null;
  readonly interviewsCount: number;
  readonly liveOfferStatus: OfferStatus | null;
}

export interface RequisitionDetail extends RequisitionListRow {
  readonly employerSubsidiaryId: string;
  readonly targetStartOn: string | null;
  readonly compensation: string | null;
  /** Band range for the opening's level scope, or null when pay
   * transparency is off, the reader lacks comp.read, or no band
   * covers the scope. Additive: never replaces the typed range. */
  readonly bandRange: string | null;
  readonly description: string | null;
  readonly stages: readonly { id: string; key: string; name: string; kind: string }[];
  readonly funnel: readonly { stageKey: string; stageName: string; count: number }[];
  readonly applications: readonly ApplicationFunnelRow[];
  readonly timeToFillDays: number | null;
}

export interface RecruitingOverview {
  readonly openRequisitions: number;
  readonly offersAwaitingResponse: number;
  readonly interviewsThisWeek: number;
}

async function namesById(
  exec: SqlExecutor,
  orgId: string,
  table: "subsidiaries" | "departments" | "parties",
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const params = ids.map((id) => sql`${id}::uuid`);
  const nameExpr = table === "parties" ? sql`display_name` : sql`name`;
  const rows = (await exec.execute<{ id: string; name: string }>(sql`
    select id::text as id, ${nameExpr} as name
      from ${table === "subsidiaries" ? sql`subsidiaries` : table === "departments" ? sql`departments` : sql`parties`}
     where org_id = ${orgId}::uuid and id in (${sql.join(params, sql`, `)})`)).rows;
  return new Map(rows.map((row) => [row.id, row.name] as const));
}

type RequisitionRow = {
  id: string;
  requisitionNumber: string;
  title: string;
  positionId: string | null;
  positionCode: string | null;
  employerSubsidiaryId: string;
  departmentId: string | null;
  departmentName: string | null;
  headcount: number;
  filledCount: number;
  hiringManagerPartyId: string | null;
  openedOn: string | null;
  targetStartOn: string | null;
  compensationMin: string | null;
  compensationMax: string | null;
  compensationCurrency: string | null;
  compensationBasis: string | null;
  status: string;
  pipelineTemplateId: string | null;
  description: string | null;
};

async function loadRequisitionRows(
  exec: SqlExecutor,
  orgId: string,
  allowed: Set<string> | null,
  status: string | null,
): Promise<RequisitionRow[]> {
  const rows = (await exec.execute<RequisitionRow>(sql`
    select r.id, r.requisition_number as "requisitionNumber", r.title,
           r.position_id as "positionId", p.position_code as "positionCode",
           r.employer_subsidiary_id as "employerSubsidiaryId",
           r.department_id as "departmentId", d.name as "departmentName",
           r.headcount, r.filled_count as "filledCount",
           r.hiring_manager_party_id as "hiringManagerPartyId",
           r.opened_on as "openedOn", r.target_start_on as "targetStartOn",
           r.compensation_min as "compensationMin",
           r.compensation_max as "compensationMax",
           r.compensation_currency as "compensationCurrency",
           r.compensation_basis as "compensationBasis",
           r.status, r.pipeline_template_id as "pipelineTemplateId",
           r.description
      from hrm_requisitions r
      left join positions p on p.org_id = r.org_id and p.id = r.position_id
      left join departments d on d.org_id = r.org_id and d.id = r.department_id
     where r.org_id = ${orgId}
       ${status ? sql`and r.status = ${status}` : sql``}
       ${allowed ? sql`and r.employer_subsidiary_id in (${sql.join([...allowed].map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
     order by r.created_at desc
  `)).rows;
  return rows;
}

function compensationLabel(row: RequisitionRow): string | null {
  if (!row.compensationMin || !row.compensationMax || !row.compensationCurrency || !row.compensationBasis) {
    return null;
  }
  return `${row.compensationMin}–${row.compensationMax} ${row.compensationCurrency} ${row.compensationBasis}`;
}

export interface ListRequisitionsQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly status?: string;
}

/** The requisitions list (aggregate read gate + employer scope). */
export async function listRequisitions(query: ListRequisitionsQuery): Promise<RequisitionListRow[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (query.status !== undefined && !["draft", "open", "on_hold", "filled", "cancelled"].includes(query.status)) {
    throw new RecruitingError("INVALID_INPUT", "unknown requisition status — check the segment");
  }
  const allowed = await requireAggregateRecruitingRead(db, orgId, actorId);
  const rows = await loadRequisitionRows(db, orgId, allowed, query.status ?? null);
  const managerNames = await namesById(
    db,
    orgId,
    "parties",
    [...new Set(rows.map((row) => row.hiringManagerPartyId).filter((id): id is string => id !== null))],
  );
  return rows.map((row) => ({
    id: row.id,
    requisitionNumber: row.requisitionNumber,
    title: row.title,
    positionCode: row.positionCode,
    departmentName: row.departmentName,
    headcount: row.headcount,
    filledCount: row.filledCount,
    hiringManagerName: row.hiringManagerPartyId ? (managerNames.get(row.hiringManagerPartyId) ?? null) : null,
    openedOn: row.openedOn,
    status: row.status as RequisitionStatus,
    href: `/hrm/recruiting?requisition=${row.id}`,
  }));
}

export interface GetRequisitionDetailQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requisitionId: string;
}

/**
 * The requisition drawer: the pipeline as stage chips, the applications
 * table, and the funnel. PII inside is redacted unless the viewer holds
 * hrm.recruiting.read — the hiring manager sees the funnel, never the
 * contact PII.
 */
export async function getRequisitionDetail(query: GetRequisitionDetailQuery): Promise<RequisitionDetail> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requisitionId = requireId(query.requisitionId, "requisitionId");
  let canSeePii = false;
  try {
    await requireHrmRecruitingRead(db, orgId, actorId, requisitionId);
    canSeePii = true;
  } catch {
    await requireOwnRequisitionForHiringManager(db, orgId, actorId, requisitionId);
  }
  const rows = await loadRequisitionRows(db, orgId, null, null);
  const row = rows.find((candidate) => candidate.id === requisitionId);
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "requisition is not visible in this organization");
  }
  const template = row.pipelineTemplateId ? await loadPipelineTemplate(db, orgId, row.pipelineTemplateId) : null;
  const stages = template?.stages ?? [];
  const stageById = new Map(stages.map((stage) => [stage.id, stage] as const));

  const applications = (await db.execute<{
    id: string;
    candidateId: string;
    stageId: string;
    status: string;
    appliedOn: string;
  }>(sql`
    select id, candidate_id as "candidateId", stage_id as "stageId",
           status, applied_on as "appliedOn"
      from hrm_applications
     where org_id = ${orgId} and requisition_id = ${requisitionId}
     order by applied_on, id
  `)).rows;

  const candidateIds = [...new Set(applications.map((application) => application.candidateId))];
  const candidateRows =
    candidateIds.length === 0
      ? []
      : (await db.execute<{
        id: string;
        displayName: string;
        email: string | null;
        phone: string | null;
        source: string | null;
        resumeAttachmentId: string | null;
        isInternal: boolean;
      }>(sql`
        select id, display_name as "displayName", email, phone, source,
               resume_attachment_id as "resumeAttachmentId",
               is_internal as "isInternal"
          from hrm_candidates
         where org_id = ${orgId} and id in (${sql.join(candidateIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `)).rows;
  const candidateById = new Map(candidateRows.map((candidate) => [candidate.id, candidate] as const));

  const applicationIds = applications.map((application) => application.id);
  const lastEvents =
    applicationIds.length === 0
      ? []
      : (await db.execute<{ applicationId: string; kind: string; recordedAt: string }>(sql`
        select distinct on (application_id) application_id as "applicationId",
               kind, recorded_at as "recordedAt"
          from hrm_application_events
         where org_id = ${orgId} and application_id in (${sql.join(applicationIds.map((id) => sql`${id}::uuid`), sql`, `)})
         order by application_id, recorded_at desc
      `)).rows;
  const lastEventByApplication = new Map(lastEvents.map((event) => [event.applicationId, event] as const));
  const interviewCounts =
    applicationIds.length === 0
      ? []
      : (await db.execute<{ applicationId: string; count: number }>(sql`
        select application_id as "applicationId", count(*)::int as count
          from hrm_interviews
         where org_id = ${orgId} and application_id in (${sql.join(applicationIds.map((id) => sql`${id}::uuid`), sql`, `)})
         group by application_id
      `)).rows;
  const interviewCountByApplication = new Map(interviewCounts.map((entry) => [entry.applicationId, entry.count] as const));
  const today = await businessToday(orgId);
  const liveOffers =
    applicationIds.length === 0
      ? []
      : (await db.execute<{ applicationId: string; status: string; expiresOn: string | null }>(sql`
        select application_id as "applicationId", status, expires_on as "expiresOn"
          from hrm_offers
         where org_id = ${orgId} and application_id in (${sql.join(applicationIds.map((id) => sql`${id}::uuid`), sql`, `)})
           and status in ('draft', 'sent')
      `)).rows;
  const liveOfferByApplication = new Map(liveOffers.map((offer) => [offer.applicationId, offer] as const));

  const funnelRows: ApplicationFunnelRow[] = applications.map((application) => {
    const candidate = candidateById.get(application.candidateId);
    if (!candidate) {
      throw new RecruitingError(
        "REFUSED",
        "an application names a candidate with no row — refusing a funnel that misattributes a candidacy",
      );
    }
    const stage = stageById.get(application.stageId);
    const lastEvent = lastEventByApplication.get(application.id) ?? null;
    const liveOffer = liveOfferByApplication.get(application.id) ?? null;
    return {
      id: application.id,
      candidate: {
        id: candidate.id,
        displayName: candidate.displayName,
        email: canSeePii ? candidate.email : null,
        phone: canSeePii ? candidate.phone : null,
        source: candidate.source,
        resumeAttachmentId: canSeePii ? candidate.resumeAttachmentId : null,
        isInternal: candidate.isInternal,
        href: `/hrm/recruiting?candidate=${candidate.id}`,
      },
      stageId: application.stageId,
      stageKey: stage?.key ?? "unknown",
      stageName: stage?.name ?? "Unknown stage",
      status: application.status,
      appliedOn: application.appliedOn,
      lastEventKind: lastEvent?.kind ?? null,
      lastEventAt: lastEvent?.recordedAt ?? null,
      interviewsCount: interviewCountByApplication.get(application.id) ?? 0,
      liveOfferStatus: liveOffer
        ? effectiveOfferStatus({ status: liveOffer.status, expiresOn: liveOffer.expiresOn, businessToday: today })
        : null,
    };
  });

  const funnel = funnelCounts({
    stageKeys: stages.map((stage) => stage.key),
    applications: funnelRows.map((entry) => ({ stageKey: entry.stageKey })),
  }).map((entry) => ({
    ...entry,
    stageName: stages.find((stage) => stage.key === entry.stageKey)?.name ?? entry.stageKey,
  }));

  // Time-to-fill: opened_on to the first hired event on this requisition.
  const hiredEvents =
    applicationIds.length === 0
      ? []
      : (await db.execute<{ recordedAt: string }>(sql`
        select recorded_at as "recordedAt" from hrm_application_events
         where org_id = ${orgId} and application_id in (${sql.join(applicationIds.map((id) => sql`${id}::uuid`), sql`, `)})
           and kind = 'hired' order by recorded_at limit 1
      `)).rows;
  const timeToFill =
    row.openedOn && hiredEvents.length > 0
      ? timeToFillDays(row.openedOn, hiredEvents[0]!.recordedAt.slice(0, 10))
      : null;

  const managerNames = row.hiringManagerPartyId
    ? await namesById(db, orgId, "parties", [row.hiringManagerPartyId])
    : new Map<string, string>();

  return {
    id: row.id,
    requisitionNumber: row.requisitionNumber,
    title: row.title,
    positionCode: row.positionCode,
    departmentName: row.departmentName,
    headcount: row.headcount,
    filledCount: row.filledCount,
    hiringManagerName: row.hiringManagerPartyId ? (managerNames.get(row.hiringManagerPartyId) ?? null) : null,
    openedOn: row.openedOn,
    status: row.status as RequisitionStatus,
    href: `/hrm/recruiting?requisition=${row.id}`,
    employerSubsidiaryId: row.employerSubsidiaryId,
    targetStartOn: row.targetStartOn,
    compensation: compensationLabel(row),
    bandRange: await requisitionBandRange(db, orgId, actorId, row),
    description: row.description,
    stages: stages.map((stage) => ({ id: stage.id, key: stage.key, name: stage.name, kind: stage.kind })),
    funnel,
    applications: funnelRows,
    timeToFillDays: timeToFill,
  };
}

/**
 * Band range for a requisition drawer (HR-12, additive): the narrowest
 * live annual band covering the opening's position level, employer,
 * and department. Returns null (renders nothing) when the
 * hrmPayTransparency switch is off, the reader lacks
 * hrm.compensation.read, the opening names no architected position, or
 * no band covers the scope — never a zero, never a guess.
 */
async function requisitionBandRange(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  row: RequisitionRow,
): Promise<string | null> {
  const { actorHasPermission } = await import("../../organization/actor-permissions.ts");
  const { featureEnabled } = await import("../../organization/feature-registry.ts");
  const { resolveBandForScope } = await import("../compensation/bands.ts");
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.compensation.read"))) return null;
  const settings = (await exec.execute<{ features: Record<string, boolean> | null }>(sql`
    select settings->'features' as features from orgs where id = ${orgId}`)).rows[0]?.features ?? {};
  if (!featureEnabled(settings, "hrmPayTransparency")) return null;
  if (!row.positionId) return null;
  const position = (await exec.execute<{ level_id: string | null; location_id: string | null }>(sql`
    select job_level_id as level_id, location_id
      from position_versions
     where org_id = ${orgId} and position_id = ${row.positionId}
       and recorded_until is null
     order by effective_from desc
     limit 1`)).rows[0];
  if (!position?.level_id) return null;
  const level = (await exec.execute<{ family_id: string | null; code: string }>(sql`
    select family_id, code from hrm_job_levels where org_id = ${orgId} and id = ${position.level_id}`)).rows[0];
  if (!level) return null;
  const today = await businessToday(orgId);
  const band = await resolveBandForScope(
    orgId,
    {
      familyId: level.family_id,
      levelId: position.level_id,
      employerSubsidiaryId: row.employerSubsidiaryId,
      locationId: position.location_id,
      currency: row.compensationCurrency ?? "CAD",
      basis: "annual",
    },
    today,
  );
  if (!band) return null;
  return `${band.min} – ${band.max} ${band.currency} (${level.code})`;
}

export interface GetCandidateQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly candidateId: string;
}

export interface CandidateDetail extends CandidateView {
  readonly applications: readonly {
    requisitionId: string;
    requisitionNumber: string;
    requisitionTitle: string;
    applicationId: string;
    stageName: string;
    status: string;
    appliedOn: string;
  }[];
  readonly interviews: readonly {
    id: string;
    applicationId: string;
    kind: string;
    scheduledAt: string;
    status: string;
    outcome: string | null;
  }[];
}

/**
 * The candidate drawer: applications and interviews with PII redacted
 * unless the viewer holds hrm.recruiting.read. A hiring manager reaches a
 * candidate only through a requisition they manage.
 */
export async function getCandidateDetail(query: GetCandidateQuery): Promise<CandidateDetail> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const candidateId = requireId(query.candidateId, "candidateId");
  const canSeePii = await actorHoldsRecruitingRead(db, orgId, actorId);
  if (!canSeePii) {
    // Without the grant, the only path in is managing one of the
    // candidate's requisitions.
    const requisitions = (await db.execute<{ requisitionId: string }>(sql`
      select distinct requisition_id as "requisitionId" from hrm_applications
       where org_id = ${orgId} and candidate_id = ${candidateId}
    `)).rows;
    let admitted = false;
    for (const entry of requisitions) {
      try {
        await requireOwnRequisitionForHiringManager(db, orgId, actorId, entry.requisitionId);
        admitted = true;
        break;
      } catch {
        // Not this one; keep looking.
      }
    }
    if (!admitted) {
      throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization");
    }
  }
  const candidate = (await db.execute<{
    id: string;
    displayName: string;
    email: string | null;
    phone: string | null;
    source: string | null;
    resumeAttachmentId: string | null;
    isInternal: boolean;
  }>(sql`
    select id, display_name as "displayName", email, phone, source,
           resume_attachment_id as "resumeAttachmentId",
           is_internal as "isInternal"
      from hrm_candidates where org_id = ${orgId} and id = ${candidateId}
  `)).rows[0];
  if (!candidate) {
    throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization");
  }
  const applications = (await db.execute<{
    requisitionId: string;
    requisitionNumber: string;
    requisitionTitle: string;
    applicationId: string;
    stageName: string;
    status: string;
    appliedOn: string;
  }>(sql`
    select a.requisition_id as "requisitionId", r.requisition_number as "requisitionNumber",
           r.title as "requisitionTitle", a.id as "applicationId",
           s.name as "stageName", a.status, a.applied_on as "appliedOn"
      from hrm_applications a
      join hrm_requisitions r on r.org_id = a.org_id and r.id = a.requisition_id
      left join hrm_pipeline_stages s on s.org_id = a.org_id and s.id = a.stage_id
     where a.org_id = ${orgId} and a.candidate_id = ${candidateId}
     order by a.applied_on
  `)).rows;
  if (!canSeePii) {
    // The manager sees only the applications on their own requisitions.
    const own: typeof applications = [];
    for (const entry of applications) {
      try {
        await requireOwnRequisitionForHiringManager(db, orgId, actorId, entry.requisitionId);
        own.push(entry);
      } catch {
        // Another manager's funnel; not shown.
      }
    }
    if (own.length === 0) {
      throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization");
    }
    const visibleIds = new Set(own.map((entry) => entry.applicationId));
    const interviews = await interviewsFor(db, orgId, visibleIds);
    return {
      id: candidate.id,
      displayName: candidate.displayName,
      email: null,
      phone: null,
      source: candidate.source,
      resumeAttachmentId: null,
      isInternal: candidate.isInternal,
      href: `/hrm/recruiting?candidate=${candidate.id}`,
      applications: own,
      interviews,
    };
  }
  const interviews = await interviewsFor(
    db,
    orgId,
    new Set(applications.map((entry) => entry.applicationId)),
  );
  return {
    id: candidate.id,
    displayName: candidate.displayName,
    email: candidate.email,
    phone: candidate.phone,
    source: candidate.source,
    resumeAttachmentId: candidate.resumeAttachmentId,
    isInternal: candidate.isInternal,
    href: `/hrm/recruiting?candidate=${candidate.id}`,
    applications,
    interviews,
  };
}

async function interviewsFor(
  exec: SqlExecutor,
  orgId: string,
  applicationIds: Set<string>,
): Promise<CandidateDetail["interviews"]> {
  if (applicationIds.size === 0) return [];
  return (await exec.execute<{
    id: string;
    applicationId: string;
    kind: string;
    scheduledAt: string;
    status: string;
    outcome: string | null;
  }>(sql`
    select id, application_id as "applicationId", kind,
           scheduled_at as "scheduledAt", status, outcome
      from hrm_interviews
     where org_id = ${orgId} and application_id in (${sql.join([...applicationIds].map((id) => sql`${id}::uuid`), sql`, `)})
     order by scheduled_at
  `)).rows;
}

export interface GetInterviewForPanelistQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly interviewId: string;
}

/**
 * The interviewer's view: the interview plus the candidate NAME — nothing
 * else. No contact PII, no other applications, no offers.
 */
export async function getInterviewForPanelist(query: GetInterviewForPanelistQuery): Promise<{
  interviewId: string;
  applicationId: string;
  candidateName: string;
  kind: string;
  scheduledAt: string;
  durationMinutes: number | null;
  location: string | null;
  status: string;
}> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const interviewId = requireId(query.interviewId, "interviewId");
  if (!(await actorOnInterviewPanel(db, orgId, actorId, interviewId))) {
    throw new RecruitingError("NOT_FOUND", "interview is not visible in this organization");
  }
  const row = (await db.execute<{
    interviewId: string;
    applicationId: string;
    candidateName: string;
    kind: string;
    scheduledAt: string;
    durationMinutes: number | null;
    location: string | null;
    status: string;
  }>(sql`
    select i.id as "interviewId", i.application_id as "applicationId",
           c.display_name as "candidateName", i.kind,
           i.scheduled_at as "scheduledAt",
           i.duration_minutes as "durationMinutes", i.location, i.status
      from hrm_interviews i
      join hrm_applications a on a.org_id = i.org_id and a.id = i.application_id
      join hrm_candidates c on c.org_id = i.org_id and c.id = a.candidate_id
     where i.org_id = ${orgId} and i.id = ${interviewId}
  `)).rows[0];
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "interview is not visible in this organization");
  }
  return row;
}

export interface LoadRecruitingOverviewQuery {
  readonly orgId: string;
  readonly actorId: string;
}

/** The HR cockpit rail panel: open requisitions, offers awaiting response, interviews this week. */
export async function loadRecruitingOverview(query: LoadRecruitingOverviewQuery): Promise<RecruitingOverview | null> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  let allowed: Set<string> | null;
  try {
    allowed = await requireAggregateRecruitingRead(db, orgId, actorId);
  } catch {
    return null;
  }
  const scope = allowed
    ? sql`and r.employer_subsidiary_id in (${sql.join([...allowed].map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql``;
  const today = await businessToday(orgId);
  const open = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_requisitions r
     where r.org_id = ${orgId} and r.status = 'open' ${scope}
  `)).rows[0]?.n ?? 0;
  const offers = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_offers o
      join hrm_applications a on a.org_id = o.org_id and a.id = o.application_id
      join hrm_requisitions r on r.org_id = o.org_id and r.id = a.requisition_id
     where o.org_id = ${orgId} and o.status = 'sent'
       and (o.expires_on is null or o.expires_on >= ${today}::date) ${scope}
  `)).rows[0]?.n ?? 0;
  const interviews = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_interviews i
      join hrm_applications a on a.org_id = i.org_id and a.id = i.application_id
      join hrm_requisitions r on r.org_id = i.org_id and r.id = a.requisition_id
     where i.org_id = ${orgId} and i.status = 'scheduled'
       and i.scheduled_at >= now() and i.scheduled_at < now() + interval '7 days' ${scope}
  `)).rows[0]?.n ?? 0;
  return { openRequisitions: open, offersAwaitingResponse: offers, interviewsThisWeek: interviews };
}

export interface OfferView {
  readonly id: string;
  readonly applicationId: string;
  readonly requisitionId: string;
  readonly positionId: string | null;
  readonly employerSubsidiaryId: string;
  readonly jobTitle: string;
  readonly proposedStartOn: string;
  readonly compensationAmount: string;
  readonly compensationCurrency: string;
  readonly compensationBasis: string;
  readonly status: string;
  readonly effectiveStatus: string;
  readonly sentAt: string | null;
  readonly expiresOn: string | null;
  readonly respondedAt: string | null;
  readonly declineReason: string | null;
  readonly href: string;
}

export interface GetOfferQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly offerId: string;
}

/** The offer drawer: terms with the reader-reported (expiry-computed) status. */
export async function getOfferDetail(query: GetOfferQuery): Promise<OfferView> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const offerId = requireId(query.offerId, "offerId");
  const row = (await db.execute<{
    id: string;
    applicationId: string;
    requisitionId: string | null;
    positionId: string | null;
    employerSubsidiaryId: string;
    jobTitle: string;
    proposedStartOn: string;
    compensationAmount: string;
    compensationCurrency: string;
    compensationBasis: string;
    status: string;
    sentAt: string | null;
    expiresOn: string | null;
    respondedAt: string | null;
    declineReason: string | null;
  }>(sql`
    select o.id, o.application_id as "applicationId",
           a.requisition_id as "requisitionId", o.position_id as "positionId",
           o.employer_subsidiary_id as "employerSubsidiaryId",
           o.job_title as "jobTitle",
           o.proposed_start_on as "proposedStartOn",
           o.compensation_amount as "compensationAmount",
           o.compensation_currency as "compensationCurrency",
           o.compensation_basis as "compensationBasis", o.status,
           o.sent_at as "sentAt", o.expires_on as "expiresOn",
           o.responded_at as "respondedAt", o.decline_reason as "declineReason"
      from hrm_offers o
      left join hrm_applications a on a.org_id = o.org_id and a.id = o.application_id
     where o.org_id = ${orgId} and o.id = ${offerId}
  `)).rows[0];
  if (!row || !row.requisitionId) {
    throw new RecruitingError("NOT_FOUND", "offer is not visible in this organization");
  }
  try {
    await requireHrmRecruitingRead(db, orgId, actorId, row.requisitionId);
  } catch {
    await requireOwnRequisitionForHiringManager(db, orgId, actorId, row.requisitionId);
  }
  const today = await businessToday(orgId);
  return {
    ...row,
    requisitionId: row.requisitionId,
    effectiveStatus: effectiveOfferStatus({ status: row.status, expiresOn: row.expiresOn, businessToday: today }),
    href: `/hrm/recruiting?offer=${row.id}`,
  };
}

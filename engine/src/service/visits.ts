/**
 * Service visits: assessment visits of a request and service visits of a
 * job, with their field lifecycle. Status moves are recorded in the visit's
 * append-only history; the database guard refuses any move the lifecycle
 * does not allow and keeps booked statuses in step with live bookings.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  actorRef,
  auditService,
  lockServiceFeature,
  optionalDate,
  optionalInstant,
  optionalText,
  requireExpectedRevision,
  requireMinutes,
  requireOne,
  requirePriority,
  requireQualificationTypes,
  requiredText,
  requireUuid,
  SYSTEM_ACTOR,
  technicianParty,
  type ServiceActor,
} from "./common.ts";
import { ServiceError, serviceDatabaseRefusal, stale } from "./errors.ts";
import {
  visitIsBooked,
  visitIsFinished,
  visitTransitionPermitted,
  type ServicePriority,
  type VisitActorMode,
  type VisitStatus,
} from "./status.ts";
import type { CustomerNoticeRequest } from "./notices.ts";

export type StoredVisit = {
  readonly id: string;
  readonly revision: number;
  readonly subsidiaryId: string;
  readonly kind: "assessment" | "service";
  readonly requestId: string | null;
  readonly jobId: string | null;
  readonly sequence: number;
  readonly agreementId: string | null;
  readonly agreementVersionId: string | null;
  readonly occursOn: string | null;
  readonly status: VisitStatus;
  readonly priority: ServicePriority;
  readonly requiredQualificationTypeIds: string[];
  readonly estimatedMinutes: number;
  readonly preferredOn: string | null;
  readonly windowStartsAt: string | null;
  readonly windowEndsAt: string | null;
  readonly slaDueAt: string | null;
  readonly reviewStatus: "not_required" | "pending" | "approved" | "rejected" | null;
  readonly customerPartyId: string;
};

const INSTANT = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const STORED_VISIT_COLUMNS = sql`v.id, v.revision, v.subsidiary_id as "subsidiaryId", v.kind, v.request_id as "requestId", v.job_id as "jobId", v.sequence,
  v.agreement_id as "agreementId", v.agreement_version_id as "agreementVersionId", v.occurs_on::text as "occursOn", v.status, v.priority,
  v.required_qualification_type_ids::text[] as "requiredQualificationTypeIds", v.estimated_minutes as "estimatedMinutes", v.preferred_on::text as "preferredOn",
  ${INSTANT(sql`v.window_starts_at`)} as "windowStartsAt", ${INSTANT(sql`v.window_ends_at`)} as "windowEndsAt", ${INSTANT(sql`v.sla_due_at`)} as "slaDueAt",
  v.review_status as "reviewStatus", coalesce(j.customer_party_id, r.customer_party_id) as "customerPartyId"`;

export const STORED_VISIT_JOINS = sql`from service_visits v
  left join service_jobs j on j.org_id = v.org_id and j.id = v.job_id
  left join service_requests r on r.org_id = v.org_id and r.id = v.request_id`;

/** Lock a visit for a command. Absent and out-of-scope visits share one refusal. */
export async function lockVisit(orgId: string, visitId: unknown): Promise<StoredVisit> {
  const id = requireUuid(visitId, "Visit");
  const row = (
    await db.execute<StoredVisit>(
      sql`select ${STORED_VISIT_COLUMNS} ${STORED_VISIT_JOINS}
    where v.org_id = ${orgId} and v.id = ${id} for update of v`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  return row;
}

export function checkVisitRevision(visit: StoredVisit, expected: unknown): void {
  if (visit.revision !== requireExpectedRevision(expected)) throw stale("This visit");
}

/** Technicians holding a live booking on the visit. */
export async function visitTechnicians(
  orgId: string,
  visitId: string,
): Promise<
  {
    entryId: string;
    revision: number;
    workerPartyId: string;
    boardId: string;
    startsAt: string;
    endsAt: string;
  }[]
> {
  return await db.execute<{
    entryId: string;
    revision: number;
    workerPartyId: string;
    boardId: string;
    startsAt: string;
    endsAt: string;
  }>(
    sql`select e.id as "entryId", e.revision,
      e.worker_party_id as "workerPartyId", e.board_id as "boardId", ${INSTANT(sql`e.starts_at`)} as "startsAt", ${INSTANT(sql`e.ends_at`)} as "endsAt"
    from schedule_entries e where e.org_id = ${orgId} and e.service_visit_id = ${visitId} and e.status = 'published'
    order by e.starts_at, e.id`,
    "objects",
  );
}

export interface VisitAuthority {
  readonly mode: VisitActorMode;
  /** The technician acting on their own visit. */
  readonly partyId: string | null;
  readonly allowed: ReadonlySet<string> | null;
}

/**
 * Who may act on a visit's field status: dispatchers and managers in the
 * visit's legal entity act as staff; otherwise the caller must be a
 * technician booked on the visit. Anyone else sees the same refusal as for
 * a visit that does not exist.
 */
export async function visitFieldAuthority(
  actor: ServiceActor,
  visit: StoredVisit,
): Promise<VisitAuthority> {
  await lockServiceFeature(actor.orgId);
  for (const permission of ["service.dispatch", "service.manage"] as const) {
    if (await actorHasPermission(db, actor.orgId, actor.actorId, permission)) {
      const allowed = await lockActorCommandAuthority(
        db,
        actor.orgId,
        actor.actorId,
        visit.subsidiaryId,
        permission,
      );
      return { mode: "staff", partyId: null, allowed };
    }
  }
  const partyId = await technicianParty(actor);
  const booked = (await visitTechnicians(actor.orgId, visit.id)).some(
    (booking) => booking.workerPartyId === partyId,
  );
  if (!booked) throw new ScopeNotFoundError();
  return { mode: "technician", partyId, allowed: null };
}

/** Staff authority over a visit in its legal entity. */
export async function visitStaffAuthority(
  actor: ServiceActor,
  visit: StoredVisit,
  permission: "service.dispatch" | "service.manage",
): Promise<ReadonlySet<string> | null> {
  await lockServiceFeature(actor.orgId);
  for (const candidate of permission === "service.manage"
    ? (["service.manage"] as const)
    : (["service.dispatch", "service.manage"] as const)) {
    if (await actorHasPermission(db, actor.orgId, actor.actorId, candidate)) {
      return lockActorCommandAuthority(
        db,
        actor.orgId,
        actor.actorId,
        visit.subsidiaryId,
        candidate,
      );
    }
  }
  throw new ScopeNotFoundError();
}

export interface StatusChange {
  readonly to: VisitStatus;
  readonly reason?: string | null;
  readonly workerPartyId?: string | null;
  /** Additional visit columns the move records, already validated. */
  readonly set?: ReturnType<typeof sql>;
}

/**
 * Apply one status move with optimistic concurrency and record it in the
 * visit history. Returns the new revision.
 */
export async function moveVisitStatus(
  actor: ServiceActor,
  visit: StoredVisit,
  change: StatusChange,
): Promise<number> {
  const stamp =
    change.to === "dispatched"
      ? sql`, dispatched_at = now()`
      : change.to === "en_route"
        ? sql`, en_route_at = now()`
        : change.to === "on_site"
          ? sql`, arrived_at = coalesce(arrived_at, now())`
          : sql``;
  const updated = await db.execute<{ revision: number }>(
    sql`update service_visits set status = ${change.to}, revision = revision + 1,
      updated_at = now(), updated_by = ${actorRef(actor)} ${stamp} ${change.set ? sql`, ${change.set}` : sql``}
    where org_id = ${actor.orgId} and id = ${visit.id} and revision = ${visit.revision} returning revision`,
    "objects",
  );
  if (updated.length !== 1) throw stale("This visit");
  const revision = updated[0]!.revision;
  requireOne(
    await db.execute(
      sql`insert into service_visit_events (org_id, visit_id, from_status, to_status, visit_revision, actor_id, worker_party_id, reason)
    values (${actor.orgId}, ${visit.id}, ${visit.status}, ${change.to}, ${revision}, ${actorRef(actor)}, ${change.workerPartyId ?? null}, ${change.reason ?? null}) returning id`,
      "objects",
    ),
    "The visit history",
  );
  return revision;
}

/** Bump a visit's revision for a change that keeps its status (a reschedule), recording it in the history. */
export async function touchVisit(
  actor: ServiceActor,
  visit: StoredVisit,
  reason: string | null,
  set?: ReturnType<typeof sql>,
): Promise<number> {
  const updated = await db.execute<{ revision: number }>(
    sql`update service_visits set revision = revision + 1, updated_at = now(), updated_by = ${actorRef(actor)}
      ${set ? sql`, ${set}` : sql``}
    where org_id = ${actor.orgId} and id = ${visit.id} and revision = ${visit.revision} returning revision`,
    "objects",
  );
  if (updated.length !== 1) throw stale("This visit");
  const revision = updated[0]!.revision;
  requireOne(
    await db.execute(
      sql`insert into service_visit_events (org_id, visit_id, from_status, to_status, visit_revision, actor_id, reason)
    values (${actor.orgId}, ${visit.id}, ${visit.status}, ${visit.status}, ${revision}, ${actorRef(actor)}, ${reason}) returning id`,
      "objects",
    ),
    "The visit history",
  );
  return revision;
}

export interface VisitInput {
  readonly estimatedMinutes: number;
  readonly priority?: ServicePriority;
  readonly preferredOn?: string | null;
  readonly windowStartsAt?: string | null;
  readonly windowEndsAt?: string | null;
  readonly instructions?: string | null;
  readonly requiredQualificationTypeIds?: readonly string[];
}

export async function normalizeVisitInput(
  orgId: string,
  input: VisitInput,
  defaults: { priority: ServicePriority; requiredQualificationTypeIds: readonly string[] },
) {
  const windowStartsAt = optionalInstant(input.windowStartsAt, "Arrival window start");
  const windowEndsAt = optionalInstant(input.windowEndsAt, "Arrival window end");
  if (
    (windowStartsAt === null) !== (windowEndsAt === null) ||
    (windowStartsAt && windowEndsAt && Date.parse(windowEndsAt) <= Date.parse(windowStartsAt))
  ) {
    throw new ServiceError("The arrival window needs a start and a later end.", {
      code: "service_invalid",
      remedy: "Enter both ends of the arrival window, or leave it empty.",
    });
  }
  return {
    estimatedMinutes: requireMinutes(input.estimatedMinutes, "Visit length"),
    priority: input.priority === undefined ? defaults.priority : requirePriority(input.priority),
    preferredOn: optionalDate(input.preferredOn, "Preferred date"),
    windowStartsAt,
    windowEndsAt,
    instructions: optionalText(input.instructions, "Instructions", 4000),
    requiredQualificationTypeIds:
      input.requiredQualificationTypeIds === undefined
        ? [...defaults.requiredQualificationTypeIds]
        : await requireQualificationTypes(orgId, input.requiredQualificationTypeIds),
  };
}

/** Insert a visit (unscheduled) under a job or a request. */
export async function insertVisit(
  actor: ServiceActor,
  input: {
    id?: string;
    subsidiaryId: string;
    kind: "assessment" | "service";
    jobId: string | null;
    requestId: string | null;
    agreement?: { agreementId: string; versionId: string; occursOn: string } | null;
    slaDueAt: string | null;
    visit: Awaited<ReturnType<typeof normalizeVisitInput>>;
  },
): Promise<string> {
  const parentFilter = input.jobId
    ? sql`job_id = ${input.jobId}`
    : sql`request_id = ${input.requestId}`;
  const sequence = (
    await db.execute<{ next: number }>(
      sql`select coalesce(max(sequence), 0) + 1 as next from service_visits
    where org_id = ${actor.orgId} and ${parentFilter}`,
      "objects",
    )
  )[0]!.next;
  const v = input.visit;
  const row = requireOne(
    await db.execute<{ id: string }>(
      sql`insert into service_visits
      (id, org_id, subsidiary_id, kind, request_id, job_id, sequence, agreement_id, agreement_version_id, occurs_on, status, priority,
       required_qualification_type_ids, estimated_minutes, preferred_on, window_starts_at, window_ends_at, sla_due_at, instructions, created_by, updated_by)
    values (${input.id ?? sql`public.uuid_generate_v7()`}, ${actor.orgId}, ${input.subsidiaryId}, ${input.kind}, ${input.requestId}, ${input.jobId}, ${sequence},
      ${input.agreement?.agreementId ?? null}, ${input.agreement?.versionId ?? null}, ${input.agreement?.occursOn ?? null}, 'unscheduled', ${v.priority},
      ${`{${v.requiredQualificationTypeIds.join(",")}}`}::uuid[], ${v.estimatedMinutes}, ${v.preferredOn}, ${v.windowStartsAt}, ${v.windowEndsAt}, ${input.slaDueAt},
      ${v.instructions}, ${actorRef(actor)}, ${actorRef(actor)})
    returning id`,
      "objects",
    ),
    "The visit",
  );
  requireOne(
    await db.execute(
      sql`insert into service_visit_events (org_id, visit_id, from_status, to_status, visit_revision, actor_id, reason)
    values (${actor.orgId}, ${row.id}, null, 'unscheduled', 1, ${actorRef(actor)},
      ${input.agreement ? `Generated from the agreement for ${input.agreement.occursOn}` : null}) returning id`,
      "objects",
    ),
    "The visit history",
  );
  return row.id;
}

export interface VisitStatusResult {
  readonly visitId: string;
  readonly revision: number;
  readonly status: VisitStatus;
  /** Customer notices the caller delivers after commit. */
  readonly notices: readonly CustomerNoticeRequest[];
}

/**
 * Move a visit to a field status: dispatched (staff), en route, on site or
 * unable to complete (the assigned technician or staff). Completion has its
 * own command because it records the work done.
 */
export async function setVisitFieldStatus(
  actor: ServiceActor & {
    visitId: string;
    expectedRevision: number;
    to: VisitStatus;
    reason?: string | null;
  },
): Promise<VisitStatusResult> {
  if (actor.to === "completed")
    throw new ServiceError("Complete the visit from its completion form.", {
      code: "service_invalid",
      remedy: "Record the work notes, parts and labor to complete the visit.",
    });
  if (!["dispatched", "en_route", "on_site", "unable_to_complete"].includes(actor.to)) {
    throw new ServiceError("Choose dispatched, en route, on site or unable to complete.", {
      code: "service_invalid",
    });
  }
  return withOrgTransaction(actor.orgId, async () => {
    const visit = await lockVisit(actor.orgId, actor.visitId);
    checkVisitRevision(visit, actor.expectedRevision);
    const authority = await visitFieldAuthority(actor, visit);
    if (!visitTransitionPermitted(visit.status, actor.to, authority.mode)) {
      throw new ServiceError(
        `This visit is ${visit.status.replace(/_/g, " ")} and cannot move to ${actor.to.replace(/_/g, " ")}.`,
        {
          status: 409,
          code: "service_invalid_transition",
          remedy: "Reload the visit to see its current status.",
        },
      );
    }
    const reason =
      actor.to === "unable_to_complete"
        ? requiredText(actor.reason, "Reason", 2000)
        : optionalText(actor.reason, "Reason", 2000);
    const technicians = await visitTechnicians(actor.orgId, visit.id);
    const worker = authority.partyId ?? technicians[0]?.workerPartyId ?? null;
    const set = actor.to === "unable_to_complete" ? sql`outcome_reason = ${reason}` : undefined;
    const revision = await moveVisitStatus(actor, visit, {
      to: actor.to,
      reason,
      workerPartyId: worker,
      set,
    });
    if (actor.to === "unable_to_complete") {
      await auditService({
        orgId: actor.orgId,
        table: "service_visits",
        rowId: visit.id,
        action: "update",
        actorId: actor.actorId,
        before: { status: visit.status },
        after: { status: actor.to },
        reason,
      });
    }
    const notices: CustomerNoticeRequest[] =
      actor.to === "en_route"
        ? [{ visitId: visit.id, kind: "en_route", occurrenceKey: `en_route:${revision}` }]
        : [];
    return { visitId: visit.id, revision, status: actor.to, notices };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Change a visit's plan: length, priority, arrival window, instructions and required qualifications. */
export async function updateVisitPlan(
  actor: ServiceActor & {
    visitId: string;
    expectedRevision: number;
    input: VisitInput;
    reason?: string | null;
  },
): Promise<{ visitId: string; revision: number }> {
  return withOrgTransaction(actor.orgId, async () => {
    const visit = await lockVisit(actor.orgId, actor.visitId);
    checkVisitRevision(visit, actor.expectedRevision);
    await visitStaffAuthority(actor, visit, "service.dispatch");
    if (
      visitIsFinished(visit.status) ||
      visit.status === "en_route" ||
      visit.status === "on_site"
    ) {
      throw new ServiceError("A visit in progress or finished keeps its plan.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Change the plan before the technician leaves, or add another visit.",
      });
    }
    const next = await normalizeVisitInput(actor.orgId, actor.input, {
      priority: visit.priority,
      requiredQualificationTypeIds: visit.requiredQualificationTypeIds,
    });
    if (
      visitIsBooked(visit.status) &&
      next.requiredQualificationTypeIds.join() !== visit.requiredQualificationTypeIds.join()
    ) {
      throw new ServiceError("Required qualifications change while the visit is unassigned.", {
        status: 409,
        code: "service_invalid",
        remedy:
          "Remove the technicians, change the requirements, then assign qualified technicians.",
      });
    }
    const set = sql`estimated_minutes = ${next.estimatedMinutes}, priority = ${next.priority}, preferred_on = ${next.preferredOn}, window_starts_at = ${next.windowStartsAt},
      window_ends_at = ${next.windowEndsAt}, instructions = ${next.instructions}, required_qualification_type_ids = ${`{${next.requiredQualificationTypeIds.join(",")}}`}::uuid[]`;
    const reason = optionalText(actor.reason, "Reason", 2000);
    const revision = await touchVisit(actor, visit, reason ?? "Visit plan changed", set);
    await auditService({
      orgId: actor.orgId,
      table: "service_visits",
      rowId: visit.id,
      action: "update",
      actorId: actor.actorId,
      before: {
        estimatedMinutes: visit.estimatedMinutes,
        priority: visit.priority,
        preferredOn: visit.preferredOn,
        windowStartsAt: visit.windowStartsAt,
        windowEndsAt: visit.windowEndsAt,
        requiredQualificationTypeIds: visit.requiredQualificationTypeIds,
      },
      after: next,
      reason,
    });
    return { visitId: visit.id, revision };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/**
 * Cancel a visit that nobody has left for. Its bookings are removed in the
 * same transaction, so the technicians are free at once.
 */
export async function cancelVisitInTransaction(
  actor: ServiceActor,
  visit: StoredVisit,
  reason: string,
  kind: "cancelled" | "skipped" | "superseded" = "cancelled",
): Promise<number> {
  if (!(
    visit.status === "unscheduled" ||
    visit.status === "scheduled" ||
    visit.status === "dispatched"
  )) {
    throw new ServiceError(
      `A visit that is ${visit.status.replace(/_/g, " ")} cannot be cancelled.`,
      {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Record it as unable to complete instead, or complete it.",
      },
    );
  }
  for (const booking of await visitTechnicians(actor.orgId, visit.id)) {
    const cancelled = await db.execute(
      sql`update schedule_entries set status = 'cancelled', revision = revision + 1, reason = ${reason},
        updated_at = now(), updated_by = ${actor.actorId === SYSTEM_ACTOR ? sql`updated_by` : actor.actorId}
      where org_id = ${actor.orgId} and id = ${booking.entryId} and revision = ${booking.revision} and status = 'published' returning id`,
      "objects",
    );
    if (cancelled.length !== 1) throw stale("A booking of this visit");
  }
  return moveVisitStatus(actor, visit, {
    to: "cancelled",
    reason,
    set: sql`cancel_kind = ${kind}, outcome_reason = ${reason}`,
  });
}

export async function cancelVisit(
  actor: ServiceActor & {
    visitId: string;
    expectedRevision: number;
    reason: string;
    skip?: boolean;
  },
): Promise<{ visitId: string; revision: number }> {
  return withOrgTransaction(actor.orgId, async () => {
    const visit = await lockVisit(actor.orgId, actor.visitId);
    checkVisitRevision(visit, actor.expectedRevision);
    await visitStaffAuthority(actor, visit, "service.dispatch");
    const reason = requiredText(actor.reason, "Reason", 2000);
    if (actor.skip && !visit.agreementId)
      throw new ServiceError("Only agreement visits are skipped.", {
        code: "service_invalid",
        remedy: "Cancel the visit instead.",
      });
    const revision = await cancelVisitInTransaction(
      actor,
      visit,
      reason,
      actor.skip ? "skipped" : "cancelled",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_visits",
      rowId: visit.id,
      action: "update",
      actorId: actor.actorId,
      before: { status: visit.status },
      after: { status: "cancelled", cancelKind: actor.skip ? "skipped" : "cancelled" },
      reason,
    });
    return { visitId: visit.id, revision };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/**
 * Recurring service agreements. An agreement owns one service job billed
 * per visit and generates that job's visits from effective-dated versions
 * (recurrence, arrival window, visit length, priority, required
 * qualifications and per-visit lines) through the dispatch policy's horizon.
 *
 * Generation is deterministic and idempotent: each occurrence is generated
 * once per agreement and date. A skipped or cancelled occurrence is a
 * decision regeneration keeps. A new version supersedes the unscheduled
 * occurrences on and after its effective date, which are generated again
 * under it; booked or worked visits keep the version that generated them.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { businessTimeZoneInTx, businessTodayInTx } from "../platform/business-date.ts";
import { calendarDaysBetween } from "../platform/civil-date.ts";
import { resolveLocalTime } from "../platform/time-zone.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import {
  allocateServiceNumber,
  auditService,
  lockCommandKey,
  lockServiceFeature,
  optionalDate,
  optionalText,
  requireDate,
  requireExpectedRevision,
  requireMinutes,
  requireOne,
  requirePriority,
  requireQualificationTypes,
  requiredText,
  requireUuid,
  resolveServiceCustomer,
  serviceAuthority,
  SYSTEM_ACTOR,
  type ServiceActor,
} from "./common.ts";
import { ServiceError, serviceDatabaseRefusal, stale } from "./errors.ts";
import { insertJob, lockJob, normalizeLines, type JobLineInput } from "./jobs.ts";
import { requirePolicy } from "./policy.ts";
import {
  horizonDate,
  parseRecurrence,
  versionedOccurrences,
  type ServiceRecurrence,
} from "./recurrence.ts";
import type { ServicePriority } from "./status.ts";
import { cancelVisitInTransaction, lockVisit } from "./visits.ts";

export interface AgreementVersionInput {
  readonly recurrence: unknown;
  /** Local clock times of the arrival window, HH:MM. */
  readonly windowStarts: string;
  readonly windowEnds: string;
  readonly estimatedMinutes: number;
  readonly priority: ServicePriority;
  readonly requiredQualificationTypeIds?: readonly string[];
  readonly instructions?: string | null;
  readonly lines: readonly JobLineInput[];
}

export type StoredAgreement = {
  readonly id: string;
  readonly revision: number;
  readonly subsidiaryId: string;
  readonly agreementNumber: string;
  readonly customerPartyId: string;
  readonly serviceAddressId: string | null;
  readonly contactId: string | null;
  readonly title: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly status: "active" | "ended" | "cancelled";
  readonly jobId: string | null;
  readonly generatedThrough: string | null;
};

const AGREEMENT_COLUMNS = sql`id, revision, subsidiary_id as "subsidiaryId", agreement_number as "agreementNumber", customer_party_id as "customerPartyId",
  service_address_id as "serviceAddressId", contact_id as "contactId", title, starts_on::text as "startsOn", ends_on::text as "endsOn", status,
  (select j.id from service_jobs j where j.org_id = service_agreements.org_id and j.agreement_id = service_agreements.id) as "jobId",
  generated_through::text as "generatedThrough"`;

async function lockAgreement(orgId: string, agreementId: unknown): Promise<StoredAgreement> {
  const row = (
    await db.execute<StoredAgreement>(
      sql`select ${AGREEMENT_COLUMNS} from service_agreements
    where org_id = ${orgId} and id = ${requireUuid(agreementId, "Agreement")} for update`,
      "objects",
    )
  )[0];
  if (!row)
    throw new ServiceError("This agreement is not available.", { status: 404, code: "not_found" });
  return row;
}

function clock(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new ServiceError(`${field} needs a clock time such as 08:00.`, {
      code: "service_invalid_time",
    });
  return value;
}

async function normalizeVersion(orgId: string, input: AgreementVersionInput) {
  const windowStarts = clock(input.windowStarts, "Arrival window start");
  const windowEnds = clock(input.windowEnds, "Arrival window end");
  if (windowEnds <= windowStarts)
    throw new ServiceError("The arrival window must end after it starts on the same day.", {
      code: "service_invalid_time",
    });
  const lines = await normalizeLines(orgId, input.lines);
  if (!lines.length)
    throw new ServiceError("An agreement bills at least one line per visit.", {
      code: "service_invalid",
      remedy: "Add the service each visit bills.",
    });
  return {
    recurrence: parseRecurrence(input.recurrence),
    windowStarts,
    windowEnds,
    estimatedMinutes: requireMinutes(input.estimatedMinutes, "Visit length"),
    priority: requirePriority(input.priority),
    requiredQualificationTypeIds: await requireQualificationTypes(
      orgId,
      input.requiredQualificationTypeIds ?? [],
    ),
    instructions: optionalText(input.instructions, "Instructions", 4000),
    lines,
  };
}

async function insertVersion(
  actor: ServiceActor,
  agreementId: string,
  effectiveFrom: string,
  version: Awaited<ReturnType<typeof normalizeVersion>>,
  reason: string,
): Promise<string> {
  const row = requireOne(
    await db.execute<{ id: string }>(
      sql`insert into service_agreement_versions
      (org_id, agreement_id, effective_from, recurrence, window_starts, window_ends, estimated_minutes, priority, required_qualification_type_ids, instructions, reason, created_by)
    values (${actor.orgId}, ${agreementId}, ${effectiveFrom}, ${JSON.stringify(version.recurrence)}::jsonb, ${version.windowStarts}, ${version.windowEnds},
      ${version.estimatedMinutes}, ${version.priority}, ${`{${version.requiredQualificationTypeIds.join(",")}}`}::uuid[], ${version.instructions}, ${reason}, ${actor.actorId})
    returning id`,
      "objects",
    ),
    "The agreement version",
  );
  for (const [index, line] of version.lines.entries()) {
    requireOne(
      await db.execute(
        sql`insert into service_agreement_lines (org_id, version_id, line_number, item_id, description, quantity, unit_price, tax_code_id)
      values (${actor.orgId}, ${row.id}, ${index + 1}, ${line.itemId}, ${line.description}, ${line.quantity}, ${line.unitPrice}, ${line.taxCodeId}) returning id`,
        "objects",
      ),
      "An agreement line",
    );
  }
  return row.id;
}

/** Create an agreement with its first version and job, and generate its visits through the horizon. */
export async function createServiceAgreement(
  actor: ServiceActor & {
    id: string;
    input: {
      customerPartyId: string;
      serviceAddressId?: string | null;
      contactId?: string | null;
      subsidiaryId?: string | null;
      title: string;
      startsOn: string;
      endsOn?: string | null;
      version: AgreementVersionInput;
      reason: string;
    };
  },
): Promise<{ agreement: StoredAgreement; generated: number }> {
  const id = requireUuid(actor.id, "Agreement key");
  const input = actor.input;
  const title = requiredText(input.title, "Title", 200);
  const startsOn = requireDate(input.startsOn, "Start date");
  const endsOn = optionalDate(input.endsOn, "End date");
  if (endsOn && calendarDaysBetween(startsOn, endsOn) < 0)
    throw new ServiceError("The agreement ends before it starts.", {
      code: "service_invalid_date",
    });
  const reason = requiredText(input.reason, "Reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const allowed = await serviceAuthority(actor, "service.manage", null);
    await lockCommandKey("service-agreement", actor.orgId, id);
    const existing = (
      await db.execute<StoredAgreement & { createdBy: string }>(
        sql`select ${AGREEMENT_COLUMNS}, created_by as "createdBy" from service_agreements where org_id = ${actor.orgId} and id = ${id}`,
        "objects",
      )
    )[0];
    if (existing) {
      if (existing.createdBy !== actor.actorId)
        throw new ServiceError("This agreement key was already used.", {
          status: 409,
          code: "service_key_reused",
        });
      return { agreement: existing, generated: 0 };
    }
    const customer = await resolveServiceCustomer(actor.orgId, allowed, input);
    const version = await normalizeVersion(actor.orgId, input.version);
    const number = await allocateServiceNumber(actor.orgId, "service_agreement");
    requireOne(
      await db.execute(
        sql`insert into service_agreements (id, org_id, subsidiary_id, agreement_number, customer_party_id, service_address_id, contact_id, title,
        starts_on, ends_on, status, created_by, updated_by)
      values (${id}, ${actor.orgId}, ${customer.subsidiaryId}, ${number}, ${customer.customerPartyId}, ${customer.serviceAddressId}, ${customer.contactId}, ${title},
        ${startsOn}, ${endsOn}, 'active', ${actor.actorId}, ${actor.actorId}) returning id`,
        "objects",
      ),
      "The agreement",
    );
    await insertJob(actor, {
      id: crypto.randomUUID(),
      customer,
      requestId: null,
      quoteDocumentId: null,
      agreementId: id,
      title,
      description: version.instructions,
      priority: version.priority,
      requiredQualificationTypeIds: version.requiredQualificationTypeIds,
      estimatedMinutes: version.estimatedMinutes,
      billingMode: "per_visit",
      laborItemId: null,
      laborUnitPrice: null,
      depositRequired: "0",
      askedAt: new Date().toISOString(),
      lines: [],
    });
    await insertVersion(actor, id, startsOn, version, reason);
    const agreement = await lockAgreement(actor.orgId, id);
    await auditService({
      orgId: actor.orgId,
      table: "service_agreements",
      rowId: id,
      action: "insert",
      actorId: actor.actorId,
      after: { ...agreement, version },
      reason,
    });
    const generated = await generateInTransaction(actor, agreement);
    return { agreement: await lockAgreement(actor.orgId, id), generated };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/**
 * Add a version taking effect on a future date. Unscheduled occurrences on
 * and after that date are superseded and generated again under the new
 * terms; booked or worked visits are kept and reported.
 */
export async function addAgreementVersion(
  actor: ServiceActor & {
    agreementId: string;
    expectedRevision: number;
    effectiveFrom: string;
    version: AgreementVersionInput;
    reason: string;
  },
): Promise<{ agreement: StoredAgreement; superseded: number; kept: number; generated: number }> {
  const effectiveFrom = requireDate(actor.effectiveFrom, "Effective date");
  const reason = requiredText(actor.reason, "Reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const agreement = await lockAgreement(actor.orgId, actor.agreementId);
    if (agreement.revision !== requireExpectedRevision(actor.expectedRevision))
      throw stale("This agreement");
    await serviceAuthority(actor, "service.manage", agreement.subsidiaryId);
    if (agreement.status !== "active")
      throw new ServiceError("Only an active agreement changes its terms.", {
        status: 409,
        code: "service_invalid_transition",
      });
    const today = await businessTodayInTx(db, actor.orgId);
    if (calendarDaysBetween(today, effectiveFrom) <= 0)
      throw new ServiceError("New terms take effect after today.", {
        code: "service_invalid_date",
        remedy:
          "Choose an effective date from tomorrow; earlier visits keep the terms they were promised under.",
      });
    const latest = (
      await db.execute<{ effectiveFrom: string }>(
        sql`select max(effective_from)::text as "effectiveFrom" from service_agreement_versions where org_id = ${actor.orgId} and agreement_id = ${agreement.id}`,
        "objects",
      )
    )[0]?.effectiveFrom;
    if (latest && calendarDaysBetween(latest, effectiveFrom) <= 0)
      throw new ServiceError("New terms take effect after the latest version.", {
        code: "service_invalid_date",
        remedy: `Choose a date after ${latest}.`,
      });
    if (agreement.endsOn && calendarDaysBetween(effectiveFrom, agreement.endsOn) < 0)
      throw new ServiceError("The agreement ends before these terms would start.", {
        code: "service_invalid_date",
      });
    const version = await normalizeVersion(actor.orgId, actor.version);
    await insertVersion(actor, agreement.id, effectiveFrom, version, reason);
    const affected = await db.execute<{ id: string; status: string }>(
      sql`select id, status from service_visits where org_id = ${actor.orgId} and agreement_id = ${agreement.id}
      and occurs_on >= ${effectiveFrom} and status <> 'cancelled' order by occurs_on`,
      "objects",
    );
    let superseded = 0;
    let kept = 0;
    for (const visit of affected) {
      if (visit.status === "unscheduled") {
        await cancelVisitInTransaction(
          actor,
          await lockVisit(actor.orgId, visit.id),
          `Superseded by the agreement terms from ${effectiveFrom}`,
          "superseded",
        );
        superseded += 1;
      } else kept += 1;
    }
    const bumped = requireOne(
      await db.execute<StoredAgreement>(
        sql`update service_agreements set revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${agreement.id} and revision = ${agreement.revision} returning ${AGREEMENT_COLUMNS}`,
        "objects",
      ),
      "The agreement",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_agreement_versions",
      rowId: agreement.id,
      action: "insert",
      actorId: actor.actorId,
      after: { effectiveFrom, version, superseded, kept },
      reason,
    });
    const generated = await generateInTransaction(actor, bumped);
    return {
      agreement: await lockAgreement(actor.orgId, agreement.id),
      superseded,
      kept,
      generated,
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** End (from a date) or cancel an agreement. Unscheduled visits after the end are cancelled; the job stays for its history. */
export async function closeServiceAgreement(
  actor: ServiceActor & {
    agreementId: string;
    expectedRevision: number;
    outcome: "ended" | "cancelled";
    endsOn?: string | null;
    reason: string;
  },
): Promise<StoredAgreement> {
  const reason = requiredText(actor.reason, "Reason", 2000);
  if (actor.outcome !== "ended" && actor.outcome !== "cancelled")
    throw new ServiceError("Choose to end or cancel the agreement.", { code: "service_invalid" });
  return withOrgTransaction(actor.orgId, async () => {
    const agreement = await lockAgreement(actor.orgId, actor.agreementId);
    if (agreement.revision !== requireExpectedRevision(actor.expectedRevision))
      throw stale("This agreement");
    await serviceAuthority(actor, "service.manage", agreement.subsidiaryId);
    if (agreement.status !== "active")
      throw new ServiceError("This agreement is already closed.", {
        status: 409,
        code: "service_invalid_transition",
      });
    const today = await businessTodayInTx(db, actor.orgId);
    const endsOn =
      actor.outcome === "cancelled"
        ? agreement.endsOn && calendarDaysBetween(agreement.endsOn, today) > 0
          ? agreement.endsOn
          : today
        : requireDate(actor.endsOn, "End date");
    if (calendarDaysBetween(agreement.startsOn, endsOn) < 0)
      throw new ServiceError("The end date is before the agreement starts.", {
        code: "service_invalid_date",
      });
    const after = await db.execute<{ id: string }>(
      sql`select id from service_visits where org_id = ${actor.orgId} and agreement_id = ${agreement.id}
      and occurs_on > ${endsOn} and status = 'unscheduled' order by occurs_on`,
      "objects",
    );
    for (const visit of after)
      await cancelVisitInTransaction(actor, await lockVisit(actor.orgId, visit.id), reason);
    const row = requireOne(
      await db.execute<StoredAgreement>(
        sql`update service_agreements set status = ${actor.outcome}, ends_on = ${endsOn}, close_reason = ${reason},
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${agreement.id} and revision = ${agreement.revision} returning ${AGREEMENT_COLUMNS}`,
        "objects",
      ),
      "The agreement",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_agreements",
      rowId: agreement.id,
      action: "update",
      actorId: actor.actorId,
      before: { status: agreement.status, endsOn: agreement.endsOn },
      after: { status: actor.outcome, endsOn, cancelledVisits: after.length },
      reason,
    });
    return row;
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

type VersionRow = {
  id: string;
  effectiveFrom: string;
  recurrence: unknown;
  windowStarts: string;
  windowEnds: string;
  estimatedMinutes: number;
  priority: ServicePriority;
  requiredQualificationTypeIds: string[];
  instructions: string | null;
};

function windowInstant(date: string, time: string, timeZone: string): string | null {
  const resolved = resolveLocalTime({ date, time: time.slice(0, 5) }, timeZone);
  // A window time a clock change skips or repeats takes its first real instant.
  return resolved.kind === "ready" && resolved.choices.length ? resolved.choices[0]!.instant : null;
}

/** Generate the agreement's missing occurrences through the policy horizon, in the caller's transaction. */
async function generateInTransaction(
  actor: ServiceActor,
  agreement: StoredAgreement,
): Promise<number> {
  if (agreement.status !== "active" || !agreement.jobId) return 0;
  const today = await businessTodayInTx(db, actor.orgId);
  const policy = await requirePolicy(actor.orgId, today);
  const through = horizonDate(today, policy.agreementHorizonDays);
  const timeZone = await businessTimeZoneInTx(db, actor.orgId);
  const job = await lockJob(actor.orgId, agreement.jobId);
  if (job.status !== "open") return 0;
  const versions = await db.execute<VersionRow>(
    sql`select id, effective_from::text as "effectiveFrom", recurrence, to_char(window_starts, 'HH24:MI') as "windowStarts",
      to_char(window_ends, 'HH24:MI') as "windowEnds", estimated_minutes as "estimatedMinutes", priority,
      required_qualification_type_ids::text[] as "requiredQualificationTypeIds", instructions
    from service_agreement_versions where org_id = ${actor.orgId} and agreement_id = ${agreement.id} order by effective_from`,
    "objects",
  );
  if (!versions.length) return 0;
  const byId = new Map(versions.map((version) => [version.id, version]));
  const parsed = versions.map((version) => ({
    id: version.id,
    effectiveFrom: version.effectiveFrom,
    recurrence: parseRecurrence(version.recurrence) as ServiceRecurrence,
  }));
  // Never generate into the past: an occurrence before today was a decision for the day it fell on.
  const from = calendarDaysBetween(agreement.startsOn, today) > 0 ? today : agreement.startsOn;
  let generated = 0;
  for (const occurrence of versionedOccurrences(
    parsed,
    { startsOn: agreement.startsOn, endsOn: agreement.endsOn },
    from,
    through,
  )) {
    const version = byId.get(occurrence.versionId)!;
    const windowStartsAt = windowInstant(occurrence.occursOn, version.windowStarts, timeZone);
    const windowEndsAt = windowInstant(occurrence.occursOn, version.windowEnds, timeZone);
    const sequence = (
      await db.execute<{ next: number }>(
        sql`select coalesce(max(sequence), 0) + 1 as next from service_visits where org_id = ${actor.orgId} and job_id = ${job.id}`,
        "objects",
      )
    )[0]!.next;
    const inserted = await db.execute<{ id: string }>(
      sql`insert into service_visits
        (org_id, subsidiary_id, kind, job_id, sequence, agreement_id, agreement_version_id, occurs_on, status, priority, required_qualification_type_ids,
         estimated_minutes, preferred_on, window_starts_at, window_ends_at, instructions, created_by, updated_by)
      values (${actor.orgId}, ${job.subsidiaryId}, 'service', ${job.id}, ${sequence}, ${agreement.id}, ${version.id}, ${occurrence.occursOn}, 'unscheduled', ${version.priority},
        ${`{${version.requiredQualificationTypeIds.join(",")}}`}::uuid[], ${version.estimatedMinutes}, ${occurrence.occursOn},
        ${windowStartsAt && windowEndsAt ? windowStartsAt : null}, ${windowStartsAt && windowEndsAt ? windowEndsAt : null}, ${version.instructions},
        ${actor.actorId === SYSTEM_ACTOR ? null : actor.actorId}, ${actor.actorId === SYSTEM_ACTOR ? null : actor.actorId})
      -- An occurrence already generated, skipped or cancelled is kept as decided: regeneration is idempotent.
      on conflict (org_id, agreement_id, occurs_on) where agreement_id is not null and cancel_kind is distinct from 'superseded' do nothing
      returning id`,
      "objects",
    );
    if (inserted.length) {
      generated += 1;
      requireOne(
        await db.execute(
          sql`insert into service_visit_events (org_id, visit_id, from_status, to_status, visit_revision, actor_id, reason)
        values (${actor.orgId}, ${inserted[0]!.id}, null, 'unscheduled', 1, ${actor.actorId === SYSTEM_ACTOR ? null : actor.actorId}, ${`Generated from the agreement for ${occurrence.occursOn}`}) returning id`,
          "objects",
        ),
        "The visit history",
      );
    }
  }
  requireOne(
    await db.execute(
      sql`update service_agreements set generated_through = ${through}, revision = revision + 1, updated_at = now(),
      updated_by = ${actor.actorId === SYSTEM_ACTOR ? sql`updated_by` : actor.actorId}
    where org_id = ${actor.orgId} and id = ${agreement.id} returning id`,
      "objects",
    ),
    "The agreement horizon",
  );
  return generated;
}

/** Generate one agreement's visits through the horizon now. */
export async function generateAgreementVisits(
  actor: ServiceActor & { agreementId: string },
): Promise<{ generated: number }> {
  return withOrgTransaction(actor.orgId, async () => {
    const agreement = await lockAgreement(actor.orgId, actor.agreementId);
    if (actor.actorId === SYSTEM_ACTOR) await lockServiceFeature(actor.orgId);
    else await serviceAuthority(actor, "service.manage", agreement.subsidiaryId);
    return { generated: await generateInTransaction(actor, agreement) };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/**
 * The worker duty for one organization: every active agreement is generated
 * through its horizon. One agreement's refusal (a missing policy, a closed
 * job) is reported and never stops the others.
 */
export async function maintainServiceAgreements(
  orgId: string,
): Promise<{
  agreements: number;
  generated: number;
  failures: { agreementId: string; error: string }[];
}> {
  if (!(await orgFeatureEnabled(orgId, "serviceDispatch")))
    return { agreements: 0, generated: 0, failures: [] };
  const due = await withOrgTransaction(orgId, async () =>
    (
      await db.execute<{ id: string }>(
        sql`select id from service_agreements
    where org_id = ${orgId} and status = 'active' order by id`,
        "objects",
      )
    ).map((row) => row.id),
  );
  const failures: { agreementId: string; error: string }[] = [];
  let generated = 0;
  for (const agreementId of due) {
    try {
      generated += (await generateAgreementVisits({ orgId, actorId: SYSTEM_ACTOR, agreementId }))
        .generated;
    } catch (error) {
      failures.push({ agreementId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { agreements: due.length, generated, failures };
}

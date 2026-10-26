import { routeSubjectSubmission } from "../flows/submission-policy.ts";
/**
 * Visit completion: work notes, parts used (issued from stock through a
 * native inventory issue), labor recorded on native time entries in the
 * technician's timesheet, and an optional completion review through Flows.
 *
 * Completion is one transaction: a part that cannot issue, a labor day the
 * field clock already records, or a review Flow that cannot route refuses
 * the whole completion and leaves the visit on site.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { businessTimeZoneInTx } from "../platform/business-date.ts";
import { localTimeFields } from "../platform/time-zone.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { issueInventory } from "../inventory/movement-issue.ts";
import {
  assertNoFieldTimeSourceCollision,
  lockEmployeeTimeSources,
} from "../hrm/field-time/source-collision.ts";
import { FieldTimeError } from "../hrm/field-time/errors.ts";

import { SERVICE_VISIT_COMPLETION_SUBJECT_KIND } from "../flows/service-visit-adapter.ts";
import {
  auditService,
  lockDependentFeature,
  optionalText,
  optionalUuid,
  requireActiveItem,
  requireInstant,
  requireOne,
  requireQuantity,
  requiredText,
  requireUnitPrice,
  requireUuid,
  type ServiceActor,
} from "./common.ts";
import { ServiceError, serviceDatabaseRefusal } from "./errors.ts";
import { lockRequest, setRequestStatus } from "./requests.ts";
import {
  checkVisitRevision,
  lockVisit,
  moveVisitStatus,
  touchVisit,
  visitFieldAuthority,
  visitTechnicians,
  type StoredVisit,
} from "./visits.ts";

export interface VisitPartInput {
  readonly itemId: string;
  readonly stockLocationId: string;
  readonly quantity: string;
  /** The selling price recorded for billing; resolved from native item pricing at the boundary. */
  readonly unitPrice: string;
  readonly billable: boolean;
  readonly lotId?: string | null;
  readonly serialId?: string | null;
  readonly memo?: string | null;
}

function activeForWork(visit: StoredVisit): void {
  if (!(
    visit.status === "scheduled" ||
    visit.status === "dispatched" ||
    visit.status === "en_route" ||
    visit.status === "on_site"
  )) {
    throw new ServiceError("Parts are recorded on a scheduled or active visit.", {
      status: 409,
      code: "service_invalid_transition",
      remedy: "Reload the visit; a finished visit keeps its parts.",
    });
  }
}

/** Record a part used on a visit. It issues from stock when the visit completes. */
export async function recordVisitPart(
  actor: ServiceActor & { visitId: string; expectedRevision: number; part: VisitPartInput },
): Promise<{ partId: string; visitRevision: number }> {
  return withOrgTransaction(actor.orgId, async () => {
    const visit = await lockVisit(actor.orgId, actor.visitId);
    await visitFieldAuthority(actor, visit);
    checkVisitRevision(visit, actor.expectedRevision);
    activeForWork(visit);
    const item = await requireActiveItem(actor.orgId, actor.part.itemId, "Part");
    const quantity = requireQuantity(actor.part.quantity, "Quantity");
    if (canonicalDecimal(quantity, 4) === null)
      throw new ServiceError("Part quantities use at most four decimal places.", {
        code: "service_invalid",
      });
    const unitPrice = requireUnitPrice(actor.part.unitPrice, "Unit price");
    if (typeof actor.part.billable !== "boolean")
      throw new ServiceError("Say whether the part is billed to the customer.", {
        code: "service_invalid",
      });
    const stockLocationId = requireUuid(actor.part.stockLocationId, "Stock location");
    if (item.inventoryProfiled) await lockDependentFeature(actor.orgId, "inventory", "Inventory");
    const location = (
      await db.execute(
        sql`select 1 from stock_locations sl
      join locations l on l.org_id = sl.org_id and l.id = sl.location_id
      where sl.org_id = ${actor.orgId} and sl.id = ${stockLocationId} and sl.is_active
        and sl.kind <> 'subcontract' and sl.inventory_ownership = 'owned'
        and (l.subsidiary_id is null or l.subsidiary_id = ${visit.subsidiaryId})`,
        "objects",
      )
    )[0];
    if (!location)
      throw new ServiceError("The stock location is not active.", {
        code: "service_invalid",
        remedy: "Choose the van or warehouse the part came from.",
      });
    const lotId = optionalUuid(actor.part.lotId, "Lot");
    const serialId = optionalUuid(actor.part.serialId, "Serial number");
    if (
      lotId &&
      !(
        await db.execute(
          sql`select 1 from lots where org_id = ${actor.orgId} and id = ${lotId} and item_id = ${item.id}`,
          "objects",
        )
      )[0]
    ) {
      throw new ServiceError("The lot belongs to another item.", {
        code: "service_invalid",
        remedy: "Choose a lot of this part.",
      });
    }
    if (
      serialId &&
      !(
        await db.execute(
          sql`select 1 from serials where org_id = ${actor.orgId} and id = ${serialId} and item_id = ${item.id}`,
          "objects",
        )
      )[0]
    ) {
      throw new ServiceError("The serial number belongs to another item.", {
        code: "service_invalid",
        remedy: "Choose a serial number of this part.",
      });
    }
    const memo = optionalText(actor.part.memo, "Note", 500);
    const part = requireOne(
      await db.execute<{ id: string }>(
        sql`insert into service_visit_parts
        (org_id, visit_id, item_id, stock_location_id, quantity, unit_price, billable, memo, lot_id, serial_id, created_by)
      values (${actor.orgId}, ${visit.id}, ${item.id}, ${stockLocationId}, ${quantity}, ${unitPrice}, ${actor.part.billable}, ${memo}, ${lotId}, ${serialId}, ${actor.actorId})
      returning id`,
        "objects",
      ),
      "The part",
    );
    const visitRevision = await touchVisit(actor, visit, `Part recorded: ${item.name}`);
    await auditService({
      orgId: actor.orgId,
      table: "service_visit_parts",
      rowId: part.id,
      action: "insert",
      actorId: actor.actorId,
      after: {
        visitId: visit.id,
        itemId: item.id,
        stockLocationId,
        quantity,
        unitPrice,
        billable: actor.part.billable,
        lotId,
        serialId,
      },
    });
    return { partId: part.id, visitRevision };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Remove a part recorded on an active visit before it issues. */
export async function removeVisitPart(
  actor: ServiceActor & { visitId: string; expectedRevision: number; partId: string },
): Promise<{ visitRevision: number }> {
  return withOrgTransaction(actor.orgId, async () => {
    const visit = await lockVisit(actor.orgId, actor.visitId);
    checkVisitRevision(visit, actor.expectedRevision);
    await visitFieldAuthority(actor, visit);
    activeForWork(visit);
    const removed = await db.execute<{ itemId: string; quantity: string }>(
      sql`delete from service_visit_parts
      where org_id = ${actor.orgId} and id = ${requireUuid(actor.partId, "Part")} and visit_id = ${visit.id} and inventory_movement_id is null
      returning item_id as "itemId", quantity::text`,
      "objects",
    );
    if (removed.length !== 1) throw new ScopeNotFoundError();
    const visitRevision = await touchVisit(actor, visit, "Part removed");
    await auditService({
      orgId: actor.orgId,
      table: "service_visit_parts",
      rowId: actor.partId,
      action: "update",
      actorId: actor.actorId,
      before: removed[0],
      after: null,
      reason: "Removed before completion",
    });
    return { visitRevision };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

export interface LaborInput {
  /** The technician who worked; a technician completing their own visit records only their own labor. */
  readonly workerPartyId?: string | null;
  readonly startedAt: string;
  readonly hours: string;
}

function laborHours(value: unknown): string {
  const canonical = canonicalDecimal(value, 4);
  if (
    canonical === null ||
    compareDecimal(canonical, "0") <= 0 ||
    compareDecimal(canonical, "24") > 0
  ) {
    throw new ServiceError(
      "Labor hours must be more than zero and at most 24, with at most four decimal places.",
      { code: "service_invalid" },
    );
  }
  return canonical;
}

function sundayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addCalendarDays(date, -weekday);
}

/** Record labor on native time entries in each technician's timesheet week. */
async function recordLabor(
  actor: ServiceActor,
  visit: StoredVisit,
  job: { laborItemId: string | null; billingMode: string } | null,
  labor: readonly LaborInput[],
  selfParty: string | null,
): Promise<string[]> {
  if (!labor.length) return [];
  if (labor.length > 20)
    throw new ServiceError("Record at most 20 labor lines on a visit.", {
      code: "service_invalid",
    });
  await lockDependentFeature(actor.orgId, "timeTracking", "Time tracking");
  const booked = new Set(
    (await visitTechnicians(actor.orgId, visit.id)).map((booking) => booking.workerPartyId),
  );
  const timeZone = await businessTimeZoneInTx(db, actor.orgId);
  const entries: string[] = [];
  const workers = labor.map((line) => selfParty ?? requireUuid(line.workerPartyId, "Technician"));
  await lockEmployeeTimeSources(db, actor.orgId, workers);
  for (const [index, line] of labor.entries()) {
    const worker = workers[index]!;
    if (selfParty && line.workerPartyId && line.workerPartyId !== selfParty) {
      throw new ServiceError("You record only your own labor.", {
        code: "service_forbidden",
        remedy: "Ask the dispatcher to record a colleague's time.",
      });
    }
    if (!booked.has(worker))
      throw new ServiceError("Labor is recorded for technicians booked on the visit.", {
        code: "service_invalid",
        remedy: "Assign the technician to the visit first.",
      });
    const startedAt = requireInstant(line.startedAt, "Labor start");
    const hours = laborHours(line.hours);
    const workedOn = localTimeFields(startedAt, timeZone)?.date;
    if (!workedOn)
      throw new ServiceError("The labor start cannot be placed in the business time zone.", {
        code: "service_invalid_time",
      });
    try {
      await assertNoFieldTimeSourceCollision(db, {
        orgId: actor.orgId,
        employeePartyId: worker,
        workedOn,
        source: "service_visit",
        sourceId: visit.id,
      });
    } catch (error) {
      if (error instanceof FieldTimeError) {
        throw new ServiceError(
          `The technician's time on ${workedOn} is already recorded by the field clock or a crew sheet.`,
          {
            code: "service_labor_collision",
            remedy:
              "Complete the visit without labor lines; their clocked time already covers the day. Reconcile in Timesheets if the visit time must be split out.",
          },
        );
      }
      throw error;
    }
    // A concurrent writer already opened the person's week; its workflow state is kept.
    await db.execute(sql`insert into timesheet_weeks (org_id, employee_party_id, week_start, status, created_by, updated_by)
      values (${actor.orgId}, ${worker}, ${sundayOf(workedOn)}::date, 'draft', ${actor.actorId}, ${actor.actorId})
      on conflict do nothing`);
    const billable = Boolean(job?.laborItemId) && job?.billingMode !== "not_billable";
    const entry = requireOne(
      await db.execute<{ id: string }>(
        sql`insert into time_entries
        (org_id, employee_party_id, worked_on, hours, started_at, item_id, is_billable, status, service_visit_id, memo, created_by, updated_by)
      values (${actor.orgId}, ${worker}, ${workedOn}::date, ${hours}, ${startedAt}::timestamptz, ${billable ? job!.laborItemId : null}, ${billable},
        'draft', ${visit.id}, ${"Service visit labor"}, ${actor.actorId}, ${actor.actorId})
      returning id`,
        "objects",
      ),
      "A labor entry",
    );
    entries.push(entry.id);
  }
  return entries;
}

/** Issue every recorded, unissued stock part of the visit from inventory. */
async function issueParts(
  actor: ServiceActor,
  visit: StoredVisit,
  issueDate: string,
): Promise<number> {
  const parts = await db.execute<{
    id: string;
    itemId: string;
    stockLocationId: string;
    quantity: string;
    lotId: string | null;
    serialId: string | null;
    memo: string | null;
    profiled: boolean;
    name: string;
  }>(
    sql`
    select sp.id, sp.item_id as "itemId", sp.stock_location_id as "stockLocationId", sp.quantity::text, sp.lot_id as "lotId", sp.serial_id as "serialId", sp.memo,
           exists (select 1 from item_inventory_profiles p where p.org_id = sp.org_id and p.item_id = sp.item_id) as profiled,
           coalesce(nullif(i.code, ''), i.name) as name
      from service_visit_parts sp join items i on i.org_id = sp.org_id and i.id = sp.item_id
     where sp.org_id = ${actor.orgId} and sp.visit_id = ${visit.id} and sp.inventory_movement_id is null
     order by sp.created_at, sp.id for update of sp`,
    "objects",
  );
  let issued = 0;
  for (const part of parts) {
    if (!part.profiled) continue;
    if (!(await lockAndCheckOrgFeature(db, actor.orgId, "inventory"))) {
      throw new ServiceError("Inventory is switched off, so stock parts cannot issue.", {
        status: 404,
        code: "service_dependency_disabled",
        remedy: "Enable Inventory on Company Settings → Features, or remove the stock parts.",
      });
    }
    try {
      const movement = await issueInventory(actor.orgId, actor.actorId, {
        itemId: part.itemId,
        stockLocationId: part.stockLocationId,
        quantity: part.quantity,
        subsidiaryId: visit.subsidiaryId,
        date: issueDate,
        lotId: part.lotId,
        serialId: part.serialId,
        idempotencyKey: `service-visit-part:${part.id}`,
        memo: part.memo ?? `Service visit part`,
        tx: db,
      });
      requireOne(
        await db.execute(
          sql`update service_visit_parts set inventory_movement_id = ${movement.movementId}, issued_at = now()
        where org_id = ${actor.orgId} and id = ${part.id} and inventory_movement_id is null returning id`,
          "objects",
        ),
        "The part issue",
      );
      issued += 1;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceError(`Part ${part.name} could not issue from stock: ${message}`, {
        code: "service_part_issue_refused",
        remedy:
          "Correct the part's stock location, quantity, lot or serial number, or remove it, then complete the visit again.",
        cause: error,
      });
    }
  }
  return issued;
}

type ReviewRouting = {
  gated: boolean;
  runId: string | null;
  failed: boolean;
  error: string | null;
};

async function routeCompletionReview(actor: ServiceActor, visitId: string): Promise<ReviewRouting> {
  const result = (
    await routeSubjectSubmission({
      orgId: actor.orgId,
      actorId: actor.actorId,
      subjectKind: SERVICE_VISIT_COMPLETION_SUBJECT_KIND,
      subjectId: visitId,
      source: "api",
    })
  ).dispatch;
  const failedRun = result.runs.find((run) => run.status === "failed");
  return {
    gated: result.gatesCreated > 0,
    runId: result.runs.find((run) => run.gatesCreated > 0)?.runId ?? null,
    failed: result.failed || Boolean(failedRun),
    error: result.error ?? failedRun?.error ?? null,
  };
}

export interface CompletionResult {
  readonly visitId: string;
  readonly revision: number;
  readonly reviewStatus: "not_required" | "pending";
  readonly partsIssued: number;
  readonly laborEntryIds: readonly string[];
}

/**
 * Complete a visit that is on site: record the work notes, issue the parts,
 * record labor and submit the completion for any review Flow.
 */
export async function completeVisit(
  actor: ServiceActor & {
    visitId: string;
    expectedRevision: number;
    workNotes: string;
    labor?: readonly LaborInput[];
  },
): Promise<CompletionResult> {
  const workNotes = requiredText(actor.workNotes, "Work notes", 8000);
  return withOrgTransaction(actor.orgId, async () => {
    const visit = await lockVisit(actor.orgId, actor.visitId);
    checkVisitRevision(visit, actor.expectedRevision);
    const authority = await visitFieldAuthority(actor, visit);
    if (visit.status !== "on_site") {
      throw new ServiceError("A visit is completed on site.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Mark the visit on site first.",
      });
    }
    const job = visit.jobId
      ? ((
          await db.execute<{ laborItemId: string | null; billingMode: string; status: string }>(
            sql`select labor_item_id as "laborItemId", billing_mode as "billingMode", status
      from service_jobs where org_id = ${actor.orgId} and id = ${visit.jobId} for share`,
            "objects",
          )
        )[0] ?? null)
      : null;
    const timeZone = await businessTimeZoneInTx(db, actor.orgId);
    const today =
      localTimeFields(new Date().toISOString(), timeZone)?.date ??
      new Date().toISOString().slice(0, 10);
    const partsIssued = await issueParts(actor, visit, today);
    const laborEntryIds = await recordLabor(
      actor,
      visit,
      job,
      actor.labor ?? [],
      authority.mode === "technician" ? authority.partyId : null,
    );
    const technician =
      authority.partyId ??
      (await visitTechnicians(actor.orgId, visit.id))[0]?.workerPartyId ??
      null;
    // Completed first, then routed: the review Flow reads the completed visit.
    const revision = await moveVisitStatus(actor, visit, {
      to: "completed",
      reason: "Work completed",
      workerPartyId: technician,
      set: sql`work_notes = ${workNotes}, completed_at = now(), completed_by = ${actor.actorId}, review_status = 'not_required', review_flow_run_id = null`,
    });
    const routing = await routeCompletionReview(actor, visit.id);
    if (routing.failed) {
      throw new ServiceError(
        `The completion review could not be routed: ${routing.error ?? "an enabled review Flow failed"}.`,
        {
          code: "service_review_unroutable",
          remedy:
            "Fix or disable the Service visit completion Flow, then complete the visit again. Nothing was saved.",
        },
      );
    }
    let reviewStatus: "not_required" | "pending" = "not_required";
    let finalRevision = revision;
    if (routing.gated) {
      reviewStatus = "pending";
      const updated = await db.execute<{ revision: number }>(
        sql`update service_visits set review_status = 'pending', review_flow_run_id = ${routing.runId},
          revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
        where org_id = ${actor.orgId} and id = ${visit.id} and revision = ${revision} returning revision`,
        "objects",
      );
      finalRevision = requireOne(updated, "The completion review").revision;
    }
    if (visit.requestId) {
      const request = await lockRequest(actor.orgId, visit.requestId);
      if (request.status === "assessment_scheduled" || request.status === "new")
        await setRequestStatus(actor, request, "assessed");
    }
    await auditService({
      orgId: actor.orgId,
      table: "service_visits",
      rowId: visit.id,
      action: "update",
      actorId: actor.actorId,
      before: { status: visit.status },
      after: { status: "completed", reviewStatus, partsIssued, laborEntryIds, workNotes },
    });
    return { visitId: visit.id, revision: finalRevision, reviewStatus, partsIssued, laborEntryIds };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/**
 * Apply a completion review decision (the registered Flows release
 * handler). Approval releases the visit for invoicing; a rejection returns
 * it to on site with the reviewer's reason.
 */
export async function releaseCompletionReview(input: {
  orgId: string;
  actorId: string;
  visitId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
}): Promise<void> {
  const actor = { orgId: input.orgId, actorId: input.actorId };
  const visit = await lockVisit(input.orgId, input.visitId);
  if (visit.status !== "completed" || visit.reviewStatus !== "pending") {
    throw new ServiceError("This visit completion is not awaiting review.", {
      status: 409,
      code: "service_invalid_transition",
      remedy: "Reload the visit.",
    });
  }
  const reason =
    input.comment?.trim() ||
    (input.outcome === "approved" ? "Completion approved" : "Completion returned for correction");
  const decided = await db.execute<{ revision: number }>(
    sql`update service_visits set review_status = ${input.outcome}, review_decided_by = ${input.actorId},
      review_decided_at = now(), review_reason = ${reason}, revision = revision + 1, updated_at = now(), updated_by = ${input.actorId}
    where org_id = ${input.orgId} and id = ${visit.id} and revision = ${visit.revision} returning revision`,
    "objects",
  );
  const revision = requireOne(decided, "The review decision").revision;
  await auditService({
    orgId: input.orgId,
    table: "service_visits",
    rowId: visit.id,
    action: "update",
    actorId: input.actorId,
    before: { reviewStatus: "pending" },
    after: { reviewStatus: input.outcome },
    reason,
  });
  if (input.outcome === "rejected") {
    const rejectedLabor = await db.execute<{ id: string }>(
      sql`update time_entries
      set status = 'rejected', rejection_reason = ${reason}, updated_at = now(), updated_by = ${input.actorId}
      where org_id = ${input.orgId} and service_visit_id = ${visit.id} and status in ('draft', 'submitted') and billing_status = 'unbilled'
      returning id`,
      "objects",
    );
    for (const entry of rejectedLabor) {
      await auditService({
        orgId: input.orgId,
        table: "time_entries",
        rowId: entry.id,
        action: "update",
        actorId: input.actorId,
        after: { status: "rejected", rejectionReason: reason },
        reason,
      });
    }
    const reopened = { ...visit, revision, reviewStatus: "rejected" as const };
    await moveVisitStatus(actor, reopened, {
      to: "on_site",
      reason,
      set: sql`completed_at = null, completed_by = null, review_status = null, review_flow_run_id = null, review_decided_by = null, review_decided_at = null, review_reason = null`,
    });
  }
}

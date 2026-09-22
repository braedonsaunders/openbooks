import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { db, withOrg, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { parseCivilDate } from "../hrm/temporal.ts";
import { getEmploymentAsOf } from "../hrm/employment-read.ts";
import {
  createChangeRequestDraft,
  withdrawChangeRequest,
} from "../hrm/change-requests.ts";
import { hrmFeatureOn } from "./services.ts";

/**
 * HR-16 event verbs — cancel / rescind / correct on employment changes.
 *
 * All three are EVENTS, never row edits: each appends an employment_changes
 * row (verb cancel/rescind/correct with the link column the 0227 CHECK
 * requires) and each is visible in the change-request drawer history.
 * Cancel reuses the existing withdraw path for in-flight requests.
 *
 * Rescind reverses a COMPLETED change by closing the version it created
 * and reopening the prior image at the original effective date (the
 * bitemporal close+supersede primitive, dates validated through
 * temporal.ts parseCivilDate). It refuses when a later change depends on
 * the target (naming the dependency's revision and kind) and when payroll
 * has consumed the period (the hrm_payroll_inputs /
 * hrm_benefit_payroll_inputs seam rows exist with consumed_by — naming the
 * run). Permission: hrm.employment.approve. Reason required.
 *
 * Correct edits a completed change without re-approval only when the org
 * setting correct_requires_reapproval is false AND the actor holds
 * hrm.employment.manage; the default (true) opens a new pre-filled change
 * request instead. Either way the correction is a new version superseding
 * at the same effective date with verb correct + corrected_change_id.
 */

export class EventVerbError extends Error {}

type ChangeEventRow = {
  id: string;
  orgId: string;
  employmentId: string;
  assignmentId: string | null;
  revision: number;
  changeKind: string;
  verb: string;
  priorSnapshot: unknown;
  closedVersions: { table: string; identity: string; version_no: number; row_id: string; before: unknown }[];
  reason: string;
  action: string | null;
  reasonCode: string | null;
  recordedAt: Date;
};

async function loadChangeEvent(exec: SqlExecutor, orgId: string, changeId: string): Promise<ChangeEventRow | null> {
  const rows = await exec.execute<ChangeEventRow>(sql`
    select id, org_id as "orgId", employment_id as "employmentId",
           assignment_id as "assignmentId", revision,
           change_kind as "changeKind", verb,
           prior_snapshot as "priorSnapshot", closed_versions as "closedVersions",
           reason, action, reason_code as "reasonCode", recorded_at as "recordedAt"
      from employment_changes
     where org_id = ${orgId} and id = ${changeId}
     limit 1
  `);
  return rows.rows[0] ?? null;
}

function requireReason(reason: string | null | undefined, verb: string): string {
  if (!reason?.trim()) {
    throw new EventVerbError(
      `${verb} needs a written reason — the audit must show why history was rewritten; add the reason and try again`,
    );
  }
  return reason.trim();
}

async function requirePermission(orgId: string, actorId: string, permission: string): Promise<void> {
  const ok = await actorHasPermission(db, orgId, actorId, permission);
  if (!ok) {
    throw new EventVerbError(
      `this action requires the ${permission} permission — ask an administrator to grant it in /admin/roles`,
    );
  }
}

/** Cancel an in-flight change request → withdrawn with reason. Reuses withdraw. */
export async function cancelChangeRequest(input: {
  orgId: string;
  actorId: string;
  requestId: string;
  reason: string;
}): Promise<{ status: string }> {
  requireReason(input.reason, "cancel");
  const request = await withdrawChangeRequest({
    orgId: input.orgId,
    actorId: input.actorId,
    requestId: input.requestId,
    reason: input.reason.trim(),
  });
  return { status: request.status };
}

async function refuseWhenDependent(exec: SqlExecutor, orgId: string, target: ChangeEventRow): Promise<void> {
  const later = await exec.execute<{ id: string; revision: number; changeKind: string; verb: string }>(sql`
    select id, revision, change_kind as "changeKind", verb
      from employment_changes
     where org_id = ${orgId} and employment_id = ${target.employmentId}
       and revision > ${target.revision}
     order by revision asc
     limit 1
  `);
  const dep = later.rows[0];
  if (dep) {
    throw new EventVerbError(
      `this change cannot be rewritten: revision ${dep.revision} (${dep.changeKind}, ${dep.verb}) was applied afterwards and depends on it — rescind or correct revision ${dep.revision} first, working newest to oldest`,
    );
  }
}

async function refuseWhenPayrollConsumed(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  effectiveFrom: string,
): Promise<void> {
  const inputs = await exec.execute<{ runId: string }>(sql`
    select consumed_by_run_document_id as "runId"
      from hrm_payroll_inputs
     where org_id = ${orgId} and employment_id = ${employmentId}
       and status = 'consumed' and absence_date >= ${effectiveFrom}::date
     limit 1
  `);
  const consumed = inputs.rows[0];
  if (consumed) {
    throw new EventVerbError(
      `payroll has consumed this period (run ${consumed.runId}) — history under a consumed run is frozen; reverse it in payroll first`,
    );
  }
  const benefits = await exec.execute<{ runId: string }>(sql`
    select i.consumed_by_run_document_id as "runId"
      from hrm_benefit_payroll_inputs i
      join hrm_benefit_enrollments e on e.org_id = i.org_id and e.id = i.enrollment_id
     where i.org_id = ${orgId} and e.employment_id = ${employmentId}
       and i.status = 'consumed' and i.coverage_to >= ${effectiveFrom}::date
     limit 1
  `);
  const benefitConsumed = benefits.rows[0];
  if (benefitConsumed) {
    throw new EventVerbError(
      `payroll has consumed this period (benefits run ${benefitConsumed.runId}) — history under a consumed run is frozen; reverse it in payroll first`,
    );
  }
}

async function currentAggregateRevision(exec: SqlExecutor, orgId: string, employmentId: string): Promise<number> {
  const rows = await exec.execute<{ revision: number }>(sql`
    select revision from worker_employments
     where org_id = ${orgId} and id = ${employmentId} for update
  `);
  const row = rows.rows[0];
  if (!row) throw new EventVerbError("the employment is gone — history about a deleted aggregate never rewrites");
  return row.revision;
}

async function appendVerbEvent(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    employmentId: string;
    assignmentId: string | null;
    revision: number;
    changeKind: string;
    verb: "rescind" | "correct" | "cancel";
    reversesChangeId: string | null;
    correctedChangeId: string | null;
    priorSnapshot: unknown;
    closedVersions: unknown[];
    reason: string;
    action: string | null;
    reasonCode: string | null;
  },
): Promise<string> {
  const inserted = (await exec.execute<{ id: string }>(sql`
    insert into employment_changes
      (org_id, employment_id, assignment_id, revision, change_kind, verb,
       reverses_change_id, corrected_change_id,
       prior_snapshot, reason, recorded_source, recorded_by, closed_versions,
       action, reason_code, created_by, updated_by)
    values (${args.orgId}, ${args.employmentId}, ${args.assignmentId}, ${args.revision},
            ${args.changeKind}, ${args.verb},
            ${args.reversesChangeId}, ${args.correctedChangeId},
            ${JSON.stringify(args.priorSnapshot)}::jsonb, ${args.reason},
            'user', ${args.actorId}, ${JSON.stringify(args.closedVersions)}::jsonb,
            ${args.action}, ${args.reasonCode}, ${args.actorId}, ${args.actorId})
    returning id
  `)).rows[0];
  if (!inserted) {
    throw new EventVerbError("the verb event was not written — nothing changed; retry the action");
  }
  return inserted.id;
}

/**
 * Rescind a COMPLETED (verb apply) change: closes the version it created
 * and reopens the prior image at the original effective date, then writes
 * the verb rescind event. As-of reads before and after equal the
 * pre-change state (proven in event-verbs.integration.test.ts).
 */
export async function rescindEmploymentChange(input: {
  orgId: string;
  actorId: string;
  changeId: string;
  reason: string;
}): Promise<{ changeId: string; revision: number }> {
  const reason = requireReason(input.reason, "rescind");
  await requirePermission(input.orgId, input.actorId, "hrm.employment.approve");
  // Verbs absent while the feature is off (the routes 404 first; this is
  // the second fence for direct service callers).
  if (!(await hrmFeatureOn(input.orgId, "hrmEventVerbs"))) {
    throw new EventVerbError(
      "change event verbs are switched off for this organization — enable them in Company Settings → Features",
    );
  }
  return withOrgTransaction(input.orgId, async () => {
    const target = await loadChangeEvent(db, input.orgId, input.changeId);
    if (!target) throw new EventVerbError("change not found — reload the history and try again");
    if (target.verb !== "apply") {
      throw new EventVerbError(
        `only an applied change can be rescinded — this event is '${target.verb}'; correct or rescind the underlying apply instead`,
      );
    }
    if (!Array.isArray(target.closedVersions) || target.closedVersions.length === 0) {
      throw new EventVerbError(
        "this change closed no versions (contact/profile evidence has no prior image to reopen) — file a correcting change request instead",
      );
    }
    await refuseWhenDependent(db, input.orgId, target);

    const recordedAt = new Date();
    const newRevision = (await currentAggregateRevision(db, input.orgId, target.employmentId)) + 1;

    // The payroll seam is checked against the change's effective date before
    // anything writes (original effective dates are preserved on reopen).
    const effectiveFrom = String(
      (target.closedVersions[0]!.before as Record<string, unknown>)["effective_from"] ?? "0001-01-01",
    );
    parseCivilDate(effectiveFrom);
    await refuseWhenPayrollConsumed(db, input.orgId, target.employmentId, effectiveFrom);

    // Pre-rescind state for the event's evidence (as-of now, before reopen).
    // "Now" is the org's business day, never the UTC day.
    const preSnapshot = await getEmploymentAsOf({
      orgId: input.orgId,
      actorId: input.actorId,
      employmentId: target.employmentId,
      effectiveDate: await businessToday(input.orgId),
      knownAt: new Date().toISOString(),
    }).catch(() => null);

    // Resolve every closure first: the deferred closure-evidence guard
    // requires the event to name each row it closes (table, identity,
    // version_no, row_id) in closed_versions, so the event carries the
    // full closure list before any version closes.
    const reopened: { table: string; identity: string }[] = [];
    const closures: { element: (typeof target.closedVersions)[number]; before: Record<string, unknown>; liveId: string; liveVersionNo: number; nextNo: number; beforeClose: Record<string, unknown> }[] = [];
    for (const element of target.closedVersions) {
      const before = element.before as Record<string, unknown> | null;
      if (!before || typeof before !== "object") {
        throw new EventVerbError("the change evidence carries no reopenable image — file a correcting change request instead");
      }
      if (element.table !== "worker_employment_versions" && element.table !== "employment_assignment_versions" && element.table !== "reporting_relationships") {
        throw new EventVerbError(
          `rescind cannot reopen evidence table '${element.table}' — file a correcting change request for the non-versioned part instead`,
        );
      }
      const live = await resolveLiveClosure(db, input.orgId, element.table, element.identity);
      closures.push({ element, before, liveId: live.id, liveVersionNo: live.versionNo, nextNo: live.versionNo + 1, beforeClose: live.before });
      reopened.push({ table: element.table, identity: element.identity });
    }

    // The rescind event FIRST: closures name it in closed_by_change_id (the
    // version tables require all three closure columns together), exactly
    // like the apply path closes with its own change id.
    const changeId = await appendVerbEvent(db, {
      orgId: input.orgId,
      actorId: input.actorId,
      employmentId: target.employmentId,
      assignmentId: target.assignmentId,
      revision: newRevision,
      changeKind: target.changeKind,
      verb: "rescind",
      reversesChangeId: target.id,
      correctedChangeId: null,
      priorSnapshot: { rescinded: target.id, state: preSnapshot },
      closedVersions: closures.map((c) => ({
        table: c.element.table,
        identity: c.element.identity,
        version_no: c.liveVersionNo,
        row_id: c.liveId,
        // The image of the row THIS event closes (the live successor),
        // not the original change's image — the guard proves exactness.
        before: c.beforeClose,
      })),
      reason,
      action: target.action,
      reasonCode: target.reasonCode,
    });

    for (const c of closures) {
      if (c.element.table === "worker_employment_versions") {
        await rescindStatusVersion(db, {
          orgId: input.orgId, actorId: input.actorId, target, element: c.element, before: c.before,
          recordedAt, changeId, liveId: c.liveId, nextNo: c.nextNo,
        });
      } else if (c.element.table === "employment_assignment_versions") {
        await rescindAssignmentVersion(db, {
          orgId: input.orgId, actorId: input.actorId, target, element: c.element, before: c.before,
          recordedAt, changeId, liveId: c.liveId, nextNo: c.nextNo,
        });
      } else {
        await rescindReportingLine(db, {
          orgId: input.orgId, actorId: input.actorId, target, element: c.element, before: c.before,
          recordedAt, changeId, liveId: c.liveId, nextNo: c.nextNo,
        });
      }
    }

    const bumped = (await db.execute(sql`
      update worker_employments set revision = ${newRevision}, updated_by = ${input.actorId}, updated_at = now()
       where org_id = ${input.orgId} and id = ${target.employmentId} and revision = ${newRevision - 1}
      returning id
    `)).rows;
    if (bumped.length !== 1) {
      throw new EventVerbError("the employment changed while rescinding — nothing applied; reload and try again");
    }
    return { changeId, revision: newRevision };
  });
}

/** The live row a rescind/correct closes, resolved before the verb event
 *  appends (the event must name it in closed_versions). */
async function resolveLiveClosure(
  exec: SqlExecutor,
  orgId: string,
  table: string,
  identity: string,
): Promise<{ id: string; versionNo: number; before: Record<string, unknown> }> {
  const idColumn = table === "worker_employment_versions"
    ? "employment_id"
    : table === "employment_assignment_versions"
      ? "assignment_id"
      : "relationship_id";
  const live = await exec.execute<{ id: string; version_no: number; before: unknown }>(sql`
    select id, version_no, to_jsonb(t) as before from ${sql.identifier(table)} t
     where org_id = ${orgId} and ${sql.identifier(idColumn)} = ${identity}
       and recorded_until is null
     limit 1
  `);
  const row = live.rows[0];
  if (!row) {
    throw new EventVerbError("the live version is gone — a concurrent change won; reload and try again");
  }
  return { id: row.id, versionNo: row.version_no, before: (row.before ?? {}) as Record<string, unknown> };
}

type RescindCtx = {
  orgId: string;
  actorId: string;
  target: ChangeEventRow;
  element: { identity: string; version_no: number; row_id: string };
  before: Record<string, unknown>;
  recordedAt: Date;
  /** The rescind event closures name (all three closure columns together). */
  changeId: string;
  /** Pre-resolved live row this rescind closes. */
  liveId: string;
  nextNo: number;
};

async function rescindStatusVersion(exec: SqlExecutor, ctx: RescindCtx): Promise<void> {
  const effectiveFrom = String(ctx.before["effective_from"] ?? "");
  parseCivilDate(effectiveFrom);
  // Close the pre-resolved live row (named in the rescind event's
  // closed_versions); reopen the prior image at the ORIGINAL effective date.
  const nextNo = ctx.nextNo;
  const closed = (await exec.execute(sql`
    update worker_employment_versions
       set recorded_until = ${ctx.recordedAt}, superseded_by = ${nextNo},
           closed_by_change_id = ${ctx.changeId}
     where org_id = ${ctx.orgId} and id = ${ctx.liveId} and recorded_until is null
    returning id
  `)).rows;
  if (closed.length !== 1) {
    throw new EventVerbError("the live employment version changed while rescinding — reload and try again");
  }
  await exec.execute(sql`
    insert into worker_employment_versions
      (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at, created_by, updated_by)
    values (${ctx.orgId}, ${ctx.element.identity}, ${nextNo},
            ${String(ctx.before["status"] ?? "active")}, ${effectiveFrom}::date,
            ${ctx.before["effective_to"] as string | null}::date,
            ${ctx.recordedAt}, ${ctx.actorId}, ${ctx.actorId})
  `);
}

async function rescindAssignmentVersion(exec: SqlExecutor, ctx: RescindCtx): Promise<void> {
  const effectiveFrom = String(ctx.before["effective_from"] ?? "");
  parseCivilDate(effectiveFrom);
  const nextNo = ctx.nextNo;
  const closed = (await exec.execute(sql`
    update employment_assignment_versions
       set recorded_until = ${ctx.recordedAt}, superseded_by = ${nextNo},
           closed_by_change_id = ${ctx.changeId}
     where org_id = ${ctx.orgId} and id = ${ctx.liveId} and recorded_until is null
    returning id
  `)).rows;
  if (closed.length !== 1) {
    throw new EventVerbError("the live assignment version changed while rescinding — reload and try again");
  }
  await exec.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, position_id, version_no, job_title,
       department_id, location_id, fte, is_primary, effective_from, effective_to,
       recorded_at, created_by, updated_by)
    values (${ctx.orgId}, ${ctx.element.identity}, ${ctx.target.employmentId},
            ${ctx.before["position_id"] as string | null}, ${nextNo},
            ${ctx.before["job_title"] as string | null},
            ${ctx.before["department_id"] as string | null},
            ${ctx.before["location_id"] as string | null},
            ${String(ctx.before["fte"] ?? "1")},
            ${ctx.before["is_primary"] === true},
            ${effectiveFrom}::date, ${ctx.before["effective_to"] as string | null}::date,
            ${ctx.recordedAt}, ${ctx.actorId}, ${ctx.actorId})
  `);
}

async function rescindReportingLine(exec: SqlExecutor, ctx: RescindCtx): Promise<void> {
  const effectiveFrom = String(ctx.before["effective_from"] ?? "");
  parseCivilDate(effectiveFrom);
  const nextNo = ctx.nextNo;
  const closed = (await exec.execute(sql`
    update reporting_relationships
       set recorded_until = ${ctx.recordedAt}, superseded_by = ${nextNo},
           closed_by_change_id = ${ctx.changeId}
     where org_id = ${ctx.orgId} and id = ${ctx.liveId} and recorded_until is null
    returning id
  `)).rows;
  if (closed.length !== 1) {
    throw new EventVerbError("the live reporting line changed while rescinding — reload and try again");
  }
  await exec.execute(sql`
    insert into reporting_relationships
      (org_id, employment_id, manager_employment_id, kind, relationship_id,
       version_no, effective_from, effective_to, recorded_at, created_by, updated_by)
    values (${ctx.orgId}, ${ctx.target.employmentId},
            ${ctx.before["manager_employment_id"] as string},
            ${String(ctx.before["kind"] ?? "line")}, ${ctx.element.identity}, ${nextNo},
            ${effectiveFrom}::date, ${ctx.before["effective_to"] as string | null}::date,
            ${ctx.recordedAt}, ${ctx.actorId}, ${ctx.actorId})
  `);
}

/** Read the org's correct_requires_reapproval setting (default TRUE). */
export async function correctRequiresReapproval(orgId: string): Promise<boolean> {
  const rows = await db.execute<{ settings: { hrmCorrectRequiresReapproval?: boolean } | null }>(sql`
    select settings from orgs where id = ${orgId} limit 1
  `);
  const settings = rows.rows[0]?.settings;
  if (!settings || typeof settings !== "object") return true;
  const v = (settings as Record<string, unknown>)["hrmCorrectRequiresReapproval"];
  return v === undefined ? true : v !== false;
}

/**
 * Correct a completed change. Default (correct_requires_reapproval true):
 * opens a NEW pre-filled change request carrying the corrected payload and
 * returns its id — the correction itself still passes approval. When the
 * org allows direct correction (setting false + hrm.employment.manage):
 * applies as a new version superseding at the same effective date with
 * verb correct + corrected_change_id.
 */
export async function correctEmploymentChange(input: {
  orgId: string;
  actorId: string;
  changeId: string;
  reason: string;
  /** Corrected scalar fields for direct application (assignment/status chains). */
  correctedFields?: Record<string, unknown>;
  /** Prefill payload when opening a new request (reapproval path). */
  prefillPayload?: Record<string, unknown>;
}): Promise<{ mode: "reapproval" | "direct"; requestId?: string; changeId?: string }> {
  const reason = requireReason(input.reason, "correct");
  if (!(await hrmFeatureOn(input.orgId, "hrmEventVerbs"))) {
    throw new EventVerbError(
      "change event verbs are switched off for this organization — enable them in Company Settings → Features",
    );
  }
  return withOrg(input.orgId, async () => {
    const target = await loadChangeEvent(db, input.orgId, input.changeId);
    if (!target) throw new EventVerbError("change not found — reload the history and try again");
    if (target.verb !== "apply") {
      throw new EventVerbError("only an applied change can be corrected — pick the underlying apply event");
    }
    if (await correctRequiresReapproval(input.orgId)) {
      await requirePermission(input.orgId, input.actorId, "hrm.employment.manage");
      const agg = await db.execute<{ revision: number }>(sql`
        select revision from worker_employments where org_id = ${input.orgId} and id = ${target.employmentId} limit 1
      `);
      if (!agg.rows[0]) throw new EventVerbError("the employment is gone — history about a deleted aggregate never rewrites");
      const request = await createChangeRequestDraft({
        orgId: input.orgId,
        actorId: input.actorId,
        employmentId: target.employmentId,
        payload: (input.prefillPayload ?? {}) as never,
      });
      return { mode: "reapproval" as const, requestId: request.id };
    }

    await requirePermission(input.orgId, input.actorId, "hrm.employment.manage");
    const fields = input.correctedFields ?? {};
    if (Object.keys(fields).length === 0) {
      throw new EventVerbError("direct correction needs correctedFields — name the fields and their corrected values");
    }
    return withOrgTransaction(input.orgId, async () => {
      await refuseWhenDependent(db, input.orgId, target);
      const recordedAt = new Date();
      const newRevision = (await currentAggregateRevision(db, input.orgId, target.employmentId)) + 1;
      // Direct correction supersedes the LIVE version at the same effective
      // date (no re-approval by org policy). Only scalar version columns on
      // the two versioned chains; anything else refuses with the reapproval
      // remedy. The live row resolves BEFORE the event appends so the event
      // names its closure (the deferred evidence guard requires it).
      const plan = await planDirectCorrection(db, {
        orgId: input.orgId, target, fields,
      });
      // The correct event first so closures name it (all three closure
      // columns together, like the apply path).
      const changeId = await appendVerbEvent(db, {
        orgId: input.orgId,
        actorId: input.actorId,
        employmentId: target.employmentId,
        assignmentId: target.assignmentId,
        revision: newRevision,
        changeKind: target.changeKind,
        verb: "correct",
        reversesChangeId: null,
        correctedChangeId: target.id,
        priorSnapshot: { corrected: target.id, fields },
        closedVersions: [{
          table: plan.table,
          identity: plan.identity,
          version_no: plan.liveVersionNo,
          row_id: plan.liveId,
          before: plan.before,
        }],
        reason,
        action: target.action,
        reasonCode: target.reasonCode,
      });
      const corrected = await applyDirectCorrection(db, {
        orgId: input.orgId, actorId: input.actorId, target, fields, recordedAt, changeId, plan,
      });
      const effectiveFrom = corrected.effectiveFrom;
      await refuseWhenPayrollConsumed(db, input.orgId, target.employmentId, effectiveFrom);
      const bumped = (await db.execute(sql`
        update worker_employments set revision = ${newRevision}, updated_by = ${input.actorId}, updated_at = now()
         where org_id = ${input.orgId} and id = ${target.employmentId} and revision = ${newRevision - 1}
        returning id
      `)).rows;
      if (bumped.length !== 1) {
        throw new EventVerbError("the employment changed while correcting — nothing applied; reload and try again");
      }
      return { mode: "direct" as const, changeId };
    });
  });
}

const CORRECTABLE_ASSIGNMENT_FIELDS = ["job_title", "department_id", "location_id", "fte", "position_id"] as const;
const CORRECTABLE_STATUS_FIELDS = ["status"] as const;

type CorrectionPlan = {
  table: "employment_assignment_versions" | "worker_employment_versions";
  identity: string;
  liveId: string;
  liveVersionNo: number;
  nextNo: number;
  before: Record<string, unknown>;
  row: Record<string, unknown>;
  effectiveFrom: string;
};

/** Validate fields and resolve the live row the correction closes. */
async function planDirectCorrection(
  exec: SqlExecutor,
  ctx: { orgId: string; target: ChangeEventRow; fields: Record<string, unknown> },
): Promise<CorrectionPlan> {
  for (const key of Object.keys(ctx.fields)) {
    if (
      !(CORRECTABLE_ASSIGNMENT_FIELDS as readonly string[]).includes(key) &&
      !(CORRECTABLE_STATUS_FIELDS as readonly string[]).includes(key)
    ) {
      throw new EventVerbError(
        `direct correction refuses field '${key}' — correctable: ${[...CORRECTABLE_ASSIGNMENT_FIELDS, ...CORRECTABLE_STATUS_FIELDS].join(", ")}; anything else needs a new change request with re-approval`,
      );
    }
  }
  const assignmentKeys = Object.keys(ctx.fields).filter((k) =>
    (CORRECTABLE_ASSIGNMENT_FIELDS as readonly string[]).includes(k),
  );
  const onAssignment = assignmentKeys.length > 0 && ctx.target.assignmentId;
  const table = onAssignment ? "employment_assignment_versions" : "worker_employment_versions";
  const idColumn = onAssignment ? "assignment_id" : "employment_id";
  const identity = onAssignment ? ctx.target.assignmentId! : ctx.target.employmentId;
  const live = await exec.execute<Record<string, unknown>>(sql`
    select *, to_jsonb(t) as before from ${sql.identifier(table)} t
     where org_id = ${ctx.orgId} and ${sql.identifier(idColumn)} = ${identity}
       and recorded_until is null
     limit 1
  `);
  const row = live.rows[0];
  if (!row) throw new EventVerbError("the live version is gone — a concurrent change won; reload and try again");
  const maxNo = await exec.execute<{ maxNo: number }>(sql`
    select coalesce(max(version_no), 0) as "maxNo" from ${sql.identifier(table)}
     where org_id = ${ctx.orgId} and ${sql.identifier(idColumn)} = ${identity}
  `);
  const effectiveFrom = String(row["effective_from"]);
  parseCivilDate(effectiveFrom);
  return {
    table,
    identity,
    liveId: String(row["id"]),
    liveVersionNo: Number(row["version_no"]),
    nextNo: (maxNo.rows[0]?.maxNo ?? 0) + 1,
    before: (row["before"] ?? row) as Record<string, unknown>,
    row,
    effectiveFrom,
  };
}

async function applyDirectCorrection(
  exec: SqlExecutor,
  ctx: {
    orgId: string;
    actorId: string;
    target: ChangeEventRow;
    fields: Record<string, unknown>;
    recordedAt: Date;
    changeId: string;
    plan: CorrectionPlan;
  },
): Promise<{ effectiveFrom: string }> {
  const { plan } = ctx;
  const row = plan.row;
  const nextNo = plan.nextNo;
  const effectiveFrom = plan.effectiveFrom;
  const closed = (await exec.execute(sql`
    update ${sql.identifier(plan.table)}
       set recorded_until = ${ctx.recordedAt}, superseded_by = ${nextNo},
           closed_by_change_id = ${ctx.changeId}
     where org_id = ${ctx.orgId} and id = ${plan.liveId} and recorded_until is null
    returning id
  `)).rows;
  if (closed.length !== 1) {
    throw new EventVerbError("the live version changed while correcting — reload and try again");
  }
  if (plan.table === "employment_assignment_versions") {
    const merged = { ...row, ...ctx.fields };
    await exec.execute(sql`
      insert into employment_assignment_versions
        (org_id, assignment_id, employment_id, position_id, version_no, job_title,
         department_id, location_id, fte, is_primary, effective_from, effective_to,
         recorded_at, created_by, updated_by)
      values (${ctx.orgId}, ${ctx.target.assignmentId}, ${ctx.target.employmentId},
              ${merged["position_id"] as string | null}, ${nextNo},
              ${merged["job_title"] as string | null},
              ${merged["department_id"] as string | null},
              ${merged["location_id"] as string | null},
              ${String(merged["fte"] ?? "1")},
              ${merged["is_primary"] === true},
              ${effectiveFrom}::date, ${row["effective_to"] as string | null}::date,
              ${ctx.recordedAt}, ${ctx.actorId}, ${ctx.actorId})
    `);
    return { effectiveFrom };
  }
  await exec.execute(sql`
    insert into worker_employment_versions
      (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at, created_by, updated_by)
    values (${ctx.orgId}, ${ctx.target.employmentId}, ${nextNo},
            ${String(ctx.fields["status"] ?? row["status"])}, ${effectiveFrom}::date,
            ${row["effective_to"] as string | null}::date,
            ${ctx.recordedAt}, ${ctx.actorId}, ${ctx.actorId})
  `);
  return { effectiveFrom };
}

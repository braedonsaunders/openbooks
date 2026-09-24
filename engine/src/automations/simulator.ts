import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { executeAutomation, loadAutomation, type RunStep } from "./execute.ts";
import { parseAutomationActions } from "./triggers.ts";

/**
 * HR-16 automation simulator — dry-run a recipe against a chosen subject
 * (or the last N real subjects of its entity) producing the run's step
 * list with status simulated and NO writes.
 *
 * The executor takes a mode flag ('simulated') and the simulate path
 * performs zero writes by construction — no run row, no notifications,
 * no outbox jobs, no field writes. simulator-writes-nothing.test.ts
 * proves it by counting rows before and after. A simulation that matched
 * nothing reports skipped_no_match with an empty step list rather than
 * pretending steps ran.
 */

export type SimulationResult = {
  subjectEntity: string | null;
  subjectId: string | null;
  status: "simulated" | "skipped_no_match";
  steps: RunStep[];
};

async function lastSubjectIds(
  orgId: string,
  entity: string,
  limit: number,
  scope: ReadonlySet<string> | null,
): Promise<string[]> {
  // Sampling must not enumerate another entity's records: only subjects
  // whose subsidiary lineage the snapshot can prove are sampled for
  // restricted callers. Entities without snapshot lineage sample nothing —
  // those callers simulate with an explicit subject id instead. An empty
  // scope sees nothing at all.
  if (scope !== null) {
    if (entity !== "employment" && entity !== "leave_request") return [];
    if (scope.size === 0) return [];
  }
  const subsidiaryFilter =
    scope === null
      ? sql``
      : sql`and ${entity === "leave_request" ? sql`e.employer_subsidiary_id` : sql`r.employer_subsidiary_id`} = any(${`{${[...scope].join(",")}}`}::uuid[])`;
  if (entity === "employment") {
    const rows = await db.execute<{ id: string }>(sql`
      select r.id from worker_employments r
       where r.org_id = ${orgId}
       ${subsidiaryFilter}
       order by r.created_at desc
       limit ${limit}
    `);
    return rows.rows.map((r) => r.id);
  }
  if (entity === "leave_request") {
    const rows = await db.execute<{ id: string }>(sql`
      select r.id from hrm_leave_requests r
      left join worker_employments e on e.org_id = r.org_id and e.id = r.employment_id
       where r.org_id = ${orgId}
       ${subsidiaryFilter}
       order by r.created_at desc
       limit ${limit}
    `);
    return rows.rows.map((r) => r.id);
  }
  const table = entity === "timesheet_week"
    ? "timesheet_weeks"
    : entity === "document" || entity === "expense_report"
      ? "documents"
      : entity === "requisition"
        ? "hrm_requisitions"
        : entity === "application"
          ? "hrm_applications"
          : entity === "review"
            ? "hrm_reviews"
            : entity === "enrollment"
              ? "hrm_benefit_enrollments"
              : entity === "position"
                ? "positions"
                : null;
  if (!table) return [];
  const rows = await db.execute<{ id: string }>(sql`
    select id from ${sql.identifier(table)}
     where org_id = ${orgId}
     order by created_at desc
     limit ${limit}
  `);
  return rows.rows.map((r) => r.id);
}

export async function simulateAutomation(input: {
  orgId: string;
  actorId: string;
  automationId: string;
  subjectEntity?: string | null;
  subjectId?: string | null;
  sampleSize?: number;
  /** Subsidiaries the actor may act on; null = unrestricted (explicit sentinel, never omitted). */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<SimulationResult[]> {
  const ok = await actorHasPermission(db, input.orgId, input.actorId, "automations.read");
  if (!ok) {
    throw new Error("automation access requires the automations.read permission — ask an administrator to grant it in /admin/roles");
  }
  return withOrg(input.orgId, async () => {
    const automation = await loadAutomation(input.orgId, input.automationId);
    if (!automation) throw new Error("automation not found — reload the list and try again");
    // Parse up front so a broken recipe refuses before any sampling.
    parseAutomationActions(automation.actions);

    const pairs: { entity: string | null; id: string | null }[] = [];
    if (input.subjectId && input.subjectEntity) {
      pairs.push({ entity: input.subjectEntity, id: input.subjectId });
    } else if (input.subjectEntity) {
      const ids = await lastSubjectIds(input.orgId, input.subjectEntity, input.sampleSize ?? 5, input.allowedSubsidiaryIds);
      if (ids.length === 0) {
        throw new Error(`no ${input.subjectEntity} records to simulate against — create one first, or pick a subject explicitly`);
      }
      for (const id of ids) pairs.push({ entity: input.subjectEntity, id });
    } else {
      pairs.push({ entity: null, id: null });
    }

    const results: SimulationResult[] = [];
    for (const pair of pairs) {
      const run = await executeAutomation({
        orgId: input.orgId,
        actorId: input.actorId,
        automationId: input.automationId,
        subjectEntity: pair.entity,
        subjectId: pair.id,
        mode: "simulated",
        allowedSubsidiaryIds: input.allowedSubsidiaryIds,
      });
      results.push({
        subjectEntity: pair.entity,
        subjectId: pair.id,
        status: run.steps.length === 0 ? "skipped_no_match" : "simulated",
        steps: run.steps,
      });
    }
    return results;
  });
}

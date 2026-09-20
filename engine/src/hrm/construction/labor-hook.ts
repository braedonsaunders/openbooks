import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HrmConstructionError } from "./errors.ts";
import { resolveWage } from "./rates.ts";
import { scopeScore, type AppliesTo } from "./pure.ts";
import { HRM_PREVAILING_WAGE_FEATURE } from "./shared.ts";

/**
 * Labor-costing hook (HR-13). The projects module cannot import hrm
 * (bounded modules), so engine/src/projects/labor-costing.ts holds an
 * injectable hook point and the web approval path registers this
 * resolver. When the org runs prevailing wage and the entry's project is
 * in a rate schedule's scope, the schedule prices the hour FIRST — and
 * an in-scope day with no covering line REFUSES by name rather than
 * underpaying. When the project is in no schedule's scope this returns
 * null and the standard wage table prices it unchanged. With the feature
 * off this returns null for every entry.
 */
export async function prevailingWageForTimeEntry(input: {
  orgId: string;
  actorId: string | null;
  employeePartyId: string;
  projectId: string;
  workedOn: string;
}): Promise<{ wage: string; currency: string } | null> {
  if (!(await lockAndCheckOrgFeature(db, input.orgId, HRM_PREVAILING_WAGE_FEATURE))) return null;
  const employments = (
    await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
      select id::text as id, employer_subsidiary_id::text as "subsidiaryId"
        from worker_employments
       where org_id = ${input.orgId}::uuid and worker_party_id = ${input.employeePartyId}::uuid
       order by id
    `)
  ).rows;
  if (employments.length === 0) return null;
  if (employments.length > 1) {
    throw new HrmConstructionError(
      `Party ${input.employeePartyId} holds ${employments.length} employments — prevailing-wage pricing needs one employment per worker; resolve the duplicate employments before approving time.`,
    );
  }
  const employment = employments[0]!;
  const schedules = (
    await db.execute<{ appliesTo: AppliesTo }>(sql`
      select applies_to as "appliesTo" from hrm_rate_schedules
       where org_id = ${input.orgId}::uuid and is_active
         and effective_from <= ${input.workedOn}::date
         and (effective_to is null or effective_to >= ${input.workedOn}::date)
    `)
  ).rows;
  if (schedules.length === 0) return null;
  const project = (
    await db.execute<{ subsidiaryId: string | null; custom: Record<string, unknown> }>(sql`
      select subsidiary_id::text as "subsidiaryId", custom
        from projects where org_id = ${input.orgId}::uuid and id = ${input.projectId}::uuid
    `)
  ).rows[0];
  if (!project) return null;
  const customLocation = (project.custom as Record<string, unknown> | null)?.location_id;
  const target = {
    projectId: input.projectId,
    locationId: typeof customLocation === "string" ? customLocation : null,
    subsidiaryId: employment.subsidiaryId ?? project.subsidiaryId,
  };
  const inScope = schedules.some((schedule) => scopeScore(schedule.appliesTo ?? {}, target) >= 0);
  if (!inScope) return null;
  // In scope but unresolvable is a refusal, and refusals write findings —
  // findings carry an actor, so a bare call without one refuses rather
  // than writing unattributed evidence. The approval path always passes
  // the approver through.
  if (!input.actorId) {
    throw new HrmConstructionError(
      "Prevailing-wage pricing needs the approver's identity to flag unresolvable days — approve time through the timesheet approval action.",
    );
  }
  const resolved = await resolveWage(db, {
    orgId: input.orgId,
    actorId: input.actorId,
    employmentId: String(employment.id),
    projectId: input.projectId,
    workedOn: input.workedOn,
  });
  return { wage: resolved.base, currency: resolved.currency };
}

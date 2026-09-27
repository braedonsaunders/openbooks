import { isCivilDate } from "../temporal.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { requireUnrestrictedHrmScope } from "../authorization.ts";
import { HrmConstructionError } from "./errors.ts";
import { inputGuards } from "../input-guards.ts";

/**
 * Shared construction-compliance plumbing (HR-13): feature asserts
 * rechecked inside every public transaction, id/date validation, and the
 * transaction helper. Every public entry runs its checks and writes on
 * the transaction runner so each check and its write are atomic — one
 * transaction per user action, partial effects roll back.
 */

/**
 * Construction compliance is one module switch: prevailing wage, certified
 * payroll, comp classes, apprentice ratios and per diem all ride it.
 */
export const HRM_CONSTRUCTION_FEATURE = "hrmConstructionCompliance" as const;

export async function assertConstructionFeature(
  exec: SqlExecutor,
  orgId: string,
  what: string,
): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_CONSTRUCTION_FEATURE))) {
    throw new HrmConstructionError(
      `${what} is unavailable while Construction compliance is off — enable it under Company Settings → Features; existing construction-compliance data is preserved.`,
    );
  }
}

export const { requireId } = inputGuards((message) => new HrmConstructionError(message));

export function requireDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !isCivilDate(value)) {
    throw new HrmConstructionError(`${field} must be a YYYY-MM-DD date.`);
  }
  return value;
}

export function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HrmConstructionError(`${field} must be a non-blank string.`);
  }
  return value.trim();
}

export { db, withOrgTransaction, type SqlExecutor };

/**
 * Project scope for construction reads and writes: the project's
 * subsidiary on the trusted runner, against the actor's allowed set. A
 * missing project and an out-of-scope project refuse with the IDENTICAL
 * message (and 404 shape), so a B project id probes like a fabricated
 * one. Pass lock "share" inside a write transaction to pin the project
 * row while the payload builds — a concurrent subsidiary move then waits
 * for the check instead of slipping between it and the write.
 */
export async function assertProjectInScope(
  exec: SqlExecutor,
  orgId: string,
  projectId: string,
  allowed: ReadonlySet<string> | null,
  lock: "none" | "share" = "none",
): Promise<void> {
  const row = (
    await exec.execute<{ subsidiaryId: string | null }>(sql`
      select subsidiary_id::text as "subsidiaryId" from projects
       where org_id = ${orgId}::uuid and id = ${projectId}::uuid
       ${lock === "share" ? sql`for share` : sql``}
    `)
  ).rows[0];
  if (!row || (allowed !== null && (!row.subsidiaryId || !allowed.has(row.subsidiaryId)))) {
    throw new HrmConstructionError(
      `Project ${projectId} does not exist in this organization — scope the run to one of its projects.`,
    );
  }
}

/**
 * Employment scope for per-diem, classification, and finding writes: the
 * trusted employment row's employer subsidiary, locked shared inside a
 * write transaction so a concurrent rehome waits for the check. Missing
 * and out-of-scope employments refuse identically (404 shape).
 */
export async function assertEmploymentInScope(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  allowed: ReadonlySet<string> | null,
  lock = false,
): Promise<void> {
  const row = (
    await exec.execute<{ employerSubsidiaryId: string | null }>(sql`
      select employer_subsidiary_id::text as "employerSubsidiaryId" from worker_employments
       where org_id = ${orgId}::uuid and id = ${employmentId}::uuid
       ${lock ? sql`for share` : sql``}
    `)
  ).rows[0];
  if (!row || (allowed !== null && (!row.employerSubsidiaryId || !allowed.has(row.employerSubsidiaryId)))) {
    throw new HrmConstructionError(
      `Employment ${employmentId} does not exist in this organization — scope the action to one of its employments.`,
    );
  }
}

/**
 * Reference fence for naming a rate schedule from another write (an
 * employment's home schedule): the schedule must exist AND sit inside
 * the actor's lens, or the assignment silently subscribes the worker to
 * another entity's rates. An org-wide schedule prices every entity, so
 * naming it needs unrestricted scope. Missing and out-of-scope refuse
 * identically — B's schedule id probes like a fabricated one.
 */
export async function assertScheduleReferenceInScope(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  scheduleId: string,
  allowed: ReadonlySet<string> | null,
): Promise<void> {
  const row = (
    await exec.execute<{ appliesTo: unknown }>(sql`
      select applies_to as "appliesTo" from hrm_rate_schedules
       where org_id = ${orgId}::uuid and id = ${scheduleId}::uuid
    `)
  ).rows[0];
  if (!row) {
    throw new HrmConstructionError(
      `Rate schedule ${scheduleId} does not exist in this organization — use one of its schedules.`,
    );
  }
  const raw = (row.appliesTo ?? {}) as { employer_subsidiary_id?: unknown; project_ids?: unknown };
  const employer = typeof raw.employer_subsidiary_id === "string" ? raw.employer_subsidiary_id : null;
  const projects = Array.isArray(raw.project_ids)
    ? raw.project_ids.filter((id): id is string => typeof id === "string")
    : [];
  if (employer === null && projects.length === 0) {
    await requireUnrestrictedHrmScope(exec, orgId, actorId);
    return;
  }
  if (allowed === null) return;
  if (employer !== null && !allowed.has(employer)) {
    throw new HrmConstructionError(
      `Rate schedule ${scheduleId} does not exist in this organization — use one of its schedules.`,
    );
  }
  for (const projectId of projects) {
    const found = (
      await exec.execute(sql`
        select 1 as one from projects
         where org_id = ${orgId}::uuid and id = ${projectId}::uuid
           and subsidiary_id = any (${`{${[...allowed].join(",")}}`}::uuid[])
      `)
    ).rows[0];
    if (!found) {
      throw new HrmConstructionError(
        `Rate schedule ${scheduleId} does not exist in this organization — use one of its schedules.`,
      );
    }
  }
}

export async function loadOrgCountry(exec: SqlExecutor, orgId: string): Promise<string> {
  const rows = (
    await exec.execute<{ country: string }>(sql`
      select country from orgs where id = ${orgId}::uuid
    `)
  ).rows;
  const country = rows[0]?.country;
  if (!country) {
    throw new HrmConstructionError(
      "The organization has no home country — set it before generating labor-compliance files.",
    );
  }
  return country;
}

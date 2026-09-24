import { sql } from "drizzle-orm";
import { HrmConstructionError } from "./errors.ts";
import { requireConstructionScope } from "../authorization.ts";
import { classificationAsOf } from "./classifications.ts";
import { recordFinding } from "./findings.ts";
import { evaluateRatio } from "./pure.ts";
import { lockScheduleScopeForWrite } from "./rates.ts";
import {
  HRM_APPRENTICE_RATIO_FEATURE,
  assertConstructionFeature,
  assertProjectInScope,
  requireDate,
  requireId,
  withOrgTransaction,
  type SqlExecutor,
} from "./shared.ts";

/**
 * Apprentice ratios (HR-13, migration 0224). checkDay counts journey vs
 * apprentice hours per rule from APPROVED time; a breach writes a
 * ratio_breach finding AND flags the day so the resolver prices the
 * apprentice hours at the journey line (the DOL rule) — both visible,
 * neither silent. The finding IS the mark: the resolver consults open
 * ratio_breach findings, so no second table and no silent repricing.
 */

export interface ApprenticeRatioRule {
  readonly id: string;
  readonly scheduleId: string;
  readonly journeyClassificationId: string;
  readonly apprenticeClassificationId: string;
  readonly ratioJourney: number;
  readonly ratioApprentice: number;
  readonly measured: "daily" | "weekly";
}

export async function createRatioRule(
  exec: SqlExecutor,
  input: {
  orgId: string;
  actorId: string;
  scheduleId: string;
  journeyClassificationId: string;
  apprenticeClassificationId: string;
  ratioJourney: number;
  ratioApprentice: number;
  measured: "daily" | "weekly";
  effectiveFrom: string;
  effectiveTo?: string | null;
}): Promise<ApprenticeRatioRule> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const scheduleId = requireId(input.scheduleId, "scheduleId");
  const journeyClassificationId = requireId(input.journeyClassificationId, "journeyClassificationId");
  const apprenticeClassificationId = requireId(input.apprenticeClassificationId, "apprenticeClassificationId");
  if (journeyClassificationId === apprenticeClassificationId) {
    throw new HrmConstructionError(
      "The journey and apprentice classifications must differ — a ratio counts apprentices against a journey class.",
    );
  }
  if (!Number.isInteger(input.ratioJourney) || input.ratioJourney < 1 || !Number.isInteger(input.ratioApprentice) || input.ratioApprentice < 1) {
    throw new HrmConstructionError("The ratio needs positive integers on both sides — e.g. 3 journey to 1 apprentice.");
  }
  if (input.measured !== "daily" && input.measured !== "weekly") {
    throw new HrmConstructionError(`Unknown ratio measure ${input.measured} — use daily or weekly.`);
  }
  const effectiveFrom = requireDate(input.effectiveFrom, "effectiveFrom");
  return withOrgTransaction(orgId, async () => {
    await assertConstructionFeature(exec, orgId, HRM_APPRENTICE_RATIO_FEATURE, "Apprentice ratio rules");
    // The rule prices its schedule's hours: the parent schedule's
    // CURRENT target governs — a rule on B's schedule (or an org-wide
    // one) refuses a restricted actor before anything is validated.
    const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
    await lockScheduleScopeForWrite(exec, orgId, actorId, scheduleId, allowed);
    const apprentice = (
      await exec.execute<{ isApprentice: boolean; journeyId: string | null }>(sql`
        select is_apprentice as "isApprentice", journey_classification_id::text as "journeyId"
          from hrm_work_classifications
         where org_id = ${orgId}::uuid and id = ${apprenticeClassificationId}::uuid
      `)
    ).rows[0];
    if (!apprentice) {
      throw new HrmConstructionError(
        `Apprentice classification ${apprenticeClassificationId} does not exist in this organization.`,
      );
    }
    if (!apprentice.isApprentice) {
      throw new HrmConstructionError(
        `Classification ${apprenticeClassificationId} is not flagged as an apprentice class — flag it before it can stand in a ratio.`,
      );
    }
    if (apprentice.journeyId !== journeyClassificationId) {
      throw new HrmConstructionError(
        `Classification ${apprenticeClassificationId} counts against journey class ${apprentice.journeyId ?? "none"} — the ratio must name the same journey class.`,
      );
    }
    const created = (
      await exec.execute<{ id: string }>(sql`
        insert into hrm_apprentice_ratio_rules
          (org_id, schedule_id, journey_classification_id, apprentice_classification_id,
           ratio_journey, ratio_apprentice, measured, effective_from, effective_to, created_by, updated_by)
        values (${orgId}::uuid, ${scheduleId}::uuid, ${journeyClassificationId}::uuid,
                ${apprenticeClassificationId}::uuid, ${input.ratioJourney}, ${input.ratioApprentice},
                ${input.measured}, ${effectiveFrom}::date, ${input.effectiveTo ?? null}::date,
                ${actorId}::uuid, ${actorId}::uuid)
        returning id::text as id
      `)
    ).rows[0];
    if (!created) throw new HrmConstructionError("The apprentice ratio rule was not written — no row was created.");
    return {
      id: String(created.id),
      scheduleId,
      journeyClassificationId,
      apprenticeClassificationId,
      ratioJourney: input.ratioJourney,
      ratioApprentice: input.ratioApprentice,
      measured: input.measured,
    };
  });
}

/**
 * Check one project day against every covering rule. Each breach appends
 * a ratio_breach finding naming the counts — and the resolver prices
 * that day's apprentice hours at the journey line from the open finding.
 */
export async function checkDay(
  exec: SqlExecutor,
  input: {
  orgId: string;
  actorId: string;
  projectId: string;
  workedOn: string;
}): Promise<readonly { ruleId: string; breach: boolean; journeyHours: string; apprenticeHours: string }[]> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const projectId = requireId(input.projectId, "projectId");
  const workedOn = requireDate(input.workedOn, "workedOn");
  return withOrgTransaction(orgId, async () => {
    await assertConstructionFeature(exec, orgId, HRM_APPRENTICE_RATIO_FEATURE, "Apprentice ratio checks");
    // The check aggregates one project's employments AND writes breach
    // findings: the project must sit inside the lens first, or an
    // A-scoped actor checks (and flags) B's day.
    const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
    await assertProjectInScope(exec, orgId, projectId, allowed, "share");
    return checkDayInScope(exec, orgId, actorId, projectId, workedOn);
  });
}

async function checkDayInScope(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  projectId: string,
  workedOn: string,
): Promise<readonly { ruleId: string; breach: boolean; journeyHours: string; apprenticeHours: string }[]> {
  const rules = (
    await exec.execute<{
      id: string;
      journeyClassificationId: string;
      apprenticeClassificationId: string;
      ratioJourney: number;
      ratioApprentice: number;
      measured: string;
    }>(sql`
      select id::text as id,
             journey_classification_id::text as "journeyClassificationId",
             apprentice_classification_id::text as "apprenticeClassificationId",
             ratio_journey as "ratioJourney", ratio_apprentice as "ratioApprentice", measured
        from hrm_apprentice_ratio_rules
       where org_id = ${orgId}::uuid and is_active
         and effective_from <= ${workedOn}::date
         and (effective_to is null or effective_to >= ${workedOn}::date)
    `)
  ).rows;
  // Approved hours per employment for the day, resolved to as-of classifications.
  const hours = (
    await exec.execute<{ employmentId: string; hours: string }>(sql`
      select w.id::text as "employmentId", sum(te.hours)::text as hours
        from time_entries te
        join worker_employments w
          on w.org_id = te.org_id and w.worker_party_id = te.employee_party_id
       where te.org_id = ${orgId}::uuid and te.project_id = ${projectId}::uuid
         and te.worked_on = ${workedOn}::date and te.status = 'approved'
       group by w.id
    `)
  ).rows;
  const byClass = new Map<string, { journey: string; apprentice: string }>();
  const journeyOf = new Map<string, string>();
  // Apprentice hours per employment per apprentice class: a breaching day
  // writes one finding per apprentice employment, because the resolver
  // reprices per employment and the finding IS the mark it reads.
  const apprenticeEmployments = new Map<string, Set<string>>();
  for (const row of hours) {
    const assignment = await classificationAsOf(exec, orgId, row.employmentId, workedOn);
    if (!assignment) continue;
    // Employments with no classification cannot feed a ratio count — the
    // wage resolver already refuses those days by name; the ratio check
    // counts classed hours only, never assumes.
    if (assignment.isApprentice && assignment.journeyClassificationId) {
      journeyOf.set(assignment.classificationId, assignment.journeyClassificationId);
      const set = apprenticeEmployments.get(assignment.classificationId) ?? new Set<string>();
      set.add(row.employmentId);
      apprenticeEmployments.set(assignment.classificationId, set);
    }
    const slot = byClass.get(assignment.classificationId) ?? { journey: "0", apprentice: "0" };
    slot[assignment.isApprentice ? "apprentice" : "journey"] = addDecimal(
      slot[assignment.isApprentice ? "apprentice" : "journey"],
      row.hours,
    );
    byClass.set(assignment.classificationId, slot);
  }
  const results: Array<{ ruleId: string; breach: boolean; journeyHours: string; apprenticeHours: string }> = [];
  for (const rule of rules) {
    const apprenticeSlot = byClass.get(rule.apprenticeClassificationId);
    const apprenticeHours = apprenticeSlot?.apprentice ?? "0";
    // Journey hours count against the rule's journey class — including
    // hours worked directly under it and apprentice classes that count
    // against it.
    let journeyHours = byClass.get(rule.journeyClassificationId)?.journey ?? "0";
    for (const [classId, journeyId] of journeyOf) {
      if (journeyId === rule.journeyClassificationId && classId !== rule.apprenticeClassificationId) {
        journeyHours = addDecimal(journeyHours, byClass.get(classId)?.apprentice ?? "0");
      }
    }
    const { breach } = evaluateRatio(journeyHours, apprenticeHours, rule.ratioJourney, rule.ratioApprentice);
    if (breach) {
      // One finding per apprentice employment under the breaching rule:
      // the resolver prices each one's hours at the journey line from
      // its open finding, and each worker's repricing stays visible.
      const employments = apprenticeEmployments.get(rule.apprenticeClassificationId) ?? new Set<string>();
      for (const employmentId of employments) {
        await recordFinding(exec, {
          orgId,
          actorId,
          kind: "ratio_breach",
          projectId,
          workedOn,
          employmentId,
          detail: {
            ruleId: rule.id,
            journeyClassificationId: rule.journeyClassificationId,
            apprenticeClassificationId: rule.apprenticeClassificationId,
            journeyHours,
            apprenticeHours,
            ratio: `${rule.ratioJourney}:${rule.ratioApprentice}`,
            measured: rule.measured,
          },
        });
      }
    }
    results.push({ ruleId: rule.id, breach, journeyHours, apprenticeHours });
  }
  return results;
}

function addDecimal(a: string, b: string): string {
  const scale = (v: string): bigint => {
    const [i, f = ""] = v.split(".");
    return BigInt(`${i}${(f + "0000").slice(0, 4)}`);
  };
  const sum = scale(a) + scale(b);
  const abs = (sum < 0n ? -sum : sum).toString().padStart(5, "0");
  return `${sum < 0n ? "-" : ""}${abs.slice(0, -4)}.${abs.slice(-4)}`;
}

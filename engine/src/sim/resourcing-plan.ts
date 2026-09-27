import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { div, cmp, mulDecimal, mulDecimalFactors } from "../money/money.ts";
import { upsertAssignment, type UpsertAssignmentInput } from "../resourcing/assignments.ts";
import { weekStartOf, weeksBetween } from "../resourcing/weeks.ts";
import type { Rng } from "./rng.ts";
import type { SimOrg } from "./world.ts";
import type { Profile } from "./profiles/types.ts";

export type ResourcingMonth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface ResourcingPracticePlan {
  /** The practice name is also the department name. */
  name: string;
  /** Job titles and the workforce members who hold each title. */
  positions: { jobTitle: string; members: string[] }[];
  /** Demand multiplier for each calendar month, in numeric month order. */
  monthlyDemandFactors: Record<ResourcingMonth, string>;
  /** A generic request for this existing role whenever its practice is in peak demand. */
  genericDemand?: { jobTitle: string };
}

export interface ResourcingSimPlan {
  /** Fraction of each named booking also held tentatively on another engagement. */
  softBookingShare: string;
  practices: ResourcingPracticePlan[];
}

export type PlannedResourcingAssignment = Omit<
  Pick<UpsertAssignmentInput, "projectId" | "weekStart" | "plannedHours" | "isBillable">,
  "plannedHours"
> & {
  plannedHours: string;
  booking: NonNullable<UpsertAssignmentInput["booking"]>;
} & (
    | { employeePartyId: string; jobTitle?: never }
    | { employeePartyId?: never; jobTitle: string }
  );

export interface ResourcingPlanningWorld {
  employees: readonly Pick<SimOrg["employees"][number], "id" | "name">[];
  engagements: readonly Pick<SimOrg["engagements"][number], "id">[];
  window: { startDate: string; endDate: string };
  utilization: number;
  annualHours: string;
}

/** Build deterministic Sunday-week assignments without writing to the database. */
export function planResourcing(
  plan: ResourcingSimPlan,
  world: ResourcingPlanningWorld,
  rng: Rng,
): PlannedResourcingAssignment[] {
  if (cmp(plan.softBookingShare, "0") < 0 || cmp(plan.softBookingShare, "1") > 0) {
    throw new Error("resourcing soft-booking share must be between zero and one");
  }
  if (world.engagements.length === 0) {
    throw new Error("resourcing plans require at least one active engagement");
  }
  const employeesByName = new Map(world.employees.map((employee) => [employee.name, employee]));
  for (const practice of plan.practices) {
    for (const position of practice.positions) {
      for (const name of position.members) {
        if (!employeesByName.has(name)) throw new Error(`resourcing member ${name} is not in the workforce`);
      }
    }
    if (practice.genericDemand && !practice.positions.some((position) =>
      position.jobTitle === practice.genericDemand!.jobTitle && position.members.length > 0
    )) {
      throw new Error(`generic demand title ${practice.genericDemand.jobTitle} needs named capacity in ${practice.name}`);
    }
  }

  const firstWeek = weekStartOf(world.window.startDate);
  const lastWeek = weekStartOf(world.window.endDate);
  const weeks = weeksBetween(firstWeek, lastWeek);
  const standardWeek = div(world.annualHours, "52");
  const utilization = String(world.utilization);
  const assignments: PlannedResourcingAssignment[] = [];

  const chooseProject = (excluded?: string): string => {
    const candidates = world.engagements.filter((engagement) => engagement.id !== excluded);
    if (candidates.length === 0) throw new Error("soft bookings require a second active engagement");
    return candidates[rng.int(0, candidates.length - 1)]!.id;
  };

  for (const weekStart of weeks) {
    const month = Number(weekStart.slice(5, 7)) as ResourcingMonth;
    for (const practice of plan.practices) {
      const factor = practice.monthlyDemandFactors[month];
      if (factor === undefined || cmp(factor, "0") < 0) {
        throw new Error(`resourcing demand factor is invalid for ${practice.name} in month ${month}`);
      }
      const namedHours = mulDecimalFactors(standardWeek, [utilization, factor]);
      if (cmp(namedHours, "0") <= 0) continue;

      for (const position of practice.positions) {
        for (const name of position.members) {
          const employee = employeesByName.get(name)!;
          const hardProjectId = chooseProject();
          assignments.push({
            employeePartyId: employee.id,
            projectId: hardProjectId,
            weekStart,
            plannedHours: namedHours,
            booking: "hard",
            isBillable: true,
          });
          if (cmp(plan.softBookingShare, "0") > 0) {
            assignments.push({
              employeePartyId: employee.id,
              projectId: chooseProject(hardProjectId),
              weekStart,
              plannedHours: mulDecimal(namedHours, plan.softBookingShare),
              booking: "soft",
              isBillable: true,
            });
          }
        }
      }

      if (practice.genericDemand && cmp(factor, "1") > 0) {
        const position = practice.positions.find((item) => item.jobTitle === practice.genericDemand!.jobTitle)!;
        assignments.push({
          jobTitle: practice.genericDemand.jobTitle,
          projectId: chooseProject(),
          weekStart,
          plannedHours: mulDecimalFactors(standardWeek, [String(position.members.length), factor]),
          booking: "hard",
          isBillable: true,
        });
      }
    }
  }
  return assignments;
}

export interface ProvisionResourcingPlanContext {
  profile: Pick<Profile, "utilization">;
  plan: ResourcingSimPlan;
  world: SimOrg;
  window: { startDate: string; endDate: string };
  rng: Rng;
}

/** Provision profile practices and assignments through the governed writer. */
export async function provisionResourcingPlan(ctx: ProvisionResourcingPlanContext): Promise<void> {
  if (ctx.profile.utilization === undefined) {
    throw new Error("a resourcing sim profile must declare its target utilization");
  }

  const featureWrite = await db.execute<{ id: string }>(sql`
    update orgs
       set settings = coalesce(settings, '{}'::jsonb)
         || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"resourcing": true}'::jsonb),
           updated_at = now(), updated_by = ${ctx.world.actors.admin}
     where id = ${ctx.world.orgId}
    returning id
  `);
  if ((featureWrite.rowCount ?? 0) !== 1 || !featureWrite.rows[0]) {
    throw new Error("resourcing feature enablement did not update its organization");
  }

  const departments = new Map<string, string>();
  const employeesByName = new Map(ctx.world.employees.map((employee) => [employee.name, employee]));
  const assignedEmployees = new Set<string>();
  for (const practice of ctx.plan.practices) {
    const departmentId = randomUUID();
    const inserted = await db.execute<{ id: string }>(sql`
      insert into departments (id, org_id, name, is_active, custom, created_by, updated_by)
      values (${departmentId}, ${ctx.world.orgId}, ${practice.name}, true, '{}'::jsonb,
              ${ctx.world.actors.admin}, ${ctx.world.actors.admin})
      returning id
    `);
    if ((inserted.rowCount ?? 0) !== 1 || inserted.rows[0]?.id !== departmentId) {
      throw new Error(`department ${practice.name} was not created`);
    }
    departments.set(practice.name, departmentId);

    for (const position of practice.positions) {
      for (const name of position.members) {
        const employee = employeesByName.get(name);
        if (!employee) throw new Error(`resourcing member ${name} is not in the workforce`);
        if (assignedEmployees.has(employee.id)) throw new Error(`employee ${name} has more than one practice role`);
        assignedEmployees.add(employee.id);
        const updated = await db.execute<{ party_id: string }>(sql`
          update employee_roles
             set job_title = ${position.jobTitle}, department_id = ${departmentId},
                 updated_at = now(), updated_by = ${ctx.world.actors.admin}
           where org_id = ${ctx.world.orgId} and party_id = ${employee.id}
          returning party_id
        `);
        if ((updated.rowCount ?? 0) !== 1 || updated.rows[0]?.party_id !== employee.id) {
          throw new Error(`employee role for ${name} was not updated`);
        }
      }
    }
  }
  if (assignedEmployees.size !== ctx.world.employees.length) {
    throw new Error("every resourcing profile employee must belong to exactly one practice");
  }
  if (ctx.world.engagements.length === 0) {
    throw new Error("resourcing plans require an active engagement");
  }

  const capacity = (await db.execute<{ annual_hours: string | null }>(sql`
    select settings->'laborCosting'->>'annualHours' as annual_hours
      from orgs where id = ${ctx.world.orgId}
  `)).rows[0];
  if (!capacity?.annual_hours) {
    throw new Error("resourcing plans require the organization's labor-costing standard hours");
  }

  const assignments = planResourcing(ctx.plan, {
    employees: ctx.world.employees,
    engagements: ctx.world.engagements,
    window: ctx.window,
    utilization: ctx.profile.utilization,
    annualHours: capacity.annual_hours,
  }, ctx.rng);
  for (const assignment of assignments) {
    const write: UpsertAssignmentInput = {
      ...assignment,
      orgId: ctx.world.orgId,
      actorId: ctx.world.actors.controller,
      allowedSubsidiaryIds: null,
    };
    await upsertAssignment(write);
  }
}

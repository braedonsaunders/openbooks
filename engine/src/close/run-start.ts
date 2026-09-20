import { CloseError } from "./period-policy.ts";
import { defaultCloseFeatureContext, defaultCloseStepEnabled } from "./features.ts";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { db } from "../platform/db.ts";
import { isoDate, utcDate, addDays } from "./calendar.ts";
import { ensureCloseDefaults } from "./defaults.ts";
import { periodFingerprint } from "./readiness.ts";
import { refreshCloseRun, runCloseAutomations } from "./run-automation.ts";
import { assertCloseScope } from "./period-locks.ts";
/** One close_blueprint_steps row materialized into run tasks at run start. */
interface CloseBlueprintStepRow extends Record<string, unknown> {
  id: string;
  key: string;
  title: string;
  description: string | null;
  workstream: string;
  task_type: string;
  completion_mode: string;
  gate_type: string;
  due_offset_business_days: number;
  evidence_required: boolean;
  sort_order: number;
  default_owner_role_key: string | null;
  default_reviewer_role_key: string | null;
  applicability: Record<string, unknown> | null;
}

function addBusinessDays(value: string, days: number): string {
  let date = utcDate(value);
  const direction = days < 0 ? -1 : 1;
  let remaining = Math.abs(days);
  while (remaining > 0) {
    date = addDays(date, direction);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining--;
  }
  return isoDate(date);
}

function blueprintStepApplies(
  applicability: Record<string, unknown> | null,
  context: {
    fiscalYear: number;
    periodNumber: number;
    lastRegularPeriod: number;
    isAdjustment: boolean;
    bookId: string;
    subsidiaryIds: string[];
  },
): boolean {
  const rules = applicability ?? {};
  const list = (key: string): unknown[] =>
    Array.isArray(rules[key]) ? (rules[key] as unknown[]) : [];
  const bookIds = list("bookIds");
  if (bookIds.length && !bookIds.includes(context.bookId)) return false;
  const fiscalYears = list("fiscalYears").map(Number);
  if (fiscalYears.length && !fiscalYears.includes(context.fiscalYear))
    return false;
  const subsidiaries = list("subsidiaryIds").filter(
    (item): item is string => typeof item === "string",
  );
  if (
    subsidiaries.length &&
    !context.subsidiaryIds.some((id) => subsidiaries.includes(id))
  )
    return false;
  const types = list("periodTypes");
  if (types.length) {
    const actual = new Set<string>(["any"]);
    if (context.isAdjustment) actual.add("adjustment");
    else {
      actual.add("month");
      if (context.periodNumber % 3 === 0) actual.add("quarter");
      if (context.periodNumber === context.lastRegularPeriod)
        actual.add("year");
    }
    if (!types.some((type) => typeof type === "string" && actual.has(type)))
      return false;
  }
  return true;
}

export async function startCloseRun(args: {
  orgId: string;
  periodId: string;
  bookId: string;
  actorId: string;
  blueprintId?: string;
  reportingPackageId?: string;
  targetCloseDate?: string;
  /** Concrete subsidiary IDs, or null as the explicit org-wide sentinel. */
  subsidiaryIds?: string[] | null;
}): Promise<string> {
  const defaults = await ensureCloseDefaults(args.orgId, args.actorId);
  const closeFeatures = await defaultCloseFeatureContext(db, args.orgId);
  const blueprintId = args.blueprintId ?? defaults.blueprintId;
  const reportingPackageId =
    args.reportingPackageId ?? defaults.reportingPackageId;
  await assertCloseScope(db, args);
  const periodRes = (await db.execute<{
      id: string;
      ends_on: string;
      fiscal_year: number;
      period_number: number;
      is_adjustment: boolean;
      last_regular_period: number;
    }>(sql`
    select p.id, p.ends_on, p.fiscal_year, p.period_number, p.is_adjustment,
           (select max(p2.period_number) from accounting_periods p2
             where p2.org_id = p.org_id and p2.fiscal_calendar_id = p.fiscal_calendar_id
               and p2.fiscal_year = p.fiscal_year and not p2.is_adjustment) as last_regular_period
      from accounting_periods p
     where p.id = ${args.periodId} and p.org_id = ${args.orgId}`));
  const period = periodRes.rows[0];
  if (!period) throw new CloseError("period not found");
  const configuration = (await db.execute<{ blueprint_name: string | null; package_ok: boolean }>(sql`
    select
      (select name from close_blueprints where id = ${blueprintId} and org_id = ${args.orgId} and is_active) as blueprint_name,
      (${reportingPackageId}::uuid is null or exists(
        select 1 from close_reporting_packages where id = ${reportingPackageId} and org_id = ${args.orgId} and is_active
      )) as package_ok`));
  if (!configuration.rows[0]?.blueprint_name)
    throw new CloseError("active close blueprint not found");
  const systemBlueprint = configuration.rows[0].blueprint_name === "close.defaultData.blueprint.name";
  if (!closeFeatures.advancedClose && !systemBlueprint) {
    throw new CloseError("custom close blueprints require Advanced close controls");
  }
  if (!configuration.rows[0]?.package_ok)
    throw new CloseError("active reporting package not found");
  // A shape-valid non-day such as February 30 would otherwise reach the
  // target_close_date DATE column and surface as a raw storage throw (HTTP 500
  // at the runs route, which only maps CloseError to 422).
  if (args.targetCloseDate !== undefined && !isIsoCalendarDate(args.targetCloseDate)) {
    throw new CloseError("target close date must be a real calendar date (YYYY-MM-DD)");
  }
  const targetCloseDate =
    args.targetCloseDate ?? addBusinessDays(period.ends_on, 5);

  return db
    .transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`close-start:${args.orgId}:${args.periodId}:${args.bookId}`},0))`);
      const existing = (await tx.execute<{
        id: string; scope: { subsidiaryIds?: string[] }; blueprint_id: string;
        status: string; system_blueprint: boolean;
      }>(sql`select r.id,r.scope,r.blueprint_id,r.status,
          b.name='close.defaultData.blueprint.name' as system_blueprint
        from close_runs r join close_blueprints b on b.id=r.blueprint_id and b.org_id=r.org_id
        where r.org_id=${args.orgId} and r.period_id=${args.periodId} and r.book_id=${args.bookId} for update of r`)).rows[0];
      if (existing) {
        if (args.subsidiaryIds !== undefined &&
            canonicalJson([...(args.subsidiaryIds ?? [])].sort()) !== canonicalJson([...(existing.scope?.subsidiaryIds ?? [])].sort()))
          throw new CloseError("existing close run has a different subsidiary scope");
        if (args.blueprintId !== undefined && args.blueprintId !== existing.blueprint_id)
          throw new CloseError("existing close run has a different blueprint");
        if (!existing.system_blueprint && !closeFeatures.advancedClose)
          throw new CloseError("custom close blueprints require Advanced close controls");
        // Resume the captured scope/blueprint and its assignment/evidence rows.
        // Defaults chosen for a new run must never rematerialize an old run.
        if (existing.status === "cancelled") {
          await tx.execute(sql`update close_runs set status='in_progress',updated_at=now(),updated_by=${args.actorId} where id=${existing.id} and org_id=${args.orgId}`);
          await tx.execute(sql`insert into close_events (org_id,run_id,event_type,actor_id,payload)
            values (${args.orgId},${existing.id},'run.resumed',${args.actorId},${JSON.stringify({scope:existing.scope,blueprintId:existing.blueprint_id})}::jsonb)`);
        }
        return existing.id;
      }
      const fingerprint = await periodFingerprint(args.orgId,args.periodId,args.bookId,args.subsidiaryIds ?? [],
        !systemBlueprint || !args.subsidiaryIds?.length);
      const inserted = (await tx.execute<{ id: string }>(sql`
      insert into close_runs
        (org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
         current_stage, target_close_date, scope, data_fingerprint, last_validated_at,
         started_at, started_by, created_by, updated_by)
      values (${args.orgId}, ${args.periodId}, ${args.bookId}, ${blueprintId}, ${reportingPackageId},
              'in_progress', 'readiness', ${targetCloseDate},
              ${JSON.stringify({ subsidiaryIds: args.subsidiaryIds ?? [] })}::jsonb,
              ${fingerprint}, now(), now(), ${args.actorId}, ${args.actorId}, ${args.actorId})
      on conflict (org_id, period_id, book_id) do nothing
      returning id`));
      const runId = inserted.rows[0]?.id;
      if (!runId) throw new CloseError("close run was created concurrently; retry to resume its captured scope");
      const steps = (await tx.execute<CloseBlueprintStepRow>(sql`
      select id, key, title, description, workstream, task_type, completion_mode,
             gate_type, due_offset_business_days, evidence_required, sort_order,
             default_owner_role_key, default_reviewer_role_key, applicability
        from close_blueprint_steps
       where blueprint_id = ${blueprintId} and org_id = ${args.orgId}
       order by sort_order`));
      if (steps.rows.length === 0)
        throw new CloseError("close blueprint has no steps");
      let materializedSteps = 0;
      for (const step of steps.rows) {
        if (systemBlueprint && !defaultCloseStepEnabled(step.key, closeFeatures)) continue;
        // These standard tasks certify group consolidation, never one entity.
        if (systemBlueprint && args.subsidiaryIds?.length && ["intercompany-balanced", "consolidation"].includes(step.key)) continue;
        if (
          !blueprintStepApplies(step.applicability, {
            fiscalYear: Number(period.fiscal_year),
            periodNumber: Number(period.period_number),
            lastRegularPeriod: Number(period.last_regular_period),
            isAdjustment: period.is_adjustment,
            bookId: args.bookId,
            subsidiaryIds: args.subsidiaryIds ?? [],
          })
        )
          continue;
        async function userForRole(
          roleKey: string | null,
          excluding?: string,
        ): Promise<string | null> {
          if (!roleKey) return null;
          const user = (await tx.execute<{ id: string }>(sql`
          select distinct u.id from users u
            join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
            join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id
           where u.org_id = ${args.orgId} and u.is_active and ar.key = ${roleKey}
             ${excluding ? sql`and u.id <> ${excluding}` : sql``}
           order by u.id limit 1
        `));
          return user.rows[0]?.id ?? null;
        }
        const configuredOwnerId = await userForRole(
          step.default_owner_role_key,
        );
        if (step.default_owner_role_key && !configuredOwnerId) {
          throw new CloseError(
            `no active user holds owner role ${step.default_owner_role_key}`,
          );
        }
        const ownerId = configuredOwnerId ?? args.actorId;
        const reviewerId = await userForRole(
          step.default_reviewer_role_key,
          ownerId,
        );
        if (step.default_reviewer_role_key && !reviewerId) {
          throw new CloseError(
            `reviewer role ${step.default_reviewer_role_key} has no user independent from the task owner`,
          );
        }
        await tx.execute(sql`
        insert into close_run_tasks
          (org_id, run_id, blueprint_step_id, key, title, description, workstream,
           task_type, completion_mode, gate_type, status, sort_order, owner_id,
           due_on, evidence_required, created_by, updated_by)
        values (${args.orgId}, ${runId}, ${step.id}, ${step.key}, ${step.title}, ${step.description},
                ${step.workstream}, ${step.task_type}, ${step.completion_mode}, ${step.gate_type},
                'blocked', ${step.sort_order}, ${ownerId},
                ${addBusinessDays(period.ends_on, Number(step.due_offset_business_days))},
                ${step.evidence_required}, ${args.actorId}, ${args.actorId})
        on conflict (run_id, key) do nothing`);
        if (reviewerId)
          await tx.execute(sql`update close_run_tasks set reviewer_id = ${reviewerId}
        where run_id = ${runId} and key = ${step.key} and org_id = ${args.orgId}`);
        materializedSteps++;
      }
      if (materializedSteps === 0)
        throw new CloseError("no blueprint steps apply to this close scope");
      await tx.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${args.orgId}, ${runId}, 'run.started', ${args.actorId},
              ${JSON.stringify({ periodId: args.periodId, bookId: args.bookId, targetCloseDate })}::jsonb)`);
      return runId;
    })
    .then(async (runId) => {
      await refreshCloseRun(args.orgId, runId, args.actorId);
      await runCloseAutomations({
        orgId: args.orgId,
        runId,
        trigger: "run_started",
        eventKey: `run:${runId}:started`,
        actorId: args.actorId,
      });
      return runId;
    });
}

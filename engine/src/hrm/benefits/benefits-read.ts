import { sql } from "drizzle-orm";
import {
  HrmAuthorizationError,
  loadOwnEmploymentIds,
  requireAggregateBenefitsRead,
  requireHrmBenefitsManageOnEmployment,
  requireHrmBenefitsRead,
} from "../authorization.ts";
import { BenefitsError } from "./errors.ts";
import { loadBenefitPlan, loadBenefitPlanLevels } from "./plans.ts";
import type { SqlExecutor } from "./shared.ts";

/**
 * HRM benefits read service (HR-8): loader-resolved rows for the Benefits
 * tab, the employee drawer section, and the cockpit panel. Lists enforce
 * the hrm.benefits.read grant plus the actor's employer-subsidiary scope;
 * single-employment reads enforce the employment gate; self reads resolve
 * the actor's own employments from storage, never from caller input.
 */

export interface BenefitPlanSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly currency: string;
  readonly isActive: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export async function listBenefitPlans(exec: SqlExecutor, orgId: string): Promise<BenefitPlanSummary[]> {
  const rows = (
    await exec.execute<Record<string, unknown>>(sql`
      select id, code, name, kind, currency, is_active as "isActive",
             effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"
        from hrm_benefit_plans
       where org_id = ${orgId}
       order by code
    `)
  ).rows;
  return rows.map((row) => ({
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    kind: String(row.kind),
    currency: String(row.currency),
    isActive: row.isActive === true,
    effectiveFrom: String(row.effectiveFrom).slice(0, 10),
    effectiveTo: row.effectiveTo != null ? String(row.effectiveTo).slice(0, 10) : null,
  }));
}

export interface EnrollmentWindowSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly opensOn: string;
  readonly closesOn: string;
  readonly status: string;
  readonly pendingApprovals: number;
  readonly elections: number;
}

export async function listEnrollmentWindows(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  filter?: { readonly status?: string },
): Promise<EnrollmentWindowSummary[]> {
  // The scope this gate resolves is load-bearing: windows targeted at a
  // hidden subsidiary stay hidden, and the election/pending counts fence
  // to in-scope employments — an org-wide count would carry B's elections
  // to an A-scoped reader. Org-wide (null-employer) windows stay
  // discoverable like unscoped plan headers: headers carry no pay, and
  // their counts are already fenced below.
  const scope = await requireAggregateBenefitsRead(exec, orgId, actorId);
  const status = filter?.status;
  if (status !== undefined && status !== "draft" && status !== "open" && status !== "closed") {
    throw new BenefitsError(
      "INVALID_INPUT",
      "window status filter is one of draft, open, closed — segments never invent a state",
    );
  }
  const inScope =
    scope === null
      ? sql`true`
      : sql`emp.employer_subsidiary_id = any (${`{${[...scope].join(",")}}`}::uuid[])`;
  const rows = (
    await exec.execute<Record<string, unknown>>(sql`
      select w.id, w.name, w.kind,
             w.opens_on::text as "opensOn", w.closes_on::text as "closesOn", w.status,
             w.applies_to as "appliesTo",
             count(distinct case when ${inScope} then e.id end)::int as elections,
             count(distinct case when e.status = 'pending_approval' and ${inScope} then e.id end)::int as "pendingApprovals"
        from hrm_enrollment_windows w
        left join hrm_benefit_enrollments e
          on e.org_id = w.org_id and e.window_id = w.id
        left join worker_employments emp
          on emp.org_id = e.org_id and emp.id = e.employment_id
       where w.org_id = ${orgId} ${status !== undefined ? sql`and w.status = ${status}` : sql``}
       group by w.id
       order by w.opens_on desc
    `)
  ).rows;
  return rows
    .filter((row) => {
      if (scope === null) return true;
      const applies = (row.appliesTo ?? {}) as { employer_subsidiary_id?: unknown };
      const employer = applies.employer_subsidiary_id;
      return employer == null || (typeof employer === "string" && scope.has(employer));
    })
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      kind: String(row.kind),
      opensOn: String(row.opensOn).slice(0, 10),
      closesOn: String(row.closesOn).slice(0, 10),
      status: String(row.status),
      pendingApprovals: Number(row.pendingApprovals ?? 0),
      elections: Number(row.elections ?? 0),
    }));
}

export interface EnrollmentSummary {
  readonly id: string;
  readonly employmentId: string;
  readonly windowId: string | null;
  readonly employeeName: string | null;
  readonly planCode: string;
  readonly planName: string;
  readonly coverageLevelKey: string | null;
  readonly coverageLabel: string | null;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly employeeAmountPerPeriod: string | null;
  readonly employerAmountPerPeriod: string | null;
  readonly currency: string;
}

export async function listEnrollments(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  filter?: { readonly windowId?: string; readonly status?: string; readonly employmentId?: string },
): Promise<EnrollmentSummary[]> {
  const scope = await requireAggregateBenefitsRead(exec, orgId, actorId);
  if (filter?.employmentId !== undefined) {
    await requireHrmBenefitsRead(exec, orgId, actorId, filter.employmentId);
  }
  const rows = (
    await exec.execute<Record<string, unknown>>(sql`
      select e.id, e.employment_id as "employmentId", e.window_id as "windowId",
             p.display_name as "employeeName",
             plan.code as "planCode", plan.name as "planName",
             e.coverage_level_key as "coverageLevelKey",
             lvl.label as "coverageLabel",
             e.status,
             e.effective_from::text as "effectiveFrom",
             e.effective_to::text as "effectiveTo",
             e.employee_amount_per_period::text as "employeeAmountPerPeriod",
             e.employer_amount_per_period::text as "employerAmountPerPeriod",
             e.currency, emp.employer_subsidiary_id as "subsidiaryId"
        from hrm_benefit_enrollments e
        join hrm_benefit_plans plan on plan.org_id = e.org_id and plan.id = e.plan_id
        join worker_employments emp on emp.org_id = e.org_id and emp.id = e.employment_id
        join parties p on p.org_id = e.org_id and p.id = emp.worker_party_id
        left join hrm_benefit_plan_levels lvl
          on lvl.org_id = e.org_id and lvl.plan_id = e.plan_id and lvl.level_key = e.coverage_level_key
       where e.org_id = ${orgId}
         ${filter?.windowId !== undefined ? sql`and e.window_id = ${filter.windowId}` : sql``}
         ${filter?.status !== undefined ? sql`and e.status = ${filter.status}` : sql``}
         ${filter?.employmentId !== undefined ? sql`and e.employment_id = ${filter.employmentId}` : sql``}
       order by e.effective_from desc, plan.code
    `)
  ).rows;
  return rows
    .filter((row) => scope === null || scope.has(String(row.subsidiaryId)))
    .map((row) => ({
      id: String(row.id),
      employmentId: String(row.employmentId),
      windowId: row.windowId != null ? String(row.windowId) : null,
      employeeName: row.employeeName != null ? String(row.employeeName) : null,
      planCode: String(row.planCode),
      planName: String(row.planName),
      coverageLevelKey: row.coverageLevelKey != null ? String(row.coverageLevelKey) : null,
      coverageLabel: row.coverageLabel != null ? String(row.coverageLabel) : null,
      status: String(row.status),
      effectiveFrom: String(row.effectiveFrom).slice(0, 10),
      effectiveTo: row.effectiveTo != null ? String(row.effectiveTo).slice(0, 10) : null,
      employeeAmountPerPeriod:
        row.employeeAmountPerPeriod != null ? String(row.employeeAmountPerPeriod) : null,
      employerAmountPerPeriod:
        row.employerAmountPerPeriod != null ? String(row.employerAmountPerPeriod) : null,
      currency: String(row.currency),
    }));
}

export interface EnrollmentDetail {
  readonly planCode: string;
  readonly planName: string;
  readonly coverageLabel: string | null;
  readonly dependents: ReadonlyArray<{ readonly id: string; readonly displayName: string; readonly relationship: string }>;
  readonly events: ReadonlyArray<{ readonly kind: string; readonly reason: string; readonly recordedAt: string }>;
}

/** One election with its plan, dependents, and evidence trail. */
export async function getEnrollmentDetail(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  enrollmentId: string,
): Promise<EnrollmentDetail> {
  const enrollment = (
    await exec.execute<Record<string, unknown>>(sql`
      select employment_id as "employmentId", plan_id as "planId",
             coverage_level_key as "coverageLevelKey"
        from hrm_benefit_enrollments
       where org_id = ${orgId} and id = ${enrollmentId}
    `)
  ).rows[0];
  if (!enrollment) {
    throw new BenefitsError("NOT_FOUND", "benefit enrollment not found in this organization — reload and retry");
  }
  await requireHrmBenefitsRead(exec, orgId, actorId, String(enrollment.employmentId));
  const plan = await loadBenefitPlan(exec, orgId, String(enrollment.planId));
  const levels = await loadBenefitPlanLevels(exec, orgId, String(enrollment.planId));
  const key = enrollment.coverageLevelKey != null ? String(enrollment.coverageLevelKey) : null;
  const dependents = (
    await exec.execute<Record<string, unknown>>(sql`
      select d.id, d.display_name as "displayName", d.relationship
        from hrm_benefit_dependents d
        join hrm_enrollment_dependents l
          on l.org_id = d.org_id and l.dependent_id = d.id
       where l.org_id = ${orgId} and l.enrollment_id = ${enrollmentId} and d.is_active
       order by d.display_name
    `)
  ).rows;
  const events = (
    await exec.execute<Record<string, unknown>>(sql`
      select kind, reason, recorded_at::text as "recordedAt"
        from hrm_benefit_events
       where org_id = ${orgId} and enrollment_id = ${enrollmentId}
       order by recorded_at
    `)
  ).rows;
  return {
    planCode: plan.code,
    planName: plan.name,
    coverageLabel: key !== null ? (levels.find((level) => level.levelKey === key)?.label ?? key) : null,
    dependents: dependents.map((row) => ({
      id: String(row.id),
      displayName: String(row.displayName),
      relationship: String(row.relationship),
    })),
    events: events.map((row) => ({
      kind: String(row.kind),
      reason: String(row.reason),
      recordedAt: String(row.recordedAt),
    })),
  };
}

/** The actor's own elections (self-service touch — own rows only). */
export async function myEnrollments(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<EnrollmentSummary[]> {
  const own = await loadOwnEmploymentIds(exec, orgId, actorId);
  const out: EnrollmentSummary[] = [];
  for (const employmentId of own) {
    await requireHrmBenefitsRead(exec, orgId, actorId, employmentId);
    out.push(...(await listEnrollments(exec, orgId, actorId, { employmentId })));
  }
  return out;
}

export interface PendingApproval {
  readonly enrollmentId: string;
  readonly employmentId: string;
  readonly employeeName: string | null;
  readonly planCode: string;
  readonly effectiveFrom: string;
}

export async function listPendingApprovals(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<PendingApproval[]> {
  const scope = await requireAggregateBenefitsRead(exec, orgId, actorId);
  const rows = (
    await exec.execute<Record<string, unknown>>(sql`
      select e.id, e.employment_id as "employmentId", p.display_name as "employeeName",
             plan.code as "planCode", e.effective_from::text as "effectiveFrom",
             emp.employer_subsidiary_id as "subsidiaryId"
        from hrm_benefit_enrollments e
        join hrm_benefit_plans plan on plan.org_id = e.org_id and plan.id = e.plan_id
        join worker_employments emp on emp.org_id = e.org_id and emp.id = e.employment_id
        join parties p on p.org_id = e.org_id and p.id = emp.worker_party_id
       where e.org_id = ${orgId} and e.status = 'pending_approval'
       order by e.effective_from
    `)
  ).rows;
  return rows
    .filter((row) => scope === null || scope.has(String(row.subsidiaryId)))
    .map((row) => ({
      enrollmentId: String(row.id),
      employmentId: String(row.employmentId),
      employeeName: row.employeeName != null ? String(row.employeeName) : null,
      planCode: String(row.planCode),
      effectiveFrom: String(row.effectiveFrom).slice(0, 10),
    }));
}

export interface BenefitsCockpit {
  readonly openWindows: EnrollmentWindowSummary[];
  readonly pendingApprovals: PendingApproval[];
  /** Active elections with no payroll input for the month (follow-up list). */
  readonly missingInputs: ReadonlyArray<{ readonly enrollmentId: string; readonly planCode: string }>;
}

/** Cockpit panel data: open windows, pending approvals, months missing inputs. */
export async function benefitsCockpit(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  coverageMonth: string,
): Promise<BenefitsCockpit> {
  const openWindows = (await listEnrollmentWindows(exec, orgId, actorId, { status: "open" })).slice(0, 5);
  const pendingApprovals = await listPendingApprovals(exec, orgId, actorId);
  const monthStart = `${coverageMonth}-01`;
  const rows = (
    await exec.execute<Record<string, unknown>>(sql`
      select e.id, plan.code as "planCode", emp.employer_subsidiary_id as "subsidiaryId"
        from hrm_benefit_enrollments e
        join hrm_benefit_plans plan on plan.org_id = e.org_id and plan.id = e.plan_id
        join worker_employments emp on emp.org_id = e.org_id and emp.id = e.employment_id
       where e.org_id = ${orgId} and e.status = 'active'
         and e.effective_from <= (date_trunc('month', ${monthStart}::date) + interval '1 month' - interval '1 day')::date
         and (e.effective_to is null or e.effective_to >= date_trunc('month', ${monthStart}::date)::date)
         and not exists (
           select 1 from hrm_benefit_payroll_inputs i
            where i.org_id = e.org_id and i.enrollment_id = e.id
              and i.coverage_from = date_trunc('month', ${monthStart}::date)::date
         )
       order by plan.code
       limit 50
    `)
  ).rows;
  const scope = await requireAggregateBenefitsRead(exec, orgId, actorId);
  return {
    openWindows,
    pendingApprovals,
    missingInputs: rows
      .filter((row) => scope === null || scope.has(String(row.subsidiaryId)))
      .map((row) => ({ enrollmentId: String(row.id), planCode: String(row.planCode) })),
  };
}

export interface EmploymentBenefitsSection {
  readonly enrollments: EnrollmentSummary[];
  readonly dependents: ReadonlyArray<{ readonly id: string; readonly displayName: string; readonly relationship: string; readonly isActive: boolean }>;
}

/** Employee drawer Benefits section: the person's elections and dependents. */
export async function employmentBenefitsSection(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<EmploymentBenefitsSection> {
  // Either grant opens the section: manage first, then read. When both
  // fail the read refusal propagates (same scope, read-worded remedy).
  try {
    await requireHrmBenefitsManageOnEmployment(exec, orgId, actorId, employmentId);
  } catch (error) {
    if (!(error instanceof HrmAuthorizationError)) throw error;
    await requireHrmBenefitsRead(exec, orgId, actorId, employmentId);
  }
  const enrollments = await listEnrollments(exec, orgId, actorId, { employmentId });
  const dependents = (
    await exec.execute<Record<string, unknown>>(sql`
      select id, display_name as "displayName", relationship, is_active as "isActive"
        from hrm_benefit_dependents
       where org_id = ${orgId} and employment_id = ${employmentId}
       order by display_name
    `)
  ).rows;
  return {
    enrollments,
    dependents: dependents.map((row) => ({
      id: String(row.id),
      displayName: String(row.displayName),
      relationship: String(row.relationship),
      isActive: row.isActive === true,
    })),
  };
}

export interface DependentSummary {
  readonly id: string;
  readonly displayName: string;
  readonly relationship: string;
  readonly birthDate: string | null;
  readonly isActive: boolean;
}

/** Dependents of one employment (read gate on the employment). */
export async function listDependents(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<DependentSummary[]> {
  await requireHrmBenefitsRead(exec, orgId, actorId, employmentId);
  const rows = (
    await exec.execute<Record<string, unknown>>(sql`
      select id, display_name as "displayName", relationship,
             birth_date::text as "birthDate", is_active as "isActive"
        from hrm_benefit_dependents
       where org_id = ${orgId} and employment_id = ${employmentId}
       order by display_name
    `)
  ).rows;
  return rows.map((row) => ({
    id: String(row.id),
    displayName: String(row.displayName),
    relationship: String(row.relationship),
    birthDate: row.birthDate != null ? String(row.birthDate).slice(0, 10) : null,
    isActive: row.isActive === true,
  }));
}

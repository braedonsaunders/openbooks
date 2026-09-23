import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { AiRailsError, finalizeBlockedRefusal } from "./errors.ts";
import { logDecision } from "./governance.ts";
import { loadAiRailsSettings } from "./settings.ts";
import { timeBalanceAsOf } from "../leave-read.ts";

/**
 * HRM AI rails (HR-21) anomaly flags: DETERMINISTIC pre-run payroll and
 * timesheet checks. The scan writes flags idempotently; each flag carries
 * an explanation rendered from a template with the numbers (no LLM in
 * the loop); acknowledge/resolve/false-positive needs a reason; rows
 * ever marked false_positive suppress the same kind+key in later scans
 * (the feedback loop, no ML).
 *
 * GATE: the payroll run's finalize step refuses while any block-severity
 * flag for the period is open. The run is owned by the payroll
 * coordinator — this module owns the flags and the check function
 * `checkPayrollFinalizeAllowed`, which the run service calls by name.
 * Warn severity is shown, never blocks.
 */

export const ANOMALY_KINDS = [
  "terminated_with_pay",
  "duplicate_bank",
  "retro_spike",
  "net_pay_spike",
  "zero_hours_with_pay",
  "hours_spike",
  "missing_rate",
  "expired_rate",
  "prevailing_wage_missing",
  "apprentice_ratio_breach",
  "benefit_input_orphan",
  "leave_input_orphan",
  "negative_balance",
  "duplicate_entry",
  "geofence_outside",
  "unrounded",
  "custom",
] as const;

export type AnomalyKind = (typeof ANOMALY_KINDS)[number];
export type AnomalySeverity = "info" | "warn" | "block";
export type FlagStatus = "open" | "acknowledged" | "resolved" | "false_positive";

/** Which severity each kind raises. Blocking kinds refuse the finalize. */
export const SEVERITY_BY_KIND: Readonly<Record<AnomalyKind, AnomalySeverity>> = {
  terminated_with_pay: "block",
  duplicate_bank: "block",
  retro_spike: "warn",
  net_pay_spike: "warn",
  zero_hours_with_pay: "warn",
  hours_spike: "warn",
  missing_rate: "block",
  expired_rate: "warn",
  prevailing_wage_missing: "block",
  apprentice_ratio_breach: "block",
  benefit_input_orphan: "warn",
  leave_input_orphan: "warn",
  negative_balance: "block",
  duplicate_entry: "warn",
  geofence_outside: "warn",
  unrounded: "warn",
  custom: "info",
};

/** Timesheet-side kinds, shown on approvals and inbox subtitles. */
export const TIME_ANOMALY_KINDS: ReadonlySet<string> = new Set([
  "zero_hours_with_pay",
  "hours_spike",
  "duplicate_entry",
  "geofence_outside",
  "unrounded",
  "missing_rate",
  "expired_rate",
]);

/**
 * Render a flag explanation from a template with the numbers. The
 * explanation is what the drawer shows; it names what was seen, what
 * was expected, and the rule or baseline — deterministic, testable.
 */
export function renderExplanation(kind: AnomalyKind, vars: Record<string, string>): string {
  const v = (name: string): string => vars[name] ?? "—";
  switch (kind) {
    case "terminated_with_pay":
      return `Employment ended ${v("endedOn")} but has ${v("inputCount")} pending pay input(s) in the period — terminated employments take no further pay; void the inputs or correct the termination date.`;
    case "duplicate_bank":
      return `Bank details (ending ${v("lastFour")}) are shared by ${v("employmentCount")} employments — split pay to one account needs review for duplicate or misdirected pay.`;
    case "retro_spike":
      return `Retro adjustment of ${v("amount")} exceeds the org threshold of ${v("threshold")} — confirm the back-pay calculation before the run.`;
    case "net_pay_spike":
      return `Net pay ${v("actual")} is ${v("z")}σ from the ${v("cohort")} baseline (mean ${v("mean")}, σ ${v("stddev")}) — confirm the inputs behind the move.`;
    case "zero_hours_with_pay":
      return `No approved hours in the period but ${v("inputCount")} pending hourly pay input(s) — confirm the hours were worked and approved.`;
    case "hours_spike":
      return `Approved hours ${v("actual")} are ${v("z")}σ from the ${v("cohort")} baseline (mean ${v("mean")}, σ ${v("stddev")}) — confirm the timesheet before it prices the run.`;
    case "missing_rate":
      return `Approved hours with no effective wage rate for the worked dates — price the run against an explicit rate, not a silent zero.`;
    case "expired_rate":
      return `Hours worked ${v("workedOn")} fall after the wage rate's end ${v("endedOn")} — renew the rate so the run prices current terms.`;
    case "prevailing_wage_missing":
      return `Certified work on ${v("workedOn")} has no prevailing determination for ${v("classification")} — the certified run cannot price without it.`;
    case "apprentice_ratio_breach":
      return `Crew on ${v("workedOn")} breaches the apprentice ratio ${v("ratio")} — restaff or resolve the compliance finding first.`;
    case "benefit_input_orphan":
      return `Benefit pay input ${v("amount")} points at enrollment ${v("enrollmentId")} (${v("status")}) — inputs from ended or cancelled enrollments do not pay.`;
    case "leave_input_orphan":
      return `Leave pay input for ${v("absenceDate")} points at request ${v("requestId")} (${v("status")}) — inputs from cancelled or rejected requests do not pay.`;
    case "negative_balance":
      return `Leave balance for ${v("leaveType")} would be ${v("balance")} hours after this period — balances may not go negative; adjust the grant or the request.`;
    case "duplicate_entry":
      return `${v("entryCount")} time entries for the same day, hours and task — one of them is double-entered; keep the true one.`;
    case "geofence_outside":
      return `Clock event at ${v("at")} falls outside the assigned geofence — confirm the work location with the supervisor.`;
    case "unrounded":
      return `Clock event at ${v("at")} is unrounded (${v("minutes")} minutes) — round under the org rounding rule before approval.`;
    case "custom":
      return v("text");
  }
}

/** Baseline breach: beyond zσ of the cohort window. Zero spread means any move breaches. */
export function baselineBreaches(mean: number, stddev: number, actual: number, z: number): boolean {
  if (!(stddev > 0)) return actual !== mean;
  return Math.abs(actual - mean) > z * stddev;
}

/** z distance for the explanation, one decimal. */
export function zDistance(mean: number, stddev: number, actual: number): string {
  if (!(stddev > 0)) return actual === mean ? "0.0" : "∞";
  return (Math.abs(actual - mean) / stddev).toFixed(1);
}

/** Suppression identity: kind plus the detail key. */
export function suppressionKey(kind: string, detailKey: string): string {
  return createHash("sha256").update(`${kind}::${detailKey}`, "utf8").digest("hex");
}

export interface ScanSummary {
  periodFrom: string;
  periodTo: string;
  created: number;
  alreadyOpen: number;
  suppressed: number;
  skipped: string[];
}

interface PendingFlag {
  kind: AnomalyKind;
  employmentId: string | null;
  detailKey: string;
  detail: Record<string, unknown>;
  explanation: string;
}

async function assertScanScope(exec: SqlExecutor, orgId: string, actorId: string): Promise<void> {
  if (await actorHasPermission(exec, orgId, actorId, "payroll.manage")) return;
  throw new AiRailsError(
    "ai_forbidden",
    "running payroll checks needs the payroll manager — ask a payroll administrator to run the scan",
  );
}

async function assertAnomalyFeature(exec: SqlExecutor, orgId: string, timeOnly: boolean): Promise<void> {
  const key = timeOnly ? "hrmTimeAnomalies" : "hrmPayrollAnomalies";
  if (!(await lockAndCheckOrgFeature(exec, orgId, key))) {
    throw new AiRailsError(
      "ai_feature_off",
      `payroll checks are unavailable while ${key} is off — enable it under Company Settings → Features`,
    );
  }
}

/** Hard rules against live tables. Each returns pending flags; skips are named. */
async function ruleTerminatedWithPay(
  exec: SqlExecutor, orgId: string, from: string, to: string,
): Promise<PendingFlag[]> {
  const rows = (await exec.execute<{
    employmentId: string; endedOn: string; inputCount: string;
  }>(sql`
    with terminated as (
      select distinct v.employment_id
        from worker_employment_versions v
       where v.org_id = ${orgId}::uuid
         and v.recorded_until is null
         and v.status = 'terminated'
         and v.effective_from <= ${to}::date
    ), inputs as (
      select employment_id, count(*) as n
        from hrm_payroll_inputs
       where org_id = ${orgId}::uuid and status = 'pending'
         and absence_date between ${from}::date and ${to}::date
       group by employment_id
      union all
      select employment_id, count(*) as n
        from hrm_benefit_payroll_inputs
       where org_id = ${orgId}::uuid and status = 'pending'
         and coverage_from <= ${to}::date and coverage_to >= ${from}::date
       group by employment_id
    )
    select t.employment_id::text as "employmentId",
           (select min(v2.effective_from)::text from worker_employment_versions v2
             where v2.org_id = ${orgId}::uuid and v2.employment_id = t.employment_id
               and v2.recorded_until is null and v2.status = 'terminated') as "endedOn",
           coalesce(sum(i.n), 0)::text as "inputCount"
      from terminated t
      join inputs i on i.employment_id = t.employment_id
     group by t.employment_id`)).rows;
  return rows.map((r) => ({
    kind: "terminated_with_pay" as const,
    employmentId: r.employmentId,
    detailKey: `terminated:${r.employmentId}`,
    detail: { key: `terminated:${r.employmentId}`, endedOn: r.endedOn, inputCount: r.inputCount },
    explanation: renderExplanation("terminated_with_pay", { endedOn: r.endedOn, inputCount: r.inputCount }),
  }));
}

async function ruleDuplicateBank(exec: SqlExecutor, orgId: string): Promise<PendingFlag[]> {
  const rows = (await exec.execute<{
    fingerprint: string; lastFour: string; employmentIds: string[];
  }>(sql`
    select md5(coalesce(lower(b.routing::text), '') || '::' || coalesce(b.account_last_four, '')) as fingerprint,
           max(b.account_last_four) as "lastFour",
           array_agg(distinct e.id::text) as "employmentIds"
      from party_bank_accounts b
      join worker_employments e
        on e.org_id = b.org_id and e.worker_party_id = b.party_id
     where b.org_id = ${orgId}::uuid and b.is_active and b.approval_status = 'approved'
       and coalesce(b.account_last_four, '') <> ''
     group by 1
    having count(distinct e.id) > 1`)).rows;
  const out: PendingFlag[] = [];
  for (const r of rows) {
    for (const employmentId of r.employmentIds) {
      out.push({
        kind: "duplicate_bank",
        employmentId,
        detailKey: `bank:${r.fingerprint}`,
        detail: { key: `bank:${r.fingerprint}`, lastFour: r.lastFour, employmentCount: String(r.employmentIds.length) },
        explanation: renderExplanation("duplicate_bank", {
          lastFour: r.lastFour ?? "—",
          employmentCount: String(r.employmentIds.length),
        }),
      });
    }
  }
  return out;
}

async function ruleRetroSpike(
  exec: SqlExecutor, orgId: string, from: string, to: string, threshold: number,
): Promise<PendingFlag[]> {
  const rows = (await exec.execute<{
    employmentId: string | null; amount: string; runDocumentId: string;
  }>(sql`
    select a.employment_id::text as "employmentId", abs(a.amount)::text as amount,
           a.pay_run_document_id::text as "runDocumentId"
      from pay_run_adjustments a
      join pay_runs r
        on r.org_id = a.org_id and r.document_id = a.pay_run_document_id
     where a.org_id = ${orgId}::uuid
       and a.adjustment_type = 'line'
       and abs(a.amount) > ${threshold}::numeric
       and r.period_start <= ${to}::date and r.period_end >= ${from}::date`)).rows;
  return rows.map((r) => ({
    kind: "retro_spike" as const,
    employmentId: r.employmentId,
    detailKey: `retro:${r.runDocumentId}:${r.employmentId ?? "none"}:${r.amount}`,
    detail: { key: `retro:${r.runDocumentId}:${r.employmentId ?? "none"}:${r.amount}`, amount: r.amount, threshold: String(threshold) },
    explanation: renderExplanation("retro_spike", { amount: r.amount, threshold: String(threshold) }),
  }));
}

async function ruleOrphans(
  exec: SqlExecutor, orgId: string, from: string, to: string,
): Promise<PendingFlag[]> {
  const out: PendingFlag[] = [];
  const benefit = (await exec.execute<{
    id: string; employmentId: string; amount: string; enrollmentId: string; status: string;
  }>(sql`
    select i.id::text as id, i.employment_id::text as "employmentId",
           i.amount::text as amount, i.enrollment_id::text as "enrollmentId", e.status
      from hrm_benefit_payroll_inputs i
      join hrm_benefit_enrollments e
        on e.org_id = i.org_id and e.id = i.enrollment_id
     where i.org_id = ${orgId}::uuid and i.status = 'pending'
       and i.coverage_from <= ${to}::date and i.coverage_to >= ${from}::date
       and e.status in ('ended', 'cancelled')`)).rows;
  for (const r of benefit) {
    out.push({
      kind: "benefit_input_orphan",
      employmentId: r.employmentId,
      detailKey: `benefit-orphan:${r.id}`,
      detail: { key: `benefit-orphan:${r.id}`, amount: r.amount, enrollmentId: r.enrollmentId, status: r.status },
      explanation: renderExplanation("benefit_input_orphan", {
        amount: r.amount, enrollmentId: r.enrollmentId, status: r.status,
      }),
    });
  }
  const leave = (await exec.execute<{
    id: string; employmentId: string; absenceDate: string; requestId: string; status: string;
  }>(sql`
    select i.id::text as id, i.employment_id::text as "employmentId",
           i.absence_date::text as "absenceDate",
           i.source_leave_request_id::text as "requestId", r.status
      from hrm_payroll_inputs i
      join hrm_leave_requests r
        on r.org_id = i.org_id and r.id = i.source_leave_request_id
     where i.org_id = ${orgId}::uuid and i.status = 'pending'
       and i.absence_date between ${from}::date and ${to}::date
       and r.status in ('cancelled', 'withdrawn', 'rejected')`)).rows;
  for (const r of leave) {
    out.push({
      kind: "leave_input_orphan",
      employmentId: r.employmentId,
      detailKey: `leave-orphan:${r.id}`,
      detail: { key: `leave-orphan:${r.id}`, absenceDate: r.absenceDate, requestId: r.requestId, status: r.status },
      explanation: renderExplanation("leave_input_orphan", {
        absenceDate: r.absenceDate, requestId: r.requestId, status: r.status,
      }),
    });
  }
  return out;
}

async function ruleZeroHoursWithPay(
  exec: SqlExecutor, orgId: string, from: string, to: string,
): Promise<PendingFlag[]> {
  const rows = (await exec.execute<{ employmentId: string; inputCount: string }>(sql`
    with inputs as (
      select employment_id, count(*) as n
        from hrm_payroll_inputs
       where org_id = ${orgId}::uuid and status = 'pending'
         and absence_date between ${from}::date and ${to}::date
       group by employment_id
    ), hours as (
      select e.id as employment_id, coalesce(sum(t.hours), 0) as h
        from worker_employments e
        left join time_entries t
          on t.org_id = e.org_id and t.employee_party_id = e.worker_party_id
         and t.worked_on between ${from}::date and ${to}::date
         and t.status = 'approved'
       where e.org_id = ${orgId}::uuid
       group by e.id
    )
    select i.employment_id::text as "employmentId", i.n::text as "inputCount"
      from inputs i
      join hours h on h.employment_id = i.employment_id
     where h.h = 0`)).rows;
  return rows.map((r) => ({
    kind: "zero_hours_with_pay" as const,
    employmentId: r.employmentId,
    detailKey: `zero-hours:${r.employmentId}`,
    detail: { key: `zero-hours:${r.employmentId}`, inputCount: r.inputCount },
    explanation: renderExplanation("zero_hours_with_pay", { inputCount: r.inputCount }),
  }));
}

async function ruleDuplicateEntries(
  exec: SqlExecutor, orgId: string, from: string, to: string,
): Promise<PendingFlag[]> {
  const rows = (await exec.execute<{
    partyId: string; workedOn: string; hours: string; taskId: string | null; entryCount: string;
  }>(sql`
    select employee_party_id::text as "partyId", worked_on::text as "workedOn",
           hours::text as hours, project_task_id::text as "taskId", count(*)::text as "entryCount"
      from time_entries
     where org_id = ${orgId}::uuid and status <> 'rejected'
       and worked_on between ${from}::date and ${to}::date
     group by employee_party_id, worked_on, hours, project_task_id
    having count(*) > 1`)).rows;
  const out: PendingFlag[] = [];
  for (const r of rows) {
    const emp = (await exec.execute<{ employmentId: string }>(sql`
      select id::text as "employmentId" from worker_employments
       where org_id = ${orgId}::uuid and worker_party_id = ${r.partyId}::uuid
       limit 1`)).rows[0];
    out.push({
      kind: "duplicate_entry",
      employmentId: emp?.employmentId ?? null,
      detailKey: `dup-entry:${r.partyId}:${r.workedOn}:${r.hours}:${r.taskId ?? "none"}`,
      detail: { key: `dup-entry:${r.partyId}:${r.workedOn}:${r.hours}:${r.taskId ?? "none"}`, entryCount: r.entryCount },
      explanation: renderExplanation("duplicate_entry", { entryCount: r.entryCount }),
    });
  }
  return out;
}

async function ruleMissingRates(
  exec: SqlExecutor, orgId: string, from: string, to: string,
): Promise<{ missing: PendingFlag[]; expired: PendingFlag[] }> {
  const missing: PendingFlag[] = [];
  const expired: PendingFlag[] = [];
  const rows = (await exec.execute<{
    partyId: string; workedOn: string; employmentId: string | null;
  }>(sql`
    select distinct t.employee_party_id::text as "partyId", t.worked_on::text as "workedOn",
           e.id::text as "employmentId"
      from time_entries t
      left join worker_employments e
        on e.org_id = t.org_id and e.worker_party_id = t.employee_party_id
     where t.org_id = ${orgId}::uuid and t.status = 'approved'
       and t.worked_on between ${from}::date and ${to}::date
       and t.cost_rate is null`)).rows;
  for (const r of rows) {
    const rate = (await exec.execute<{ id: string; effectiveTo: string | null }>(sql`
      select id::text as id, effective_to::text as "effectiveTo"
        from labor_cost_rates
       where org_id = ${orgId}::uuid and is_active
         and (employee_party_id = ${r.partyId}::uuid or employee_party_id is null)
         and effective_from <= ${r.workedOn}::date
       order by effective_from desc
       limit 1`)).rows[0];
    if (!rate) {
      missing.push({
        kind: "missing_rate",
        employmentId: r.employmentId,
        detailKey: `missing-rate:${r.partyId}:${r.workedOn}`,
        detail: { key: `missing-rate:${r.partyId}:${r.workedOn}`, workedOn: r.workedOn },
        explanation: renderExplanation("missing_rate", {}),
      });
    } else if (rate.effectiveTo !== null && rate.effectiveTo < r.workedOn) {
      expired.push({
        kind: "expired_rate",
        employmentId: r.employmentId,
        detailKey: `expired-rate:${r.partyId}:${r.workedOn}`,
        detail: { key: `expired-rate:${r.partyId}:${r.workedOn}`, workedOn: r.workedOn, endedOn: rate.effectiveTo },
        explanation: renderExplanation("expired_rate", { workedOn: r.workedOn, endedOn: rate.effectiveTo }),
      });
    }
  }
  return { missing, expired };
}

/** HR-13 findings mirrored as flags, only while construction compliance is on. */
async function ruleConstructionMirror(
  exec: SqlExecutor, orgId: string, from: string, to: string,
): Promise<{ flags: PendingFlag[]; skipped: string | null }> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, "hrmConstructionCompliance"))) {
    return { flags: [], skipped: "construction findings (hrmConstructionCompliance off)" };
  }
  const rows = (await exec.execute<{
    kind: string; employmentId: string | null; workedOn: string | null; id: string;
  }>(sql`
    select kind, employment_id::text as "employmentId", worked_on::text as "workedOn",
           id::text as id
      from hrm_compliance_findings
     where org_id = ${orgId}::uuid and status = 'open'
       and (worked_on is null or (worked_on <= ${to}::date and worked_on >= ${from}::date - interval '90 days'))`)).rows;
  const flags: PendingFlag[] = [];
  for (const r of rows) {
    if (r.kind === "missing_rate") {
      flags.push({
        kind: "prevailing_wage_missing",
        employmentId: r.employmentId,
        detailKey: `pw-missing:${r.id}`,
        detail: { key: `pw-missing:${r.id}`, workedOn: r.workedOn ?? "—", classification: "assigned classification" },
        explanation: renderExplanation("prevailing_wage_missing", {
          workedOn: r.workedOn ?? "—",
          classification: "assigned classification",
        }),
      });
    } else if (r.kind === "ratio_breach") {
      flags.push({
        kind: "apprentice_ratio_breach",
        employmentId: r.employmentId,
        detailKey: `ratio:${r.id}`,
        detail: { key: `ratio:${r.id}`, workedOn: r.workedOn ?? "—", ratio: "trade ratio" },
        explanation: renderExplanation("apprentice_ratio_breach", {
          workedOn: r.workedOn ?? "—",
          ratio: "trade ratio",
        }),
      });
    }
  }
  return { flags, skipped: null };
}

/** Negative leave balances after the period, through the leave read service. */
async function ruleNegativeBalances(
  exec: SqlExecutor, orgId: string, from: string, to: string,
): Promise<PendingFlag[]> {
  const rows = (await exec.execute<{
    employmentId: string; leaveTypeId: string; leaveType: string;
  }>(sql`
    select distinct r.employment_id::text as "employmentId",
           r.leave_type_id::text as "leaveTypeId",
           t.name as "leaveType"
      from hrm_leave_requests r
      join hrm_leave_types t on t.org_id = r.org_id and t.id = r.leave_type_id
     where r.org_id = ${orgId}::uuid and r.status = 'approved'
       and r.starts_on <= ${to}::date and r.ends_on >= ${from}::date`)).rows;
  const out: PendingFlag[] = [];
  for (const r of rows) {
    let balance: string | null;
    try {
      balance = (await timeBalanceAsOf(exec, orgId, r.employmentId, r.leaveTypeId, to)).balance;
    } catch {
      // No coverage reads as null — uncovered leave is the leave gate's
      // refusal, not an anomaly flag.
      continue;
    }
    if (balance !== null && Number(balance) < 0) {
      out.push({
        kind: "negative_balance",
        employmentId: r.employmentId,
        detailKey: `neg-balance:${r.employmentId}:${r.leaveTypeId}`,
        detail: { key: `neg-balance:${r.employmentId}:${r.leaveTypeId}`, leaveType: r.leaveType, balance },
        explanation: renderExplanation("negative_balance", { leaveType: r.leaveType, balance }),
      });
    }
  }
  return out;
}

/** Baseline rules against the cohort windows; missing baselines skip by name. */
async function ruleBaselines(
  exec: SqlExecutor, orgId: string, from: string, to: string,
  cohortKey: string, z: number,
): Promise<{ flags: PendingFlag[]; skipped: string[] }> {
  const skipped: string[] = [];
  const flags: PendingFlag[] = [];
  const baselines = (await exec.execute<{ cohortKey: string; metric: string; mean: string; stddev: string }>(sql`
    select cohort_key as "cohortKey", metric, mean::text as mean, stddev::text as stddev
      from anomaly_baselines
     where org_id = ${orgId}::uuid`)).rows;
  if (baselines.length === 0) {
    return { flags, skipped: ["baseline z-checks (no anomaly_baselines computed yet — run the baseline job)"] };
  }
  // Cohort grain follows the org's declared key; department grain resolves
  // through the primary assignment, everything else through the employer
  // subsidiary until the pay-schedule and job-level grains land.
  const cohortSql = cohortKey === "department"
    ? sql`(select av.department_id::text from employment_assignment_versions av where av.org_id = e.org_id and av.employment_id = e.id and av.recorded_until is null and av.is_primary order by av.version_no desc limit 1)`
    : sql`e.employer_subsidiary_id::text`;
  // Current-period aggregates per employment from calculated stubs.
  const currents = (await exec.execute<{
    employmentId: string; cohort: string | null; net: string; gross: string;
  }>(sql`
    select s.employment_id::text as "employmentId",
           ${cohortSql} as cohort,
           sum(s.net_pay)::text as net, sum(s.gross)::text as gross
      from pay_stubs s
      join worker_employments e on e.org_id = s.org_id and e.id = s.employment_id
      join pay_runs r on r.org_id = s.org_id and r.document_id = s.pay_run_document_id
     where s.org_id = ${orgId}::uuid
       and r.period_start <= ${to}::date and r.period_end >= ${from}::date
     group by s.employment_id, e.employer_subsidiary_id`)).rows;
  const hoursRows = (await exec.execute<{ employmentId: string; hours: string }>(sql`
    select e.id::text as "employmentId", coalesce(sum(t.hours), 0)::text as hours
      from worker_employments e
      left join time_entries t
        on t.org_id = e.org_id and t.employee_party_id = e.worker_party_id
       and t.worked_on between ${from}::date and ${to}::date
       and t.status = 'approved'
     where e.org_id = ${orgId}::uuid
     group by e.id`)).rows;
  const hoursByEmp = new Map(hoursRows.map((r) => [r.employmentId, Number(r.hours)]));
  const byCohortMetric = new Map(baselines.map((b) => [`${b.cohortKey}::${b.metric}`, b]));
  for (const c of currents) {
    const cohort = c.cohort ?? "unassigned";
    // The flag vocabulary names net_pay_spike and hours_spike; a gross
    // move rides net_pay_spike with the metric named in the detail and
    // the explanation, so the reader sees which figure moved.
    const checks: { metric: "net_pay" | "gross" | "hours"; actual: number; kind: AnomalyKind }[] = [
      { metric: "net_pay", actual: Number(c.net), kind: "net_pay_spike" },
      { metric: "gross", actual: Number(c.gross), kind: "net_pay_spike" },
      { metric: "hours", actual: hoursByEmp.get(c.employmentId) ?? 0, kind: "hours_spike" },
    ];
    for (const check of checks) {
      const base = byCohortMetric.get(`${cohort}::${check.metric}`);
      if (!base) {
        const key = `baseline ${check.metric} for cohort ${cohort}`;
        if (!skipped.includes(key)) skipped.push(`${key} (no baseline row — run the baseline job)`);
        continue;
      }
      const mean = Number(base.mean);
      const stddev = Number(base.stddev);
      if (baselineBreaches(mean, stddev, check.actual, z)) {
        const zz = zDistance(mean, stddev, check.actual);
        const vars = {
          actual: String(check.actual), z: zz, cohort,
          mean: String(mean), stddev: String(stddev),
        };
        const explanation = check.metric === "gross"
          ? `Gross ${vars.actual} is ${zz}σ from the ${cohort} baseline (mean ${vars.mean}, σ ${vars.stddev}) — confirm the inputs behind the move.`
          : renderExplanation(check.kind, vars);
        flags.push({
          kind: check.kind,
          employmentId: c.employmentId,
          detailKey: `${check.metric}:${c.employmentId}:${zz}`,
          detail: { key: `${check.metric}:${c.employmentId}:${zz}`, metric: check.metric, ...vars },
          explanation,
        });
      }
    }
  }
  return { flags, skipped };
}

/** Persist idempotently: suppressed and already-open rows are never duplicated. */
async function persistFlags(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  from: string,
  to: string,
  pending: PendingFlag[],
): Promise<{ created: number; alreadyOpen: number; suppressed: number }> {
  let created = 0;
  let alreadyOpen = 0;
  let suppressed = 0;
  const suppressedKeys = new Set(
    (await exec.execute<{ kind: string; key: string }>(sql`
      select kind, coalesce(detail->>'key', '') as key
        from payroll_anomaly_flags
       where org_id = ${orgId}::uuid and status = 'false_positive'`)).rows
      .map((r) => suppressionKey(r.kind, r.key)),
  );
  for (const flag of pending) {
    if (suppressedKeys.has(suppressionKey(flag.kind, flag.detailKey))) {
      suppressed += 1;
      continue;
    }
    const existing = (await exec.execute<{ id: string; status: string }>(sql`
      select id::text as id, status from payroll_anomaly_flags
       where org_id = ${orgId}::uuid
         and pay_period_from = ${from}::date and pay_period_to = ${to}::date
         and coalesce(employment_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = coalesce(${flag.employmentId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         and kind = ${flag.kind}
         and coalesce(detail->>'key', '') = ${flag.detailKey}
       limit 1`)).rows[0];
    if (existing) {
      alreadyOpen += 1;
      continue;
    }
    // A racing rescan for the same key is expected and benign: the
    // rescan-unique index arbitrates, the loser lands zero rows, and the
    // flag is counted already-open. DO NOTHING (not a 23505 catch) because
    // a unique violation would abort this scan transaction and fail every
    // later statement with 25P02. Inference-less: the arbiter is an
    // expression index, which ON CONFLICT (columns) cannot name.
    const inserted = (await exec.execute<{ id: string }>(sql`
      insert into payroll_anomaly_flags (
        org_id, pay_period_from, pay_period_to, employment_id, kind,
        severity, detail, explanation, status, created_by
      ) values (
        ${orgId}::uuid, ${from}::date, ${to}::date,
        ${flag.employmentId}::uuid, ${flag.kind},
        ${SEVERITY_BY_KIND[flag.kind]}, ${JSON.stringify(flag.detail)}::jsonb,
        ${flag.explanation}, 'open', ${actorId}::uuid
      ) on conflict do nothing
      returning id::text as id`)).rows[0];
    if (inserted) created += 1;
    else alreadyOpen += 1;
  }
  return { created, alreadyOpen, suppressed };
}

export interface ScanOptions {
  readonly timeOnly?: boolean;
}

/**
 * Run the deterministic scan for a period and persist flags idempotently.
 * One transaction: the flags and the decision row commit together.
 */
export async function scanAnomalies(
  exec: SqlExecutor,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly periodFrom: string;
    readonly periodTo: string;
    readonly options?: ScanOptions;
  },
): Promise<ScanSummary> {
  const { orgId, actorId, periodFrom: from, periodTo: to } = input;
  if (!orgId || !actorId) throw new AiRailsError("ai_invalid_input", "orgId and actorId are required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new AiRailsError("ai_invalid_input", "periodFrom/periodTo must be YYYY-MM-DD with periodFrom <= periodTo");
  }
  const timeOnly = input.options?.timeOnly === true;
  await assertScanScope(exec, orgId, actorId);
  await assertAnomalyFeature(exec, orgId, timeOnly);
  const settings = await loadAiRailsSettings(exec, orgId);

  const skipped: string[] = [];
  const pending: PendingFlag[] = [];
  // Clock-event rules (geofence_outside, unrounded) have no source table on
  // this base — HR-20 clock events are not installed — so they skip by name
  // instead of accruing zero or refusing the whole scan.
  skipped.push("geofence_outside, unrounded (no clock-event source on this base)");
  if (!timeOnly) {
    pending.push(...(await ruleTerminatedWithPay(exec, orgId, from, to)));
    pending.push(...(await ruleDuplicateBank(exec, orgId)));
    pending.push(...(await ruleRetroSpike(exec, orgId, from, to, settings.retroThreshold)));
    pending.push(...(await ruleOrphans(exec, orgId, from, to)));
    const construction = await ruleConstructionMirror(exec, orgId, from, to);
    pending.push(...construction.flags);
    if (construction.skipped) skipped.push(construction.skipped);
    const base = await ruleBaselines(exec, orgId, from, to, settings.cohortKey, settings.zThreshold);
    pending.push(...base.flags);
    skipped.push(...base.skipped);
  }
  pending.push(...(await ruleZeroHoursWithPay(exec, orgId, from, to)));
  pending.push(...(await ruleDuplicateEntries(exec, orgId, from, to)));
  const rates = await ruleMissingRates(exec, orgId, from, to);
  pending.push(...rates.missing, ...rates.expired);

  pending.push(...(await ruleNegativeBalances(exec, orgId, from, to)));
  const persisted = await persistFlags(exec, orgId, actorId, from, to, pending);
  await logDecision(exec, {
    orgId,
    actorId,
    capabilityKey: timeOnly ? "hrmTimeAnomalies" : "hrmPayrollAnomalies",
    subjectKind: "pay_period",
    subjectId: null,
    input: `scanAnomalies ${from}..${to} timeOnly=${timeOnly}`,
    output: `created=${persisted.created} open=${persisted.alreadyOpen} suppressed=${persisted.suppressed}`,
    outputSummary: `anomaly scan ${from} to ${to}: ${persisted.created} new, ${persisted.alreadyOpen} already open`,
    sources: [],
    outcome: "shown",
    model: "anomalies-service",
  });
  return { periodFrom: from, periodTo: to, ...persisted, skipped };
}

export type FlagRow = {
  id: string;
  kind: string;
  severity: string;
  status: string;
  employmentId: string | null;
  payPeriodFrom: string;
  payPeriodTo: string;
  explanation: string;
  detail: unknown;
  reason: string | null;
}

async function assertFlagReadScope(exec: SqlExecutor, orgId: string, actorId: string): Promise<void> {
  if (await actorHasPermission(exec, orgId, actorId, "payroll.manage")) return;
  if (await actorHasPermission(exec, orgId, actorId, "time.approve")) return;
  if (await actorHasPermission(exec, orgId, actorId, "hrm.employment.read")) return;
  throw new AiRailsError(
    "ai_forbidden",
    "payroll checks need the payroll manager, time approver or HR reader — ask an administrator for access",
  );
}

/** List flags with filter chips state. */
export async function listFlags(
  exec: SqlExecutor,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly periodFrom?: string;
    readonly periodTo?: string;
    readonly severity?: string;
    readonly kind?: string;
    readonly status?: string;
    readonly employmentId?: string;
  },
): Promise<FlagRow[]> {
  await assertFlagReadScope(exec, input.orgId, input.actorId);
  const rows = (await exec.execute<FlagRow>(sql`
    select id::text as id, kind, severity, status,
           employment_id::text as "employmentId",
           pay_period_from::text as "payPeriodFrom",
           pay_period_to::text as "payPeriodTo",
           explanation, detail, reason
      from payroll_anomaly_flags
     where org_id = ${input.orgId}::uuid
       and (${input.periodFrom ?? null}::date is null or pay_period_from = ${input.periodFrom ?? null}::date)
       and (${input.periodTo ?? null}::date is null or pay_period_to = ${input.periodTo ?? null}::date)
       -- Every optional filter is CAST. An untyped null parameter makes
       -- PostgreSQL refuse the whole statement with "could not determine
       -- data type of parameter", so leaving severity, kind or status
       -- unset threw instead of matching everything -- which is the
       -- default state of the checks list.
       and (${input.severity ?? null}::text is null or severity = ${input.severity ?? null}::text)
       and (${input.kind ?? null}::text is null or kind = ${input.kind ?? null}::text)
       and (${input.status ?? null}::text is null or status = ${input.status ?? null}::text)
       and (${input.employmentId ?? null}::uuid is null or employment_id = ${input.employmentId ?? null}::uuid)
     order by severity, pay_period_from desc, id`)).rows;
  return rows;
}

/** Flags for one subject — the chips on timesheet approvals and inbox items. */
export async function flagsForEmployment(
  exec: SqlExecutor,
  input: { readonly orgId: string; readonly actorId: string; readonly employmentId: string },
): Promise<FlagRow[]> {
  return listFlags(exec, {
    orgId: input.orgId,
    actorId: input.actorId,
    employmentId: input.employmentId,
    status: "open",
  });
}

/**
 * Acknowledge, resolve, or mark false-positive. False-positive feeds the
 * suppression list; resolution needs a reason (the CHECK refuses empty
 * reasons, and zero matched rows fail). Block flags additionally need
 * payroll.manage — an approver cannot clear what refuses the finalize.
 */
export async function transitionFlag(
  exec: SqlExecutor,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly flagId: string;
    readonly to: FlagStatus;
    readonly reason: string;
  },
): Promise<FlagRow> {
  const { orgId, actorId, flagId } = input;
  if (!["acknowledged", "resolved", "false_positive"].includes(input.to)) {
    throw new AiRailsError("ai_invalid_input", "transition target must be acknowledged, resolved or false_positive");
  }
  if (input.reason.trim().length === 0) {
    throw new AiRailsError(
      "ai_reason_required",
      "a reason is required — write the sentence the audit needs; empty reasons are refused",
    );
  }
  await assertFlagReadScope(exec, orgId, actorId);
  const current = (await exec.execute<{ severity: string; status: string }>(sql`
    select severity, status from payroll_anomaly_flags
     where org_id = ${orgId}::uuid and id = ${flagId}::uuid`)).rows[0];
  if (!current) {
    throw new AiRailsError(
      "ai_flag_missing",
      `flag ${flagId} matched no row — it is missing or outside this organization; reload and retry`,
    );
  }
  if (current.status !== "open" && current.status !== "acknowledged") {
    throw new AiRailsError(
      "ai_flag_closed",
      `flag is already ${current.status} — closed flags stay closed; run a fresh scan for the new period`,
    );
  }
  if (current.severity === "block" && input.to !== "acknowledged"
    && !(await actorHasPermission(exec, orgId, actorId, "payroll.manage"))) {
    throw new AiRailsError(
      "ai_forbidden",
      "only the payroll manager resolves or dismisses blocking flags — acknowledge it and escalate instead",
    );
  }
  const rows = (await exec.execute<FlagRow>(sql`
    update payroll_anomaly_flags
       set status = ${input.to}, reason = ${input.reason},
           resolved_by = ${actorId}::uuid, resolved_at = now(),
           updated_by = ${actorId}::uuid, updated_at = now()
     where org_id = ${orgId}::uuid and id = ${flagId}::uuid
    returning id::text as id, kind, severity, status,
           employment_id::text as "employmentId",
           pay_period_from::text as "payPeriodFrom",
           pay_period_to::text as "payPeriodTo",
           explanation, detail, reason`)).rows;
  const row = rows[0];
  if (!row) {
    throw new AiRailsError("ai_flag_missing", `flag ${flagId} matched no row on write — reload and retry`);
  }
  await logDecision(exec, {
    orgId,
    actorId,
    capabilityKey: "hrmPayrollAnomalies",
    subjectKind: "payroll_anomaly_flag",
    subjectId: row.id,
    input: `transitionFlag ${row.id} -> ${input.to}`,
    output: `${input.to}: ${input.reason}`,
    outputSummary: `flag ${row.kind} ${input.to} (${input.reason.slice(0, 80)})`,
    sources: [{ kind: "payroll_anomaly_flag", id: row.id }],
    outcome: "accepted",
    humanReviewer: actorId,
    model: "anomalies-service",
  });
  return row;
}

export interface FinalizeCheck {
  openBlockCount: number;
  openBlocks: FlagRow[];
}

/**
 * THE finalize hook. The payroll run service calls this by name before
 * committing: any open block-severity flag for the period refuses the
 * finalize with the remedy. Warn is reported, never blocks.
 */
export async function checkPayrollFinalizeAllowed(
  exec: SqlExecutor,
  input: { readonly orgId: string; readonly periodFrom: string; readonly periodTo: string },
): Promise<FinalizeCheck> {
  const rows = (await exec.execute<FlagRow>(sql`
    select id::text as id, kind, severity, status,
           employment_id::text as "employmentId",
           pay_period_from::text as "payPeriodFrom",
           pay_period_to::text as "payPeriodTo",
           explanation, detail, reason
      from payroll_anomaly_flags
     where org_id = ${input.orgId}::uuid
       and severity = 'block' and status in ('open', 'acknowledged')
       and pay_period_from <= ${input.periodTo}::date
       and pay_period_to >= ${input.periodFrom}::date
     order by id`)).rows;
  if (rows.length > 0) {
    throw finalizeBlockedRefusal(rows.length, input.periodFrom, input.periodTo);
  }
  return { openBlockCount: 0, openBlocks: [] };
}

/**
 * Recompute cohort baselines over the trailing window of pay dates. The
 * scheduled tick owns the cadence; this function owns the math. Recompute
 * is an upsert per (org, cohort, metric) — a newer window replaces the
 * older one, which is the expected and benign conflict.
 */
export async function computeBaselines(
  exec: SqlExecutor,
  input: { readonly orgId: string; readonly actorId: string; readonly windowPeriods?: number },
): Promise<{ computed: number; windowPayDates: string[]; cohortKey: string }> {
  const { orgId, actorId } = input;
  const windowPeriods = input.windowPeriods ?? 6;
  if (!(await actorHasPermission(exec, orgId, actorId, "payroll.manage"))) {
    throw new AiRailsError(
      "ai_forbidden",
      "recomputing anomaly baselines needs the payroll manager — ask a payroll administrator",
    );
  }
  const settings = await loadAiRailsSettings(exec, orgId);
  const cohortKey = settings.cohortKey === "pay_schedule" || settings.cohortKey === "job_level"
    ? "subsidiary"
    : settings.cohortKey;
  const dates = (await exec.execute<{ payDate: string }>(sql`
    select distinct pay_date::text as "payDate" from pay_stubs
     where org_id = ${orgId}::uuid
     order by pay_date desc
     limit ${windowPeriods}`)).rows.map((r) => r.payDate);
  if (dates.length < 2) {
    throw new AiRailsError(
      "ai_baseline_too_early",
      "baselines need at least two calculated pay dates — run payroll twice before computing them",
    );
  }
  const earliest = dates[dates.length - 1];
  const cohortSql = cohortKey === "department"
    ? sql`(select av.department_id::text from employment_assignment_versions av where av.org_id = e.org_id and av.employment_id = e.id and av.recorded_until is null and av.is_primary order by av.version_no desc limit 1)`
    : sql`e.employer_subsidiary_id::text`;
  const stats = (await exec.execute<{
    cohort: string; metric: string; mean: string; stddev: string;
  }>(sql`
    with window_stubs as (
      select s.employment_id, s.net_pay, s.gross, ${cohortSql} as cohort
        from pay_stubs s
        join worker_employments e on e.org_id = s.org_id and e.id = s.employment_id
       where s.org_id = ${orgId}::uuid and s.pay_date >= ${earliest}::date
    )
    select coalesce(cohort, 'unassigned') as cohort, 'net_pay' as metric,
           avg(net_pay)::text as mean, coalesce(stddev_pop(net_pay), 0)::text as stddev
      from window_stubs group by 1
    union all
    select coalesce(cohort, 'unassigned') as cohort, 'gross' as metric,
           avg(gross)::text as mean, coalesce(stddev_pop(gross), 0)::text as stddev
      from window_stubs group by 1
    union all
    select coalesce(cohort, 'unassigned') as cohort, 'hours' as metric,
           avg(h)::text as mean, coalesce(stddev_pop(h), 0)::text as stddev
      from (
        select ${cohortSql} as cohort, coalesce(sum(t.hours), 0) as h
          from worker_employments e
          left join time_entries t
            on t.org_id = e.org_id and t.employee_party_id = e.worker_party_id
           and t.worked_on >= ${earliest}::date and t.status = 'approved'
         where e.org_id = ${orgId}::uuid
         group by e.id, e.org_id
      ) per_employment
     group by 1`)).rows;
  let computed = 0;
  for (const s of stats) {
    const done = (await exec.execute<{ id: string }>(sql`
      insert into anomaly_baselines (
        org_id, cohort_key, metric, window_periods, mean, stddev, computed_at, created_by
      ) values (
        ${orgId}::uuid, ${s.cohort}, ${s.metric}, ${dates.length},
        ${s.mean}::numeric, ${s.stddev}::numeric, now(), ${actorId}::uuid
      )
      on conflict (org_id, cohort_key, metric) do update
         set window_periods = excluded.window_periods, mean = excluded.mean,
             stddev = excluded.stddev, computed_at = now(), updated_by = ${actorId}::uuid,
             updated_at = now()
      returning id::text as id`)).rows[0];
    if (done) computed += 1;
  }
  await logDecision(exec, {
    orgId,
    actorId,
    capabilityKey: "hrmPayrollAnomalies",
    subjectKind: "anomaly_baselines",
    subjectId: null,
    input: `computeBaselines window=${dates.length}`,
    output: `computed=${computed} cohorts over ${earliest}..${dates[0]}`,
    outputSummary: `baselines recomputed (${computed} cohort-metric windows)`,
    sources: [],
    outcome: "accepted",
    humanReviewer: actorId,
    model: "anomalies-service",
  });
  return { computed, windowPayDates: dates, cohortKey };
}

/** Public boundaries. Each is one transaction. */
export async function runAnomalyScan(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly options?: ScanOptions;
}): Promise<ScanSummary> {
  return withOrgTransaction(query.orgId, () => scanAnomalies(db, query));
}

export async function computeAnomalyBaselines(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly windowPeriods?: number;
}): Promise<{ computed: number; windowPayDates: string[]; cohortKey: string }> {
  return withOrgTransaction(query.orgId, () => computeBaselines(db, query));
}

export async function resolveFlag(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly flagId: string;
  readonly to: FlagStatus;
  readonly reason: string;
}): Promise<FlagRow> {
  return withOrgTransaction(query.orgId, () => transitionFlag(db, query));
}


import { sql } from "drizzle-orm";
import { fromUnits, toUnits } from "../../money/money.ts";
import { loadOwnEmploymentIds, requireHrmBenefitsRead, requireOwnEmploymentSubject, requireHrmSelfRead } from "../authorization.ts";
import { parseCivilDate } from "../temporal.ts";
import { BenefitsError } from "./errors.ts";
import type { EnrollmentSummary } from "./benefits-read.ts";
import type { BenefitAward } from "./program-types.ts";
import {
  assertHrmEnabled,
  db,
  requireActorId,
  requireId,
  requireOrgId,
  withOrgTransaction,
} from "./shared.ts";

/**
 * Employee reward statement: one employment's benefits, program awards, and
 * payroll records in a single read — without duplicating payments and
 * without conflating estimates with committed payroll values.
 *
 * An employee reads their own employments with the self-service read grant: the subject is the employment resolved from their login,
 * and every row query is fenced to that employment id — never an
 * organization-wide list. Anyone else passes the HR employment gate
 * (grant plus employer scope). Award rows project value, status, linkage,
 * frozen program title and limited evidence metadata. Full source and policy
 * snapshots stay in the database; allocation fractions and explanations
 * are excluded because they can reveal the employer's financial base.
 *
 * Sections stay visually separate for a reason: an award is the
 * entitlement record (what the program owes), a pay stub is the payroll
 * record (what payroll calculated and committed). Delivery does not certify
 * bank settlement; payment evidence belongs to the native payment workflow.
 * A delivered award's value is already inside
 * stub gross. External fulfillment is recorded separately by its provider
 * reference; neither category is added to payroll gross. Voided native runs
 * classify their award deliveries as reversed history, outside paid totals.
 * Draft, pending, approved, and queued awards are listed as NOT YET PAID
 * and never summed with delivered ones; totals group by currency and mixed
 * currencies are never totaled. Company measures (profit, totals, digests)
 * never appear here: the employee sees their own figures or nothing.
 */

export interface StatementStubLine {
  readonly componentCode: string | null;
  readonly kind: string;
  readonly description: string;
  readonly amount: string;
}

export interface StatementStub {
  readonly payDate: string;
  readonly currency: string;
  readonly gross: string;
  readonly netPay: string;
  readonly lines: readonly StatementStubLine[];
}

export interface StatementAward extends BenefitAward {
  /** The employer-facing policy title frozen when this award was recorded. */
  readonly programName: string;
  readonly deliveryState: "pending" | "delivered" | "reversed";
}

export interface BenefitStatement {
  readonly employmentId: string;
  readonly enrollments: readonly EnrollmentSummary[];
  /** Delivered to committed payroll; value is already inside stub gross. */
  readonly paidAwards: readonly StatementAward[];
  /** Draft/pending/approved/queued awards: not yet delivered to payroll. */
  readonly pendingAwards: readonly StatementAward[];
  /** Historical deliveries reversed by a native pay-run void; never counted as paid. */
  readonly reversedAwards: readonly StatementAward[];
  /** Delivered totals grouped by currency (mixed currencies never total). */
  readonly paidTotals: ReadonlyArray<{ readonly currency: string; readonly total: string }>;
  readonly payrollRecords: readonly StatementStub[];
}

/**
 * Authorize one employment's statement: self (the employment belongs to
 * the actor and the self-service read grant is present) or manager (HR
 * employment gate). A stranger's employment fails both and never yields an empty statement.
 */
async function authorizeSubject(
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<"self" | "manager"> {
  const own = await loadOwnEmploymentIds(db, orgId, actorId);
  if (own.includes(employmentId)) {
    await requireOwnEmploymentSubject(db, orgId, actorId, employmentId, "hrm.self.read");
    return "self";
  }
  await requireHrmBenefitsRead(db, orgId, actorId, employmentId);
  return "manager";
}

/** Own-subject enrollment rows: one employment, no aggregate list. */
async function readOwnEnrollments(orgId: string, employmentId: string): Promise<EnrollmentSummary[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
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
     where e.org_id = ${orgId} and e.employment_id = ${employmentId}
     order by e.effective_from desc
  `)).rows;
  const textOrNull = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  return rows.map((row) => ({
    id: String(row.id),
    employmentId: String(row.employmentId),
    windowId: textOrNull(row.windowId),
    employeeName: textOrNull(row.employeeName),
    planCode: String(row.planCode),
    planName: String(row.planName),
    coverageLevelKey: textOrNull(row.coverageLevelKey),
    coverageLabel: textOrNull(row.coverageLabel),
    status: String(row.status),
    effectiveFrom: String(row.effectiveFrom).slice(0, 10),
    effectiveTo: row.effectiveTo != null ? String(row.effectiveTo).slice(0, 10) : null,
    employeeAmountPerPeriod: textOrNull(row.employeeAmountPerPeriod),
    employerAmountPerPeriod: textOrNull(row.employerAmountPerPeriod),
    currency: String(row.currency),
  }));
}

/** Only statement-safe metadata is projected. Allocation fractions and their
 * explanations can disclose the company pool by division, even without a
 * profit field, so the statement never forwards arbitrary award evidence. */
export function statementEvidence(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  if (typeof input.kind === "string") safe.kind = input.kind;
  if (typeof input.programRevision === "number") safe.programRevision = input.programRevision;
  if (typeof input.payableAfter === "string") {
    try { safe.payableAfter = parseCivilDate(input.payableAfter); } catch {
      // Malformed optional display metadata is withheld; it never supplies
      // policy or eligibility inputs, which their source services validate.
    }
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

/**
 * Own-subject award rows: one employment's full set, newest first. The
 * projection includes the frozen title and limited evidence metadata,
 * without selecting confidential source or policy objects.
 */
async function readOwnAwards(orgId: string, employmentId: string): Promise<StatementAward[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select r.run_status as "runStatus", doc.status as "runDocumentStatus",
           a.id, a.program_snapshot->>'name' as "programName", a.program_id as "programId", a.employment_id as "employmentId",
           a.period_from::text as "periodFrom", a.period_to::text as "periodTo",
           a.value::text as "value", a.currency, a.status, a.evidence,
           a.source_key as "sourceKey", a.adjusts_award_id as "adjustsAwardId",
           a.external_ref as "externalRef",
           a.pay_run_document_id as "payRunDocumentId",
           a.pay_run_adjustment_id as "payRunAdjustmentId",
           a.approved_by as "approvedBy", a.approved_at::text as "approvedAt",
           a.created_by as "createdBy", a.void_reason as "voidReason"
      from hrm_benefit_awards a
      left join pay_runs r on r.org_id = a.org_id and r.document_id = a.pay_run_document_id
      left join documents doc on doc.org_id = a.org_id and doc.id = a.pay_run_document_id
     where a.org_id = ${orgId} and a.employment_id = ${employmentId}
     order by a.period_from desc, a.created_at desc
  `)).rows;
  return rows.map((row) => ({
    id: String(row.id),
    deliveryState: row.status !== "delivered" ? "pending"
      : row.runStatus === "voided" || row.runDocumentStatus === "voided" ? "reversed" : "delivered",
    programId: String(row.programId),
    programName: typeof row.programName === "string" ? row.programName : "",
    employmentId: String(row.employmentId),
    periodFrom: String(row.periodFrom).slice(0, 10),
    periodTo: row.periodTo != null ? String(row.periodTo).slice(0, 10) : null,
    value: String(row.value),
    currency: String(row.currency),
    status: row.status as BenefitAward["status"],
    evidence: statementEvidence(row.evidence),
    sourceKey: row.sourceKey != null ? String(row.sourceKey) : null,
    adjustsAwardId: row.adjustsAwardId != null ? String(row.adjustsAwardId) : null,
    externalRef: row.externalRef != null ? String(row.externalRef) : null,
    payRunDocumentId: row.payRunDocumentId != null ? String(row.payRunDocumentId) : null,
    payRunAdjustmentId: row.payRunAdjustmentId != null ? String(row.payRunAdjustmentId) : null,
    approvedBy: row.approvedBy != null ? String(row.approvedBy) : null,
    approvedAt: row.approvedAt != null ? String(row.approvedAt) : null,
    createdBy: row.createdBy != null ? String(row.createdBy) : null,
    voidReason: row.voidReason != null ? String(row.voidReason) : null,
  }));
}

async function employmentStatement(
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<BenefitStatement> {
  await authorizeSubject(orgId, actorId, employmentId);
  const enrollments = await readOwnEnrollments(orgId, employmentId);
  const awards = await readOwnAwards(orgId, employmentId);
  const paidAwards = awards.filter((a) => a.status === "delivered" && a.deliveryState === "delivered");
  const reversedAwards = awards.filter((a) => a.deliveryState === "reversed");
  const pendingAwards = awards.filter((a) => a.status !== "delivered" && a.status !== "voided");
  const totals = new Map<string, bigint>();
  for (const award of paidAwards) {
    totals.set(award.currency, (totals.get(award.currency) ?? 0n) + toUnits(award.value));
  }
  const paidTotals = [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([currency, units]) => ({ currency, total: fromUnits(units) }));

  const stubRows = (await db.execute<{
    id: string; pay_date: string; currency: string; gross: string; net_pay: string;
  }>(sql`
    select s.id::text as id, s.pay_date::text as pay_date, s.currency_code as currency,
           s.gross::text as gross, s.net_pay::text as net_pay
      from pay_stubs s
      join pay_runs r on r.org_id = s.org_id and r.document_id = s.pay_run_document_id
      join documents d on d.org_id = r.org_id and d.id = r.document_id
     where s.org_id = ${orgId} and s.employment_id = ${employmentId}
       and r.run_status = 'committed' and d.status <> 'voided'
     order by s.pay_date desc
  `)).rows;
  const payrollRecords: StatementStub[] = [];
  for (const stub of stubRows) {
    const lineRows = (await db.execute<{
      component_code: string | null; kind: string; description: string; amount: string;
    }>(sql`
      select c.code as component_code, l.kind, l.description, l.amount::text as amount
        from pay_stub_lines l
        left join pay_components c on c.org_id = l.org_id and c.id = l.component_id
       where l.org_id = ${orgId} and l.stub_id = ${stub.id}::uuid
       order by l.sequence, l.id
    `)).rows;
    payrollRecords.push({
      payDate: stub.pay_date.slice(0, 10),
      currency: stub.currency,
      gross: stub.gross,
      netPay: stub.net_pay,
      lines: lineRows.map((l) => ({
        componentCode: l.component_code,
        kind: l.kind,
        description: l.description,
        amount: l.amount,
      })),
    });
  }
  return { employmentId, enrollments, paidAwards, pendingAwards, reversedAwards, paidTotals, payrollRecords };
}

/** One employment's statement (the employee themself, or a manager with scope). */
export async function employmentBenefitStatement(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
}): Promise<BenefitStatement> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmEnabled(db, orgId);
    return employmentStatement(orgId, actorId, employmentId);
  });
}

/** The actor's own statement across their employments, under self-service authorization. */
export async function myBenefitStatement(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<BenefitStatement[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmEnabled(db, orgId);
    // Empty own-employment set is a named absence, not an empty success:
    // without it the statement would report "nothing" for a stranger.
    await requireHrmSelfRead(db, orgId, actorId);
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    if (own.length === 0) {
      throw new BenefitsError(
        "NOT_FOUND",
        "no employment is linked to this user — statements read through your own employments, never a typed id",
      );
    }
    const out: BenefitStatement[] = [];
    for (const employmentId of [...own].sort()) {
      out.push(await employmentStatement(orgId, actorId, employmentId));
    }
    return out;
  });
}

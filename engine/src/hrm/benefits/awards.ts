import { BENEFIT_AWARD_SUBJECT_KIND } from "@openbooks/schema/src/benefits-programs.ts";
import { sql } from "drizzle-orm";
import { awardPayrollProcessedSql } from "./payroll-delivery-evidence.ts";
import { lockFlowSubjectDecision } from "../../flows/decision-lock.ts";
import { db, withOrgTransaction, withTransactionSavepoint, type SqlExecutor } from "../../platform/db.ts";
import { fitsLedgerRange, normalizeMoney } from "../../money/money.ts";
import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { moneyRefusal } from "../../money/decimal-refusal.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import {
  requireAggregateBenefitsRead,
  requireHrmBenefitsManage,
  requireHrmBenefitsManageOnEmployment,
} from "../authorization.ts";
import { PayrollError } from "../../payroll/error.ts";
import { mutatePayRunAdjustment } from "../../payroll/run-adjustments.ts";
import { benefitListWindow } from "./list-window.ts";
import { BenefitsError, isUniqueViolation } from "./errors.ts";
import { getBenefitProgram } from "./programs.ts";
import {
  assertHrmEnabled,
  requireActorId,
  requireCivilDate,
  requireId,
  requireOneRow,
  requireOrgId,
} from "./shared.ts";
import type { BenefitAward } from "./program-types.ts";

/**
 * Employer-defined benefit award lifecycle.
 *
 * Each award records one issuance with immutable program and source
 * snapshots: a correction voids and reissues, never rewrites. Value is an
 * exact decimal in program currency, delivered through existing payroll
 * inputs (never manual net-pay edits) or a recorded external reference that
 * never pretends the provider issued something it did not.
 *
 * Segregation: HR authors (hrm.benefits.manage) create, submit, and
 * void; finance payout (payroll.manage) queues and records delivery.
 * Submission follows the pinned program approval setting: none or native Flows.
 * No-approval and direct processing retain evidence without inventing a human decision.
 */

export type { BenefitAward, BenefitAwardStatus } from "./program-types.ts";

const AWARD_COLUMNS = sql`id, program_id as "programId",
  employment_id as "employmentId",
  period_from::text as "periodFrom", period_to::text as "periodTo",
  value::text as "value", currency, status,
  program_snapshot as "programSnapshot", source_snapshot as "sourceSnapshot",
  evidence, source_key as "sourceKey", adjusts_award_id as "adjustsAwardId",
  external_ref as "externalRef",
  pay_run_document_id as "payRunDocumentId",
  pay_run_adjustment_id as "payRunAdjustmentId",
  flow_run_id as "flowRunId", submitted_by as "submittedBy", submitted_at::text as "submittedAt", decision_snapshot as "decisionSnapshot",
  approved_by as "approvedBy", approved_at::text as "approvedAt",
  created_by as "createdBy", void_reason as "voidReason"`;

// A committed run alone is insufficient: the employee's exact native input
// must be present on its calculated stub with the required payment representation.


function toAward(row: Record<string, unknown>): BenefitAward {
  const status = String(row.status);
  if (
    status !== "draft" &&
    status !== "pending" &&
    status !== "rejected" &&
    status !== "approved" &&
    status !== "queued" &&
    status !== "delivered" &&
    status !== "voided"
  ) {
    throw new BenefitsError("REFUSED", "benefit award carries an unknown status — reload and retry");
  }
  return {
    id: String(row.id),
    programId: String(row.programId),
    employmentId: String(row.employmentId),
    periodFrom: String(row.periodFrom).slice(0, 10),
    periodTo: row.periodTo != null ? String(row.periodTo).slice(0, 10) : null,
    value: String(row.value),
    currency: String(row.currency),
    status,
    evidence:
      row.evidence !== null && row.evidence !== undefined
        ? (row.evidence as Record<string, unknown>)
        : null,
    sourceKey: row.sourceKey != null ? String(row.sourceKey) : null,
    adjustsAwardId: row.adjustsAwardId != null ? String(row.adjustsAwardId) : null,
    externalRef: row.externalRef != null ? String(row.externalRef) : null,
    payRunDocumentId: row.payRunDocumentId != null ? String(row.payRunDocumentId) : null,
    payRunAdjustmentId: row.payRunAdjustmentId != null ? String(row.payRunAdjustmentId) : null,
    payrollProcessed: row.payrollProcessed === true,
    flowRunId: row.flowRunId != null ? String(row.flowRunId) : null,
    submittedBy: row.submittedBy != null ? String(row.submittedBy) : null,
    submittedAt: row.submittedAt != null ? String(row.submittedAt) : null,
    decisionSnapshot: row.decisionSnapshot != null ? row.decisionSnapshot as Record<string, unknown> : null,
    approvalHref: status === "pending" && row.flowRunId != null ? "/approvals" : null,
    approvedBy: row.approvedBy != null ? String(row.approvedBy) : null,
    approvedAt: row.approvedAt != null ? String(row.approvedAt) : null,
    createdBy: row.createdBy != null ? String(row.createdBy) : null,
    voidReason: row.voidReason != null ? String(row.voidReason) : null,
  };
}

async function requirePayrollManage(exec: SqlExecutor, orgId: string, actorId: string): Promise<void> {
  if (!(await actorHasPermission(exec, orgId, actorId, "payroll.manage"))) {
    throw new BenefitsError(
      "REFUSED",
      "recording payout needs the payroll.manage permission — HR authors the award, finance releases the payout; ask a payroll manager",
    );
  }
}

async function requireAwardEntityScope(exec: SqlExecutor, orgId: string, actorId: string, programId: string): Promise<string> {
  const row = (await exec.execute<{ legal_entity_id: string | null }>(sql`
    select legal_entity_id from hrm_benefit_programs where org_id = ${orgId} and id = ${programId}
  `)).rows[0];
  const scope = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (!row?.legal_entity_id || (scope !== null && !scope.has(String(row.legal_entity_id)))) {
    throw new BenefitsError("NOT_FOUND", "benefit award not found in this organization — reload the award list and retry");
  }
  return String(row.legal_entity_id);
}

async function lockAwardRun(exec: SqlExecutor, orgId: string, awardId: string, requestedRunId?: string | null): Promise<void> {
  // Native calculate, commit and adjustment writes acquire these same run
  // locks. Always take them before the award lock to keep payout moves ordered.
  const runId = requestedRunId ?? (await exec.execute<{ pay_run_document_id: string | null }>(sql`
    select pay_run_document_id from hrm_benefit_awards where org_id = ${orgId} and id = ${awardId}
  `)).rows[0]?.pay_run_document_id;
  if (runId) {
    await exec.execute(sql`
      select r.document_id from pay_runs r join documents d on d.org_id = r.org_id and d.id = r.document_id
       where r.org_id = ${orgId} and r.document_id = ${runId} for update of r, d
    `);
  }
}

async function appendAwardEvent(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  awardId: string,
  kind: string,
  reason: string,
): Promise<void> {
  await exec.execute(sql`
    insert into hrm_benefit_award_events (org_id, award_id, kind, reason, actor, created_by)
    values (${orgId}, ${awardId}, ${kind}, ${reason}, ${actorId}, ${actorId})
  `);
}

async function auditAwardWrite(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  awardId: string,
  event: string,
  before: unknown,
  after: unknown,
  reason: string | null,
): Promise<void> {
  await exec.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'hrm_benefit_awards', ${awardId}, 'update', ${JSON.stringify({
      event,
      actor: { kind: "user", userId: actorId },
      before,
      after,
      reason,
    })}::jsonb, ${actorId})
  `);
}

function canonicalValue(value: unknown, signed: boolean): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw new BenefitsError("INVALID_INPUT", moneyRefusal("value", value, "an amount"));
  }
  const canonical = normalizeMoney(exact);
  if (!fitsLedgerRange(canonical)) {
    throw new BenefitsError("INVALID_INPUT", "the amount exceeds the ledger's 15 whole-digit limit — enter a smaller exact amount");
  }
  if (canonical === "0.0000") {
    throw new BenefitsError("INVALID_INPUT", signed
      ? "a zero-value adjustment corrects no payroll obligation — enter a non-zero signed correction or leave the original reward unchanged"
      : "a zero-value reward creates no payroll obligation — enter a positive award value");
  }
  if (!signed && canonical.startsWith("-")) {
    throw new BenefitsError("INVALID_INPUT", "award value is a positive amount in program currency");
  }
  return canonical;
}

/**
 * Load one award; unknown or out-of-scope ids refuse uniformly. Awards bind
 * to an employment, so restricted actors see only awards of their own
 * legal entities, resolved through the immutable program entity in the database.
 */
export async function getBenefitAward(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  awardId: string,
): Promise<BenefitAward> {
  const scope = await requireAggregateBenefitsRead(exec, orgId, actorId);
  await assertHrmEnabled(exec, orgId);
  const row = (
    await exec.execute<Record<string, unknown>>(sql`
      select a.id as id, a.program_id as "programId",
             a.employment_id as "employmentId",
             a.period_from::text as "periodFrom", a.period_to::text as "periodTo",
             a.value::text as "value", a.currency, a.status,
             a.program_snapshot as "programSnapshot", a.source_snapshot as "sourceSnapshot",
             a.evidence, a.source_key as "sourceKey", a.adjusts_award_id as "adjustsAwardId", a.external_ref as "externalRef",
             a.pay_run_document_id as "payRunDocumentId",
             a.pay_run_adjustment_id as "payRunAdjustmentId",
             a.flow_run_id as "flowRunId", a.submitted_by as "submittedBy", a.submitted_at::text as "submittedAt", a.decision_snapshot as "decisionSnapshot",
             a.approved_by as "approvedBy", a.approved_at::text as "approvedAt",
             a.created_by as "createdBy", a.void_reason as "voidReason",
             p.legal_entity_id as "subsidiaryId", ${awardPayrollProcessedSql} as "payrollProcessed"
        from hrm_benefit_awards a
        join hrm_benefit_programs p on p.org_id = a.org_id and p.id = a.program_id
       where a.org_id = ${orgId} and a.id = ${awardId}
    `)
  ).rows[0];
  if (!row) {
    throw new BenefitsError(
      "NOT_FOUND",
      "benefit award not found in this organization — reload the award list and retry",
    );
  }
  if (scope !== null) {
    const subsidiary = row.subsidiaryId != null ? String(row.subsidiaryId) : null;
    if (subsidiary === null || !scope.has(subsidiary)) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit award not found in this organization — reload the award list and retry",
      );
    }
  }
  return toAward(row);
}

export async function listBenefitAwards(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId?: string;
  readonly limit?: number;
  readonly offset?: number;
}): Promise<{ awards: BenefitAward[]; total: number }> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    const scope = await requireAggregateBenefitsRead(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    if (query.programId !== undefined) {
      await getBenefitProgram(db, orgId, actorId, String(query.programId));
    }
    const { limit, offset } = benefitListWindow(query.limit, query.offset);
    const rows = (
      await db.execute<Record<string, unknown>>(sql`
        select a.id as id, a.program_id as "programId",
               a.employment_id as "employmentId",
               a.period_from::text as "periodFrom", a.period_to::text as "periodTo",
               a.value::text as "value", a.currency, a.status,
               a.program_snapshot as "programSnapshot", a.source_snapshot as "sourceSnapshot",
               a.evidence, a.source_key as "sourceKey", a.adjusts_award_id as "adjustsAwardId",
               a.external_ref as "externalRef",
               a.pay_run_document_id as "payRunDocumentId",
               a.pay_run_adjustment_id as "payRunAdjustmentId",
               a.flow_run_id as "flowRunId", a.submitted_by as "submittedBy", a.submitted_at::text as "submittedAt", a.decision_snapshot as "decisionSnapshot",
             a.approved_by as "approvedBy", a.approved_at::text as "approvedAt",
               a.created_by as "createdBy", a.void_reason as "voidReason",
               ${awardPayrollProcessedSql} as "payrollProcessed"
          from hrm_benefit_awards a
          join hrm_benefit_programs p on p.org_id = a.org_id and p.id = a.program_id
         where a.org_id = ${orgId}
           ${query.programId !== undefined ? sql`and a.program_id = ${query.programId}` : sql``}
           ${scope !== null ? sql`and p.legal_entity_id = any (${`{${[...scope].join(",")}}`}::uuid[])` : sql``}
         order by a.period_from desc, a.id desc
         ${limit !== null ? sql`limit ${limit} offset ${offset}` : sql`offset ${offset}`}
      `)
    ).rows;
    const total = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from hrm_benefit_awards a
          join hrm_benefit_programs p on p.org_id = a.org_id and p.id = a.program_id
         where a.org_id = ${orgId}
           ${query.programId !== undefined ? sql`and a.program_id = ${query.programId}` : sql``}
           ${scope !== null ? sql`and p.legal_entity_id = any (${`{${[...scope].join(",")}}`}::uuid[])` : sql``}
      `)
    ).rows[0]?.n ?? 0;
    return { awards: rows.map(toAward), total };
  });
}

export interface CreateBenefitAwardQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId: string;
  readonly employmentId: string;
  readonly periodFrom: string;
  readonly periodTo?: string | null;
  readonly value: string | number;
  readonly currency: string;
  readonly evidence?: Record<string, unknown> | null;
  readonly sourceKey?: string | null;
  readonly adjustsAwardId?: string | null;
  readonly settlementMeasurement?: Record<string, unknown> | null;
}

const SETTLEMENT_KEY = /^(settle|adjust):/i;

/**
 * Shared award recording. `origin` separates the two doors: manual awards
 * are recorded directly (rewards, allowances, custom) while settled awards
 * arrive from the settlement calculation with measured evidence under a
 * reserved source key. Evidence carries per-award proof only — company
 * financial totals stay in the confidential source snapshot, never in
 * self-service-visible evidence.
 */
async function recordAward(
  query: CreateBenefitAwardQuery,
  origin: "manual" | "settlement",
): Promise<BenefitAward> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const programId = requireId(query.programId, "programId");
  const employmentId = requireId(query.employmentId, "employmentId");
  const periodFrom = requireCivilDate(query.periodFrom, "periodFrom");
  const periodTo =
    query.periodTo === undefined || query.periodTo === null
      ? null
      : requireCivilDate(query.periodTo, "periodTo");
  if (periodTo !== null && periodTo < periodFrom) {
    throw new BenefitsError("INVALID_INPUT", "periodTo ends on or after periodFrom");
  }
  const adjustsAwardId =
    query.adjustsAwardId === undefined || query.adjustsAwardId === null
      ? null
      : requireId(query.adjustsAwardId, "adjustsAwardId");
  const value = canonicalValue(query.value, adjustsAwardId !== null);
  const currency = String(query.currency ?? "").trim();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BenefitsError("INVALID_INPUT", "currency is a 3-letter ISO code in capitals");
  }
  const sourceKey =
    query.sourceKey === undefined || query.sourceKey === null
      ? null
      : String(query.sourceKey).trim().length > 0
        ? String(query.sourceKey).trim()
        : null;
  if (origin === "manual" && sourceKey !== null && SETTLEMENT_KEY.test(sourceKey)) {
    throw new BenefitsError(
      "REFUSED",
      "settlement keys are issued by the settlement calculation — record manual awards without a key or with a non-reserved key",
    );
  }
  if (origin === "settlement" && (sourceKey === null || !SETTLEMENT_KEY.test(sourceKey))) {
    throw new BenefitsError(
      "REFUSED",
      "settled awards carry a settle: or adjust: source key — the key is the idempotency proof, never a manual label",
    );
  }
  const evidence = query.evidence ?? null;
  if (evidence !== null && (typeof evidence !== "object" || Array.isArray(evidence))) {
    throw new BenefitsError("INVALID_INPUT", "evidence is a JSON object of issuance proof, or null");
  }
  const settlementMeasurement = query.settlementMeasurement ?? null;
  if (settlementMeasurement !== null && (typeof settlementMeasurement !== "object" || Array.isArray(settlementMeasurement))) {
    throw new BenefitsError("INVALID_INPUT", "settlement measurement is a JSON object of full money and hours facts, or null");
  }
  if (origin === "manual" && settlementMeasurement !== null) {
    throw new BenefitsError(
      "REFUSED",
      "manual awards never carry settlement measurement — the settlement calculation records its own facts",
    );
  }
  return withOrgTransaction(orgId, async () => {
    if (adjustsAwardId === null) await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, employmentId);
    else await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    // Program row first, same ordering as settlement and membership writes:
    // every policy, membership, and source read below shares this lock, so a
    // concurrent edit waits instead of landing between the reads and the
    // award. Membership edits bump the program revision under the same lock.
    const lockedHeader = (
      await db.execute<Record<string, unknown>>(sql`
        select id from hrm_benefit_programs
         where org_id = ${orgId} and id = ${programId}
         for update
      `)
    ).rows[0];
    if (!lockedHeader) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit program not found in this organization — reload the program list and retry",
      );
    }
    const program = await getBenefitProgram(db, orgId, actorId, programId);
    if (program.status !== "active" && !(adjustsAwardId !== null && program.status === "closed")) {
      throw new BenefitsError(
        "BAD_STATE",
        `program ${program.code} is ${program.status} — awards issue only from active programs`,
      );
    }
    await requireAwardEntityScope(db, orgId, actorId, program.id);
    let originalPolicy: Record<string, unknown> | null = null;
    let originalSources: Record<string, unknown> | null = null;
    if (adjustsAwardId === null && program.legalEntityId !== null) {
      const employment = (
        await db.execute<{ employer_subsidiary_id: string | null }>(sql`
          select employer_subsidiary_id from worker_employments
           where org_id = ${orgId} and id = ${employmentId}
        `)
      ).rows[0];
      const employmentEntity = employment?.employer_subsidiary_id ?? null;
      if (employmentEntity === null || String(employmentEntity) !== program.legalEntityId) {
        throw new BenefitsError(
          "REFUSED",
          `program ${program.code} belongs to a different legal entity than this employment — issue to employments of the program's entity`,
        );
      }
    }
    const covering = (
      await db.execute<{ id: string }>(sql`
        select id from hrm_benefit_program_members
         where org_id = ${orgId} and program_id = ${programId} and employment_id = ${employmentId}
           and effective_from <= ${periodFrom}::date
           and (effective_to is null or effective_to >= ${periodTo ?? periodFrom}::date)
         limit 1
      `)
    ).rows;
    if (adjustsAwardId === null && covering.length === 0) {
      throw new BenefitsError(
        "REFUSED",
        `no program ${program.code} membership covers this employment over ${periodFrom}..${periodTo ?? periodFrom} — enroll the employment first; awards never issue outside membership`,
      );
    }
    if (adjustsAwardId !== null) {
      const adjusted = (
        await db.execute<Record<string, unknown>>(sql`
          select ${AWARD_COLUMNS} from hrm_benefit_awards
           where org_id = ${orgId} and id = ${adjustsAwardId}
        `)
      ).rows[0];
      if (!adjusted) {
        throw new BenefitsError(
          "NOT_FOUND",
          "adjusted award not found in this organization — link the award this correction adjusts",
        );
      }
      const target = toAward(adjusted);
      if (!["approved", "queued", "delivered"].includes(target.status)) {
        throw new BenefitsError("REFUSED", "only approved, queued or delivered obligations can receive an adjusting award — complete approval before recording a correction");
      }
      originalPolicy = adjusted.programSnapshot as Record<string, unknown>;
      originalSources = adjusted.sourceSnapshot as Record<string, unknown>;
      if (target.programId !== programId) {
        throw new BenefitsError(
          "REFUSED",
          "an adjusting award corrects an award of the same program — link an award issued from this program",
        );
      }
      if (
        target.employmentId !== employmentId ||
        target.currency !== currency ||
        target.periodFrom !== periodFrom ||
        (target.periodTo ?? null) !== periodTo
      ) {
        throw new BenefitsError(
          "REFUSED",
          "an adjusting award corrects the same employment, currency, and period — link the award this delta adjusts",
        );
      }
      if (sourceKey === null || !/^adjust:/i.test(sourceKey)) {
        throw new BenefitsError(
          "REFUSED",
          "adjusting awards carry an adjust: source key — the key names the correction, never a manual label",
        );
      }
    }
    const currencyDefinition = (await db.execute<{ minor_units: number }>(sql`
      select minor_units from currencies where code = ${currency}
    `)).rows[0];
    if (!currencyDefinition || !Number.isInteger(currencyDefinition.minor_units) || currencyDefinition.minor_units < 0 || currencyDefinition.minor_units > 4) {
      throw new BenefitsError("REFUSED", `currency ${currency} has no supported minor-unit definition — configure a valid currency before recording an award`);
    }
    const fraction = value.split(".")[1] ?? "";
    if (/[^0]/.test(fraction.slice(currencyDefinition.minor_units))) {
      throw new BenefitsError("REFUSED", `award value has more than ${currencyDefinition.minor_units} payable decimal places for ${currency} — enter an exact amount in the currency's minor units`);
    }
    if (currency !== program.currency) {
      throw new BenefitsError(
        "REFUSED",
        `award currency ${currency} differs from program ${program.code} currency ${program.currency} — payroll never converts currency; reissue in ${program.currency}`,
      );
    }
    if (origin === "manual" && program.family === "incentive") {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} is a measured incentive — manual awards cannot forge a settlement; record it through the settlement calculation`,
      );
    }
    if (periodFrom < program.effectiveFrom || (program.effectiveTo !== null && (periodTo ?? periodFrom) > program.effectiveTo)) {
      throw new BenefitsError(
        "REFUSED",
        `award period ${periodFrom}..${periodTo ?? periodFrom} falls outside program ${program.code} window ${program.effectiveFrom}..${program.effectiveTo ?? "open"} — issue inside the program window`,
      );
    }
    const service = (
      await db.execute<{ service_start: string | null }>(sql`
        select service_start::text as service_start from worker_employments
         where org_id = ${orgId} and id = ${employmentId}
      `)
    ).rows[0];
    if (!service) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit award not found in this organization — reload the award list and retry",
      );
    }
    if (adjustsAwardId === null && service.service_start !== null && String(service.service_start).slice(0, 10) > periodFrom) {
      throw new BenefitsError(
        "REFUSED",
        `employment service starts after the award period — issue awards inside the employment span`,
      );
    }
    const activeCoverage = (await db.execute<{ covered: boolean }>(sql`
      select coalesce(
        daterange(${periodFrom}::date, ${(periodTo ?? periodFrom)}::date + 1, '[)')
          <@ range_agg(daterange(effective_from, effective_to, '[)')),
        false
      ) as covered
      from worker_employment_versions
      where org_id = ${orgId} and employment_id = ${employmentId}
        and status = 'active' and recorded_until is null
    `)).rows[0]?.covered === true;
    if (adjustsAwardId === null && !activeCoverage) {
      throw new BenefitsError(
        "REFUSED",
        "current employment history has no active service covering the full award period — issue awards inside active service; end dates exclude their day",
      );
    }
    const sources = (
      await db.execute<{ account_id: string; weight_bps: number | null }>(sql`
        select account_id, weight_bps from hrm_benefit_program_sources
         where org_id = ${orgId} and program_id = ${programId}
         order by account_id
      `)
    ).rows;
    if (adjustsAwardId === null && program.valuation === "fixed" && program.fixedAmount !== null && value !== program.fixedAmount) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} pays a fixed ${program.fixedAmount} ${program.currency} — a fixed award carries the configured denomination, never an arbitrary value`,
      );
    }
    if (program.capAmount !== null) {
      const over =
        BigInt(normalizeMoney(value).replace(".", "")) > BigInt(program.capAmount.replace(".", ""));
      if (over) {
        throw new BenefitsError(
          "REFUSED",
          `award value ${value} ${currency} exceeds program ${program.code} per-award cap ${program.capAmount} ${program.currency} — lower the award, or close the program and create a replacement with a new code and a higher cap`,
        );
      }
    }
    if (program.budgetAmount !== null) {
      const spent = (
        await db.execute<{ total: string | null }>(sql`
          select sum(value)::text as total from hrm_benefit_awards
           where org_id = ${orgId} and program_id = ${programId}
             and status <> 'voided'
        `)
      ).rows[0]?.total ?? null;
      const spentUnits = spent === null ? 0n : BigInt(normalizeMoney(spent).replace(".", ""));
      if (spentUnits + BigInt(normalizeMoney(value).replace(".", "")) > BigInt(program.budgetAmount.replace(".", ""))) {
        throw new BenefitsError(
          "REFUSED",
          `program ${program.code} budget ${program.budgetAmount} ${program.currency} cannot cover this award — spent ${normalizeMoney(spent ?? "0")} with ${value} requested; void an award, or close the program and create a replacement with a new code and a higher budget`,
        );
      }
    }
    const programSnapshot = originalPolicy ? { ...originalPolicy, approvalMode: originalPolicy.approvalMode ?? program.approvalMode } : {
      id: program.id,
      code: program.code,
      name: program.name,
      family: program.family,
      currency: program.currency,
      approvalMode: program.approvalMode,
      deliveryMethod: program.deliveryMethod,
      valuation: program.valuation,
      metric: program.metric,
      metricScope: program.metricScope,
      scopes: [...program.scopeIds],
      allocation: program.allocation,
      percentRate: program.percentRate,
      fixedAmount: program.fixedAmount,
      capAmount: program.capAmount,
      budgetAmount: program.budgetAmount,
      thresholdAmount: program.thresholdAmount,
      frequency: program.frequency,
      periodBasis: program.periodBasis,
      paymentDelayDays: program.paymentDelayDays,
      legalEntityId: program.legalEntityId,
      effectiveFrom: program.effectiveFrom,
      effectiveTo: program.effectiveTo,
      revision: program.revision,
    };
    const sourceSnapshot = originalSources ?? {
      accounts: sources.map((row) => ({
        accountId: String(row.account_id),
        weightBps: row.weight_bps,
      })),
      payComponentId: program.payComponentId,
      measurement: {
        metric: program.metric,
        metricScope: program.metricScope,
        scopes: [...program.scopeIds],
        frequency: program.frequency,
        periodBasis: program.periodBasis,
        periodFrom,
        periodTo,
        ...(settlementMeasurement !== null ? { settlement: settlementMeasurement } : {}),
      },
    };
    let insertedRows: Record<string, unknown>[];
    try {
      insertedRows = (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_awards
            (org_id, program_id, employment_id, period_from, period_to,
             value, currency, program_snapshot, source_snapshot,
             evidence, source_key, adjusts_award_id, created_by, updated_by)
          values (${orgId}, ${programId}, ${employmentId},
                  ${periodFrom}::date, ${periodTo}::date,
                  ${value}, ${currency},
                  ${JSON.stringify(programSnapshot)}::jsonb,
                  ${JSON.stringify(sourceSnapshot)}::jsonb,
                  ${evidence === null ? null : JSON.stringify(evidence)}::jsonb,
                  ${sourceKey}, ${adjustsAwardId}, ${actorId}, ${actorId})
          returning ${AWARD_COLUMNS}
        `)
      ).rows;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BenefitsError(
          "REFUSED",
          "this award was already recorded — the source key is issued once; reload the award list instead of recording twice",
        );
      }
      throw error;
    }
    const inserted = requireOneRow(insertedRows, "recording the benefit award");
    const award = toAward(inserted);
    await appendAwardEvent(
      db,
      orgId,
      actorId,
      award.id,
      "created",
      origin === "settlement" ? "award recorded from the settlement calculation" : "award recorded directly",
    );
    await auditAwardWrite(db, orgId, actorId, award.id, "created", null, award, null);
    return award;
  });
}

/**
 * Record a directly entered award (rewards, allowances, custom). Incentives
 * settle from the preview calculation with measured evidence — direct manual
 * incentive values would bypass the measure. Served by POST
 * /api/hrm/benefit-awards.
 */
export async function createBenefitAward(query: CreateBenefitAwardQuery): Promise<BenefitAward> {
  return recordAward(query, "manual");
}

/**
 * Record a settled award from the settlement calculation: measured evidence
 * with per-award proof plus a reserved settle: or adjust: source key for
 * idempotency. Signed correcting awards link the adjusted award and carry an
 * adjust: key. Evidence stays per-award proof — company financial totals
 * belong in the confidential source snapshot, never in self-service-visible
 * evidence. Served by the settlement path, never the public manual route.
 */
export async function recordSettledAward(query: CreateBenefitAwardQuery): Promise<BenefitAward> {
  const evidence = query.evidence ?? null;
  const computation = evidence !== null ? (evidence as Record<string, unknown>).computation : undefined;
  if (evidence === null || typeof computation !== "object" || computation === null || Array.isArray(computation)) {
    throw new BenefitsError(
      "REFUSED",
      "settled awards carry the settlement computation in evidence — run the settlement preview instead of recording directly",
    );
  }
  return recordAward(query, "settlement");
}

/** Submit once under the pinned no-approval setting or native Flows policy. */
export async function submitBenefitAward(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly awardId: string;
}): Promise<BenefitAward> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const awardId = requireId(query.awardId, "awardId");
  return withOrgTransaction(orgId, () => withTransactionSavepoint(db, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    await lockFlowSubjectDecision(orgId, BENEFIT_AWARD_SUBJECT_KIND, awardId);
    const row = requireOneRow((await db.execute<Record<string, unknown>>(sql`
      select ${AWARD_COLUMNS} from hrm_benefit_awards where org_id = ${orgId} and id = ${awardId} for update
    `)).rows, "loading the reward for submission");
    const before = toAward(row);
    await requireAwardEntityScope(db, orgId, actorId, before.programId);
    // A replay adopts the existing submission; it cannot open fresh gates.
    if ((before.flowRunId !== null || before.decisionSnapshot?.mode === "not_required") && ["pending", "approved", "queued", "delivered", "rejected"].includes(before.status)) return before;
    if (before.status !== "draft") throw new BenefitsError("BAD_STATE", `reward is ${before.status} — only a draft can be submitted; create a new reward for a new decision`);
    requireOneRow((await db.execute(sql`update hrm_benefit_awards set submitted_by = ${actorId}, submitted_at = now(), updated_by = ${actorId}, updated_at = now() where org_id = ${orgId} and id = ${awardId} and status = 'draft' returning id`)).rows, "recording the reward submitter");
    const programPolicy = row.programSnapshot as Record<string, unknown>;
    if (programPolicy.approvalMode !== "none" && programPolicy.approvalMode !== "flows") {
      throw new BenefitsError("REFUSED", "This reward has no pinned approval setting. Void it and create a new reward from a program with an explicit approval setting.");
    }
    if (programPolicy.approvalMode === "none") {
      const decision = { outcome: "approved", mode: "not_required", approvalMode: "none", programId: before.programId, revision: programPolicy.revision };
      const after = toAward(requireOneRow((await db.execute<Record<string, unknown>>(sql`
        update hrm_benefit_awards set status = 'approved', approved_at = now(), approved_by = null,
          decision_snapshot = ${JSON.stringify(decision)}::jsonb, updated_by = ${actorId}, updated_at = now()
        where org_id = ${orgId} and id = ${awardId} and status = 'draft' returning ${AWARD_COLUMNS}
      `)).rows, "submitting the reward without required approvals"));
      await appendAwardEvent(db, orgId, actorId, awardId, "submitted", "No approvals required by the pinned program setting; ready for payroll. No human approval was recorded.");
      await auditAwardWrite(db, orgId, actorId, awardId, "submitted", before, after, "no approvals required by the pinned program setting");
      return after;
    }
    const { runRecordFlows } = await import("../../flows/run.ts");
    const result = await runRecordFlows({ kind: "on_submit", source: "api" }, BENEFIT_AWARD_SUBJECT_KIND, awardId, { orgId, userId: actorId });
    const gatedRun = result.runs.find(run => run.gatesCreated > 0);
    const directRun = result.runs.find(run => run.ungatedOutcome === "apply" && run.status === "completed" && run.gatesCreated === 0);
    const governingRun = gatedRun ?? directRun;
    if (result.failed) {
      const cause = result.runs.filter(run => run.status === "failed").map(run => `${run.flowName}: ${run.error ?? "execution failed"}`).join("; ") || result.error || "workflow dispatch failed";
      throw new BenefitsError("REFUSED", `Benefits workflow could not submit this reward: ${cause}. Open Flows, correct the policy or approver assignment, then submit again. No approval or payout was recorded.`);
    }
    if (!governingRun) throw new BenefitsError("REFUSED", "No Benefits approval policy matched this reward. Open Flows, choose Benefits reward or incentive award, and configure approval steps or explicitly select direct processing before submitting again.");
    const pending = requireOneRow((await db.execute<Record<string, unknown>>(sql`
      update hrm_benefit_awards set status = 'pending', flow_run_id = ${governingRun.runId}, updated_by = ${actorId}, updated_at = now()
      where org_id = ${orgId} and id = ${awardId} and status = 'draft' returning ${AWARD_COLUMNS}
    `)).rows, "submitting the reward");
    await appendAwardEvent(db, orgId, actorId, awardId, "submitted", gatedRun ? "submitted to the configured Benefits approval workflow" : "submitted under the explicit direct processing policy");
    let after = toAward(pending);
    if (!gatedRun && directRun) {
      const runs = await awardSubmissionRuns(orgId, awardId);
      const policy = runs.find(run => run.id === directRun.runId)?.context.submissionPolicy as { ungatedOutcome?: unknown } | undefined;
      if (policy?.ungatedOutcome !== "apply") throw new BenefitsError("REFUSED", "The direct processing policy has no pinned execution evidence. Review it in Flows and submit again.");
      const snapshot = { outcome: "approved", mode: "automatic", runId: directRun.runId, runs, gates: [] };
      after = toAward(requireOneRow((await db.execute<Record<string, unknown>>(sql`
        update hrm_benefit_awards set status = 'approved', approved_at = now(), approved_by = null,
          decision_snapshot = ${JSON.stringify(snapshot)}::jsonb, updated_by = ${actorId}, updated_at = now()
        where org_id = ${orgId} and id = ${awardId} and status = 'pending' returning ${AWARD_COLUMNS}
      `)).rows, "applying the direct processing policy"));
      await appendAwardEvent(db, orgId, actorId, awardId, "automatically_approved", "ready for payroll under the explicit direct processing policy; no human approval was recorded");
    }
    await auditAwardWrite(db, orgId, actorId, awardId, "submitted", before, after, gatedRun ? "workflow approval required" : "explicit direct processing");
    return after;
  }));
}

type SubmissionRun = { id: string; status: string; context: Record<string, unknown> };
async function awardSubmissionRuns(orgId: string, awardId: string): Promise<SubmissionRun[]> {
  return (await db.execute<SubmissionRun>(sql`select id, status, context from flow_runs where org_id = ${orgId} and subject_kind = ${BENEFIT_AWARD_SUBJECT_KIND} and subject_id = ${awardId} and trigger = 'on_submit' order by created_at, id`)).rows;
}

/** Native gate release runs inside decideGate's transactional savepoint. */
export async function releaseBenefitAwardApproval(query: {
  readonly orgId: string; readonly actorId: string; readonly awardId: string;
  readonly outcome: "approved" | "rejected"; readonly comment?: string | null;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const awardId = requireId(query.awardId, "awardId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    await lockFlowSubjectDecision(orgId, BENEFIT_AWARD_SUBJECT_KIND, awardId);
    const row = requireOneRow((await db.execute<Record<string, unknown>>(sql`select ${AWARD_COLUMNS} from hrm_benefit_awards where org_id = ${orgId} and id = ${awardId} for update`)).rows, "loading the reward decision");
    const before = toAward(row);
    await requireAwardEntityScope(db, orgId, actorId, before.programId);
    if (before.status !== "pending") return;
    if (!before.flowRunId || !before.submittedBy) throw new BenefitsError("REFUSED", "This reward has no workflow submission evidence. Preserve it and submit a new reward through the configured Benefits policy.");
    const gates = (await db.execute<{ id: string; status: string; decided_by: string | null; decided_at: string | null; comment: string | null; on_behalf_of_user_id: string | null }>(sql`
      select id, status, decided_by, decided_at::text, comment, on_behalf_of_user_id from flow_gates
      where org_id = ${orgId} and subject_kind = ${BENEFIT_AWARD_SUBJECT_KIND} and subject_id = ${awardId} order by created_at, id
    `)).rows;
    if (gates.some(gate => gate.status === "pending" || gate.status === "escalated")) throw new BenefitsError("REFUSED", "Approval stages remain open. Complete the reward's pending decisions in Approvals before adding it to payroll.");
    if (!gates.some(gate => gate.status === query.outcome && gate.decided_by === actorId)) throw new BenefitsError("REFUSED", "No matching workflow decision authorizes this reward. Decide its assigned gate in Approvals.");
    if (query.outcome === "approved" && gates.some(gate => gate.status === "rejected")) throw new BenefitsError("REFUSED", "The reward was rejected by its approval workflow. Create a new reward rather than releasing the rejected obligation.");
    const runs = await awardSubmissionRuns(orgId, awardId);
    if (!runs.some(run => run.id === before.flowRunId) || runs.some(run => run.status === "failed")) throw new BenefitsError("REFUSED", "The reward's workflow evidence is missing or failed. Review the execution in Flows before retrying the decision.");
    const snapshot = { outcome: query.outcome, mode: "human", runId: before.flowRunId, runs, gates };
    const after = toAward(requireOneRow((await db.execute<Record<string, unknown>>(sql`
      update hrm_benefit_awards set status = ${query.outcome}, approved_by = ${query.outcome === "approved" ? actorId : null},
        approved_at = ${query.outcome === "approved" ? sql`now()` : sql`null`}, decision_snapshot = ${JSON.stringify(snapshot)}::jsonb,
        updated_by = ${actorId}, updated_at = now()
      where org_id = ${orgId} and id = ${awardId} and status = 'pending' returning ${AWARD_COLUMNS}
    `)).rows, "recording the workflow decision"));
    await appendAwardEvent(db, orgId, actorId, awardId, query.outcome, query.comment?.trim() || `Benefits workflow ${query.outcome}`);
    await auditAwardWrite(db, orgId, actorId, awardId, query.outcome, before, after, query.comment?.trim() || null);
  });
}

/**
 * Approved → queued: finance links the pay-run adjustment carrying this
 * award and releases the payout. The adjustment is verified (same run,
 * employee, component, exact value, live run) at queue time so same-run
 * retries replay off the stored linkage; delivery additionally requires the
 * run committed. Payroll awards cannot queue without native linkage.
 */
export async function queueBenefitAward(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly awardId: string;
  readonly payRunDocumentId?: string | null;
  readonly payRunAdjustmentId?: string | null;
}): Promise<BenefitAward> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const awardId = requireId(query.awardId, "awardId");
  const payRunDocumentId =
    query.payRunDocumentId === undefined || query.payRunDocumentId === null
      ? null
      : requireId(query.payRunDocumentId, "payRunDocumentId");
  const payRunAdjustmentId =
    query.payRunAdjustmentId === undefined || query.payRunAdjustmentId === null
      ? null
      : requireId(query.payRunAdjustmentId, "payRunAdjustmentId");
  if ((payRunDocumentId === null) !== (payRunAdjustmentId === null)) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "payout linkage names both the pay run and its adjustment — link the adjustment carrying this award",
    );
  }
  return withOrgTransaction(orgId, async () => {
    await requirePayrollManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    await lockAwardRun(db, orgId, awardId, payRunDocumentId);
    const locked = (
      await db.execute<Record<string, unknown>>(sql`
        select ${AWARD_COLUMNS} from hrm_benefit_awards
         where org_id = ${orgId} and id = ${awardId}
         for update
      `)
    ).rows[0];
    if (!locked) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit award not found in this organization — reload the award list and retry",
      );
    }
    const before = toAward(locked);
    if (before.status !== "approved" && before.status !== "queued" && before.status !== "delivered") {
      throw new BenefitsError(
        "BAD_STATE",
        `award is ${before.status} — only approved awards queue; reload and retry`,
      );
    }
    if (before.status === "approved") {
      const policy = locked.programSnapshot as Record<string, unknown>;
      const decision = before.decisionSnapshot;
      const none = policy.approvalMode === "none" && decision?.mode === "not_required"
        && decision.approvalMode === "none" && decision.programId === before.programId && decision.revision === policy.revision
        && before.flowRunId === null && before.approvedBy === null && before.approvedAt !== null && before.submittedBy !== null && before.submittedAt !== null;
      const flows = policy.approvalMode === "flows" && before.flowRunId !== null
        && decision?.runId === before.flowRunId && before.approvedAt !== null && before.submittedBy !== null && before.submittedAt !== null
        && ((decision.mode === "human" && before.approvedBy !== null) || (decision.mode === "automatic" && before.approvedBy === null));
      if (decision?.outcome !== "approved" || (!none && !flows)) {
        throw new BenefitsError("REFUSED", "This reward has no complete pinned approval decision. Void the unissued reward and create a new reward before adding it to payroll.");
      }
      if (flows) {
        const proof = (await db.execute<{ complete: boolean; matching_actor: boolean }>(sql`
          select
            not exists (select 1 from flow_gates where org_id=${orgId} and subject_kind=${BENEFIT_AWARD_SUBJECT_KIND} and subject_id=${awardId} and status in ('pending','escalated','rejected'))
            and not exists (select 1 from flow_runs where org_id=${orgId} and subject_kind=${BENEFIT_AWARD_SUBJECT_KIND} and subject_id=${awardId} and status in ('running','waiting','failed')) as complete,
            exists (select 1 from flow_gates where org_id=${orgId} and subject_kind=${BENEFIT_AWARD_SUBJECT_KIND} and subject_id=${awardId} and status='approved' and decided_by=${before.approvedBy} and decided_at is not null) as matching_actor
        `)).rows[0];
        if (!proof?.complete || (decision?.mode === "human" && !proof.matching_actor)) {
          throw new BenefitsError("REFUSED", "This reward has no complete matching workflow decision. Review its native approval history before adding it to payroll; void an unissued reward with inconsistent evidence and create a new reward.");
        }
      }
    }
    const employment = (
      await db.execute<{ employer_subsidiary_id: string | null; worker_party_id: string }>(sql`
        select employer_subsidiary_id, worker_party_id from worker_employments
         where org_id = ${orgId} and id = ${before.employmentId}
      `)
    ).rows[0];
    if (!employment) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit award not found in this organization — reload the award list and retry",
      );
    }
    await requireAwardEntityScope(db, orgId, actorId, before.programId);
    const program = await getBenefitProgram(db, orgId, actorId, before.programId);
    if (normalizeMoney(before.value) === "0.0000") {
      throw new BenefitsError("REFUSED", before.adjustsAwardId === null
        ? "a zero-value reward cannot enter payroll — void this reward and create a reward with a positive value"
        : "a zero-value adjustment cannot enter payroll — void this adjustment and record a non-zero signed correction");
    }
    if (payRunDocumentId === null || payRunAdjustmentId === null) {
      throw new BenefitsError("REFUSED", "select an editable pay run to queue this payroll award — a queued award must have its native pay-run adjustment");
    }
    if ((before.status === "queued" || before.status === "delivered") && (before.payRunDocumentId !== payRunDocumentId || before.payRunAdjustmentId !== payRunAdjustmentId)) {
      throw new BenefitsError("REFUSED", "this award already queued with different payout linkage — use its recorded pay run and adjustment");
    }
    if (payRunDocumentId !== null && payRunAdjustmentId !== null) {
      if (program.payComponentId === null) {
        throw new BenefitsError(
          "REFUSED",
          `program ${program.code} names no pay component — link an earning component in program setup before queuing payout linkage`,
        );
      }
      await requireAwardAdjustment(
        db,
        orgId,
        program.code,
        before,
        String(employment.worker_party_id),
        program.payComponentId,
        payRunDocumentId,
        payRunAdjustmentId,
        before.status === "delivered",
      );
    }
    if (before.status === "queued" || before.status === "delivered") return before;
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_awards
             set status = 'queued',
                 pay_run_document_id = ${payRunDocumentId},
                 pay_run_adjustment_id = ${payRunAdjustmentId},
                 updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${awardId}
          returning ${AWARD_COLUMNS}
        `)
      ).rows,
      "queueing the benefit award",
    );
    const after = toAward(updated);
    await appendAwardEvent(
      db,
      orgId,
      actorId,
      awardId,
      "queued",
      payRunAdjustmentId === null
        ? "queued for payout by finance"
        : `queued for payout by finance on pay run ${payRunDocumentId} adjustment ${payRunAdjustmentId}`,
    );
    await auditAwardWrite(db, orgId, actorId, awardId, "queued", before, after, "queued for payout");
    return after;
  });
}

/**
 * Verify a pay-run adjustment carries this award exactly: same run document,
 * same employee party, same component, same amount, a line adjustment — and
 * the run is committed. A pending or calculated run proves nothing; delivery
 * is recorded only after finalize.
 */
async function requireAwardAdjustment(
  exec: SqlExecutor,
  orgId: string,
  programCode: string,
  award: BenefitAward,
  workerPartyId: string,
  payComponentId: string,
  payRunDocumentId: string,
  payRunAdjustmentId: string,
  committed: boolean,
): Promise<void> {
  const adjustment = (
    await exec.execute<{
      employee_party_id: string;
      component_id: string | null;
      amount: string | null;
      adjustment_type: string;
      note: string | null;
      replace_component: boolean;
    }>(sql`
      select employee_party_id, component_id, amount::text as amount, adjustment_type, note, replace_component
        from pay_run_adjustments
       where org_id = ${orgId} and id = ${payRunAdjustmentId}
         and pay_run_document_id = ${payRunDocumentId}
    `)
  ).rows[0];
  if (!adjustment) {
    throw new BenefitsError(
      "NOT_FOUND",
      "pay-run adjustment not found on this run in this organization — create the adjustment on the run before recording delivery",
    );
  }
  const note = `Benefit award ${award.id} (${programCode} ${award.periodFrom}..${award.periodTo ?? "open"})`;
  if (adjustment.replace_component || adjustment.note !== note) {
    throw new BenefitsError("REFUSED", "this adjustment is not the additive native line issued for this award — queue the award through its pay-run action");
  }
  if (adjustment.adjustment_type !== "line") {
    throw new BenefitsError(
      "REFUSED",
      "the linked pay-run adjustment is not a payable line — link the line adjustment carrying this award",
    );
  }
  if (String(adjustment.employee_party_id) !== workerPartyId) {
    throw new BenefitsError(
      "REFUSED",
      `the linked adjustment pays a different employee — link the adjustment for this award's employment`,
    );
  }
  if (adjustment.component_id === null || String(adjustment.component_id) !== payComponentId) {
    throw new BenefitsError(
      "REFUSED",
      `the linked adjustment prices a different pay component — link the adjustment on program ${programCode}'s earning component`,
    );
  }
  if (adjustment.amount === null || normalizeMoney(adjustment.amount) !== award.value) {
    throw new BenefitsError(
      "REFUSED",
      `the linked adjustment pays ${adjustment.amount ?? "nothing"} but the award is ${award.value} ${award.currency} — link the adjustment carrying this award's exact value`,
    );
  }
  // The native adjustment calculator closes manual lines at two decimals.
  // Refuse any finer value here rather than queueing an amount that payroll
  // would round away from the approved obligation.
  if (/[^0]/.test((award.value.split(".")[1] ?? "").slice(2))) {
    throw new BenefitsError("REFUSED", "the native payroll adjustment supports two decimal places — this approved award has finer precision; preserve it and resolve the payroll precision before queueing");
  }
  const run = (
    await exec.execute<{ run_status: string; document_status: string; subsidiary_id: string | null; currency: string; pay_date: string }>(sql`
      select r.run_status, d.status as document_status, d.subsidiary_id, d.currency, r.pay_date::text as pay_date
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${payRunDocumentId}
    `)
  ).rows[0];
  if (!run) {
    throw new BenefitsError("NOT_FOUND", "pay run not found in this organization — finalize the run before recording delivery");
  }
  const programPolicy = (await exec.execute<{ legal_entity_id: string; payable_date: string; delivery_method: string }>(sql`
    select legal_entity_id, delivery_method, (${award.periodTo ?? award.periodFrom}::date + payment_delay_days)::text as payable_date
      from hrm_benefit_programs where org_id = ${orgId} and id = ${award.programId}
  `)).rows[0];
  const programEntity = programPolicy?.legal_entity_id;
  if (!programPolicy || run.pay_date < programPolicy.payable_date) {
    throw new BenefitsError("REFUSED", `this run pays before the award is payable on ${programPolicy?.payable_date ?? "an unresolved date"} — select a run on or after the payable date`);
  }
  if (run.subsidiary_id !== programEntity || run.currency !== award.currency) {
    throw new BenefitsError("REFUSED", "the pay run has a different legal entity or currency than this award — select a run in the program's entity and award currency");
  }
  if (!committed && award.status !== "queued" && (run.document_status !== "draft" || run.run_status === "committed")) {
    throw new BenefitsError("BAD_STATE", "this pay run is not editable — select an editable draft run before queuing an award");
  }
  if (run.document_status === "voided") {
    throw new BenefitsError(
      "BAD_STATE",
      "pay run is voided — record an adjusting award on a live pay run",
    );
  }
  if (committed && run.run_status !== "committed") {
    throw new BenefitsError(
      "BAD_STATE",
      `pay run is ${run.run_status} — delivery records only after the run is committed; a pending run proves no payout`,
    );
  }
  const expectedPaymentKind = programPolicy.delivery_method === "external" ? "non_cash" : "cash";
  if (!committed) {
    const component = (await exec.execute<{ payment_kind: string; kind: string; is_active: boolean }>(sql`
      select payment_kind, kind, is_active from pay_components where org_id = ${orgId} and id = ${payComponentId}
    `)).rows[0];
    if (!component || component.kind !== "earning" || !component.is_active || component.payment_kind !== expectedPaymentKind) {
      throw new BenefitsError("REFUSED", `the program requires an active ${expectedPaymentKind === "non_cash" ? "non-cash" : "cash"} earning component — configure the matching payroll representation before queueing`);
    }
  }
  if (committed) {
    const consumed = (await exec.execute<{ id: string }>(sql`
      select l.id from pay_stubs s join pay_stub_lines l on l.org_id = s.org_id and l.stub_id = s.id
       where s.org_id = ${orgId} and s.pay_run_document_id = ${payRunDocumentId}
         and s.employee_party_id = ${workerPartyId} and s.employment_id = ${award.employmentId}
         and s.currency_code = ${award.currency} and l.component_id = ${payComponentId}
         and l.kind = 'earning' and l.amount = ${award.value}::numeric and l.description = ${note}
         and l.payment_kind = ${expectedPaymentKind}
         and (${expectedPaymentKind} = 'cash' or l.non_cash_account_id is not null)
       limit 1
    `)).rows[0];
    if (!consumed) {
      throw new BenefitsError("REFUSED", "the committed run has no matching payroll representation for this award — review the employee's inclusion and calculation; a committed run alone does not prove this benefit was processed");
    }
  }
}

async function requireCommittedAwardAdjustment(
  exec: SqlExecutor,
  orgId: string,
  programCode: string,
  award: BenefitAward,
  workerPartyId: string,
  payComponentId: string,
  payRunDocumentId: string,
  payRunAdjustmentId: string,
): Promise<void> {
  return requireAwardAdjustment(
    exec,
    orgId,
    programCode,
    award,
    workerPartyId,
    payComponentId,
    payRunDocumentId,
    payRunAdjustmentId,
    true,
  );
}

/**
 * Queued → delivered through a committed pay run. Delivery reuses the
 * pay-run adjustment seam — never a manual net-pay edit, never a fabricated
 * enrollment row. Queued means the adjustment exists on the run; delivered
 * means the run is committed with the award's exact employee, component,
 * and value on it.
 */
export async function recordPayrollDelivery(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly awardId: string;
  readonly payRunDocumentId: string;
  readonly payRunAdjustmentId: string;
}): Promise<BenefitAward> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const awardId = requireId(query.awardId, "awardId");
  const payRunDocumentId = requireId(query.payRunDocumentId, "payRunDocumentId");
  const payRunAdjustmentId = requireId(query.payRunAdjustmentId, "payRunAdjustmentId");
  return withOrgTransaction(orgId, async () => {
    await requirePayrollManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    await lockAwardRun(db, orgId, awardId, payRunDocumentId);
    const locked = (
      await db.execute<Record<string, unknown>>(sql`
        select ${AWARD_COLUMNS} from hrm_benefit_awards
         where org_id = ${orgId} and id = ${awardId}
         for update
      `)
    ).rows[0];
    if (!locked) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit award not found in this organization — reload the award list and retry",
      );
    }
    const before = toAward(locked);
    if (before.status !== "queued" && before.status !== "delivered") {
      throw new BenefitsError(
        "BAD_STATE",
        `award is ${before.status} — only queued awards record payroll delivery; reload and retry`,
      );
    }
    if (
      before.payRunDocumentId !== payRunDocumentId ||
      before.payRunAdjustmentId !== payRunAdjustmentId
    ) {
      throw new BenefitsError(
        "REFUSED",
        "delivery names a different pay run than the queued linkage — replay the queued adjustment instead of relinking",
      );
    }
    await requireAwardEntityScope(db, orgId, actorId, before.programId);
    const employment = (
      await db.execute<{ employer_subsidiary_id: string | null; worker_party_id: string }>(sql`
        select employer_subsidiary_id, worker_party_id from worker_employments
         where org_id = ${orgId} and id = ${before.employmentId}
      `)
    ).rows[0];
    if (!employment) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit award not found in this organization — reload the award list and retry",
      );
    }
    const program = await getBenefitProgram(db, orgId, actorId, before.programId);
    if (program.deliveryMethod !== "payroll") {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} delivers externally — record an external reference with its tax representation, not a payroll payout`,
      );
    }
    if (program.payComponentId === null) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} names no pay component — link an earning component in program setup; delivery uses pay-run adjustments, never manual net-pay edits`,
      );
    }
    await requireCommittedAwardAdjustment(
      db,
      orgId,
      program.code,
      before,
      String(employment.worker_party_id),
      program.payComponentId,
      payRunDocumentId,
      payRunAdjustmentId,
    );
    if (before.status === "delivered") return before;
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_awards
             set status = 'delivered',
                 pay_run_document_id = ${payRunDocumentId},
                 pay_run_adjustment_id = ${payRunAdjustmentId},
                 updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${awardId}
          returning ${AWARD_COLUMNS}
        `)
      ).rows,
      "recording payroll delivery",
    );
    const after = toAward(updated);
    await appendAwardEvent(
      db,
      orgId,
      actorId,
      awardId,
      "delivered",
      `processed in pay run ${payRunDocumentId} adjustment ${payRunAdjustmentId}; this is not bank-payment evidence`,
    );
    await auditAwardWrite(db, orgId, actorId, awardId, "delivered", before, after, "processed in payroll");
    return after;
  });
}

/**
 * Queued → delivered through an external provider. The reference is the
 * provider's own issuance record — this service never claims the provider
 * issued anything it did not. The exact committed non-cash payroll line is
 * required independently of this reference: it proves the configured tax
 * representation was processed without paying the benefit value as cash.
 */
export async function recordExternalDelivery(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly awardId: string;
  readonly externalRef: string;
}): Promise<BenefitAward> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const awardId = requireId(query.awardId, "awardId");
  const externalRef = typeof query.externalRef === "string" ? query.externalRef.trim() : "";
  if (externalRef.length === 0) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "external delivery records the provider's own reference — enter the reference the provider issued",
    );
  }
  return withOrgTransaction(orgId, async () => {
    await requirePayrollManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const linkage = (await db.execute<{ pay_run_document_id: string | null }>(sql`
      select pay_run_document_id from hrm_benefit_awards where org_id = ${orgId} and id = ${awardId}
    `)).rows[0];
    await lockAwardRun(db, orgId, awardId, linkage?.pay_run_document_id ?? null);
    const locked = (
      await db.execute<Record<string, unknown>>(sql`
        select ${AWARD_COLUMNS} from hrm_benefit_awards
         where org_id = ${orgId} and id = ${awardId}
         for update
      `)
    ).rows[0];
    if (!locked) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit award not found in this organization — reload the award list and retry",
      );
    }
    const before = toAward(locked);
    if (before.status === "delivered") {
      await requireAwardEntityScope(db, orgId, actorId, before.programId);
      if (before.externalRef === externalRef) return before;
      throw new BenefitsError("REFUSED", "this provider fulfillment already has a different reference — preserve its recorded evidence and issue an adjusting award for a correction");
    }
    if (before.status !== "queued") {
      throw new BenefitsError(
        "BAD_STATE",
        `award is ${before.status} — only queued awards record external delivery; reload and retry`,
      );
    }
    await requireAwardEntityScope(db, orgId, actorId, before.programId);
    const program = await getBenefitProgram(db, orgId, actorId, before.programId);
    if (program.deliveryMethod !== "external") {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} delivers through payroll — create a pay-run adjustment, not an external reference`,
      );
    }
    if (before.payRunDocumentId === null || before.payRunAdjustmentId === null || program.payComponentId === null) {
      throw new BenefitsError("REFUSED", "this provider benefit has no native non-cash payroll linkage — add it to an editable pay run, calculate and commit that run before recording provider fulfillment");
    }
    const employment = (await db.execute<{ worker_party_id: string }>(sql`
      select worker_party_id from worker_employments where org_id = ${orgId} and id = ${before.employmentId}
    `)).rows[0];
    if (!employment) throw new BenefitsError("NOT_FOUND", "the benefit employment is unavailable — reload the award and resolve its employment before recording fulfillment");
    await requireCommittedAwardAdjustment(db, orgId, program.code, before, employment.worker_party_id,
      program.payComponentId, before.payRunDocumentId, before.payRunAdjustmentId);
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_awards
             set status = 'delivered', external_ref = ${externalRef},
                 updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${awardId}
          returning ${AWARD_COLUMNS}
        `)
      ).rows,
      "recording external delivery",
    );
    const after = toAward(updated);
    await appendAwardEvent(
      db,
      orgId,
      actorId,
      awardId,
      "external_delivered",
      `provider reference ${externalRef} recorded as issued by the provider`,
    );
    await auditAwardWrite(db, orgId, actorId, awardId, "external_delivered", before, after, externalRef);
    return after;
  });
}

/** Open awards void with a reason; delivered history stays delivered. */
export async function voidBenefitAward(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly awardId: string;
  readonly reason: string;
}): Promise<BenefitAward> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const awardId = requireId(query.awardId, "awardId");
  const reason = typeof query.reason === "string" ? query.reason.trim() : "";
  if (reason.length === 0) {
    throw new BenefitsError("INVALID_INPUT", "voiding an award needs a reason — it is the row's evidence");
  }
  return withOrgTransaction(orgId, () => withTransactionSavepoint(db, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    await lockFlowSubjectDecision(orgId, BENEFIT_AWARD_SUBJECT_KIND, awardId);
    await lockAwardRun(db, orgId, awardId);
    const locked = (
      await db.execute<Record<string, unknown>>(sql`
        select ${AWARD_COLUMNS} from hrm_benefit_awards
         where org_id = ${orgId} and id = ${awardId}
         for update
      `)
    ).rows[0];
    if (!locked) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit award not found in this organization — reload the award list and retry",
      );
    }
    const before = toAward(locked);
    if (before.status === "delivered") {
      throw new BenefitsError("BAD_STATE", "award is delivered history — issue an adjusting award instead of voiding it");
    }
    if (before.status === "rejected") {
      throw new BenefitsError("BAD_STATE", "The reward was rejected by its workflow — preserve the decision and create a new reward for a new request.");
    }
    if (before.status === "voided") {
      throw new BenefitsError("BAD_STATE", "award is voided history — issue a new award with a new source reference instead of changing it");
    }
    await requireAwardEntityScope(db, orgId, actorId, before.programId);
    const linkedAdjustment = before.status === "queued" ? before.payRunAdjustmentId : null;
    const linkedRun = before.status === "queued" ? before.payRunDocumentId : null;
    if (linkedAdjustment !== null) {
      await requirePayrollManage(db, orgId, actorId);
      const run = (await db.execute<{ run_status: string; document_status: string }>(sql`
        select r.run_status, d.status as document_status from pay_runs r
          join documents d on d.org_id = r.org_id and d.id = r.document_id
         where r.org_id = ${orgId} and r.document_id = ${linkedRun}
      `)).rows[0];
      if (!run || run.run_status === "committed" || run.document_status !== "draft") {
        throw new BenefitsError("REFUSED", "this award belongs to a finalized pay run — preserve its payroll history and record an adjusting award instead of voiding");
      }
    }
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_awards
             set status = 'voided', void_reason = ${reason},
                 pay_run_document_id = null, pay_run_adjustment_id = null,
                 updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${awardId}
          returning ${AWARD_COLUMNS}
        `)
      ).rows,
      "voiding the benefit award",
    );
    if (linkedAdjustment !== null && linkedRun !== null) {
      try {
        await mutatePayRunAdjustment({
          orgId, documentId: linkedRun, actorId,
          allowedSubsidiaryIds: await actorAllowedSubsidiaryIds(db, orgId, actorId),
          mutation: { action: "delete", adjustmentId: linkedAdjustment },
        });
      } catch (error) {
        if (error instanceof PayrollError) throw new BenefitsError("REFUSED", error.message);
        throw error;
      }
    }
    const after = toAward(updated);
    if (before.status === "pending" && before.flowRunId !== null) {
      const { cancelDispatchRuns } = await import("../../flows/dispatch-result.ts");
      await cancelDispatchRuns(orgId, (await awardSubmissionRuns(orgId, awardId)).map(run => run.id), { actorId });
    }
    await appendAwardEvent(db, orgId, actorId, awardId, "voided", reason);
    await auditAwardWrite(db, orgId, actorId, awardId, "voided", before, after, reason);
    return after;
  }));
}

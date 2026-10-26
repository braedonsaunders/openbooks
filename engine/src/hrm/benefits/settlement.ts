import { readAwardDeliveryPolicy } from "./award-delivery-policy.ts";
import {
  measureTransactionSettlement,
  type TransactionSettlementSnapshot,
} from "./transaction-settlement.ts";
import {
  measureProjectMarginSettlement,
  type ProjectMarginSnapshot,
} from "./project-margin-settlement.ts";
import { createHash } from "node:crypto";
import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { fromUnits, normalizeMoney, toUnits } from "../../money/money.ts";
import { businessTodayInTx } from "../../platform/business-date.ts";
import { awardPayrollProcessedSql } from "./payroll-delivery-evidence.ts";
import { sql } from "drizzle-orm";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { lockActorCommandAuthority } from "../../organization/actor-command-authority.ts";
import { ScopeNotFoundError } from "../../organization/subsidiary-scope.ts";
import { PayrollError } from "../../payroll/error.ts";
import {
  mutatePayRunAdjustment,
  PayRunAdjustmentIdempotencyConflict,
} from "../../payroll/run-adjustments.ts";
import { addCalendarDays, isIsoCalendarDate } from "../../platform/civil-date.ts";
import { getS3Blob, refuseMaskedStorageKind } from "../../platform/file-storage.ts";
import { requireNativeFileReadAuthority } from "../../records/file-read-authority.ts";
import { pinnedTransactionExecutor } from "../../platform/db.ts";
import type { BenefitAward, BenefitProgram, BenefitProgramMember } from "./program-types.ts";
import {
  buildBenefitAwardProgramSnapshot,
  getBenefitAward,
  queueBenefitAward,
  recordPayrollDelivery,
  recordSettledAward,
  recordSourceBoundAdjustingAward,
  recordSourceEvidencedFirstAward,
} from "./awards.ts";
import { mintSourceEvidenceAdmission } from "./source-evidence-capability.ts";
import {
  parseRetainedSourceArtifact,
  combineRetainedSourceClaims,
  sourceEvidenceNativePreviewDigest,
  type RetainedSourceArtifactSelection,
  type VerifiedRetainedSourceArtifact,
} from "./retained-source.ts";
export {
  canonicalRetainedJson,
  parseRetainedSourceRow,
  parseRetainedSourceArtifact,
  combineRetainedSourceClaims,
  resolveRetainedJsonPointer,
  sourceEvidenceNativePreviewDigest,
} from "./retained-source.ts";
export type {
  RetainedSourceArtifactSelection,
  VerifiedRetainedSourceArtifact,
} from "./retained-source.ts";
import { requireAggregateBenefitsManage, requireAggregateBenefitsRead } from "../authorization.ts";
import { BenefitsError } from "./errors.ts";
import { isUuid } from "../../platform/uuid.ts";
import {
  computeIncentiveAwards,
  eligibleMembers,
  partitionMembers,
  type IncentiveComputation,
  type IncentiveMeasured,
  type IncentiveMemberShare,
  type IncentivePeriodBasis,
} from "./incentive-math.ts";
import {
  measureApprovedHours,
  measureMoneySource,
  resolvePeriodBasis,
  type HoursSourceSnapshot,
  type MoneySourceSnapshot,
} from "./incentives.ts";
import { listProgramMemberships, programPolicyInForce } from "./programs.ts";
import type { BenefitTransactionPolicy } from "./transaction-policy.ts";
import {
  assertHrmEnabled,
  db,
  requireActorId,
  requireCivilDate,
  requireId,
  requireOneRow,
  requireOrgId,
  withOrgTransaction,
} from "./shared.ts";

/**
 * Incentive settlement: preview, settle, adjust, and deliver.
 *
 * Preview measures the same sources settlement measures and values awards
 * with the same pure function, so a preview that shows X settles X when
 * the sources have not moved — and when they have moved, the frozen
 * snapshot tells the operator exactly what changed. Previews are never
 * obligations: settled award rows follow the explicitly configured native
 * approval policy, then finance adds the approved value to payroll. Payroll
 * processing and provider fulfillment each retain their own evidence.
 *
 * Concurrency: settlement holds the program row FOR UPDATE and a
 * transaction-scoped advisory lock over (program, period) — two settlers
 * serialize, and a revision bump between preview and settle is caught by
 * the overlap check (existing awards carry the old revision). Corrections
 * to settled history are new adjusting awards, never rewrites.
 *
 * Every valued benefit uses the native pay-run adjustment seam. Payroll
 * programs use cash earnings; provider programs use non-cash earnings whose
 * configured statutory bases remain intact without adding a cash payment.
 */

export interface PreviewIncentiveSettlementQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  /** Project-margin programs: measure revenue recorded on or before this date (default: the business date). */
  readonly asOf?: string;
}

export type SettleIncentivePeriodQuery = PreviewIncentiveSettlementQuery;

export interface IncentivePreview {
  readonly programId: string;
  readonly programCode: string;
  readonly programName: string;
  readonly programStatus: string;
  readonly programRevision: number;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly periodBasis: IncentivePeriodBasis;
  readonly fiscalCalendarId: string | null;
  readonly payableAfter: string;
  readonly currency: string;
  readonly minorUnits: number;
  readonly measured:
    | MoneySourceSnapshot
    | HoursSourceSnapshot
    | TransactionSettlementSnapshot
    | ProjectMarginSnapshot;
  readonly computation: IncentiveComputation;
  /** Recipient rows the actor may see (subsidiary scope fences the rest). */
  readonly visibleRecipients: ReadonlyArray<IncentiveComputation["recipients"][number]>;
  /** Named exclusions (partial members, zero-hours members). */
  readonly excluded: readonly string[];
  /**
   * True when the period has not ended: the numbers are an estimate from
   * sources so far, never a settlement basis. Settle refuses these spans.
   */
  readonly isEstimate: boolean;
  readonly sourceKeyPrefix: string;
  /**
   * Full frozen measure for the award service's source_snapshot (manager
   * eyes only — never employee-visible, never DSAR). The settlement passes
   * this object to the award create call the moment it accepts it.
   */
  readonly sourceSnapshot: Record<string, unknown>;
}

export interface SettledPeriod {
  readonly awards: readonly BenefitAward[];
  readonly preview: IncentivePreview;
}

export interface IncentivePeriodReconciliation {
  readonly preview: IncentivePreview | null;
  /** Exact native source measure when a loss correctly has no payable computation. */
  readonly nativeMeasureOnly: {
    readonly programRevision: number;
    readonly periodFrom: string;
    readonly periodTo: string;
    readonly periodBasis: IncentivePeriodBasis;
    readonly fiscalCalendarId: string | null;
    readonly payableAfter: string;
    readonly currency: string;
    readonly minorUnits: number;
    readonly measured: IncentivePreview["measured"];
    readonly summaryLines: readonly string[];
    readonly isEstimate: boolean;
    /** Manager-facing frozen native facts, parallel to preview.sourceSnapshot. */
    readonly sourceSnapshot: Record<string, unknown>;
  } | null;
  /** Awards processed on committed, non-voided payroll runs for this exact program period. */
  readonly processedPayrollTotal: string;
  /** Positive means payroll history exceeds today's native measurement. */
  readonly payrollMinusCurrentMeasurement: string;
  /** Original native-measured settlement awards for this exact period; linked corrections do not rewrite this measure history. */
  readonly nativeMeasuredHistoryTotal: string;
  /** Original source-evidenced first obligations for this exact period; linked corrections remain separate award rows. */
  readonly sourceEvidencedFirstTotal: string;
  /** Native and source-evidenced obligation history combined, less today's native measurement. */
  readonly obligationHistoryMinusCurrentMeasurement: string;
}

export type { VerifiedRetainedSourceArtifact as VerifiedSourceArtifact } from "./retained-source.ts";

export interface SourceEvidenceMappingAttestation {
  readonly employmentId: string;
  readonly basis: string;
  readonly reason: string;
  readonly confirmed: true;
}

export interface GoverningDecisionAttestation {
  readonly basis: string;
  readonly reason: string;
  readonly confirmed: true;
}

interface RecordSourceEvidencedFirstIncentiveBase extends PreviewIncentiveSettlementQuery {
  readonly asOf: string;
  readonly expectedProgramRevision: number;
  readonly requestKey: string;
  readonly employmentId: string;
  readonly value: string;
  readonly currency: string;
  readonly sourceIssueDate: string;
  readonly sourceRowRef: string;
  readonly sourceArtifacts: readonly RetainedSourceArtifactSelection[];
  /** Explicit review of a single-currency native payroll context, never a document currency claim. */
  readonly nativeCurrencyBasis?: { readonly confirmed: true; readonly reason: string };
  /** Digest of the exact locked preview the operator confirmed. */
  readonly expectedNativePreviewDigest: string;
  readonly mappingAttestation: SourceEvidenceMappingAttestation;
  readonly reason: string;
}

export type RecordSourceEvidencedFirstIncentiveQuery =
  | (RecordSourceEvidencedFirstIncentiveBase & {
      readonly sourceEvidenceClass: "missing-source-identity";
      readonly sourcePaidDate?: never;
      readonly governingDecisionAttestation?: never;
    })
  | (RecordSourceEvidencedFirstIncentiveBase & {
      readonly sourceEvidenceClass: "source-paid-above-native-measure";
      /** Exact paid date claimed by the retained source row; source evidence only, never a native payment claim. */
      readonly sourcePaidDate: string;
      readonly governingDecisionAttestation: GoverningDecisionAttestation;
    });

/** Deterministic UUID from award + run: one award queues once per run. */
function adjustmentKey(awardId: string, runDocumentId: string): string {
  const hash = createHash("sha1")
    .update("benefit.award.adj.", "utf8")
    .update(awardId, "utf8")
    .update(":", "utf8")
    .update(runDocumentId, "utf8")
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function settleKeyPrefix(
  programId: string,
  periodFrom: string,
  periodTo: string,
  revision: number,
): string {
  return `settle:${programId}:${periodFrom}:${periodTo}:r${revision}`;
}

async function requireFinanceManage(orgId: string, actorId: string): Promise<void> {
  if (!(await actorHasPermission(db, orgId, actorId, "payroll.manage"))) {
    throw new BenefitsError(
      "REFUSED",
      "releasing an award payout needs the payroll.manage permission — HR authors the award, finance releases the payout; ask a payroll manager",
    );
  }
}

async function currencyMinorUnits(orgId: string, currency: string): Promise<number> {
  const row = (
    await db.execute<{ minor_units: number }>(
      sql`
    select minor_units from currencies where code = ${currency}
  `,
      "objects",
    )
  )[0];
  if (!row) {
    throw new BenefitsError(
      "REFUSED",
      `currency ${currency} has no minor-unit definition — settle in a known ISO currency; payable precision is never guessed`,
    );
  }
  if (!Number.isInteger(row.minor_units) || row.minor_units < 0 || row.minor_units > 4) {
    throw new BenefitsError(
      "REFUSED",
      `currency ${currency} declares ${row.minor_units} minor units — the ledger holds at most 4; correct the currency definition before settling`,
    );
  }
  return row.minor_units;
}

interface SettlementContext {
  program: BenefitProgram;
  /** The exact account source set used to measure this period. */
  sources: ReadonlyArray<{ accountId: string; weightBps: number | null }>;
  /** Null means the period is governed by current program rules. */
  policyRevisionId: string | null;
  /** Transaction rules from a governing revision; undefined reads the current rules. */
  transactionPolicy: BenefitTransactionPolicy | null | undefined;
  scope: Set<string> | null;
  basis: IncentivePeriodBasis;
  fiscalCalendarId: string | null;
  departmentIds: string[];
  projectIds: string[];
  revenueAccountIds: string[];
  expenseAccountIds: string[];
  incentiveExpenseAccountId: string | null;
  minorUnits: number;
  members: BenefitProgramMember[];
  projectCompletion: ReadonlyArray<{
    readonly projectId: string;
    readonly status: string;
    readonly updatedAt: string;
  }>;
}

async function loadSettlementContext(
  orgId: string,
  actorId: string,
  programId: string,
  scope: Set<string> | null,
  forSettle: boolean,
  periodFrom: string,
  periodTo: string,
): Promise<SettlementContext> {
  // The rules in force for this period: a period starting before an
  // active-program revision measures under the rules that revision replaced.
  const inForce = await programPolicyInForce(
    db,
    orgId,
    actorId,
    programId,
    requireCivilDate(periodFrom, "periodFrom"),
    requireCivilDate(periodTo, "periodTo"),
  );
  const program = inForce.program;
  if (forSettle && program.status !== "active") {
    throw new BenefitsError(
      "BAD_STATE",
      `program ${program.code} is ${program.status} — awards settle only from active programs; activate it before settling`,
    );
  }
  if (program.family !== "incentive" && program.family !== "custom") {
    throw new BenefitsError(
      "REFUSED",
      `program ${program.code} is a ${program.family} program — only incentive and custom programs settle through measurement; fixed rewards record awards directly`,
    );
  }
  if (program.metric === null) {
    throw new BenefitsError(
      "REFUSED",
      `program ${program.code} names no metric — fixed-amount awards are recorded directly, not settled through measurement; configure revenue, gross_profit, net_profit, approved_hours, or transactions to settle`,
    );
  }
  if (program.legalEntityId === null) {
    throw new BenefitsError(
      "REFUSED",
      `program ${program.code} names no legal entity — set the owning entity before measuring; measures never span entities`,
    );
  }
  if (program.metricScope === null) {
    throw new BenefitsError(
      "REFUSED",
      `program ${program.code} names no measure scope — select company, department, or project before measuring`,
    );
  }
  const metric = program.metric;

  // Typed scope rows: company carries none; anything else must carry rows,
  // and every row must name an entity of the scope's kind.
  const departmentIds: string[] = [];
  const projectIds: string[] = [];
  for (const id of program.scopeIds) {
    if (program.metricScope === "department") departmentIds.push(id);
    else if (program.metricScope === "project") projectIds.push(id);
  }
  if (program.metricScope === "project" && program.scopeCustomerIds.length > 0) {
    // A customer scope measures every project of that customer in the
    // program's entity as of this measurement; the expanded list is part of
    // the measured evidence.
    const customerProjects = (
      await db.execute<{ id: string }>(
        sql`
      select id::text as id from projects
       where org_id = ${orgId}
         and customer_id = any (${`{${program.scopeCustomerIds.join(",")}}`}::uuid[])
         and (subsidiary_id is null or subsidiary_id = ${program.legalEntityId}::uuid)
       order by id
    `,
        "objects",
      )
    ).map((r) => r.id);
    for (const id of customerProjects) if (!projectIds.includes(id)) projectIds.push(id);
    if (projectIds.length === 0) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} measures the projects of its customers, but they have no projects in the program's legal entity — add projects or reselect the customers`,
      );
    }
  }
  if (
    program.metricScope !== "company" &&
    program.scopeIds.length === 0 &&
    program.scopeCustomerIds.length === 0
  ) {
    throw new BenefitsError(
      "REFUSED",
      `program ${program.code} measures ${program.metricScope} scope with no scoped rows — name the ${program.metricScope === "department" ? "departments" : "projects"} before measuring; the base is never the whole company by fallback`,
    );
  }
  if (program.metricScope === "department") {
    const rows = await db.execute<{ id: string }>(
      sql`
      select id::text as id from departments
       where org_id = ${orgId} and id = any (${`{${departmentIds.join(",")}}`}::uuid[])
    `,
      "objects",
    );
    const found = new Set(rows.map((r) => r.id));
    const missing = departmentIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} scopes ${missing.length} department(s) outside this organization — reselect the scope; measures never cross tenants`,
      );
    }
  }

  const projectCompletion: Array<{ projectId: string; status: string; updatedAt: string }> = [];
  if (program.frequency === "project_complete") {
    if (program.metricScope !== "project" || projectIds.length === 0) {
      throw new BenefitsError(
        "REFUSED",
        "project-completion programs name their project scope — select the projects before previewing or settling",
      );
    }
    if (!(await lockAndCheckOrgFeature(db, orgId, "projects"))) {
      throw new BenefitsError(
        "REFUSED",
        "Projects is off — turn it on in Company Settings → Features before measuring project completion",
      );
    }
    // Keep completion facts fixed through settlement. Project record edits
    // take these same row locks, so reopening cannot race an obligation.
    const projects = await db.execute<{ id: string; status: string; updated_at: string }>(
      sql`
      select id::text as id, status, updated_at::text as updated_at from projects
       where org_id = ${orgId} and subsidiary_id = ${program.legalEntityId}
         and id = any (${`{${projectIds.join(",")}}`}::uuid[])
       order by id for share
    `,
      "objects",
    );
    if (projects.length !== new Set(projectIds).size) {
      throw new BenefitsError(
        "NOT_FOUND",
        "a completion project is not visible in the program's legal entity — review the selected project scope before settling",
      );
    }
    projectCompletion.push(
      ...projects.map((p) => ({ projectId: p.id, status: p.status, updatedAt: p.updated_at })),
    );
    const incomplete = projects.filter((p) => p.status !== "closed");
    if (forSettle && incomplete.length > 0) {
      throw new BenefitsError(
        "REFUSED",
        `${incomplete.length} selected project(s) are not closed — close each selected project in its project record before settling a completion award; substantial completion and cancellation do not authorize payment`,
      );
    }
  }

  // Source accounts split by actual GL type: income measures revenue,
  // costs measure expense. A weight other than full (null or 10000 bps)
  // refuses — the base sums whole accounts and an applied weight would
  // silently scale the base.
  if (program.metricScope === "project" && !(await lockAndCheckOrgFeature(db, orgId, "projects"))) {
    throw new BenefitsError(
      "REFUSED",
      "project measurement sources are unavailable while Projects is off — enable Projects under Company Settings → Features to use this program",
    );
  }
  const sources = inForce.sources;
  if (
    (metric === "revenue" || metric === "gross_profit" || metric === "net_profit") &&
    sources.length === 0
  ) {
    throw new BenefitsError(
      "REFUSED",
      `program ${program.code} measures ${metric} with no source accounts — select the explicit income and cost accounts the base sums`,
    );
  }
  for (const source of sources) {
    if (source.weightBps !== null && source.weightBps !== 10000) {
      throw new BenefitsError(
        "REFUSED",
        `source account ${source.accountId} carries weight ${source.weightBps} bps — partial account weights have no meaning in an additive base; clear the weight to count the whole account`,
      );
    }
  }
  const accountIds = sources.map((s) => s.accountId);
  const accountRows =
    accountIds.length > 0
      ? await db.execute<{ id: string; type: string }>(
          sql`
    select id::text as id, type from accounts
     where org_id = ${orgId} and id = any (${`{${accountIds.join(",")}}`}::uuid[])
  `,
          "objects",
        )
      : [];
  const typeById = new Map(accountRows.map((r) => [r.id, r.type]));
  const revenueAccountIds: string[] = [];
  const expenseAccountIds: string[] = [];
  for (const id of accountIds) {
    const type = typeById.get(id);
    if (type === undefined) {
      throw new BenefitsError(
        "REFUSED",
        `source account ${id} is outside this organization — reselect the sources; measures never cross tenants`,
      );
    }
    if (type === "income" || type === "income_other") revenueAccountIds.push(id);
    else if (
      type === "cogs" ||
      type === "expense" ||
      type === "expense_other" ||
      type === "expense_deferred"
    ) {
      expenseAccountIds.push(id);
    } else {
      throw new BenefitsError(
        "REFUSED",
        `source account ${id} is type ${type} — only income and cost accounts enter a base; remove it or reclassify the account`,
      );
    }
  }

  // The component's expense account must stay out of the base (circularity
  // is refused at measure time); a missing component is refused at settle.
  let incentiveExpenseAccountId: string | null = null;
  if (program.payComponentId !== null) {
    const component = (
      await db.execute<{ expense_account_id: string | null }>(
        sql`
      select expense_account_id from pay_components where org_id = ${orgId} and id = ${program.payComponentId}
    `,
        "objects",
      )
    )[0];
    if (!component) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} links pay component ${program.payComponentId}, which is outside this organization — relink the component before settling`,
      );
    }
    incentiveExpenseAccountId =
      component.expense_account_id !== null ? String(component.expense_account_id) : null;
  } else if (forSettle && program.deliveryMethod === "payroll") {
    throw new BenefitsError(
      "REFUSED",
      `program ${program.code} delivers through payroll but links no pay component — link the earning component before settling; payroll never prices an award without one`,
    );
  }

  // Named basis: calendar is explicit; fiscal resolves the org calendar.
  let basis: IncentivePeriodBasis;
  let fiscalCalendarId: string | null = null;
  if (program.periodBasis === "fiscal") {
    const resolved = await resolvePeriodBasis(db, orgId);
    basis = resolved.basis;
    fiscalCalendarId = resolved.calendarId;
  } else if (program.periodBasis === "calendar") {
    basis = { kind: "calendar" };
  } else {
    basis = { kind: "calendar" };
  }

  const memberships = await listProgramMemberships({ orgId, actorId, programId });
  const named = memberships.filter((m) => !m.excluded);
  const members =
    program.eligibility === "all_employees"
      ? [
          ...named,
          ...(await employerWideMembers(orgId, program, memberships, periodFrom, periodTo)),
        ]
      : named;
  const minorUnits = await currencyMinorUnits(orgId, program.currency);
  return {
    program,
    sources,
    policyRevisionId: inForce.revisionId,
    transactionPolicy: inForce.transactionPolicy,
    scope,
    basis,
    fiscalCalendarId,
    departmentIds,
    projectIds,
    revenueAccountIds,
    expenseAccountIds,
    incentiveExpenseAccountId,
    minorUnits,
    members,
    projectCompletion,
  };
}

/**
 * Employer-wide eligibility: every employment of the program's employer in
 * active service during the period (and, for payroll delivery, on payroll)
 * is a member for the whole period, with
 * equal weight. Named memberships still carry roles and weights and take
 * precedence for their employments; an excluded membership touching the
 * period removes its employment.
 */
async function employerWideMembers(
  orgId: string,
  program: BenefitProgram,
  named: readonly BenefitProgramMember[],
  periodFrom: string,
  periodTo: string,
): Promise<BenefitProgramMember[]> {
  // Named inclusions and exclusions touching the period both take the
  // employment out of the employer-wide set.
  const namedIds = new Set(
    named
      .filter(
        (m) =>
          m.effectiveFrom <= periodTo && (m.effectiveTo === null || m.effectiveTo >= periodFrom),
      )
      .map((m) => m.employmentId),
  );
  const rows = await db.execute<{ id: string }>(
    sql`
    select w.id::text as id from worker_employments w
     where w.org_id = ${orgId} and w.employer_subsidiary_id = ${program.legalEntityId}
       -- A payroll-delivered program covers only employees payroll pays.
       and (${program.deliveryMethod !== "payroll"} or exists (
             select 1 from employee_payroll_profiles prof
              where prof.org_id = w.org_id and prof.employee_party_id = w.worker_party_id and prof.is_active
                and (prof.employment_id is null or prof.employment_id = w.id)))
       and exists (select 1 from worker_employment_versions v
                    where v.org_id = w.org_id and v.employment_id = w.id
                      and v.status = 'active' and v.recorded_until is null
                      and v.effective_from <= ${periodTo}::date
                      and (v.effective_to is null or v.effective_to > ${periodFrom}::date))
     order by w.id
  `,
    "objects",
  );
  return rows
    .filter((r) => !namedIds.has(r.id))
    .map((r) => ({
      id: `employer:${r.id}`,
      programId: program.id,
      employmentId: r.id,
      effectiveFrom: periodFrom,
      effectiveTo: periodTo,
      weight: "1",
      role: null,
      excluded: false,
    }));
}

interface MeasuredIncentiveSources {
  measured: IncentiveMeasured;
  excluded: string[];
  moneySnapshot: MoneySourceSnapshot | null;
  hoursSnapshot: HoursSourceSnapshot | null;
  transactionSnapshot?: TransactionSettlementSnapshot;
  projectMarginSnapshot?: ProjectMarginSnapshot;
}

interface ComputedIncentiveSources extends MeasuredIncentiveSources {
  computation: IncentiveComputation;
}

interface NonpayableLossIncentiveSources extends MeasuredIncentiveSources {
  computation: null;
  nonpayableReason: string;
}

function measureAndCompute(
  orgId: string,
  actorId: string,
  ctx: SettlementContext,
  periodFrom: string,
  periodTo: string,
  asOf?: string,
): Promise<ComputedIncentiveSources>;
function measureAndCompute(
  orgId: string,
  actorId: string,
  ctx: SettlementContext,
  periodFrom: string,
  periodTo: string,
  asOf: string | undefined,
  options: { readonly allowNativeLossWithoutAward: true },
): Promise<ComputedIncentiveSources | NonpayableLossIncentiveSources>;
async function measureAndCompute(
  orgId: string,
  actorId: string,
  ctx: SettlementContext,
  periodFrom: string,
  periodTo: string,
  asOf?: string,
  options?: { readonly allowNativeLossWithoutAward: true },
): Promise<ComputedIncentiveSources | NonpayableLossIncentiveSources> {
  const { program } = ctx;
  const metric = program.metric!;
  if (metric === "transactions") {
    const result = await measureTransactionSettlement({
      orgId,
      actorId,
      program,
      policy: ctx.transactionPolicy,
      members: ctx.members,
      minorUnits: ctx.minorUnits,
      basis: ctx.basis,
      periodFrom,
      periodTo,
    });
    return { ...result, moneySnapshot: null, hoursSnapshot: null };
  }
  if (metric === "project_margin") {
    const result = await measureProjectMarginSettlement({
      orgId,
      program,
      members: ctx.members,
      minorUnits: ctx.minorUnits,
      basis: ctx.basis,
      periodFrom,
      periodTo,
      revenueAccountIds: ctx.revenueAccountIds,
      expenseAccountIds: ctx.expenseAccountIds,
      asOf: asOf ?? (await businessTodayInTx(db, orgId)),
      allowNativeLossWithoutAward: options?.allowNativeLossWithoutAward === true,
    });
    if (result.computation === null) {
      return {
        measured: result.measured,
        excluded: result.excluded,
        moneySnapshot: null,
        hoursSnapshot: null,
        projectMarginSnapshot: result.projectMarginSnapshot,
        computation: null,
        nonpayableReason:
          result.nonpayableReason ??
          "Every recipient nets a project-margin loss this period, so no native award can carry the losses forward.",
      };
    }
    return {
      measured: result.measured,
      computation: result.computation,
      excluded: result.excluded,
      moneySnapshot: null,
      hoursSnapshot: null,
      projectMarginSnapshot: result.projectMarginSnapshot,
    };
  }
  const eligible = eligibleMembers(ctx.members, periodFrom, periodTo);
  const memberEmploymentIds = new Set<string>();
  for (const member of eligible) {
    if (memberEmploymentIds.has(member.employmentId)) {
      throw new BenefitsError(
        "REFUSED",
        `employment ${member.employmentId} has several membership versions within this period — preview separate manual spans for each effective version; a period never guesses a role weight across versions`,
      );
    }
    memberEmploymentIds.add(member.employmentId);
  }
  const memberById = new Map(ctx.members.map((m) => [m.employmentId, m]));
  let measured: IncentiveMeasured;
  let shares: IncentiveMemberShare[];
  const excluded: string[] = [];
  let moneySnapshot: MoneySourceSnapshot | null = null;
  let hoursSnapshot: HoursSourceSnapshot | null = null;
  // Zero-hours members never take a share of an hours allocation: they are
  // excluded with a named line, never zero-awarded (a recorded zero is a
  // no-op write).
  const excludeZeroHours = (
    rows: ReadonlyArray<{ employmentId: string; hours: string }>,
  ): IncentiveMemberShare[] => {
    const out: IncentiveMemberShare[] = [];
    for (const row of rows) {
      if (program.allocation === "hours" && row.hours === "0.0000") {
        excluded.push(
          `${row.employmentId}: no approved hours in the period — excluded, never zero-awarded`,
        );
        continue;
      }
      const member = memberById.get(row.employmentId);
      out.push({
        employmentId: row.employmentId,
        weight: member?.weight ?? null,
        hours: program.allocation === "hours" ? row.hours : null,
        effectiveFrom: member?.effectiveFrom ?? periodFrom,
        effectiveTo: member?.effectiveTo ?? null,
      });
    }
    return out;
  };
  if (metric === "approved_hours") {
    const snapshot = await measureApprovedHours(db, orgId, actorId, {
      scope: program.metricScope!,
      departmentIds: ctx.departmentIds,
      projectIds: ctx.projectIds,
      workDepartmentIds: program.scopeDepartmentIds,
      hourClassifications: program.hourClassifications,
      unassignedTime: program.unassignedTime,
      legalEntityId: program.legalEntityId!,
      periodFrom,
      periodTo,
      memberEmploymentIds: [...new Set(eligible.map((m) => m.employmentId))],
      memberPeriods: eligible.map((m) => ({
        employmentId: m.employmentId,
        effectiveFrom: m.effectiveFrom,
        effectiveTo: m.effectiveTo,
      })),
      allowedSubsidiaryIds: ctx.scope,
    });
    hoursSnapshot = snapshot;
    measured = {
      metric,
      scope: program.metricScope!,
      sourceAccountIds: [],
      periodFrom,
      periodTo,
      value: snapshot.totalHours,
      currency: null,
    };
    shares = excludeZeroHours(snapshot.hoursByEmployment);
  } else {
    const snapshot = await measureMoneySource(db, orgId, actorId, {
      metric,
      scope: program.metricScope!,
      departmentIds: ctx.departmentIds,
      projectIds: ctx.projectIds,
      revenueAccountIds: ctx.revenueAccountIds,
      expenseAccountIds: ctx.expenseAccountIds,
      legalEntityId: program.legalEntityId!,
      currency: program.currency,
      periodFrom,
      periodTo,
      incentiveExpenseAccountId: ctx.incentiveExpenseAccountId,
      unassignedTime: program.unassignedTime,
      allowedSubsidiaryIds: ctx.scope,
    });
    measured = {
      metric,
      scope: program.metricScope!,
      sourceAccountIds: [...snapshot.revenueAccountIds, ...snapshot.expenseAccountIds],
      periodFrom,
      periodTo,
      value: snapshot.value,
      currency: snapshot.currency,
    };
    if (program.allocation === "hours") {
      // Hours shares need their own approved-time read over the same scope.
      const attribution = await measureApprovedHours(db, orgId, actorId, {
        scope: program.metricScope!,
        departmentIds: ctx.departmentIds,
        projectIds: ctx.projectIds,
        workDepartmentIds: program.scopeDepartmentIds,
        hourClassifications: program.hourClassifications,
        unassignedTime: program.unassignedTime,
        legalEntityId: program.legalEntityId!,
        periodFrom,
        periodTo,
        memberEmploymentIds: [...new Set(eligible.map((m) => m.employmentId))],
        memberPeriods: eligible.map((m) => ({
          employmentId: m.employmentId,
          effectiveFrom: m.effectiveFrom,
          effectiveTo: m.effectiveTo,
        })),
        allowedSubsidiaryIds: ctx.scope,
      });
      hoursSnapshot = attribution;
      shares = excludeZeroHours(attribution.hoursByEmployment);
    } else {
      // No proration policy exists in configuration, so only full-period
      // members take shares of fixed, percent, and pool awards — partial
      // members are excluded with a named line, never paid a full share.
      const { covered, partial } = partitionMembers(ctx.members, periodFrom, periodTo);
      void eligible;
      for (const m of partial) {
        excluded.push(
          `${m.employmentId}: membership ${m.effectiveFrom}..${m.effectiveTo ?? "open"} does not cover ${periodFrom}..${periodTo} — excluded without proration; no proration policy is configured`,
        );
      }
      if (covered.length === 0) {
        throw new BenefitsError(
          "REFUSED",
          `no member covers the full period ${periodFrom}..${periodTo} — extend membership dates that are wrong, or settle the partial span as its own manual period; partial members never take full shares`,
        );
      }
      shares = covered.map((m) => ({
        employmentId: m.employmentId,
        weight: m.weight,
        hours: null,
        effectiveFrom: m.effectiveFrom,
        effectiveTo: m.effectiveTo,
      }));
    }
    moneySnapshot = snapshot;
  }
  let computation: IncentiveComputation;
  try {
    computation = computeIncentiveAwards({
      program,
      measured,
      shares,
      periodBasis: ctx.basis,
      minorUnits: ctx.minorUnits,
    });
  } catch (error) {
    if (
      options?.allowNativeLossWithoutAward === true &&
      error instanceof BenefitsError &&
      error.code === "REFUSED" &&
      error.message.startsWith("the measured ") &&
      error.message.includes(" is a loss (")
    ) {
      return {
        measured,
        excluded,
        moneySnapshot,
        hoursSnapshot,
        computation: null,
        nonpayableReason: error.message,
      };
    }
    throw error;
  }
  excluded.push(...computation.excludedZero);
  return { measured, computation, excluded, moneySnapshot, hoursSnapshot };
}

/**
 * Simulate or pre-check a settlement: the same measure and the same math
 * settlement runs, over an explicit period that may be historical (posted
 * and approved sources only — a simulation from real data, never a
 * projection). Writes nothing.
 */
export async function previewIncentiveSettlement(
  query: PreviewIncentiveSettlementQuery,
): Promise<IncentivePreview> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const programId = requireId(query.programId, "programId");
  return withOrgTransaction(orgId, async () => {
    const scope = await requireAggregateBenefitsRead(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const ctx = await loadSettlementContext(
      orgId,
      actorId,
      programId,
      scope,
      false,
      query.periodFrom,
      query.periodTo,
    );
    const result = await measureAndCompute(
      orgId,
      actorId,
      ctx,
      query.periodFrom,
      query.periodTo,
      query.asOf === undefined ? undefined : requireCivilDate(query.asOf, "asOf"),
    );
    return buildPreviewResult(orgId, scope, ctx, query, result);
  });
}

/** Compare today's native measure with the award history still present in payroll. */
export async function reconcileIncentivePeriod(
  query: PreviewIncentiveSettlementQuery,
): Promise<IncentivePeriodReconciliation> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const programId = requireId(query.programId, "programId");
  const periodFrom = requireCivilDate(query.periodFrom, "periodFrom");
  const periodTo = requireCivilDate(query.periodTo, "periodTo");
  const asOf = query.asOf === undefined ? undefined : requireCivilDate(query.asOf, "asOf");
  return withOrgTransaction(orgId, async () => {
    const scope = await requireAggregateBenefitsRead(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const ctx = await loadSettlementContext(
      orgId,
      actorId,
      programId,
      scope,
      false,
      periodFrom,
      periodTo,
    );
    const result = await measureAndCompute(orgId, actorId, ctx, periodFrom, periodTo, asOf, {
      allowNativeLossWithoutAward: true,
    });
    const preview = result.computation
      ? await buildPreviewResult(orgId, scope, ctx, { ...query, periodFrom, periodTo }, result)
      : null;
    let nativeMeasureOnly: IncentivePeriodReconciliation["nativeMeasureOnly"] = null;
    if (result.computation === null) {
      const measured =
        result.moneySnapshot ??
        result.projectMarginSnapshot ??
        result.transactionSnapshot ??
        result.hoursSnapshot;
      if (!measured)
        throw new BenefitsError(
          "REFUSED",
          "native loss reconciliation has no retained source measure",
        );
      const today = await businessTodayInTx(db, orgId);
      const isEstimate =
        periodTo >= today || ctx.projectCompletion.some((project) => project.status !== "closed");
      nativeMeasureOnly = {
        programRevision: ctx.program.revision,
        periodFrom,
        periodTo,
        periodBasis: ctx.basis,
        fiscalCalendarId: ctx.fiscalCalendarId,
        payableAfter: addCalendarDays(periodTo, ctx.program.paymentDelayDays),
        currency: ctx.program.currency,
        minorUnits: ctx.minorUnits,
        measured,
        summaryLines: [
          `${ctx.program.code} — ${ctx.program.name}: the native measure is ${result.measured.value} ${result.measured.currency ?? "hours"}`,
          result.nonpayableReason,
          "No native payable award was computed or recorded for this period.",
        ],
        isEstimate,
        sourceSnapshot: buildNonpayableNativeMeasureSnapshot(
          ctx,
          { ...query, periodFrom, periodTo, ...(asOf === undefined ? {} : { asOf }) },
          result,
          result.nonpayableReason,
        ),
      };
    }
    const scopeFilter =
      scope === null
        ? sql``
        : sql`and exists (
      select 1 from hrm_benefit_programs scoped_program
       where scoped_program.org_id = a.org_id and scoped_program.id = a.program_id
         and scoped_program.legal_entity_id = any(${`{${[...scope].join(",")}}`}::uuid[])
    )`;
    const processed = (
      await db.execute<{ total: string }>(
        sql`
      select coalesce(sum(a.value), 0)::text as total
        from hrm_benefit_awards a
       where a.org_id = ${orgId} and a.program_id = ${programId}
         and a.period_from = ${periodFrom}::date and a.period_to = ${periodTo}::date
         and a.status = 'delivered' and ${awardPayrollProcessedSql}
         ${scopeFilter}
    `,
        "objects",
      )
    )[0];
    const obligationHistory = (
      await db.execute<{ nativeTotal: string; sourceEvidenceTotal: string }>(
        sql`
      select coalesce(sum(a.value) filter (where a.source_key like 'settle:%'), 0)::text as "nativeTotal",
             coalesce(sum(a.value) filter (where a.source_key like 'source-first:%'), 0)::text as "sourceEvidenceTotal"
        from hrm_benefit_awards a
       where a.org_id = ${orgId} and a.program_id = ${programId}
         and a.adjusts_award_id is null and a.status <> 'voided'
         and a.period_from = ${periodFrom}::date and a.period_to = ${periodTo}::date
         ${scopeFilter}
    `,
        "objects",
      )
    )[0];
    const native = fromUnits(
      preview?.visibleRecipients.reduce((sum, recipient) => sum + toUnits(recipient.value), 0n) ??
        0n,
    );
    const processedPayrollTotal = normalizeMoney(processed?.total ?? "0");
    const payrollMinusCurrentMeasurement = fromUnits(
      toUnits(processedPayrollTotal) - toUnits(native),
    );
    const nativeMeasuredHistoryTotal = normalizeMoney(obligationHistory?.nativeTotal ?? "0");
    const sourceEvidencedFirstTotal = normalizeMoney(obligationHistory?.sourceEvidenceTotal ?? "0");
    const obligationHistoryMinusCurrentMeasurement = fromUnits(
      toUnits(nativeMeasuredHistoryTotal) + toUnits(sourceEvidencedFirstTotal) - toUnits(native),
    );
    return {
      preview,
      nativeMeasureOnly,
      processedPayrollTotal,
      payrollMinusCurrentMeasurement,
      nativeMeasuredHistoryTotal,
      sourceEvidencedFirstTotal,
      obligationHistoryMinusCurrentMeasurement,
    };
  });
}

async function buildPreviewResult(
  orgId: string,
  scope: Set<string> | null,
  ctx: SettlementContext,
  query: PreviewIncentiveSettlementQuery,
  result: {
    computation: IncentiveComputation;
    moneySnapshot: MoneySourceSnapshot | null;
    hoursSnapshot: HoursSourceSnapshot | null;
    transactionSnapshot?: TransactionSettlementSnapshot;
    projectMarginSnapshot?: ProjectMarginSnapshot;
    excluded: string[];
  },
): Promise<IncentivePreview> {
  const visible =
    scope === null
      ? [...result.computation.recipients]
      : await fenceRecipients(orgId, scope, result.computation);
  const measured =
    result.projectMarginSnapshot ??
    result.transactionSnapshot ??
    result.moneySnapshot ??
    result.hoursSnapshot;
  if (!measured) {
    throw new BenefitsError(
      "REFUSED",
      "settlement measured nothing — the program names no metric source; configure the measure before previewing",
    );
  }
  const sourceSnapshot = buildSourceSnapshot(
    ctx,
    query,
    result,
    result.computation,
    result.excluded,
  );
  const today = await businessTodayInTx(db, orgId);
  // A period ending today is still incomplete: estimates until tomorrow.
  const openPeriod = query.periodTo >= today;
  const openProjects = ctx.projectCompletion.filter((p) => p.status !== "closed");
  const isEstimate = openPeriod || openProjects.length > 0;
  const estimateLines = [
    ...(openPeriod
      ? [
          `estimate: period ends ${query.periodTo} (today ${today}) — sources are incomplete; settle only after the period closes`,
        ]
      : []),
    ...(openProjects.length > 0
      ? [
          `estimate: ${openProjects.length} selected project(s) are not closed — close each project in its project record before settling a completion award`,
        ]
      : []),
  ];
  return {
    programId: ctx.program.id,
    programCode: ctx.program.code,
    programName: ctx.program.name,
    programStatus: ctx.program.status,
    programRevision: ctx.program.revision,
    periodFrom: query.periodFrom,
    periodTo: query.periodTo,
    periodBasis: ctx.basis,
    fiscalCalendarId: ctx.fiscalCalendarId,
    payableAfter: addCalendarDays(query.periodTo, ctx.program.paymentDelayDays),
    currency: ctx.program.currency,
    minorUnits: ctx.minorUnits,
    measured,
    computation: {
      ...result.computation,
      recipients: visible,
      summaryLines: [...result.computation.summaryLines, ...estimateLines],
    },
    visibleRecipients: visible,
    excluded: result.excluded,
    isEstimate,
    sourceKeyPrefix: settleKeyPrefix(
      ctx.program.id,
      query.periodFrom,
      query.periodTo,
      ctx.program.revision,
    ),
    sourceSnapshot,
  };
}

async function fenceRecipients(
  orgId: string,
  scope: Set<string>,
  computation: IncentiveComputation,
): Promise<IncentiveComputation["recipients"]> {
  if (computation.recipients.length === 0) return [];
  const ids = computation.recipients.map((r) => r.employmentId);
  const rows = await db.execute<{ id: string; employer_subsidiary_id: string }>(
    sql`
    select id::text as id, employer_subsidiary_id::text as employer_subsidiary_id
      from worker_employments
     where org_id = ${orgId} and id = any (${`{${ids.join(",")}}`}::uuid[])
  `,
    "objects",
  );
  const entityById = new Map(rows.map((r) => [r.id, r.employer_subsidiary_id]));
  return computation.recipients.filter((r) => {
    const entity = entityById.get(r.employmentId);
    return entity !== undefined && scope.has(entity);
  });
}

async function buildPreview(
  orgId: string,
  actorId: string,
  ctx: SettlementContext,
  query: PreviewIncentiveSettlementQuery,
  result: {
    measured: IncentiveMeasured;
    computation: IncentiveComputation;
    moneySnapshot: MoneySourceSnapshot | null;
    hoursSnapshot: HoursSourceSnapshot | null;
    transactionSnapshot?: TransactionSettlementSnapshot;
    excluded: string[];
  },
): Promise<IncentivePreview> {
  const scope = await requireAggregateBenefitsRead(db, orgId, actorId);
  return buildPreviewResult(orgId, scope, ctx, query, result);
}

function canonicalUuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw new BenefitsError("INVALID_INPUT", `${field} must be a UUID`);
  return value.toLowerCase();
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Replay equality ignores only the server-stamped governing-decision time:
 * a retry necessarily stamps a new clock value, while class, paid date,
 * governing actor, basis, and reason must still match exactly.
 */
function sourceSnapshotForReplay(snapshot: Record<string, unknown>): Record<string, unknown> {
  const evidence = snapshot.sourceEvidence as Record<string, unknown> | undefined;
  const governing = evidence?.governingDecision as Record<string, unknown> | undefined;
  if (!evidence || !governing || !Object.hasOwn(governing, "attestedAt")) return snapshot;
  const rest = { ...governing };
  delete rest.attestedAt;
  return { ...snapshot, sourceEvidence: { ...evidence, governingDecision: rest } };
}

/**
 * Record one source-evidenced first obligation when a locked native
 * remeasurement has no payable recipient for this employment. The separate
 * source-first origin preserves native measurement and all ordinary
 * eligibility, caps, approval, queue, and delivery controls.
 */
export async function recordSourceEvidencedFirstIncentiveAward(
  query: RecordSourceEvidencedFirstIncentiveQuery,
): Promise<BenefitAward> {
  const orgId = canonicalUuid(query.orgId, "orgId");
  const actorId = canonicalUuid(query.actorId, "actorId");
  const programId = canonicalUuid(query.programId, "programId");
  const employmentId = canonicalUuid(query.employmentId, "employmentId");
  const requestKey = canonicalUuid(query.requestKey, "requestKey");
  const periodFrom = requireCivilDate(query.periodFrom, "periodFrom");
  const periodTo = requireCivilDate(query.periodTo, "periodTo");
  const asOf = requireCivilDate(query.asOf, "asOf");
  const sourceIssueDate = requireCivilDate(query.sourceIssueDate, "sourceIssueDate");
  const sourceSystem = "cabinet-retained";
  const requestedSourceRowRef = String(query.sourceRowRef ?? "").trim();
  const requestedSourceRowRefCanonical = isUuid(requestedSourceRowRef)
    ? requestedSourceRowRef.toLowerCase()
    : requestedSourceRowRef;
  const reason = String(query.reason ?? "").trim();
  if (!Number.isInteger(query.expectedProgramRevision) || query.expectedProgramRevision < 1) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "expectedProgramRevision is the reviewed positive program revision",
    );
  }
  if (requestedSourceRowRefCanonical.length === 0 || requestedSourceRowRefCanonical.length > 300) {
    throw new BenefitsError("INVALID_INPUT", "a stable retained source-row reference is required");
  }
  if (reason.length < 8 || reason.length > 2000) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "source-evidence reason explains the first obligation in 8–2000 characters",
    );
  }
  const isAboveNativeMeasure = query.sourceEvidenceClass === "source-paid-above-native-measure";
  if (!isAboveNativeMeasure && query.sourceEvidenceClass !== "missing-source-identity") {
    throw new BenefitsError(
      "REFUSED",
      "source-evidenced first obligations cover missing native source identity or a source payment above a negative native project-margin measure only; other measurement exceptions require separate policy review",
    );
  }
  const sourcePaidDate =
    query.sourceEvidenceClass === "source-paid-above-native-measure"
      ? requireCivilDate(query.sourcePaidDate, "sourcePaidDate")
      : null;
  const governingAttestation =
    query.sourceEvidenceClass === "source-paid-above-native-measure"
      ? query.governingDecisionAttestation
      : undefined;
  const governingBasis = String(governingAttestation?.basis ?? "").trim();
  const governingReason = String(governingAttestation?.reason ?? "").trim();
  if (
    isAboveNativeMeasure &&
    (governingAttestation?.confirmed !== true ||
      typeof governingAttestation?.basis !== "string" ||
      typeof governingAttestation?.reason !== "string" ||
      governingBasis.length < 8 ||
      governingBasis.length > 2000 ||
      governingReason.length < 8 ||
      governingReason.length > 2000)
  ) {
    throw new BenefitsError(
      "REFUSED",
      "review the retained row and the negative native measure, then attest the governing decision for paying above it with its basis and reason",
    );
  }
  if (periodTo < periodFrom)
    throw new BenefitsError("INVALID_INPUT", "periodTo ends on or after periodFrom");
  const attestation = query.mappingAttestation;
  const mappingEmploymentId =
    attestation?.employmentId === undefined
      ? ""
      : canonicalUuid(attestation.employmentId, "mappingAttestation.employmentId");
  const mappingBasis = String(attestation?.basis ?? "").trim();
  const mappingReason = String(attestation?.reason ?? "").trim();
  if (
    attestation?.confirmed !== true ||
    mappingEmploymentId !== employmentId ||
    mappingBasis.length < 8 ||
    mappingBasis.length > 2000 ||
    mappingReason.length < 8 ||
    mappingReason.length > 2000
  ) {
    throw new BenefitsError(
      "REFUSED",
      "review the retained row, then attest the source-row to native employment and payer mapping with its basis and reason",
    );
  }
  if (
    !Array.isArray(query.sourceArtifacts) ||
    query.sourceArtifacts.length < 1 ||
    query.sourceArtifacts.length > 5
  ) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "one retained source file and up to four corroborating files are required",
    );
  }

  const sourceSelections = query.sourceArtifacts.map((artifact, index) => {
    const fileId = canonicalUuid(artifact.fileId, `sourceArtifacts[${index}].fileId`);
    const versionId = canonicalUuid(artifact.versionId, `sourceArtifacts[${index}].versionId`);
    const rowPointer = String(artifact.rowPointer ?? "");
    if (rowPointer !== "" && (!rowPointer.startsWith("/") || rowPointer.length > 1024)) {
      throw new BenefitsError(
        "INVALID_INPUT",
        "retained source rows use a bounded JSON Pointer selection",
      );
    }
    const sourceFields =
      artifact.sourceFields === undefined ? undefined : Object.freeze({ ...artifact.sourceFields });
    const pdfSelection =
      artifact.pdfSelection === undefined ? undefined : structuredClone(artifact.pdfSelection);
    return {
      fileId,
      versionId,
      rowPointer,
      ...(sourceFields ? { sourceFields } : {}),
      ...(pdfSelection ? { pdfSelection } : {}),
    };
  });
  if (
    isAboveNativeMeasure &&
    !sourceSelections.some(
      (selection) =>
        selection.sourceFields?.sourcePaidDatePointer !== undefined ||
        selection.pdfSelection?.fields.sourcePaidDate !== undefined,
    )
  ) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "the selected retained source row must identify its source paid date field for a source-paid-above-native-measure obligation",
    );
  }
  const inputValue = canonicalDecimal(query.value, 4);
  const currency = String(query.currency ?? "")
    .trim()
    .toUpperCase();
  const nativeCurrencyReview =
    query.nativeCurrencyBasis === undefined
      ? undefined
      : {
          confirmed: query.nativeCurrencyBasis.confirmed,
          reason: String(query.nativeCurrencyBasis.reason ?? "").trim(),
        };
  if (
    nativeCurrencyReview &&
    (nativeCurrencyReview.confirmed !== true ||
      nativeCurrencyReview.reason.length < 8 ||
      nativeCurrencyReview.reason.length > 2000)
  ) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "review and explain the native program and payroll currency basis",
    );
  }
  if (inputValue === null || !/^[A-Z]{3}$/.test(currency)) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "source amount and currency use exact supported values",
    );
  }
  const expectedNativePreviewDigest = String(query.expectedNativePreviewDigest ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedNativePreviewDigest)) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "confirm the exact native preview digest before recording the source obligation",
    );
  }
  return withOrgTransaction(orgId, async () => {
    try {
      await lockActorCommandAuthority(db, orgId, actorId, null, "hrm.benefits.manage");
    } catch (error) {
      if (!(error instanceof ScopeNotFoundError)) throw error;
      const refusal = new BenefitsError(
        "NOT_FOUND",
        "The benefit actor is unavailable in this organization's current authority; reload the program and retry.",
      );
      refusal.cause = error;
      throw refusal;
    }
    const scope = await requireAggregateBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const lockedProgram = requireOneRow(
      await db.execute<{ revision: number }>(
        sql`
      select revision from hrm_benefit_programs
       where org_id = ${orgId} and id = ${programId}
       for update
    `,
        "objects",
      ),
      "locking the benefit program",
    );
    const currentProgramRevision = Number(lockedProgram.revision);
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtext(${"benefit_settle:" + programId + ":" + periodFrom + ":" + periodTo}))
    `);
    const sourceArtifacts: VerifiedRetainedSourceArtifact[] = [];
    const parsedArtifacts: Awaited<ReturnType<typeof parseRetainedSourceArtifact>>[] = [];
    let combinedSourceSize = 0;
    for (const selection of sourceSelections) {
      await requireNativeFileReadAuthority({ orgId, actorId, fileId: selection.fileId }, db);
      const retained = (
        await db.execute<{
          filename: string;
          contentType: string;
          contentHash: string | null;
          sizeBytes: number;
          storageKind: string;
          bytes: Buffer | null;
          isInactive: boolean;
        }>(
          sql`
        select fi.name as filename, fv.content_type as "contentType",
               fv.content_hash as "contentHash", fv.size_bytes as "sizeBytes",
               fv.storage_kind as "storageKind", blob.bytes, fi.is_inactive as "isInactive"
          from files fi
          join file_versions fv on fv.file_id = fi.id
          left join file_blobs blob on blob.version_id = fv.id
         where fi.org_id = ${orgId} and fi.id = ${selection.fileId} and fv.id = ${selection.versionId}
         for share of fi, fv
      `,
          "objects",
        )
      )[0];
      if (!retained || retained.isInactive) {
        throw new BenefitsError(
          "REFUSED",
          "the retained Cabinet source file is unavailable or inactive",
        );
      }
      refuseMaskedStorageKind(retained.storageKind);
      const bytes =
        retained.storageKind === "s3"
          ? await getS3Blob(selection.versionId)
          : retained.storageKind === "db"
            ? retained.bytes
            : null;
      if (!bytes)
        throw new BenefitsError(
          "REFUSED",
          "the pinned Cabinet source version has no readable native bytes",
        );
      const contentHash = retained.contentHash?.toLowerCase() ?? "";
      if (
        !/^[0-9a-f]{64}$/.test(contentHash) ||
        sha256(bytes) !== contentHash ||
        bytes.length !== Number(retained.sizeBytes)
      ) {
        throw new BenefitsError(
          "REFUSED",
          "native Cabinet bytes do not match the pinned version hash and size",
        );
      }
      combinedSourceSize += bytes.length;
      if (bytes.length > 10_000_000 || combinedSourceSize > 10_000_000) {
        throw new BenefitsError(
          "REFUSED",
          "retained evidence files exceed the supported source snapshot size",
        );
      }
      const parsed = await parseRetainedSourceArtifact(bytes, retained.contentType, selection);
      parsedArtifacts.push(parsed);
      sourceArtifacts.push({
        ...selection,
        filename: retained.filename,
        contentType: String(retained.contentType).trim().toLowerCase(),
        sha256: contentHash,
        sizeBytes: bytes.length,
        bytesBase64: bytes.toString("base64"),
        rowSha256: parsed.rowSha256,
        row: parsed.row,
      });
    }
    const primary = sourceArtifacts[0]!;
    const ctx = await loadSettlementContext(
      orgId,
      actorId,
      programId,
      scope,
      true,
      periodFrom,
      periodTo,
    );
    let currencyEvidence: Record<string, unknown> | undefined;
    if (nativeCurrencyReview) {
      const basis = await db.execute<{
        payerCurrency: string;
        profileId: string;
        scheduleId: string;
      }>(
        sql`
        select s.base_currency as "payerCurrency", p.id::text as "profileId", cal.id::text as "scheduleId"
          from worker_employments w
          join subsidiaries s on s.org_id=w.org_id and s.id=w.employer_subsidiary_id
          join employee_payroll_profiles p on p.org_id=w.org_id and p.employment_id=w.id and p.employee_party_id=w.worker_party_id
          join pay_schedules cal on cal.org_id=p.org_id and cal.id=p.pay_schedule_id
         where w.org_id=${orgId} and w.id=${employmentId} and w.employer_subsidiary_id=${ctx.program.legalEntityId}
           and p.is_active and cal.is_active and s.is_active and not s.is_elimination
           and (cal.subsidiary_id is null or cal.subsidiary_id=s.id)
         for share of w,s,p,cal
      `,
        "objects",
      );
      if (
        basis.length !== 1 ||
        basis[0]!.payerCurrency !== ctx.program.currency ||
        currency !== ctx.program.currency ||
        ctx.program.deliveryMethod !== "payroll"
      ) {
        throw new BenefitsError(
          "REFUSED",
          "native currency evidence requires one active payroll profile and matching program and legal-payer currency; review the actual configuration",
        );
      }
      currencyEvidence = {
        kind: "reviewed-native-program-payroll-currency",
        actorId,
        programId,
        reviewedProgramRevision: query.expectedProgramRevision,
        legalPayerId: ctx.program.legalEntityId,
        employmentId,
        currency,
        profileId: basis[0]!.profileId,
        scheduleId: basis[0]!.scheduleId,
        reason: nativeCurrencyReview.reason,
        documentCurrencyClaim: "denomination-retained-per-source-document",
      };
    }
    const claims = combineRetainedSourceClaims(
      parsedArtifacts,
      currencyEvidence ? currency : undefined,
    );
    const sourceRowRef = isUuid(claims.sourceRowRef)
      ? claims.sourceRowRef.toLowerCase()
      : claims.sourceRowRef;
    const sourceValue = canonicalDecimal(claims.value, 4);
    const retainedCurrency = claims.currency.toUpperCase();
    const retainedFrom = requireCivilDate(claims.periodFrom, "retainedSource.periodFrom");
    const retainedTo = requireCivilDate(claims.periodTo, "retainedSource.periodTo");
    const retainedIssueDate = requireCivilDate(
      claims.sourceIssueDate,
      "retainedSource.sourceIssueDate",
    );
    const retainedPaidDate =
      claims.sourcePaidDate === undefined
        ? null
        : requireCivilDate(claims.sourcePaidDate, "retainedSource.sourcePaidDate");
    const normalizedSourceRowRef = isUuid(query.sourceRowRef)
      ? query.sourceRowRef.toLowerCase()
      : String(query.sourceRowRef).trim();
    if (
      sourceRowRef.length === 0 ||
      sourceRowRef.length > 300 ||
      sourceRowRef !== normalizedSourceRowRef ||
      sourceValue === null ||
      normalizeMoney(sourceValue) !== normalizeMoney(inputValue) ||
      retainedCurrency !== currency ||
      retainedFrom !== periodFrom ||
      retainedTo !== periodTo ||
      retainedIssueDate !== sourceIssueDate ||
      (isAboveNativeMeasure && retainedPaidDate !== sourcePaidDate)
    ) {
      throw new BenefitsError(
        "REFUSED",
        "source amount, currency, earning period, issue date, paid date, or row reference differs from the selected retained row",
      );
    }
    const sourceKey = `source-first:${sha256(`${orgId}\n${programId}\n${sourceSystem}\n${sourceRowRef}`)}`;
    // The candidate snapshot is built before every changed-state refusal so
    // an exact retry can return its stored row ahead of revision, preview
    // digest, overlap, and budget checks that moved after it was recorded.
    const result = await measureAndCompute(orgId, actorId, ctx, periodFrom, periodTo, asOf, {
      allowNativeLossWithoutAward: true,
    });
    const previewQuery = { orgId, actorId, programId, periodFrom, periodTo, asOf };
    const previewSnapshot = result.computation
      ? buildSourceSnapshot(ctx, previewQuery, result, result.computation, result.excluded)
      : buildNonpayableNativeMeasureSnapshot(ctx, previewQuery, result, result.nonpayableReason);
    const previewDigest = sourceEvidenceNativePreviewDigest({
      periodFrom,
      periodTo,
      asOf,
      nativeSnapshot: previewSnapshot,
    });
    const targetNativeRecipient =
      result.computation?.recipients.find((recipient) => recipient.employmentId === employmentId) ??
      null;
    const pmSnapshot = result.projectMarginSnapshot ?? null;
    const pmAffectedProjects =
      pmSnapshot === null
        ? []
        : pmSnapshot.projects.filter((project) =>
            project.shares.some((share) => share.employmentId === employmentId),
          );
    const pmTargetShareTotal = pmAffectedProjects.reduce(
      (sum, project) =>
        sum +
        project.shares
          .filter((share) => share.employmentId === employmentId)
          .reduce((projectSum, share) => projectSum + toUnits(share.value), 0n),
      0n,
    );
    const pmTargetCarry = pmSnapshot?.carryForward?.[employmentId] ?? null;
    const governingDecision = isAboveNativeMeasure
      ? {
          actorId,
          attestedAt: requireOneRow(
            await db.execute<{ attestedAt: string }>(
              sql`
            select now()::text as "attestedAt"
          `,
              "objects",
            ),
            "stamping the governing decision",
          ).attestedAt,
          basis: governingBasis,
          reason: governingReason,
        }
      : null;
    const nativeMeasureAnchor = {
      classification: query.sourceEvidenceClass,
      employmentId,
      nativeRecipientState:
        targetNativeRecipient === null
          ? "no-native-recipient-row"
          : toUnits(targetNativeRecipient.value) > 0n
            ? "native-recipient-payable"
            : "native-recipient-computed-zero",
      measuredValue: result.measured.value,
      targetShareTotal: fromUnits(pmTargetShareTotal),
      targetCarryForward: pmTargetCarry,
      affectedProjectIds: pmAffectedProjects.map((project) => project.projectId),
      explanation:
        result.computation === null
          ? result.nonpayableReason
          : "The locked native project-margin computation leaves this employment with a negative carry-forward and no payable native award.",
    };
    const missingAnchor = {
      classification: query.sourceEvidenceClass,
      employmentId,
      nativeRecipientState:
        targetNativeRecipient === null
          ? "no-native-recipient-row"
          : toUnits(targetNativeRecipient.value) > 0n
            ? "native-recipient-payable"
            : "native-recipient-computed-zero",
      explanation:
        result.computation === null
          ? result.nonpayableReason
          : targetNativeRecipient === null
            ? "The locked native incentive computation contains no recipient row for this employment."
            : `The locked native incentive computation produced ${targetNativeRecipient.value} ${currency} for this employment, which is not payable.`,
    };
    const sourceEvidence = {
      kind: "source-evidenced-first-incentive-v1",
      recordedBy: actorId,
      requestKey,
      expectedProgramRevision: query.expectedProgramRevision,
      currentProgramRevision,
      effectivePolicyRevision: ctx.program.revision,
      effectivePolicyRevisionId: ctx.policyRevisionId,
      effectivePolicy: {
        program: buildBenefitAwardProgramSnapshot(ctx.program),
        policyRevisionId: ctx.policyRevisionId,
        sourceAccounts: ctx.sources.map((source) => ({
          accountId: source.accountId,
          weightBps: source.weightBps,
        })),
        transactionPolicy:
          ctx.transactionPolicy === undefined
            ? { origin: "current-program-rules" }
            : ctx.transactionPolicy,
      },
      sourceSystem,
      sourceRowRef,
      sourceRow: primary.row,
      sourceArtifacts,
      ...(currencyEvidence ? { currencyEvidence } : {}),
      ...(sourceSelections.some(
        (selection) =>
          selection.pdfSelection?.fields.periodFrom || selection.pdfSelection?.fields.periodTo,
      )
        ? {
            sourceCoverageInterpretation: {
              kind: "retained-report-settlement-coverage",
              underlyingEarningDatesCertified: false,
            },
          }
        : {}),
      sourceIssueDate,
      periodFrom,
      periodTo,
      value: normalizeMoney(sourceValue),
      currency,
      sourceEvidenceClass: query.sourceEvidenceClass,
      ...(isAboveNativeMeasure
        ? {
            sourcePaidDate,
            nativeMeasureAnchor,
            governingDecision,
            nativePaymentClaim: "none-established-by-this-source-recording",
          }
        : { missingAnchor }),
      mappingAttestation: {
        actorId,
        employmentId,
        legalPayerId: ctx.program.legalEntityId,
        basis: mappingBasis,
        reason: mappingReason,
      },
      reason,
      sourcePolicyEvidence: { status: "not-established-by-this-source-recording", sourceIssueDate },
      nativeIdentity: {
        projectId: null,
        customerId: null,
        ticketId: null,
        timeEntryIds: null,
        correspondence: "unknown",
      },
      nativePreview: {
        periodFrom,
        periodTo,
        asOf,
        currentProgramRevision,
        effectivePolicyRevision: ctx.program.revision,
        effectivePolicyRevisionId: ctx.policyRevisionId,
        effectivePolicy: {
          program: buildBenefitAwardProgramSnapshot(ctx.program),
          policyRevisionId: ctx.policyRevisionId,
          sourceAccounts: ctx.sources.map((source) => ({
            accountId: source.accountId,
            weightBps: source.weightBps,
          })),
          transactionPolicy:
            ctx.transactionPolicy === undefined
              ? { origin: "current-program-rules" }
              : ctx.transactionPolicy,
        },
        digest: previewDigest,
        snapshot: previewSnapshot,
      },
    };
    const sourceSnapshot = {
      kind: "source-evidenced-first-incentive-v1",
      reason,
      // Payroll delivery evidence validates the configured earning component
      // from the authoritative award source snapshot. Keep the component
      // selected by the effective program in this retained source record.
      payComponentId: ctx.program.payComponentId,
      sourceEvidence,
    };
    const ownRecipientEvidence = {
      kind: "source-evidenced-first-obligation",
      sourceIssueDate,
      sourceEvidenceClass: query.sourceEvidenceClass,
    };

    // Exact retry precedes every changed-state refusal below — program
    // revision, preview digest, duplicate, overlap, and budget alike. The
    // source row identity, actor, request key, source bytes, native preview,
    // and all award facts must remain identical; the stored row alone is
    // returned.
    const existing = (
      await db.execute<Record<string, unknown>>(
        sql`
      select id, employment_id as "employmentId", period_from::text as "periodFrom",
             period_to::text as "periodTo", value::text as value, currency,
             program_snapshot as "programSnapshot", source_snapshot as "sourceSnapshot",
             evidence, created_by as "createdBy"
        from hrm_benefit_awards
       where org_id = ${orgId} and program_id = ${programId} and source_key = ${sourceKey}
       for update
    `,
        "objects",
      )
    )[0];
    if (existing) {
      const storedSnapshot = existing.sourceSnapshot as Record<string, unknown> | null;
      const storedEvidence = (storedSnapshot?.sourceEvidence ?? {}) as Record<string, unknown>;
      const storedProgramSnapshot = existing.programSnapshot as Record<string, unknown> | null;
      const expectedProgramSnapshot = buildBenefitAwardProgramSnapshot(ctx.program);
      const same =
        String(existing.createdBy).toLowerCase() === actorId &&
        String(existing.employmentId).toLowerCase() === employmentId &&
        String(existing.periodFrom).slice(0, 10) === periodFrom &&
        String(existing.periodTo).slice(0, 10) === periodTo &&
        normalizeMoney(String(existing.value)) === normalizeMoney(sourceValue) &&
        String(existing.currency).trim() === currency &&
        storedEvidence.requestKey === requestKey &&
        snapshotsMatch(storedProgramSnapshot ?? {}, expectedProgramSnapshot) &&
        snapshotsMatch(
          sourceSnapshotForReplay(storedSnapshot ?? {}),
          sourceSnapshotForReplay(sourceSnapshot),
        ) &&
        existing.evidence !== null &&
        snapshotsMatch(existing.evidence as Record<string, unknown>, ownRecipientEvidence);
      if (!same)
        throw new BenefitsError(
          "REFUSED",
          "this retained source row already has a different first obligation; preserve it and use the linked adjusting-award lifecycle for a correction",
        );
      return getBenefitAward(db, orgId, actorId, String(existing.id));
    }
    if (currentProgramRevision !== query.expectedProgramRevision) {
      throw new BenefitsError(
        "REFUSED",
        `program revision changed from ${query.expectedProgramRevision} to ${currentProgramRevision} — refresh the native preview and review the retained source rows again`,
      );
    }
    if (previewDigest !== expectedNativePreviewDigest) {
      throw new BenefitsError(
        "REFUSED",
        "native sources changed after review — refresh the preview at the same measurement cutoff and confirm again",
      );
    }
    if (ctx.program.metric === "transactions") {
      throw new BenefitsError(
        "REFUSED",
        "transaction programs must use native transaction settlement and its group ceilings; source-evidenced first obligations do not bypass that measurement",
      );
    }
    if (isAboveNativeMeasure && ctx.program.metric !== "project_margin") {
      throw new BenefitsError(
        "REFUSED",
        "source-paid-above-native-measure currently covers project-margin programs only — preserve the retained source evidence and route other negative-measure exceptions through governed review",
      );
    }
    if (ctx.program.legalEntityId === null) {
      throw new BenefitsError(
        "REFUSED",
        "source-evidenced incentives require a native program legal payer",
      );
    }
    const today = await businessTodayInTx(db, orgId);
    if (periodTo >= today)
      throw new BenefitsError(
        "REFUSED",
        "source-evidenced first obligations are recorded only for closed program periods",
      );
    const targetMembership = eligibleMembers(ctx.members, periodFrom, periodTo).find(
      (member) => member.employmentId === employmentId,
    );
    if (!targetMembership) {
      throw new BenefitsError(
        "REFUSED",
        "the selected employment is not an eligible member of this program for the source period",
      );
    }
    if (
      ctx.program.allocation !== "hours" &&
      !partitionMembers(ctx.members, periodFrom, periodTo).covered.some(
        (member) => member.employmentId === employmentId,
      )
    ) {
      throw new BenefitsError(
        "REFUSED",
        "the selected employment does not cover the full source period under this program's membership policy",
      );
    }
    const targetEmployment = (
      await db.execute<{
        employerSubsidiaryId: string | null;
        serviceStart: string | null;
      }>(
        sql`
      select employer_subsidiary_id::text as "employerSubsidiaryId", service_start::text as "serviceStart"
        from worker_employments
       where org_id = ${orgId} and id = ${employmentId}
       for share
    `,
        "objects",
      )
    )[0];
    if (!targetEmployment || targetEmployment.employerSubsidiaryId !== ctx.program.legalEntityId) {
      throw new BenefitsError(
        "REFUSED",
        "the selected employment is not in this program's legal payer",
      );
    }
    if (
      targetEmployment.serviceStart &&
      String(targetEmployment.serviceStart).slice(0, 10) > periodTo
    ) {
      throw new BenefitsError("REFUSED", "the selected employment begins after the source period");
    }
    const activeCoverage =
      (
        await db.execute<{ covered: boolean }>(
          sql`
      select coalesce(
        daterange(${periodFrom}::date, ${periodTo}::date + 1, '[)') &&
          range_agg(daterange(effective_from, effective_to, '[)')),
        false
      ) as covered
        from worker_employment_versions
       where org_id = ${orgId} and employment_id = ${employmentId}
         and status = 'active' and recorded_until is null
    `,
          "objects",
        )
      )[0]?.covered === true;
    if (!activeCoverage) {
      throw new BenefitsError(
        "REFUSED",
        "the selected employment has no active service during the source period",
      );
    }
    if (currency !== ctx.program.currency || toUnits(sourceValue) <= 0n) {
      throw new BenefitsError(
        "REFUSED",
        "the issued source amount must be positive and use the program currency",
      );
    }
    const sourceFraction = normalizeMoney(sourceValue).split(".")[1] ?? "";
    if (/[^0]/.test(sourceFraction.slice(ctx.minorUnits))) {
      throw new BenefitsError(
        "REFUSED",
        `the issued source amount exceeds ${currency}'s configured payable precision`,
      );
    }
    if (
      ctx.program.effectiveFrom > periodFrom ||
      (ctx.program.effectiveTo !== null && ctx.program.effectiveTo < periodTo)
    ) {
      throw new BenefitsError(
        "REFUSED",
        "the source period falls outside the program's effective window",
      );
    }
    if (ctx.program.capAmount !== null && toUnits(sourceValue) > toUnits(ctx.program.capAmount)) {
      throw new BenefitsError("REFUSED", "the source amount exceeds this program's per-award cap");
    }
    const reusedRequest = (
      await db.execute<{ id: string }>(
        sql`
      select id from hrm_benefit_awards
       where org_id = ${orgId} and program_id = ${programId}
         and source_snapshot #>> '{sourceEvidence,requestKey}' = ${requestKey}
       limit 1
    `,
        "objects",
      )
    )[0];
    if (reusedRequest)
      throw new BenefitsError(
        "REFUSED",
        "requestKey is already bound to another retained source row; review the source selection and use a new request key",
      );

    const overlap = (
      await db.execute<{ id: string }>(
        sql`
      select id from hrm_benefit_awards
       where org_id = ${orgId} and program_id = ${programId}
         and status <> 'voided' and adjusts_award_id is null
         and (${ctx.program.frequency === "project_complete"}
           or (employment_id = ${employmentId}
             and period_from <= ${periodTo}::date
             and (period_to is null or period_to >= ${periodFrom}::date)))
       limit 1
    `,
        "objects",
      )
    )[0];
    if (overlap) {
      throw new BenefitsError(
        "REFUSED",
        ctx.program.frequency === "project_complete"
          ? "this project completion already has a nonvoid original award — correct its history through a linked adjusting award"
          : "this employment already has a nonvoid original award overlapping the source period — correct its history through the linked adjusting-award lifecycle",
      );
    }
    if (ctx.program.budgetAmount !== null) {
      const spent =
        (
          await db.execute<{ total: string | null }>(
            sql`
        select sum(value)::text as total from hrm_benefit_awards
         where org_id = ${orgId} and program_id = ${programId} and status <> 'voided'
      `,
            "objects",
          )
        )[0]?.total ?? null;
      if (
        (spent === null ? 0n : toUnits(spent)) + toUnits(sourceValue) >
        toUnits(ctx.program.budgetAmount)
      ) {
        throw new BenefitsError(
          "REFUSED",
          "the source amount would exceed the program's remaining budget",
        );
      }
    }
    // An exact source-key retry is handled above before this admission test:
    // a changed native preview must refuse as changed history, while an exact
    // retry returns its stored row even if an unrelated later calculation
    // now makes this employment payable natively.
    if (
      result.computation?.recipients.some(
        (recipient) => recipient.employmentId === employmentId && toUnits(recipient.value) > 0n,
      )
    ) {
      throw new BenefitsError(
        "REFUSED",
        "native measurement already has a payable recipient for this employment — settle the native award instead of recording a source-evidenced first obligation",
      );
    }
    if (isAboveNativeMeasure) {
      if (pmSnapshot === null) {
        throw new BenefitsError(
          "REFUSED",
          "source-paid-above-native-measure requires the locked native project-margin measure for this period — refresh the native preview and review the retained source row again",
        );
      }
      if (pmTargetCarry === null || toUnits(pmTargetCarry) >= 0n) {
        throw new BenefitsError(
          "REFUSED",
          "source-paid-above-native-measure requires a negative project-margin carry-forward for this employment in the locked native measure; a zero result, a threshold miss, or an absent carry is not a negative native measurement",
        );
      }
      if (!pmAffectedProjects.length || pmTargetShareTotal >= 0n) {
        throw new BenefitsError(
          "REFUSED",
          "source-paid-above-native-measure requires this period's native project-margin measure to value this employment's project shares below zero — a carry inherited from an earlier period alone does not establish a negative measure for this period",
        );
      }
      const sharedProject = pmAffectedProjects.find((project) => project.shares.length > 1);
      if (sharedProject) {
        throw new BenefitsError(
          "REFUSED",
          `source-paid-above-native-measure cannot partially consume project ${sharedProject.projectId}, whose native shares belong to several recipients — the whole-project paid set cannot consume only this employment's share; preserve the retained source evidence and route this shared-project exception through governed review so every recipient's share is decided together`,
        );
      }
    } else if (result.computation === null || toUnits(result.computation.totalAwarded) <= 0n) {
      throw new BenefitsError(
        "REFUSED",
        "missing-source-identity requires a positive native incentive pool for other recipients and no payable result for this employment; a loss or threshold miss is not a missing identity",
      );
    }
    const admission = mintSourceEvidenceAdmission({
      executor: pinnedTransactionExecutor() ?? db,
      facts: {
        orgId,
        actorId,
        programId,
        programRevision: currentProgramRevision,
        employmentId,
        legalPayerId: ctx.program.legalEntityId,
        periodFrom,
        periodTo,
        currency,
        value: normalizeMoney(sourceValue),
        sourceKey,
        requestKey,
        sourceEvidenceClass: query.sourceEvidenceClass,
        sourcePaidDate,
      },
      snapshot: sourceSnapshot,
    });
    return recordSourceEvidencedFirstAward({
      orgId,
      actorId,
      programId,
      employmentId,
      periodFrom,
      periodTo,
      value: normalizeMoney(sourceValue),
      currency,
      evidence: ownRecipientEvidence,
      sourceKey,
      sourceEvidenceSnapshot: admission.snapshot,
      sourceEvidenceAdmission: admission.token,
    });
  });
}

/**
 * Settle a period: lock, freeze facts, and record one draft award per
 * payable recipient, atomically and idempotently. A retried settlement
 * returns the existing awards when revision, sources, and values match;
 * anything else refuses and directs corrections to adjusting awards.
 * Awards are created draft; submission applies the configured native Flows
 * policy, whether explicit direct processing or one or more approval gates.
 */
export async function settleIncentivePeriod(
  query: SettleIncentivePeriodQuery,
): Promise<SettledPeriod> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const programId = requireId(query.programId, "programId");
  return withOrgTransaction(orgId, async () => {
    const scope = await requireAggregateBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    // Freeze the program row first: every read below (config, members,
    // sources) and every award created from them shares this lock, so a
    // concurrent edit waits and a revision bump cannot slip between the
    // measure and the writes.
    const locked = requireOneRow(
      await db.execute<{ revision: number }>(
        sql`
        select revision from hrm_benefit_programs
         where org_id = ${orgId} and id = ${programId}
         for update
      `,
        "objects",
      ),
      "locking the benefit program",
    );
    void locked;
    // Serialize overlapping settlers on a transaction-scoped advisory lock;
    // the row lock above already orders writers, this names the period.
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtext(${"benefit_settle:" + programId + ":" + query.periodFrom + ":" + query.periodTo}))
    `);
    const ctx = await loadSettlementContext(
      orgId,
      actorId,
      programId,
      scope,
      true,
      query.periodFrom,
      query.periodTo,
    );
    // Closed periods only: settling a future or open span would freeze
    // incomplete sources as obligations. A period ending today is still
    // incomplete — preview it as an estimate until tomorrow.
    const today = await businessTodayInTx(db, orgId);
    if (query.periodTo >= today) {
      throw new BenefitsError(
        "REFUSED",
        `period ends ${query.periodTo} (today ${today}) — settle closed periods only; preview this span as an estimate until it closes`,
      );
    }
    const result = await measureAndCompute(
      orgId,
      actorId,
      ctx,
      query.periodFrom,
      query.periodTo,
      query.asOf === undefined ? undefined : requireCivilDate(query.asOf, "asOf"),
    );
    const { computation } = result;
    if (computation.totalAwarded === "0.0000") {
      throw new BenefitsError(
        "REFUSED",
        `settlement of ${query.periodFrom}..${query.periodTo} owes nothing (${computation.summaryLines[computation.summaryLines.length - 1] ?? "no awards"}) — no zero awards are recorded; a recorded zero is a no-op write`,
      );
    }
    for (const recipient of computation.recipients) {
      if (recipient.value === "0.0000") {
        throw new BenefitsError(
          "REFUSED",
          `settlement values ${recipient.employmentId} at zero — zero awards are never recorded; narrow the membership or correct the evidence`,
        );
      }
    }
    const prefix = settleKeyPrefix(
      ctx.program.id,
      query.periodFrom,
      query.periodTo,
      ctx.program.revision,
    );
    // Full-set overlap read, straight from storage: the list endpoint
    // pages, so settlement compares the whole overlapping set directly — a
    // 501st award must never slip past the check. Any non-voided award
    // whose span touches this span overlaps; only the exact same span may
    // retry, and only when the frozen facts still match bit for bit.
    const overlapping = await db.execute<Record<string, unknown>>(
      sql`
      select a.id as id, a.employment_id as "employmentId",
             a.period_from::text as "periodFrom", a.period_to::text as "periodTo",
             a.value::text as "value", a.source_key as "sourceKey",
             a.evidence, a.source_snapshot as "sourceSnapshot"
        from hrm_benefit_awards a
       where a.org_id = ${orgId} and a.program_id = ${programId}
         and a.status <> 'voided' and a.adjusts_award_id is null
         and (${ctx.program.frequency === "project_complete"}
           or (a.period_from <= ${query.periodTo}::date
             and (a.period_to is null or a.period_to >= ${query.periodFrom}::date)))
    `,
      "objects",
    );
    const exact = overlapping.filter(
      (row) =>
        String(row.periodFrom).slice(0, 10) === query.periodFrom &&
        (row.periodTo != null ? String(row.periodTo).slice(0, 10) : null) === query.periodTo,
    );
    const others = overlapping.filter((row) => !exact.includes(row));
    if (others.length > 0) {
      throw new BenefitsError(
        "REFUSED",
        ctx.program.frequency === "project_complete"
          ? "this program's project completion was already settled on another span — retry that exact span or record a linked adjusting award; completion does not authorize a second settlement"
          : `${others.length} settled award(s) overlap ${query.periodFrom}..${query.periodTo} on a different span — overlapping spans never settle twice; settle the exact span again or correct history with adjusting awards`,
      );
    }
    if (exact.length > 0) {
      const expectedKeys = new Set(
        computation.recipients.map((r) => `${prefix}:${r.employmentId}`),
      );
      const existingKeys = new Set(
        exact.map((a) => (a.sourceKey != null ? String(a.sourceKey) : null)),
      );
      const sameKeys =
        existingKeys.size === expectedKeys.size &&
        [...expectedKeys].every((k) => existingKeys.has(k));
      const persisted = exact.map((a) => {
        const snap = a.sourceSnapshot as Record<string, Record<string, unknown>> | null;
        return (snap?.measurement?.settlement ?? null) as Record<string, unknown> | null;
      });
      const current = buildSourceSnapshot(ctx, query, result, computation, result.excluded);
      const sameFacts =
        sameKeys &&
        persisted.every((snap) => snap !== null && settlementSnapshotsMatch(snap, current)) &&
        exact.every((a) => {
          const recipient = computation.recipients.find(
            (r) => `${prefix}:${r.employmentId}` === String(a.sourceKey),
          );
          return recipient !== undefined && recipient.value === String(a.value);
        });
      if (sameFacts) {
        // Idempotent retry: the same facts already landed — return the
        // stored rows (re-read through the scoped getter), never duplicates.
        const awards: BenefitAward[] = [];
        for (const row of exact) {
          awards.push(await getBenefitAward(db, orgId, actorId, String(row.id)));
        }
        return { awards, preview: await buildPreview(orgId, actorId, ctx, query, result) };
      }
      throw new BenefitsError(
        "REFUSED",
        `period ${query.periodFrom}..${query.periodTo} already settled ${exact.length} award(s) with different facts — settled history is never rewritten; record corrections as adjusting awards naming the original`,
      );
    }
    // Full frozen measure persists once, in source_snapshot (DSAR-excluded,
    // manager eyes only); per-award evidence carries the recipient's own
    // computation proof.
    const measurement = buildSourceSnapshot(ctx, query, result, computation, result.excluded);
    const awards: BenefitAward[] = [];
    for (const recipient of computation.recipients) {
      const award = await recordSettledAward({
        orgId,
        actorId,
        programId: ctx.program.id,
        employmentId: recipient.employmentId,
        periodFrom: query.periodFrom,
        periodTo: query.periodTo,
        value: recipient.value,
        currency: computation.currency,
        evidence: {
          ...buildEvidence(ctx, query, computation),
          computation: {
            value: recipient.value,
            capped: recipient.capped,
          },
        },
        sourceKey: `${prefix}:${recipient.employmentId}`,
        settlementMeasurement: measurement,
      });
      awards.push(award);
    }
    return { awards, preview: await buildPreview(orgId, actorId, ctx, query, result) };
  });
}

/**
 * Canonical frozen measure, shaped for the award service's source_snapshot:
 * program identity and revision, named basis, full money or hours facts
 * (totals, digest, book, entry ids, accounts), and the computation lines.
 * Manager eyes only.
 */
export function buildSourceSnapshot(
  ctx: SettlementContext,
  query: PreviewIncentiveSettlementQuery,
  result: {
    moneySnapshot: MoneySourceSnapshot | null;
    hoursSnapshot: HoursSourceSnapshot | null;
    transactionSnapshot?: TransactionSettlementSnapshot;
    projectMarginSnapshot?: ProjectMarginSnapshot;
  },
  computation: IncentiveComputation,
  excluded: readonly string[],
): Record<string, unknown> {
  const money = result.moneySnapshot;
  const hours = result.hoursSnapshot;
  const attribution = (hours?.hoursByEmployment ?? [])
    .map((r) => `${r.employmentId}=${r.hours}`)
    .sort()
    .join("|");
  return {
    kind: "incentive-measure",
    programRevision: ctx.program.revision,
    programCode: ctx.program.code,
    programName: ctx.program.name,
    periodBasis: ctx.basis,
    fiscalCalendarId: ctx.fiscalCalendarId,
    projectCompletion: ctx.projectCompletion,
    metric:
      result.projectMarginSnapshot?.metric ??
      result.transactionSnapshot?.metric ??
      money?.metric ??
      "approved_hours",
    ...(result.transactionSnapshot ? { transaction: result.transactionSnapshot } : {}),
    ...(result.projectMarginSnapshot ? { projectMargin: result.projectMarginSnapshot } : {}),
    scope:
      result.projectMarginSnapshot?.scope ??
      result.transactionSnapshot?.scope ??
      money?.scope ??
      hours?.scope ??
      null,
    measuredValue: computation.measuredValue,
    poolValue: computation.poolValue,
    currency: computation.currency,
    minorUnits: ctx.minorUnits,
    bookId: money?.bookId ?? null,
    digest:
      result.projectMarginSnapshot?.digest ??
      result.transactionSnapshot?.digest ??
      money?.digest ??
      createHash("sha256")
        .update(
          `${hours?.entryIds.join(",") ?? ""}#${hours?.totalHours ?? ""}#${attribution}`,
          "utf8",
        )
        .digest("hex"),
    entryIds: [
      ...(result.transactionSnapshot
        ? new Set(result.transactionSnapshot.source.lines.map((line) => line.documentId))
        : (money?.entryIds ?? hours?.entryIds ?? [])),
    ].sort(),
    entryCount:
      result.transactionSnapshot?.entryCount ?? money?.entryCount ?? hours?.entryCount ?? 0,
    lineCount: result.transactionSnapshot?.lineCount ?? money?.lineCount ?? hours?.entryCount ?? 0,
    maxStamp: money?.maxPostedAt ?? hours?.maxApprovedAt ?? null,
    revenueTotal: money?.revenueTotal ?? null,
    expenseTotal: money?.expenseTotal ?? null,
    totalHours: hours?.totalHours ?? null,
    hoursAttribution: (hours?.hoursByEmployment ?? [])
      .map((r) => ({ employmentId: r.employmentId, hours: r.hours }))
      .sort((a, b) => (a.employmentId < b.employmentId ? -1 : 1)),
    memberships: ctx.members
      .map((m) => ({
        employmentId: m.employmentId,
        effectiveFrom: m.effectiveFrom,
        effectiveTo: m.effectiveTo,
        weight: m.weight,
        role: m.role,
      }))
      .sort((a, b) => (a.employmentId < b.employmentId ? -1 : 1)),
    postingFacts: money?.postingFacts ?? [],
    approvedHoursFacts: hours?.approvedHoursFacts ?? [],
    sourceAccounts: [...ctx.revenueAccountIds, ...ctx.expenseAccountIds].sort(),
    legalEntityId: ctx.program.legalEntityId,
    excludedMembers: [...excluded].sort(),
    recipients: computation.recipients,
    summaryLines: computation.summaryLines,
  };
}

function buildNonpayableNativeMeasureSnapshot(
  ctx: SettlementContext,
  query: PreviewIncentiveSettlementQuery,
  result: NonpayableLossIncentiveSources,
  reason: string,
): Record<string, unknown> {
  return {
    kind: "incentive-native-measure-without-award",
    programRevision: ctx.program.revision,
    programCode: ctx.program.code,
    periodFrom: query.periodFrom,
    periodTo: query.periodTo,
    asOf: query.asOf ?? null,
    periodBasis: ctx.basis,
    fiscalCalendarId: ctx.fiscalCalendarId,
    metric: result.measured.metric,
    measured: result.measured,
    measuredSource:
      result.projectMarginSnapshot ??
      result.transactionSnapshot ??
      result.moneySnapshot ??
      result.hoursSnapshot,
    legalEntityId: ctx.program.legalEntityId,
    memberships: ctx.members
      .map((member) => ({
        employmentId: member.employmentId,
        effectiveFrom: member.effectiveFrom,
        effectiveTo: member.effectiveTo,
        weight: member.weight,
        role: member.role,
        excluded: member.excluded,
      }))
      .sort((left, right) => (left.employmentId < right.employmentId ? -1 : 1)),
    exclusions: [...result.excluded].sort(),
    nonpayableReason: reason,
  };
}

/**
 * Frozen-facts equality: the canonical fields that reproduce the measure.
 * Object key order is ignored; every frozen fact, including attribution
 * and approval stamps, participates in the retry check. Evidence revision alone cannot see a changed
 * line under the same entries — the digest can.
 */
/**
 * Canonicalize a JSON value so structurally identical snapshots compare
 * equal regardless of object key order. PostgreSQL `jsonb` reorders object
 * keys on write, so a persisted snapshot stringified after a round trip
 * never key-matches a freshly built one. Array order is preserved: ordered
 * facts (posting lines, attribution rows) stay order-sensitive.
 */
export function canonicalSnapshotJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSnapshotJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalSnapshotJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function snapshotsMatch(
  persisted: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  return canonicalSnapshotJson(persisted) === canonicalSnapshotJson(current);
}

/**
 * Earlier project-margin evidence predates the explicit cutoff field. Admit
 * that shape only when its original digest and every retained fact match the
 * exact legacy representation of the current calculation.
 */
function settlementSnapshotsMatch(
  persisted: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  if (snapshotsMatch(persisted, current)) return true;
  const oldMargin = persisted.projectMargin;
  const newMargin = current.projectMargin;
  if (
    persisted.metric !== "project_margin" ||
    current.metric !== "project_margin" ||
    oldMargin === null ||
    typeof oldMargin !== "object" ||
    Array.isArray(oldMargin) ||
    newMargin === null ||
    typeof newMargin !== "object" ||
    Array.isArray(newMargin)
  )
    return false;
  const old = oldMargin as Record<string, unknown>;
  const fresh = newMargin as Record<string, unknown>;
  if (
    Object.hasOwn(old, "asOf") ||
    typeof fresh.asOf !== "string" ||
    !isIsoCalendarDate(fresh.asOf) ||
    fresh.metric !== "project_margin" ||
    fresh.scope !== "company" ||
    !Array.isArray(fresh.projects)
  )
    return false;
  const legacyBody = {
    metric: "project_margin",
    scope: "company",
    projects: fresh.projects,
    ...(Object.hasOwn(fresh, "carryForward") ? { carryForward: fresh.carryForward } : {}),
  };
  const currentBody = {
    metric: "project_margin",
    scope: "company",
    asOf: fresh.asOf,
    projects: fresh.projects,
    ...(Object.hasOwn(fresh, "carryForward") ? { carryForward: fresh.carryForward } : {}),
  };
  const digest = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const currentDigest = digest(currentBody);
  if (
    fresh.digest !== currentDigest ||
    current.digest !== currentDigest ||
    !snapshotsMatch(fresh, { ...currentBody, digest: currentDigest })
  )
    return false;
  const legacyDigest = digest(legacyBody);
  return (
    old.digest === legacyDigest &&
    persisted.digest === legacyDigest &&
    snapshotsMatch(persisted, {
      ...current,
      projectMargin: { ...legacyBody, digest: legacyDigest },
      digest: legacyDigest,
    })
  );
}

function buildEvidence(
  ctx: SettlementContext,
  query: PreviewIncentiveSettlementQuery,
  computation: IncentiveComputation,
): Record<string, unknown> {
  // Per-award evidence stays employee-safe: the recipient's own share and
  // explanation, the program revision, and the payable date — never company
  // totals, entry ids, or digests. The full frozen measure (totals, digest,
  // book, entry ids) belongs in source_snapshot, which excludes DSAR export;
  // evidence must not leak company profit into employee-visible reads. The
  // settlement passes the full snapshot to the award service the moment its
  // create call accepts it.
  return {
    kind: "incentive-settlement",
    programRevision: ctx.program.revision,
    programCode: ctx.program.code,
    payableAfter: addCalendarDays(query.periodTo, ctx.program.paymentDelayDays),
    currency: computation.currency,
  };
}

/**
 * Correct settled history without rewriting it: a new draft adjusting
 * award for the same employment and period, linked to the original. The
 * original stays immutable; approval and delivery treat the adjustment as
 * its own award. Signed deltas are native here: a positive value tops up
 * an underpayment, a negative value corrects an overpayment through the
 * same approval and payroll earning-adjustment protections as any award.
 * A caller-minted correction id identifies the request, so equal deltas
 * can be distinct corrections and retries cannot change their evidence.
 */
export async function createAdjustingAward(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly awardId: string;
  readonly correctionId: string;
  readonly value: string;
  readonly reason: string;
  /** Native source row for a settled reissue or correction. */
  readonly sourceReference?: string;
  /** Override the original period only when a source row carries a different paid period. */
  readonly periodFrom?: string;
  readonly periodTo?: string;
}): Promise<BenefitAward> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const awardId = requireId(query.awardId, "awardId");
  const correctionId = requireId(query.correctionId, "correctionId");
  const reason =
    typeof query.reason === "string" && query.reason.trim().length > 0 ? query.reason.trim() : null;
  if (!reason) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "an adjusting award names its reason — the reason is the correction's evidence",
    );
  }
  const sourceReference =
    query.sourceReference === undefined
      ? undefined
      : typeof query.sourceReference === "string" &&
          query.sourceReference.trim().length > 0 &&
          query.sourceReference.trim().length <= 500
        ? query.sourceReference.trim()
        : null;
  if (sourceReference === null) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "an adjustment source reference is empty or longer than 500 characters — use the issuing system's paid-row reference",
    );
  }
  const periodFrom =
    query.periodFrom === undefined ? undefined : requireCivilDate(query.periodFrom, "periodFrom");
  const periodTo =
    query.periodTo === undefined ? undefined : requireCivilDate(query.periodTo, "periodTo");
  if ((periodFrom === undefined) !== (periodTo === undefined)) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "an adjustment period override supplies both start and end dates",
    );
  }
  if (periodFrom !== undefined && periodTo !== undefined && periodTo < periodFrom) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "an adjustment period ends before it starts — correct the source row's paid period",
    );
  }
  if (periodFrom !== undefined && sourceReference === undefined) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "a period override needs its source row reference — bind the dated correction to its original paid row",
    );
  }
  return withOrgTransaction(orgId, async () => {
    await requireAggregateBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const original = await getBenefitAward(db, orgId, actorId, awardId);
    requireOneRow(
      await db.execute(
        sql`
      select id from hrm_benefit_programs where org_id = ${orgId} and id = ${original.programId} for update
    `,
        "objects",
      ),
      "locking the adjustment program",
    );
    if (original.status === "voided") {
      throw new BenefitsError(
        "REFUSED",
        "voided awards stay voided — re-settle the period instead of adjusting a void",
      );
    }
    if (original.status === "draft" || original.status === "pending") {
      throw new BenefitsError(
        "REFUSED",
        `award is ${original.status} — correct it before approval instead; adjusting awards top up settled (approved or later) history`,
      );
    }
    let delta: string;
    try {
      const exact = canonicalDecimal(String(query.value), 4);
      if (exact === null) throw new Error("not exact");
      delta = normalizeMoney(exact);
    } catch {
      throw new BenefitsError(
        "INVALID_INPUT",
        `adjustment value ${JSON.stringify(query.value)} is not an exact decimal amount — record plain digits; negative values correct overpayments`,
      );
    }
    if (delta === "0.0000") {
      throw new BenefitsError(
        "REFUSED",
        "a zero adjustment corrects nothing — record a signed non-zero delta or leave history alone",
      );
    }
    // Caller-stable key: the same correction retried returns the same award.
    const sourceKey = `adjust:${original.id}:${correctionId}`;
    const prior = (
      await db.execute<{ id: string }>(
        sql`
      select id from hrm_benefit_awards
       where org_id = ${orgId} and program_id = ${original.programId} and source_key = ${sourceKey}
    `,
        "objects",
      )
    )[0];
    if (prior) {
      const recorded = await getBenefitAward(db, orgId, actorId, String(prior.id));
      if (
        recorded.value !== delta ||
        recorded.adjustsAwardId !== original.id ||
        recorded.evidence?.reason !== reason ||
        recorded.evidence?.sourceReference !== sourceReference ||
        recorded.periodFrom !== (periodFrom ?? original.periodFrom) ||
        recorded.periodTo !== (periodTo ?? original.periodTo)
      ) {
        throw new BenefitsError(
          "REFUSED",
          "this correction request was already recorded with different details — retain its original evidence and use a new correction request for a separate change",
        );
      }
      return recorded;
    }
    const adjustment = {
      orgId,
      actorId,
      programId: original.programId,
      employmentId: original.employmentId,
      periodFrom: periodFrom ?? original.periodFrom,
      periodTo: periodTo ?? original.periodTo,
      value: delta,
      currency: original.currency,
      evidence: {
        kind: "incentive-adjustment",
        direction: delta.startsWith("-") ? "recovery" : sourceReference ? "reissue" : "topup",
        supersedes: original.id,
        supersededValue: original.value,
        ...(sourceReference ? { sourceReference } : {}),
        computation: {
          share: "adjustment",
          grossValue: delta,
          value: delta,
          capped: false,
          explanation: `${delta.startsWith("-") ? "overpayment recovery" : sourceReference ? "source-bound reissue" : "underpayment top-up"} of ${delta} against award ${original.id}: ${reason}`,
        },
        reason,
      },
      sourceKey,
      adjustsAwardId: original.id,
      settlementMeasurement: null,
    };
    return periodFrom !== undefined && periodTo !== undefined
      ? recordSourceBoundAdjustingAward(adjustment, {
          sourceReference: sourceReference!,
          periodFrom,
          periodTo,
        })
      : recordSettledAward(adjustment);
  });
}

export interface QueueAwardForPayRunQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly awardId: string;
  readonly runDocumentId: string;
}

/**
 * Release an approved payroll award onto a pay run: one idempotent line
 * adjustment on the program's earning component, then approved → queued.
 * The adjustment key derives from (award, run), so a retry replays the
 * same row and a second run refuses rather than double-paying (the award
 * is already queued). Provider benefits use non-cash earning inputs so their
 * configured statutory treatment reaches the same payroll calculation.
 */
export async function queueAwardForPayRun(
  query: QueueAwardForPayRunQuery,
): Promise<{ award: BenefitAward; adjustmentId: string; runDocumentId: string }> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const awardId = requireId(query.awardId, "awardId");
  const runDocumentId = requireId(query.runDocumentId, "runDocumentId");
  return withOrgTransaction(orgId, async () => {
    await requireFinanceManage(orgId, actorId);
    await assertHrmEnabled(db, orgId);
    // The native run lock precedes the award lock, matching payroll commit
    // and the award queue/delivery services. No run can commit between
    // adding an input and persisting its award linkage.
    requireOneRow(
      await db.execute(
        sql`
      select r.document_id from pay_runs r join documents d on d.org_id = r.org_id and d.id = r.document_id
       where r.org_id = ${orgId} and r.document_id = ${runDocumentId} for update of r, d
    `,
        "objects",
      ),
      "locking the pay run",
    );
    requireOneRow(
      await db.execute(
        sql`
      select id from hrm_benefit_awards where org_id = ${orgId} and id = ${awardId} for update
    `,
        "objects",
      ),
      "locking the award",
    );
    const award = await getBenefitAward(db, orgId, actorId, awardId);
    if (normalizeMoney(award.value) === "0.0000") {
      throw new BenefitsError(
        "REFUSED",
        award.adjustsAwardId === null
          ? "a zero-value reward cannot enter payroll — void this reward and create a reward with a positive value"
          : "a zero-value adjustment cannot enter payroll — void this adjustment and record a non-zero signed correction",
      );
    }
    const key = adjustmentKey(awardId, runDocumentId);
    if (award.status === "queued" || award.status === "delivered") {
      const replay = await queueBenefitAward({
        orgId,
        actorId,
        awardId,
        payRunDocumentId: runDocumentId,
        payRunAdjustmentId: key,
      });
      return { award: replay, adjustmentId: key, runDocumentId };
    }
    if (award.status !== "approved") {
      throw new BenefitsError(
        "BAD_STATE",
        `award is ${award.status} — only approved awards queue for payout; approve it first`,
      );
    }
    const program = await readAwardDeliveryPolicy(db, orgId, actorId, awardId);
    if (program.payComponentId === null) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} links no pay component — link the earning component before queuing; payroll never prices an award without one`,
      );
    }
    const employment = requireOneRow(
      await db.execute<{ worker_party_id: string; employer_subsidiary_id: string }>(
        sql`
        select worker_party_id::text as worker_party_id,
               employer_subsidiary_id::text as employer_subsidiary_id
          from worker_employments where org_id = ${orgId} and id = ${award.employmentId}
      `,
        "objects",
      ),
      "the award employment",
    );
    // Component gate mirrors the run-adjustment seam (which enforces it
    // authoritatively): active, earning, adjustable. Jurisdiction follows
    // the component's own statutory flags on the run — the check here
    // refuses a wrong-country component before the run does.
    const component = requireOneRow(
      await db.execute<{
        kind: string;
        is_active: boolean;
        system_key: string | null;
        country: string | null;
        payment_kind: string;
      }>(
        sql`
        select kind, is_active, system_key, country, payment_kind from pay_components
         where org_id = ${orgId} and id = ${program.payComponentId}
      `,
        "objects",
      ),
      "the program pay component",
    );
    if (component.kind !== "earning" || !component.is_active) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} links component ${program.payComponentId}, which is ${component.is_active ? `a ${component.kind}` : "inactive"} — awards pay through an active earning component`,
      );
    }
    const expectedPaymentKind = program.deliveryMethod === "external" ? "non_cash" : "cash";
    if (component.payment_kind !== expectedPaymentKind)
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} requires an active ${expectedPaymentKind === "non_cash" ? "non-cash" : "cash"} earning component — select the matching component in the program before adding it to payroll`,
      );
    if (
      component.system_key !== null &&
      !["base_pay", "overtime", "allowance", "bonus", "vacation_payout"].includes(
        component.system_key,
      )
    ) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} links component ${program.payComponentId} (system ${component.system_key}), which pay runs do not adjust — link an adjustable earning component`,
      );
    }
    const profile = (
      await db.execute<{ country: string | null }>(
        sql`
      select country from employee_payroll_profiles
       where org_id = ${orgId} and employment_id = ${award.employmentId}
       order by created_at desc limit 1
    `,
        "objects",
      )
    )[0];
    if (!profile) {
      throw new BenefitsError(
        "REFUSED",
        "the award employment has no payroll profile — stamp the employee payroll profile before queuing; the run cannot price them without one",
      );
    }
    if (
      component.country !== null &&
      profile.country !== null &&
      component.country !== profile.country
    ) {
      throw new BenefitsError(
        "REFUSED",
        `component ${program.payComponentId} is scoped to ${component.country} but the employment pays in ${profile.country} — link the matching country's component; jurisdiction follows the component`,
      );
    }
    const run = (
      await db.execute<{ run_status: string; document_status: string; pay_date: string }>(
        sql`
      select r.run_status, d.status as document_status, r.pay_date::text as pay_date
        from pay_runs r join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${runDocumentId}
    `,
        "objects",
      )
    )[0];
    if (!run) {
      throw new BenefitsError(
        "NOT_FOUND",
        "pay run not found in this organization — queue the award onto an open run",
      );
    }
    if (run.run_status === "committed" || run.document_status !== "draft") {
      throw new BenefitsError(
        "REFUSED",
        `pay run is ${run.run_status} — queue awards onto an editable draft run; committed runs take corrections, not new awards`,
      );
    }
    // The program's payment delay is honored at release, not just printed
    // on the preview: a run paying before the award is payable refuses.
    const payableAfter = addCalendarDays(
      award.periodTo ?? award.periodFrom,
      program.paymentDelayDays,
    );
    if (run.pay_date < payableAfter) {
      throw new BenefitsError(
        "REFUSED",
        `award is payable after ${payableAfter} but this run pays ${run.pay_date} — queue it onto a run paying on or after the payable date`,
      );
    }
    try {
      await mutatePayRunAdjustment({
        orgId,
        documentId: runDocumentId,
        actorId,
        mutation: {
          action: "add",
          employeePartyId: String(employment.worker_party_id),
          componentId: program.payComponentId,
          amount: award.value,
          note: `Benefit award ${award.id} (${program.code} ${award.periodFrom}..${award.periodTo ?? "open"})`,
          idempotencyKey: key,
        },
      });
    } catch (error) {
      if (error instanceof PayRunAdjustmentIdempotencyConflict) {
        throw new BenefitsError(
          "REFUSED",
          "this award input was already recorded with different details — reconcile the existing run input before releasing another payment",
        );
      }
      if (error instanceof PayrollError) throw new BenefitsError("REFUSED", error.message);
      throw error;
    }
    // The queue service validates and stores the exact native input linkage
    // in the same transaction. Processing later proves payroll consumed it;
    // provider fulfillment remains separate evidence for non-cash value.
    const queued = await queueBenefitAward({
      orgId,
      actorId,
      awardId,
      payRunDocumentId: runDocumentId,
      payRunAdjustmentId: key,
    });
    const stored = (
      await db.execute<{ id: string }>(
        sql`
      select id from pay_run_adjustments where org_id = ${orgId} and id = ${key}
    `,
        "objects",
      )
    )[0];
    if (!stored) {
      throw new BenefitsError(
        "REFUSED",
        "the payout adjustment is missing — nothing was queued; reconcile the native run input before retrying",
      );
    }
    return { award: queued, adjustmentId: String(stored.id), runDocumentId };
  });
}

/**
 * Confirm delivery after the run commits: the domain service re-verifies
 * the adjustment carries this award exactly (employee, component, value)
 * and the run is committed, then marks delivered. Call this only after
 * finalize. This records payroll processing, not bank-payment evidence.
 */
export async function confirmAwardPayrollDelivery(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly awardId: string;
  readonly runDocumentId: string;
  readonly adjustmentId: string;
}): Promise<BenefitAward> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return recordPayrollDelivery({
    orgId,
    actorId,
    awardId: requireId(query.awardId, "awardId"),
    payRunDocumentId: requireId(query.runDocumentId, "runDocumentId"),
    payRunAdjustmentId: requireId(query.adjustmentId, "adjustmentId"),
  });
}

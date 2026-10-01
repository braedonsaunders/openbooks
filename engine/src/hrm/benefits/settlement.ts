import { createHash } from "node:crypto";
import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { normalizeMoney } from "../../money/money.ts";
import { businessTodayInTx } from "../../platform/business-date.ts";
import { sql } from "drizzle-orm";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { PayrollError } from "../../payroll/error.ts";
import { mutatePayRunAdjustment, PayRunAdjustmentIdempotencyConflict } from "../../payroll/run-adjustments.ts";
import { addCalendarDays } from "../../platform/civil-date.ts";
import type {
  BenefitAward,
  BenefitProgram,
  BenefitProgramMember,
} from "./program-types.ts";
import {
  getBenefitAward,
  queueBenefitAward,
  recordPayrollDelivery,
  recordSettledAward,
} from "./awards.ts";
import { requireAggregateBenefitsManage, requireAggregateBenefitsRead } from "../authorization.ts";
import { BenefitsError } from "./errors.ts";
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
import { getBenefitProgram, listProgramMemberships, listProgramSources } from "./programs.ts";
import {
  assertHrmEnabled,
  db,
  requireActorId,
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
 * obligations: only settled award rows (created draft, then approved by a
 * second actor, queued by finance, and marked delivered after the pay run
 * commits) promise payment.
 *
 * Concurrency: settlement holds the program row FOR UPDATE and a
 * transaction-scoped advisory lock over (program, period) — two settlers
 * serialize, and a revision bump between preview and settle is caught by
 * the overlap check (existing awards carry the old revision). Corrections
 * to settled history are new adjusting awards, never rewrites.
 *
 * Delivery uses the native pay-run adjustment seam for payroll programs.
 * External programs never enter a pay run as cash: a cash earning would
 * pay the employee twice, and a bare earning component withholds no tax,
 * so external awards refuse payroll delivery by name until a native
 * tax-only representation exists.
 */

export interface PreviewIncentiveSettlementQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
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
  readonly measured: MoneySourceSnapshot | HoursSourceSnapshot;
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

function settleKeyPrefix(programId: string, periodFrom: string, periodTo: string, revision: number): string {
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
  const row = (await db.execute<{ minor_units: number }>(sql`
    select minor_units from currencies where code = ${currency}
  `)).rows[0];
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
  projectCompletion: ReadonlyArray<{ readonly projectId: string; readonly status: string; readonly updatedAt: string }>;
}

async function loadSettlementContext(
  orgId: string,
  actorId: string,
  programId: string,
  scope: Set<string> | null,
  forSettle: boolean,
): Promise<SettlementContext> {
  const program = await getBenefitProgram(db, orgId, actorId, programId);
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
      `program ${program.code} names no metric — fixed-amount awards are recorded directly, not settled through measurement; configure revenue, gross_profit, net_profit, or approved_hours to settle`,
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
  if (program.metricScope !== "company" && program.scopeIds.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      `program ${program.code} measures ${program.metricScope} scope with no scoped rows — name the ${program.metricScope === "department" ? "departments" : "projects"} before measuring; the base is never the whole company by fallback`,
    );
  }
  if (program.metricScope === "department") {
    const rows = (await db.execute<{ id: string }>(sql`
      select id::text as id from departments
       where org_id = ${orgId} and id = any (${`{${departmentIds.join(",")}}`}::uuid[])
    `)).rows;
    const found = new Set(rows.map((r) => r.id));
    const missing = departmentIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} scopes ${missing.length} department(s) outside this organization — reselect the scope; measures never cross tenants`,
      );
    }
  }

  const projectCompletion: Array<{projectId: string; status: string; updatedAt: string}> = [];
  if (program.frequency === "project_complete") {
    if (program.metricScope !== "project" || projectIds.length === 0) {
      throw new BenefitsError("REFUSED", "project-completion programs name their project scope — select the projects before previewing or settling");
    }
    if (!(await lockAndCheckOrgFeature(db, orgId, "projects"))) {
      throw new BenefitsError("REFUSED", "Projects is off — turn it on in Company Settings → Features before measuring project completion");
    }
    // Keep completion facts fixed through settlement. Project record edits
    // take these same row locks, so reopening cannot race an obligation.
    const projects = (await db.execute<{id: string; status: string; updated_at: string}>(sql`
      select id::text as id, status, updated_at::text as updated_at from projects
       where org_id = ${orgId} and subsidiary_id = ${program.legalEntityId}
         and id = any (${`{${projectIds.join(",")}}`}::uuid[])
       order by id for share
    `)).rows;
    if (projects.length !== new Set(projectIds).size) {
      throw new BenefitsError("NOT_FOUND", "a completion project is not visible in the program's legal entity — review the selected project scope before settling");
    }
    projectCompletion.push(...projects.map((p) => ({projectId: p.id, status: p.status, updatedAt: p.updated_at})));
    const incomplete = projects.filter((p) => p.status !== "closed");
    if (forSettle && incomplete.length > 0) {
      throw new BenefitsError("REFUSED", `${incomplete.length} selected project(s) are not closed — close each selected project in its project record before settling a completion award; substantial completion and cancellation do not authorize payment`);
    }
  }

  // Source accounts split by actual GL type: income measures revenue,
  // costs measure expense. A weight other than full (null or 10000 bps)
  // refuses — the base sums whole accounts and an applied weight would
  // silently scale the base.
  const sources = await listProgramSources(db, orgId, actorId, programId);
  if ((metric === "revenue" || metric === "gross_profit" || metric === "net_profit") && sources.length === 0) {
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
  const accountRows = accountIds.length > 0 ? (await db.execute<{ id: string; type: string }>(sql`
    select id::text as id, type from accounts
     where org_id = ${orgId} and id = any (${`{${accountIds.join(",")}}`}::uuid[])
  `)).rows : [];
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
    else if (type === "cogs" || type === "expense" || type === "expense_other" || type === "expense_deferred") {
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
    const component = (await db.execute<{ expense_account_id: string | null }>(sql`
      select expense_account_id from pay_components where org_id = ${orgId} and id = ${program.payComponentId}
    `)).rows[0];
    if (!component) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} links pay component ${program.payComponentId}, which is outside this organization — relink the component before settling`,
      );
    }
    incentiveExpenseAccountId = component.expense_account_id !== null ? String(component.expense_account_id) : null;
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

  const members = await listProgramMemberships({ orgId, actorId, programId });
  const minorUnits = await currencyMinorUnits(orgId, program.currency);
  return {
    program, scope, basis, fiscalCalendarId, departmentIds, projectIds,
    revenueAccountIds, expenseAccountIds, incentiveExpenseAccountId, minorUnits, members, projectCompletion,
  };
}

async function measureAndCompute(
  orgId: string,
  actorId: string,
  ctx: SettlementContext,
  periodFrom: string,
  periodTo: string,
): Promise<{
  measured: IncentiveMeasured;
  computation: IncentiveComputation;
  excluded: string[];
  moneySnapshot: MoneySourceSnapshot | null;
  hoursSnapshot: HoursSourceSnapshot | null;
}> {
  const { program } = ctx;
  const metric = program.metric!;
  const eligible = eligibleMembers(ctx.members, periodFrom, periodTo);
  const memberEmploymentIds = new Set<string>();
  for (const member of eligible) {
    if (memberEmploymentIds.has(member.employmentId)) {
      throw new BenefitsError("REFUSED", `employment ${member.employmentId} has several membership versions within this period — preview separate manual spans for each effective version; a period never guesses a role weight across versions`);
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
  const excludeZeroHours = (rows: ReadonlyArray<{ employmentId: string; hours: string }>): IncentiveMemberShare[] => {
    const out: IncentiveMemberShare[] = [];
    for (const row of rows) {
      if (program.allocation === "hours" && row.hours === "0.0000") {
        excluded.push(`${row.employmentId}: no approved hours in the period — excluded, never zero-awarded`);
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
      legalEntityId: program.legalEntityId!,
      periodFrom,
      periodTo,
      memberEmploymentIds: [...new Set(eligible.map((m) => m.employmentId))],
      memberPeriods: eligible.map((m) => ({ employmentId: m.employmentId, effectiveFrom: m.effectiveFrom, effectiveTo: m.effectiveTo })),
      allowedSubsidiaryIds: ctx.scope,
    });
    hoursSnapshot = snapshot;
    measured = {
      metric, scope: program.metricScope!, sourceAccountIds: [],
      periodFrom, periodTo, value: snapshot.totalHours, currency: null,
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
      allowedSubsidiaryIds: ctx.scope,
    });
    measured = {
      metric, scope: program.metricScope!, sourceAccountIds: [...snapshot.revenueAccountIds, ...snapshot.expenseAccountIds],
      periodFrom, periodTo, value: snapshot.value, currency: snapshot.currency,
    };
    if (program.allocation === "hours") {
      // Hours shares need their own approved-time read over the same scope.
      const attribution = await measureApprovedHours(db, orgId, actorId, {
        scope: program.metricScope!,
        departmentIds: ctx.departmentIds,
        projectIds: ctx.projectIds,
        legalEntityId: program.legalEntityId!,
        periodFrom,
        periodTo,
        memberEmploymentIds: [...new Set(eligible.map((m) => m.employmentId))],
      memberPeriods: eligible.map((m) => ({ employmentId: m.employmentId, effectiveFrom: m.effectiveFrom, effectiveTo: m.effectiveTo })),
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
  const computation = computeIncentiveAwards({
    program,
    measured,
    shares,
    periodBasis: ctx.basis,
    minorUnits: ctx.minorUnits,
  });
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
    const ctx = await loadSettlementContext(orgId, actorId, programId, scope, false);
    const result = await measureAndCompute(orgId, actorId, ctx, query.periodFrom, query.periodTo);
    return buildPreviewResult(orgId, scope, ctx, query, result);
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
    excluded: string[];
  },
): Promise<IncentivePreview> {
  const visible = scope === null
    ? [...result.computation.recipients]
    : await fenceRecipients(orgId, scope, result.computation);
  const measured = result.moneySnapshot ?? result.hoursSnapshot;
  if (!measured) {
    throw new BenefitsError(
      "REFUSED",
      "settlement measured nothing — the program names no metric source; configure the measure before previewing",
    );
  }
  const sourceSnapshot = buildSourceSnapshot(ctx, query, result, result.computation, result.excluded);
  const today = await businessTodayInTx(db, orgId);
  // A period ending today is still incomplete: estimates until tomorrow.
  const openPeriod = query.periodTo >= today;
  const openProjects = ctx.projectCompletion.filter((p) => p.status !== "closed");
  const isEstimate = openPeriod || openProjects.length > 0;
  const estimateLines = [
    ...(openPeriod ? [`estimate: period ends ${query.periodTo} (today ${today}) — sources are incomplete; settle only after the period closes`] : []),
    ...(openProjects.length > 0 ? [`estimate: ${openProjects.length} selected project(s) are not closed — close each project in its project record before settling a completion award`] : []),
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
    sourceKeyPrefix: settleKeyPrefix(ctx.program.id, query.periodFrom, query.periodTo, ctx.program.revision),
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
  const rows = (await db.execute<{ id: string; employer_subsidiary_id: string }>(sql`
    select id::text as id, employer_subsidiary_id::text as employer_subsidiary_id
      from worker_employments
     where org_id = ${orgId} and id = any (${`{${ids.join(",")}}`}::uuid[])
  `)).rows;
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
    excluded: string[];
  },
): Promise<IncentivePreview> {
  const scope = await requireAggregateBenefitsRead(db, orgId, actorId);
  return buildPreviewResult(orgId, scope, ctx, query, result);
}

/**
 * Settle a period: lock, freeze facts, and record one draft award per
 * payable recipient, atomically and idempotently. A retried settlement
 * returns the existing awards when revision, sources, and values match;
 * anything else refuses and directs corrections to adjusting awards.
 * Awards are created draft — approval stays with a second actor.
 */
export async function settleIncentivePeriod(query: SettleIncentivePeriodQuery): Promise<SettledPeriod> {
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
      (await db.execute<{ revision: number }>(sql`
        select revision from hrm_benefit_programs
         where org_id = ${orgId} and id = ${programId}
         for update
      `)).rows,
      "locking the benefit program",
    );
    void locked;
    // Serialize overlapping settlers on a transaction-scoped advisory lock;
    // the row lock above already orders writers, this names the period.
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtext(${"benefit_settle:" + programId + ":" + query.periodFrom + ":" + query.periodTo}))
    `);
    const ctx = await loadSettlementContext(orgId, actorId, programId, scope, true);
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
    const result = await measureAndCompute(orgId, actorId, ctx, query.periodFrom, query.periodTo);
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
    const prefix = settleKeyPrefix(ctx.program.id, query.periodFrom, query.periodTo, ctx.program.revision);
    // Full-set overlap read, straight from storage: the list endpoint
    // pages, so settlement compares the whole overlapping set directly — a
    // 501st award must never slip past the check. Any non-voided award
    // whose span touches this span overlaps; only the exact same span may
    // retry, and only when the frozen facts still match bit for bit.
    const overlapping = (await db.execute<Record<string, unknown>>(sql`
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
    `)).rows;
    const exact = overlapping.filter(
      (row) => String(row.periodFrom).slice(0, 10) === query.periodFrom &&
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
      const expectedKeys = new Set(computation.recipients.map((r) => `${prefix}:${r.employmentId}`));
      const existingKeys = new Set(exact.map((a) => a.sourceKey != null ? String(a.sourceKey) : null));
      const sameKeys = existingKeys.size === expectedKeys.size && [...expectedKeys].every((k) => existingKeys.has(k));
      const persisted = exact.map((a) => {
        const snap = a.sourceSnapshot as Record<string, Record<string, unknown>> | null;
        return (snap?.measurement?.settlement ?? null) as Record<string, unknown> | null;
      });
      const current = buildSourceSnapshot(ctx, query, result, computation, result.excluded);
      const sameFacts = sameKeys && persisted.every((snap) => snap !== null && snapshotsMatch(snap, current)) &&
        exact.every((a) => {
          const recipient = computation.recipients.find((r) => `${prefix}:${r.employmentId}` === String(a.sourceKey));
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
  result: { moneySnapshot: MoneySourceSnapshot | null; hoursSnapshot: HoursSourceSnapshot | null },
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
    metric: money?.metric ?? "approved_hours",
    scope: money?.scope ?? hours?.scope ?? null,
    measuredValue: computation.measuredValue,
    poolValue: computation.poolValue,
    currency: computation.currency,
    minorUnits: ctx.minorUnits,
    bookId: money?.bookId ?? null,
    digest: money?.digest ?? createHash("sha256")
      .update(`${hours?.entryIds.join(",") ?? ""}#${hours?.totalHours ?? ""}#${attribution}`, "utf8")
      .digest("hex"),
    entryIds: [...(money?.entryIds ?? hours?.entryIds ?? [])].sort(),
    entryCount: money?.entryCount ?? hours?.entryCount ?? 0,
    lineCount: money?.lineCount ?? hours?.entryCount ?? 0,
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
}): Promise<BenefitAward> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const awardId = requireId(query.awardId, "awardId");
  const correctionId = requireId(query.correctionId, "correctionId");
  const reason = typeof query.reason === "string" && query.reason.trim().length > 0 ? query.reason.trim() : null;
  if (!reason) {
    throw new BenefitsError("INVALID_INPUT", "an adjusting award names its reason — the reason is the correction's evidence");
  }
  return withOrgTransaction(orgId, async () => {
    await requireAggregateBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const original = await getBenefitAward(db, orgId, actorId, awardId);
    requireOneRow((await db.execute(sql`
      select id from hrm_benefit_programs where org_id = ${orgId} and id = ${original.programId} for update
    `)).rows, "locking the adjustment program");
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
    const prior = (await db.execute<{ id: string }>(sql`
      select id from hrm_benefit_awards
       where org_id = ${orgId} and program_id = ${original.programId} and source_key = ${sourceKey}
    `)).rows[0];
    if (prior) {
      const recorded = await getBenefitAward(db, orgId, actorId, String(prior.id));
      if (recorded.value !== delta || recorded.adjustsAwardId !== original.id || recorded.evidence?.reason !== reason) {
        throw new BenefitsError("REFUSED", "this correction request was already recorded with different details — retain its original evidence and use a new correction request for a separate change");
      }
      return recorded;
    }
    return recordSettledAward({
      orgId,
      actorId,
      programId: original.programId,
      employmentId: original.employmentId,
      periodFrom: original.periodFrom,
      periodTo: original.periodTo,
      value: delta,
      currency: original.currency,
      evidence: {
        kind: "incentive-adjustment",
        direction: delta.startsWith("-") ? "recovery" : "topup",
        supersedes: original.id,
        supersededValue: original.value,
        computation: {
          share: "adjustment",
          grossValue: delta,
          value: delta,
          capped: false,
          explanation: `${delta.startsWith("-") ? "overpayment recovery" : "underpayment top-up"} of ${delta} against award ${original.id}: ${reason}`,
        },
        reason,
      },
      sourceKey,
      adjustsAwardId: original.id,
      settlementMeasurement: null,
    });
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
 * is already queued). External programs never reach a pay run: no cash
 * leg, no tax guess.
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
    requireOneRow((await db.execute(sql`
      select r.document_id from pay_runs r join documents d on d.org_id = r.org_id and d.id = r.document_id
       where r.org_id = ${orgId} and r.document_id = ${runDocumentId} for update of r, d
    `)).rows, "locking the pay run");
    requireOneRow((await db.execute(sql`
      select id from hrm_benefit_awards where org_id = ${orgId} and id = ${awardId} for update
    `)).rows, "locking the award");
    const award = await getBenefitAward(db, orgId, actorId, awardId);
    const key = adjustmentKey(awardId, runDocumentId);
    if (award.status === "queued" || award.status === "delivered") {
      const replay = await queueBenefitAward({ orgId, actorId, awardId, payRunDocumentId: runDocumentId, payRunAdjustmentId: key });
      return { award: replay, adjustmentId: key, runDocumentId };
    }
    if (award.status !== "approved") {
      throw new BenefitsError(
        "BAD_STATE",
        `award is ${award.status} — only approved awards queue for payout; approve it first`,
      );
    }
    const program = await getBenefitProgram(db, orgId, actorId, award.programId);
    if (program.deliveryMethod !== "payroll") {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} delivers externally — no cash leg ever enters a pay run (it would pay the employee twice), and a bare earning component withholds no tax. Record the provider's own reference through external delivery; tax on this non-cash value has no native payroll representation yet — classify it with payroll before relying on this record for tax`,
      );
    }
    if (program.payComponentId === null) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} links no pay component — link the earning component before queuing; payroll never prices an award without one`,
      );
    }
    const employment = requireOneRow(
      (await db.execute<{ worker_party_id: string; employer_subsidiary_id: string }>(sql`
        select worker_party_id::text as worker_party_id,
               employer_subsidiary_id::text as employer_subsidiary_id
          from worker_employments where org_id = ${orgId} and id = ${award.employmentId}
      `)).rows,
      "the award employment",
    );
    // Component gate mirrors the run-adjustment seam (which enforces it
    // authoritatively): active, earning, adjustable. Jurisdiction follows
    // the component's own statutory flags on the run — the check here
    // refuses a wrong-country component before the run does.
    const component = requireOneRow(
      (await db.execute<{
        kind: string; is_active: boolean; system_key: string | null; country: string | null;
      }>(sql`
        select kind, is_active, system_key, country from pay_components
         where org_id = ${orgId} and id = ${program.payComponentId}
      `)).rows,
      "the program pay component",
    );
    if (component.kind !== "earning" || !component.is_active) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} links component ${program.payComponentId}, which is ${component.is_active ? `a ${component.kind}` : "inactive"} — awards pay through an active earning component`,
      );
    }
    if (component.system_key !== null && !["base_pay", "overtime", "allowance", "bonus", "vacation_payout"].includes(component.system_key)) {
      throw new BenefitsError(
        "REFUSED",
        `program ${program.code} links component ${program.payComponentId} (system ${component.system_key}), which pay runs do not adjust — link an adjustable earning component`,
      );
    }
    const profile = (await db.execute<{ country: string | null }>(sql`
      select country from employee_payroll_profiles
       where org_id = ${orgId} and employment_id = ${award.employmentId}
       order by created_at desc limit 1
    `)).rows[0];
    if (!profile) {
      throw new BenefitsError(
        "REFUSED",
        "the award employment has no payroll profile — stamp the employee payroll profile before queuing; the run cannot price them without one",
      );
    }
    if (component.country !== null && profile.country !== null && component.country !== profile.country) {
      throw new BenefitsError(
        "REFUSED",
        `component ${program.payComponentId} is scoped to ${component.country} but the employment pays in ${profile.country} — link the matching country's component; jurisdiction follows the component`,
      );
    }
    const run = (await db.execute<{ run_status: string; document_status: string; pay_date: string }>(sql`
      select r.run_status, d.status as document_status, r.pay_date::text as pay_date
        from pay_runs r join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${runDocumentId}
    `)).rows[0];
    if (!run) {
      throw new BenefitsError("NOT_FOUND", "pay run not found in this organization — queue the award onto an open run");
    }
    if (run.run_status === "committed" || run.document_status !== "draft") {
      throw new BenefitsError(
        "REFUSED",
        `pay run is ${run.run_status} — queue awards onto an editable draft run; committed runs take corrections, not new awards`,
      );
    }
    // The program's payment delay is honored at release, not just printed
    // on the preview: a run paying before the award is payable refuses.
    const payableAfter = addCalendarDays(award.periodTo ?? award.periodFrom, program.paymentDelayDays);
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
    // in the same transaction. Delivery later proves that input was paid.
    const queued = await queueBenefitAward({ orgId, actorId, awardId, payRunDocumentId: runDocumentId, payRunAdjustmentId: key });
    const stored = (await db.execute<{ id: string }>(sql`
      select id from pay_run_adjustments where org_id = ${orgId} and id = ${key}
    `)).rows[0];
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
 * finalize — delivered means paid.
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

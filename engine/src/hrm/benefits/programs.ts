import { readTransactionPolicy, validateTransactionPolicy, requireTransactionPolicyStorage } from "./transaction-policy.ts";
import { requireBenefitCurrency } from "./currency-options.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { cmp, fitsLedgerRange, normalizeMoney } from "../../money/money.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { businessTodayInTx } from "../../platform/business-date.ts";
import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { moneyRefusal } from "../../money/decimal-refusal.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import {
  requireAggregateBenefitsRead,
  requireHrmBenefitsManage,
  requireHrmBenefitsManageOnEmployment,
} from "../authorization.ts";
import { benefitListWindow } from "./list-window.ts";
import { BenefitsError, isUniqueViolation } from "./errors.ts";
import {
  assertHrmEnabled,
  requireActorId,
  requireCivilDate,
  requireId,
  requireOneRow,
  requireOrgId,
} from "./shared.ts";
import type {
  BenefitAllocation,
  BenefitApprovalMode,
  BenefitDeliveryMethod,
  BenefitFrequency,
  BenefitMetric,
  BenefitMetricScope,
  BenefitPeriodBasis,
  BenefitProgram,
  BenefitProgramFamily,
  BenefitProgramMember,
  BenefitProgramStatus,
  BenefitValuation,
} from "./program-types.ts";
import {
  BENEFIT_ALLOCATIONS,
  BENEFIT_DELIVERY_METHODS,
  BENEFIT_FREQUENCIES,
  BENEFIT_METRIC_SCOPES,
  BENEFIT_METRICS,
  BENEFIT_PROGRAM_FAMILIES,
  BENEFIT_PROGRAM_STATUSES,
  BENEFIT_VALUATIONS,
} from "./program-types.ts";

/**
 * Employer-defined benefit program service.
 *
 * Existing insured plans (hrm_benefit_plans) stay authoritative for health
 * and retirement; this service owns the separate employer-defined program
 * model (rewards, allowances, incentives, custom). Rule configuration is
 * typed columns and child rows, never mutable JSON rules; snapshot JSON
 * carries evidence only. Every write locks its program row, checks the
 * affected row count, and appends audit_log evidence with actor, timestamp,
 * and before/after state.
 */

// Re-export the shared vocabulary so callers import one module.
export type {
  BenefitAllocation,
  BenefitApprovalMode,
  BenefitDeliveryMethod,
  BenefitFrequency,
  BenefitMetric,
  BenefitMetricScope,
  BenefitPeriodBasis,
  BenefitProgram,
  BenefitProgramFamily,
  BenefitProgramMember,
  BenefitProgramStatus,
  BenefitValuation,
} from "./program-types.ts";

const PROGRAM_COLUMNS = sql`id, code, name, family,
  description, legal_entity_id as "legalEntityId", currency, status,
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
  pay_component_id as "payComponentId",
  approval_mode as "approvalMode", delivery_method as "deliveryMethod", valuation,
  metric, metric_scope as "metricScope",
  allocation, period_basis as "periodBasis", percent_rate::text as "percentRate",
  fixed_amount::text as "fixedAmount", cap_amount::text as "capAmount",
  budget_amount::text as "budgetAmount", threshold_amount::text as "thresholdAmount",
  frequency, payment_delay_days as "paymentDelayDays",
  revision, created_by as "createdBy", updated_by as "updatedBy"`;

function asFamily(value: unknown, field: string): BenefitProgramFamily {
  if (
    value === "reward" ||
    value === "allowance" ||
    value === "incentive" ||
    value === "custom"
  ) {
    return value;
  }
  throw new BenefitsError(
    "INVALID_INPUT",
    `${field} is one of reward, allowance, incentive, custom — insured health and retirement stay on benefit plans, not programs`,
  );
}

function asStatus(value: unknown): BenefitProgramStatus {
  if (value === "draft" || value === "active" || value === "closed") return value;
  throw new BenefitsError("REFUSED", "benefit program carries an unknown status — reload and retry");
}

function asApprovalMode(value: unknown): BenefitApprovalMode {
  if (value === "none" || value === "flows") return value;
  throw new BenefitsError("INVALID_INPUT", "approvalMode is none or flows — choose no approvals or native Flows approval for this program");
}

function asDelivery(value: unknown): BenefitDeliveryMethod {
  if (value === "payroll" || value === "external") return value;
  throw new BenefitsError(
    "INVALID_INPUT",
    "deliveryMethod is payroll or external — payroll pays through pay-run inputs, external records a provider reference",
  );
}

function asValuation(value: unknown): BenefitValuation {
  if (value === "fixed" || value === "percent" || value === "pool" || value === "per_unit") return value;
  throw new BenefitsError("INVALID_INPUT", "valuation is fixed, percent, pool, or per_unit");
}

function asMetric(value: unknown): BenefitMetric | null {
  if (value === null || value === undefined) return null;
  if (
    value === "revenue" ||
    value === "gross_profit" ||
    value === "net_profit" ||
    value === "approved_hours" || value === "transactions"
  ) {
    return value;
  }
  throw new BenefitsError(
    "INVALID_INPUT",
    "metric is revenue, gross_profit, net_profit, approved_hours, or transactions",
  );
}

function asMetricScope(value: unknown): BenefitMetricScope | null {
  if (value === null || value === undefined) return null;
  if (value === "company" || value === "department" || value === "project") return value;
  throw new BenefitsError("INVALID_INPUT", "metricScope is company, department, or project");
}

function asAllocation(value: unknown): BenefitAllocation {
  if (value === "equal" || value === "hours" || value === "role" || value === "responsibility") return value;
  throw new BenefitsError("INVALID_INPUT", "allocation is equal, hours, role, or responsibility");
}

function asPeriodBasis(value: unknown): BenefitPeriodBasis | null {
  if (value === null || value === undefined) return null;
  if (value === "calendar" || value === "fiscal") return value;
  throw new BenefitsError("REFUSED", "benefit program carries an unknown period basis — reload and retry");
}

function asFrequency(value: unknown): BenefitFrequency {
  if (
    value === "monthly" ||
    value === "quarterly" ||
    value === "annual" ||
    value === "project_complete" ||
    value === "manual"
  ) {
    return value;
  }
  throw new BenefitsError(
    "INVALID_INPUT",
    "frequency is monthly, quarterly, annual, project_complete, or manual",
  );
}

function canonicalAmount(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw new BenefitsError("INVALID_INPUT", moneyRefusal(field, value, "an amount"));
  }
  const canonical = normalizeMoney(exact);
  if (!fitsLedgerRange(canonical)) {
    throw new BenefitsError("INVALID_INPUT", "the amount exceeds the ledger's 15 whole-digit limit — enter a smaller exact amount");
  }
  if (canonical.startsWith("-")) {
    throw new BenefitsError("INVALID_INPUT", `${field} is a non-negative amount in plan currency`);
  }
  return canonical;
}

async function loadProgramScopes(
  exec: SqlExecutor,
  orgId: string,
  programId: string,
): Promise<string[]> {
  const rows = (
    await exec.execute<{ department_id: string | null; project_id: string | null }>(sql`
      select department_id, project_id from hrm_benefit_program_scopes
       where org_id = ${orgId} and program_id = ${programId}
       order by department_id, project_id
    `)
  ).rows;
  return rows.map((row) => String(row.department_id ?? row.project_id));
}

function toProgram(row: Record<string, unknown>, scopeIds: readonly string[] = []): BenefitProgram {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    family: asFamily(row.family, "family"),
    description: row.description != null ? String(row.description) : null,
    legalEntityId: row.legalEntityId != null ? String(row.legalEntityId) : null,
    currency: String(row.currency),
    status: asStatus(row.status),
    effectiveFrom: String(row.effectiveFrom).slice(0, 10),
    effectiveTo: row.effectiveTo != null ? String(row.effectiveTo).slice(0, 10) : null,
    payComponentId: row.payComponentId != null ? String(row.payComponentId) : null,
    approvalMode: asApprovalMode(row.approvalMode),
    deliveryMethod: asDelivery(row.deliveryMethod),
    valuation: asValuation(row.valuation),
    metric: asMetric(row.metric),
    metricScope: asMetricScope(row.metricScope),
    scopeIds: [...scopeIds],
    allocation: asAllocation(row.allocation),
    percentRate: row.percentRate != null ? String(row.percentRate) : null,
    fixedAmount: row.fixedAmount != null ? String(row.fixedAmount) : null,
    capAmount: row.capAmount != null ? String(row.capAmount) : null,
    budgetAmount: row.budgetAmount != null ? String(row.budgetAmount) : null,
    thresholdAmount: row.thresholdAmount != null ? String(row.thresholdAmount) : null,
    frequency: asFrequency(row.frequency),
    periodBasis: asPeriodBasis(row.periodBasis),
    paymentDelayDays: Number(row.paymentDelayDays ?? 0),
    revision: Number(row.revision ?? 1),
    createdBy: row.createdBy != null ? String(row.createdBy) : null,
    updatedBy: row.updatedBy != null ? String(row.updatedBy) : null,
  };
}

/**
 * Load one program; unknown or out-of-scope ids refuse uniformly, never
 * null. Programs anchor to a legal entity on activation; restricted actors
 * see org-wide drafts plus programs of their own entities.
 */
export async function getBenefitProgram(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  programId: string,
): Promise<BenefitProgram> {
  const scope = await requireAggregateBenefitsRead(exec, orgId, actorId);
  await assertHrmEnabled(exec, orgId);
  const row = (
    await exec.execute<Record<string, unknown>>(sql`
      select ${PROGRAM_COLUMNS} from hrm_benefit_programs
       where org_id = ${orgId} and id = ${programId}
    `)
  ).rows[0];
  if (!row) {
    throw new BenefitsError(
      "NOT_FOUND",
      "benefit program not found in this organization — reload the program list and retry",
    );
  }
  const legalEntityId = row.legalEntityId != null ? String(row.legalEntityId) : null;
  if (scope !== null && (legalEntityId === null || !scope.has(legalEntityId))) {
    throw new BenefitsError(
      "NOT_FOUND",
      "benefit program not found in this organization — reload the program list and retry",
    );
  }
  const scopes = await loadProgramScopes(exec, orgId, programId);
  return toProgram(row, scopes);
}

export async function listBenefitPrograms(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly status?: BenefitProgramStatus;
  readonly family?: BenefitProgramFamily;
  readonly limit?: number;
  readonly offset?: number;
}): Promise<{ programs: BenefitProgram[]; total: number }> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (query.status !== undefined && !(BENEFIT_PROGRAM_STATUSES as readonly string[]).includes(query.status)) {
    throw new BenefitsError("INVALID_INPUT", "program status filter is draft, active, or closed");
  }
  if (query.family !== undefined && !(BENEFIT_PROGRAM_FAMILIES as readonly string[]).includes(query.family)) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "program family filter is reward, allowance, incentive, or custom",
    );
  }
  return withOrgTransaction(orgId, async () => {
    const scope = await requireAggregateBenefitsRead(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const { limit, offset } = benefitListWindow(query.limit, query.offset);
    const total = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_benefit_programs
         where org_id = ${orgId}
           ${query.status !== undefined ? sql`and status = ${query.status}` : sql``}
           ${query.family !== undefined ? sql`and family = ${query.family}` : sql``}
           ${scope !== null ? sql`and legal_entity_id = any (${`{${[...scope].join(",")}}`}::uuid[])` : sql``}
      `)
    ).rows[0]?.n ?? 0;
    const rows = (
      await db.execute<Record<string, unknown>>(sql`
        select ${PROGRAM_COLUMNS} from hrm_benefit_programs
         where org_id = ${orgId}
           ${query.status !== undefined ? sql`and status = ${query.status}` : sql``}
           ${query.family !== undefined ? sql`and family = ${query.family}` : sql``}
           ${scope !== null ? sql`and legal_entity_id = any (${`{${[...scope].join(",")}}`}::uuid[])` : sql``}
         order by code
         ${limit !== null ? sql`limit ${limit} offset ${offset}` : sql`offset ${offset}`}
      `)
    ).rows;
    const out: BenefitProgram[] = [];
    for (const row of rows) {
      out.push(toProgram(row, await loadProgramScopes(db, orgId, String(row.id))));
    }
    return { programs: out, total };
  });
}

async function requireLegalEntity(
  exec: SqlExecutor,
  orgId: string,
  legalEntityId: string | null,
): Promise<void> {
  if (legalEntityId === null) return;
  const row = (
    await exec.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and id = ${legalEntityId}
         and is_active and not is_elimination
    `)
  ).rows[0];
  if (!row) {
    throw new BenefitsError(
      "REFUSED",
      "the program names a legal entity outside this organization or not active — choose the active employing subsidiary that owns this program",
    );
  }
}

/**
 * The actor's subsidiary allowlist binds the proposed legal entity: a
 * subsidiary-restricted actor configures only their own entities, never any
 * entity in the org. Unrestricted actors (null) keep every entity.
 */
async function requireLegalEntityVisibleToActor(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  legalEntityId: string | null,
): Promise<void> {
  const scope = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (scope === null) return;
  if (legalEntityId === null) {
    throw new BenefitsError(
      "REFUSED",
      "org-wide programs are configured by unrestricted managers — name an employing subsidiary of your scope in program setup",
    );
  }
  if (!scope.has(legalEntityId)) {
    throw new BenefitsError(
      "NOT_FOUND",
      "benefit program not found in this organization and legal-entity scope — reload the program list and retry",
    );
  }
}

/**
 * Pay-component validation for programs. Payroll delivery requires an
 * earning component (so the value reaches pay through an established
 * taxable representation, never a manual net-pay edit). Provider-delivered
 * value uses an explicit non-cash earning so the same tax machinery sees
 * the benefit without paying its value to the employee a second time.
 */
async function requireProgramPayComponent(
  exec: SqlExecutor,
  orgId: string,
  programCode: string,
  payComponentId: string | null,
  deliveryMethod: BenefitDeliveryMethod,
): Promise<void> {
  if (payComponentId === null) {
    throw new BenefitsError("REFUSED", `program ${programCode} names no pay component — link ${deliveryMethod === "external" ? "a non-cash" : "a cash"} earning component in the program; all valued benefits require their native payroll representation`);
  }
  const row = (
    await exec.execute<{ kind: string; isActive: boolean; paymentKind: string }>(sql`
      select kind, is_active as "isActive", payment_kind as "paymentKind" from pay_components
       where org_id = ${orgId} and id = ${payComponentId}
    `)
  ).rows[0];
  if (!row) {
    throw new BenefitsError(
      "REFUSED",
      `program ${programCode} names a pay component outside this organization — link a component of this org in program setup`,
    );
  }
  if (!row.isActive) {
    throw new BenefitsError(
      "REFUSED",
      `program ${programCode} names an inactive pay component — reactivate the component or link its replacement in program setup`,
    );
  }
  if (row.kind !== "earning") {
    throw new BenefitsError(
      "REFUSED",
      `program ${programCode} names a pay component of kind ${row.kind} — the program component must be kind earning so the value reaches pay with its established tax treatment; relink it in program setup`,
    );
  }
  const expectedKind = deliveryMethod === "external" ? "non_cash" : "cash";
  if (row.paymentKind !== expectedKind) throw new BenefitsError("REFUSED", `program ${programCode} requires a ${expectedKind === "cash" ? "cash" : "non-cash"} earning component — provider benefits must not also pay cash, and payroll rewards must create cash entitlement`);
}

interface ProgramRuleInput {
  readonly family: BenefitProgramFamily;
  readonly deliveryMethod: BenefitDeliveryMethod;
  readonly valuation: BenefitValuation;
  readonly allocation: BenefitAllocation;
  readonly metric: BenefitMetric | null;
  readonly metricScope: BenefitMetricScope | null;
  readonly scopeIds: readonly string[];
  readonly percentRate: string | null;
  readonly fixedAmount: string | null;
  readonly capAmount: string | null;
  readonly budgetAmount: string | null;
  readonly thresholdAmount: string | null;
  readonly frequency: BenefitFrequency;
  readonly periodBasis: BenefitPeriodBasis | null;
  readonly paymentDelayDays: number;
}

/** Every advertised rule must resolve: missing pieces refuse by name. */
function requireResolvableRules(code: string, rules: ProgramRuleInput): void {
  if (rules.metric === "transactions") {
    if (!(["incentive","custom"] as readonly string[]).includes(rules.family) || rules.metricScope !== "company" || rules.allocation !== "responsibility" || rules.deliveryMethod !== "payroll" || rules.scopeIds.length || rules.capAmount !== null || rules.thresholdAmount !== null || rules.budgetAmount !== null || !["percent","per_unit"].includes(rules.valuation)) {
      throw new BenefitsError("INVALID_INPUT", "Transaction programs use payroll delivery, explicit transaction grouping and percent or per-unit valuation; configure ceilings in transaction rules instead of overlapping header caps, thresholds or budgets.");
    }
    if (rules.valuation === "percent" && (rules.percentRate === null || cmp(rules.percentRate,"0")<=0)) throw new BenefitsError("INVALID_INPUT","Configure a positive transaction percentage before activating this program.");
    if (rules.valuation === "per_unit" && (rules.fixedAmount === null || cmp(rules.fixedAmount,"0")<=0)) throw new BenefitsError("INVALID_INPUT","Configure a positive amount per transaction unit before activating this program.");
  } else if (rules.valuation === "per_unit" || rules.allocation === "responsibility") {
    throw new BenefitsError("INVALID_INPUT","Per-unit valuation needs the transactions metric; select the native source rules before continuing.");
  }
  if (rules.valuation === "fixed" && rules.fixedAmount === null) {
    throw new BenefitsError(
      "REFUSED",
      `program ${code} values fixed awards but names no fixed amount — enter the per-award amount in program setup`,
    );
  }
  if (rules.valuation === "fixed" && rules.fixedAmount !== null && cmp(rules.fixedAmount, "0") <= 0) {
    throw new BenefitsError("REFUSED", `program ${code} needs a positive fixed reward amount — enter a positive denomination before creating or activating its payroll obligations`);
  }
  if (rules.valuation === "percent" && rules.percentRate === null) {
    throw new BenefitsError(
      "REFUSED",
      `program ${code} values percent awards but names no percent rate — enter the rate in program setup`,
    );
  }
  if (rules.percentRate !== null) {
    const rateUnits = BigInt(rules.percentRate.replace(".", ""));
    if (rateUnits < 0n || rateUnits > 1000000n) {
      throw new BenefitsError(
        "REFUSED",
        `program ${code} percent rate ${rules.percentRate} is outside 0..100 percent — enter the rate as percent points in program setup`,
      );
    }
  }
  if (rules.valuation === "pool" && rules.budgetAmount === null) {
    throw new BenefitsError(
      "REFUSED",
      `program ${code} values pool awards but names no budget — enter the pool budget in program setup`,
    );
  }
  if (rules.family === "incentive" && rules.metric === null) {
    throw new BenefitsError(
      "REFUSED",
      `program ${code} is an incentive but names no metric — choose revenue, gross_profit, net_profit, or approved_hours in program setup`,
    );
  }
  if (rules.deliveryMethod === "external" && rules.family === "incentive") {
    throw new BenefitsError(
      "REFUSED",
      `program ${code} is a metric incentive delivered externally — incentives pay through payroll so the measured value keeps its payroll evidence; choose payroll delivery or a non-incentive family`,
    );
  }
  if (rules.metricScope !== null && rules.metric === null) {
    throw new BenefitsError(
      "REFUSED",
      `program ${code} scopes measurement without a metric — choose the metric the scope measures in program setup`,
    );
  }
  if ((rules.metricScope === null || rules.metricScope === "company") && rules.scopeIds.length > 0) {
    throw new BenefitsError(
      "REFUSED",
      `program ${code} measures at company scope but names scoped entities — clear the scope list or choose department or project scope in program setup`,
    );
  }
  if ((rules.metricScope === "department" || rules.metricScope === "project") && rules.scopeIds.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      `program ${code} measures at ${rules.metricScope} scope but names no ${rules.metricScope} — select at least one ${rules.metricScope} in program setup`,
    );
  }
  if (rules.frequency === "project_complete" && rules.metricScope !== "project") {
    throw new BenefitsError("REFUSED", `program ${code} pays on project completion but has no project measurement scope — select project scope and its projects before using this frequency`);
  }
  if ((rules.frequency === "quarterly" || rules.frequency === "annual") && rules.periodBasis === null) {
    throw new BenefitsError(
      "REFUSED",
      `program ${code} measures ${rules.frequency} but names no period basis — choose calendar or fiscal quarters in program setup so settlement and payroll agree on the period`,
    );
  }
  if (rules.paymentDelayDays < 0 || !Number.isInteger(rules.paymentDelayDays)) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "paymentDelayDays is a non-negative whole number of days",
    );
  }
}

async function requireRoleMembershipWeights(exec: SqlExecutor, orgId: string, programId: string, code: string, allocation: BenefitAllocation): Promise<void> {
  if (allocation !== "role") return;
  const invalid = (await exec.execute<{ display_name: string | null }>(sql`
    select p.display_name from hrm_benefit_program_members m
      join worker_employments e on e.org_id = m.org_id and e.id = m.employment_id
      join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
     where m.org_id = ${orgId} and m.program_id = ${programId} and (m.weight is null or m.weight <= 0)
     order by m.id limit 1
  `)).rows[0];
  if (invalid) {
    throw new BenefitsError("REFUSED", `program ${code} has a membership for ${invalid.display_name ?? "an employee"} without a positive allocation weight — keep equal allocation, or create a new role-weighted program and enroll members with positive weights`);
  }
}

async function auditProgramWrite(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  programId: string,
  event: string,
  before: unknown,
  after: unknown,
  reason: string | null,
): Promise<void> {
  await exec.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'hrm_benefit_programs', ${programId}, 'update', ${JSON.stringify({
      event,
      actor: { kind: "user", userId: actorId },
      before,
      after,
      reason,
    })}::jsonb, ${actorId})
  `);
}

/**
 * Source accounts resolve upfront — postable, of this org, of the program's
 * entity when both name one — never an arbitrary named account. Money
 * metrics (revenue, gross profit, net profit) post against profit-and-loss
 * accounts only; fixed and manual programs post through the pay component's
 * native expense mapping, so their sources are informational. Activation
 * re-proves the stored accounts because the chart may have changed since the
 * draft.
 */
async function requireProgramSourceAccounts(
  exec: SqlExecutor,
  orgId: string,
  programCode: string,
  legalEntityId: string | null,
  metric: BenefitMetric | null,
  accountIds: readonly string[],
  payComponentId: string | null,
): Promise<void> {
  if (new Set(accountIds).size !== accountIds.length) {
    throw new BenefitsError("INVALID_INPUT", "a measurement account is selected more than once — select each source account once");
  }
  if (metric === "transactions" && accountIds.length) throw new BenefitsError("INVALID_INPUT","Transaction programs measure their configured native source items — clear ledger measurement accounts and use Transaction rules instead of overlapping source definitions.");
  const moneyMetric = metric !== null && metric !== "approved_hours" && metric !== "transactions";
  const ownExpense = moneyMetric && payComponentId !== null
    ? (await exec.execute<{ expense_account_id: string | null }>(sql`
        select expense_account_id from pay_components where org_id = ${orgId} and id = ${payComponentId}
      `)).rows[0]?.expense_account_id
    : null;
  for (const accountId of [...new Set(accountIds.map(String))]) {
    if (ownExpense && String(ownExpense) === accountId) {
      throw new BenefitsError("REFUSED", `program ${programCode} measures its own incentive expense — remove that account from the measure to avoid a circular payout base`);
    }
    const row = (
      await exec.execute<{ id: string; type: string; is_active: boolean; is_summary: boolean; subsidiary_id: string | null }>(sql`
        select id, type, is_active, is_summary, subsidiary_id
          from accounts where org_id = ${orgId} and id = ${accountId}
      `)
    ).rows[0];
    if (!row) {
      throw new BenefitsError(
        "REFUSED",
        `program ${programCode} names a source account outside this organization — choose postable accounts of this org in program setup`,
      );
    }
    if (!row.is_active || row.is_summary) {
      throw new BenefitsError(
        "REFUSED",
        `program ${programCode} names a source account that is not postable — choose an active non-summary account in program setup`,
      );
    }
    if (legalEntityId !== null && row.subsidiary_id !== null && String(row.subsidiary_id) !== legalEntityId) {
      throw new BenefitsError(
        "REFUSED",
        `program ${programCode} names a source account of another legal entity — choose accounts of its employing entity`,
      );
    }
    if (metric === "revenue" && row.type !== "income") {
      throw new BenefitsError("REFUSED", `program ${programCode} measures revenue but selects a ${row.type} account — select actual income accounts; expense sources do not enter a revenue base`);
    }
    if (moneyMetric && !["income", "cogs", "expense", "expense_other", "expense_deferred"].includes(row.type)) {
      throw new BenefitsError(
        "REFUSED",
        `program ${programCode} measures money (${metric}) against a ${row.type} account — money metrics use income or cost accounts; choose one in program setup`,
      );
    }
  }
}

/**
 * Replace the program scope rows, resolving every id through its tenant
 * key. Department scope resolves departments; project scope resolves
 * projects; company scope stores no rows.
 */
async function writeProgramScopes(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  programId: string,
  programCode: string,
  legalEntityId: string | null,
  metricScope: BenefitMetricScope | null,
  scopeIds: readonly string[],
): Promise<void> {
  const deleted = await exec.execute(sql`
    delete from hrm_benefit_program_scopes
     where org_id = ${orgId} and program_id = ${programId}
  `);
  void deleted;
  if (metricScope === null || metricScope === "company") return;
  if (metricScope === "project" && !(await lockAndCheckOrgFeature(exec, orgId, "projects"))) {
    throw new BenefitsError(
      "REFUSED",
      `program ${programCode} scopes project measurement while the projects feature is off — enable Projects under Company Settings → Features; program data is preserved`,
    );
  }
  const unique = [...new Set(scopeIds.map(String))];
  for (const scopeId of unique) {
    if (metricScope === "department") {
      const row = (
        await exec.execute<{ id: string; subsidiary_id: string | null }>(sql`
          select id, subsidiary_id from departments where org_id = ${orgId} and id = ${scopeId}
        `)
      ).rows[0];
      if (!row) {
        throw new BenefitsError(
          "REFUSED",
          "the program names a department outside this organization — choose departments of this org in program setup",
        );
      }
      if (legalEntityId !== null && row.subsidiary_id !== null && String(row.subsidiary_id) !== legalEntityId) {
        throw new BenefitsError(
          "REFUSED",
          `the program names a department of another legal entity — scope ${programCode} to departments of its employing entity`,
        );
      }
      const inserted = (
        await exec.execute(sql`
          insert into hrm_benefit_program_scopes (org_id, program_id, department_id, created_by, updated_by)
          values (${orgId}, ${programId}, ${scopeId}, ${actorId}, ${actorId})
          returning id
        `)
      ).rows;
      requireOneRow(inserted, "recording program scope");
    } else {
      const row = (
        await exec.execute<{ id: string; subsidiary_id: string | null }>(sql`
          select id, subsidiary_id from projects where org_id = ${orgId} and id = ${scopeId}
        `)
      ).rows[0];
      if (!row) {
        throw new BenefitsError(
          "REFUSED",
          "the program names a project outside this organization — choose projects of this org in program setup",
        );
      }
      if (legalEntityId !== null && row.subsidiary_id !== null && String(row.subsidiary_id) !== legalEntityId) {
        throw new BenefitsError(
          "REFUSED",
          `the program names a project of another legal entity — scope ${programCode} to projects of its employing entity`,
        );
      }
      const inserted = (
        await exec.execute(sql`
          insert into hrm_benefit_program_scopes (org_id, program_id, project_id, created_by, updated_by)
          values (${orgId}, ${programId}, ${scopeId}, ${actorId}, ${actorId})
          returning id
        `)
      ).rows;
      requireOneRow(inserted, "recording program scope");
    }
  }
}

export interface CreateBenefitProgramQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly code: string;
  readonly name: string;
  readonly family: BenefitProgramFamily;
  readonly description?: string | null;
  readonly legalEntityId?: string | null;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly payComponentId?: string | null;
  readonly approvalMode?: BenefitApprovalMode;
  readonly deliveryMethod?: BenefitDeliveryMethod;
  readonly valuation?: BenefitValuation;
  readonly metric?: BenefitMetric | null;
  readonly metricScope?: BenefitMetricScope | null;
  readonly scopeIds?: readonly string[];
  readonly allocation?: BenefitAllocation;
  readonly percentRate?: string | number | null;
  readonly fixedAmount?: string | number | null;
  readonly capAmount?: string | number | null;
  readonly budgetAmount?: string | number | null;
  readonly thresholdAmount?: string | number | null;
  readonly frequency?: BenefitFrequency;
  readonly periodBasis?: BenefitPeriodBasis | null;
  readonly paymentDelayDays?: number;
  readonly sourceAccountIds?: readonly string[];
}

function cleanCode(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) throw new BenefitsError("INVALID_INPUT", `${field} names the program code — enter a non-blank code`);
  return text;
}

export async function createBenefitProgram(query: CreateBenefitProgramQuery): Promise<BenefitProgram> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const code = cleanCode(query.code, "code");
  const name = cleanCode(query.name, "name");
  const family = asFamily(query.family, "family");
  const currency = typeof query.currency === "string" ? query.currency.trim() : "";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "currency is a 3-letter ISO code in capitals — payroll never converts it",
    );
  }
  const effectiveFrom = requireCivilDate(query.effectiveFrom, "effectiveFrom");
  const effectiveTo =
    query.effectiveTo === undefined || query.effectiveTo === null
      ? null
      : requireCivilDate(query.effectiveTo, "effectiveTo");
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    throw new BenefitsError("INVALID_INPUT", "effectiveTo ends on or after effectiveFrom");
  }
  const approvalMode = query.approvalMode === undefined ? "none" : asApprovalMode(query.approvalMode);
  const deliveryMethod = query.deliveryMethod === undefined ? "payroll" : asDelivery(query.deliveryMethod);
  const valuation = query.valuation === undefined ? "fixed" : asValuation(query.valuation);
  const metric = query.metric === undefined ? null : asMetric(query.metric);
  const metricScope = query.metricScope === undefined ? null : asMetricScope(query.metricScope);
  const allocation =
    query.allocation === undefined ? "equal" : asAllocation(query.allocation);
  const frequency =
    query.frequency === undefined ? "manual" : asFrequency(query.frequency);
  const periodBasis = query.periodBasis === undefined ? null : asPeriodBasis(query.periodBasis);
  const paymentDelayDays = query.paymentDelayDays ?? 0;
  const rules: ProgramRuleInput = {
    family,
    deliveryMethod,
    valuation,
    allocation,
    metric,
    metricScope,
    scopeIds: query.scopeIds ?? [],
    percentRate: canonicalAmount(query.percentRate ?? null, "percentRate"),
    fixedAmount: canonicalAmount(query.fixedAmount ?? null, "fixedAmount"),
    capAmount: canonicalAmount(query.capAmount ?? null, "capAmount"),
    budgetAmount: canonicalAmount(query.budgetAmount ?? null, "budgetAmount"),
    thresholdAmount: canonicalAmount(query.thresholdAmount ?? null, "thresholdAmount"),
    frequency,
    periodBasis,
    paymentDelayDays,
  };
  requireResolvableRules(code, rules);
  const legalEntityId = query.legalEntityId ?? null;
  const payComponentId = query.payComponentId ?? null;
  const description =
    query.description === undefined || query.description === null
      ? null
      : String(query.description).trim().length > 0
        ? String(query.description).trim()
        : null;
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    await requireLegalEntity(db, orgId, legalEntityId);
    await requireLegalEntityVisibleToActor(db, orgId, actorId, legalEntityId);
    await requireBenefitCurrency(db, orgId, currency, legalEntityId);
    await requireProgramPayComponent(db, orgId, code, payComponentId, deliveryMethod);
    if (metric === "transactions") await requireTransactionPolicyStorage(db);
    await requireProgramSourceAccounts(db, orgId, code, legalEntityId, metric, query.sourceAccountIds ?? [], payComponentId);
    let insertedRows: Record<string, unknown>[];
    try {
      insertedRows = (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_programs
            (org_id, code, name, family, description, legal_entity_id, currency,
             effective_from, effective_to, pay_component_id, approval_mode, delivery_method,
             valuation, metric, metric_scope, allocation,
             percent_rate, fixed_amount, cap_amount, budget_amount,
             threshold_amount, frequency, period_basis, payment_delay_days,
             created_by, updated_by)
          values (${orgId}, ${code}, ${name}, ${family}, ${description}, ${legalEntityId},
                  ${currency}, ${effectiveFrom}::date, ${effectiveTo}::date,
                  ${payComponentId}, ${approvalMode}, ${deliveryMethod}, ${valuation}, ${metric},
                  ${metricScope}, ${allocation},
                  ${rules.percentRate}, ${rules.fixedAmount}, ${rules.capAmount},
                  ${rules.budgetAmount}, ${rules.thresholdAmount}, ${frequency},
                  ${periodBasis}, ${paymentDelayDays}, ${actorId}, ${actorId})
          returning ${PROGRAM_COLUMNS}
        `)
      ).rows;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BenefitsError(
          "REFUSED",
          `benefit program code ${JSON.stringify(code)} already exists — choose a code this organization does not use`,
        );
      }
      throw error;
    }
    const inserted = requireOneRow(insertedRows, "recording the benefit program");
    const insertedId = String(inserted.id);
    await writeProgramScopes(db, orgId, actorId, insertedId, code, legalEntityId, metricScope, rules.scopeIds);
    const scopes = await loadProgramScopes(db, orgId, insertedId);
    const program = toProgram(inserted, scopes);
    const sources = query.sourceAccountIds ?? [];
    for (const accountId of sources) {
      const stored = (
        await db.execute(sql`
          insert into hrm_benefit_program_sources (org_id, program_id, account_id, created_by, updated_by)
          values (${orgId}, ${program.id}, ${String(accountId)}, ${actorId}, ${actorId})
          returning id
        `)
      ).rows;
      requireOneRow(stored, "recording the program funding source");
    }
    await auditProgramWrite(db, orgId, actorId, program.id, "created", null,
      { ...program, sourceAccountIds: [...sources].sort() }, null);
    return program;
  });
}

export interface UpdateBenefitProgramQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly legalEntityId?: string | null;
  readonly currency?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly payComponentId?: string | null;
  readonly approvalMode?: BenefitApprovalMode;
  readonly deliveryMethod?: BenefitDeliveryMethod;
  readonly valuation?: BenefitValuation;
  readonly metric?: BenefitMetric | null;
  readonly metricScope?: BenefitMetricScope | null;
  readonly scopeIds?: readonly string[];
  readonly allocation?: BenefitAllocation;
  readonly percentRate?: string | number | null;
  readonly fixedAmount?: string | number | null;
  readonly capAmount?: string | number | null;
  readonly budgetAmount?: string | number | null;
  readonly thresholdAmount?: string | number | null;
  readonly frequency?: BenefitFrequency;
  readonly periodBasis?: BenefitPeriodBasis | null;
  readonly paymentDelayDays?: number;
  readonly sourceAccountIds?: readonly string[];
  readonly reason: string;
}

/** Edit a draft program. Close active programs and create replacements with new codes; rules never change in place. */
export async function updateBenefitProgram(query: UpdateBenefitProgramQuery): Promise<BenefitProgram> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const programId = requireId(query.programId, "programId");
  const reason = typeof query.reason === "string" ? query.reason.trim() : "";
  if (reason.length === 0) {
    throw new BenefitsError("INVALID_INPUT", "updating a program needs a reason — it is the revision evidence");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const locked = (
      await db.execute<Record<string, unknown>>(sql`
        select ${PROGRAM_COLUMNS} from hrm_benefit_programs
         where org_id = ${orgId} and id = ${programId}
         for update
      `)
    ).rows[0];
    if (!locked) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit program not found in this organization — reload the program list and retry",
      );
    }
    const beforeScopes = await loadProgramScopes(db, orgId, programId);
    const before = toProgram(locked, beforeScopes);
    if (before.status !== "draft") {
      throw new BenefitsError(
        "BAD_STATE",
        `program ${before.code} is ${before.status} — close this program and create a replacement program with a new code; only drafts edit in place`,
      );
    }
    const next = {
      name: query.name === undefined ? before.name : cleanCode(query.name, "name"),
      description: query.description === undefined ? before.description : query.description,
      legalEntityId: query.legalEntityId === undefined ? before.legalEntityId : query.legalEntityId,
      currency: query.currency === undefined ? before.currency : String(query.currency).trim(),
      effectiveFrom:
        query.effectiveFrom === undefined ? before.effectiveFrom : requireCivilDate(query.effectiveFrom, "effectiveFrom"),
      effectiveTo:
        query.effectiveTo === undefined
          ? before.effectiveTo
          : query.effectiveTo === null
            ? null
            : requireCivilDate(query.effectiveTo, "effectiveTo"),
      payComponentId: query.payComponentId === undefined ? before.payComponentId : query.payComponentId,
      approvalMode: query.approvalMode === undefined ? before.approvalMode : asApprovalMode(query.approvalMode),
      deliveryMethod: query.deliveryMethod === undefined ? before.deliveryMethod : asDelivery(query.deliveryMethod),
      valuation: query.valuation === undefined ? before.valuation : asValuation(query.valuation),
      metric: query.metric === undefined ? before.metric : asMetric(query.metric),
      metricScope: query.metricScope === undefined ? before.metricScope : asMetricScope(query.metricScope),
      scopeIds: query.scopeIds === undefined ? before.scopeIds : query.scopeIds,
      allocation: query.allocation === undefined ? before.allocation : asAllocation(query.allocation),
      percentRate:
        query.percentRate === undefined ? before.percentRate : canonicalAmount(query.percentRate, "percentRate"),
      fixedAmount:
        query.fixedAmount === undefined ? before.fixedAmount : canonicalAmount(query.fixedAmount, "fixedAmount"),
      capAmount:
        query.capAmount === undefined ? before.capAmount : canonicalAmount(query.capAmount, "capAmount"),
      budgetAmount:
        query.budgetAmount === undefined ? before.budgetAmount : canonicalAmount(query.budgetAmount, "budgetAmount"),
      thresholdAmount:
        query.thresholdAmount === undefined
          ? before.thresholdAmount
          : canonicalAmount(query.thresholdAmount, "thresholdAmount"),
      frequency: query.frequency === undefined ? before.frequency : asFrequency(query.frequency),
      periodBasis: query.periodBasis === undefined ? before.periodBasis : asPeriodBasis(query.periodBasis),
      paymentDelayDays: query.paymentDelayDays === undefined ? before.paymentDelayDays : query.paymentDelayDays,
    };
    if (!/^[A-Z]{3}$/.test(next.currency)) {
      throw new BenefitsError("INVALID_INPUT", "currency is a 3-letter ISO code in capitals");
    }
    if (next.effectiveTo !== null && next.effectiveTo < next.effectiveFrom) {
      throw new BenefitsError("INVALID_INPUT", "effectiveTo ends on or after effectiveFrom");
    }
    requireResolvableRules(before.code, {
      family: before.family,
      deliveryMethod: next.deliveryMethod,
      valuation: next.valuation,
      allocation: next.allocation,
      metric: next.metric,
      metricScope: next.metricScope,
      scopeIds: next.scopeIds,
      percentRate: next.percentRate,
      fixedAmount: next.fixedAmount,
      capAmount: next.capAmount,
      budgetAmount: next.budgetAmount,
      thresholdAmount: next.thresholdAmount,
      frequency: next.frequency,
      periodBasis: next.periodBasis,
      paymentDelayDays: next.paymentDelayDays,
    });
    await requireLegalEntity(db, orgId, next.legalEntityId);
    await requireLegalEntityVisibleToActor(db, orgId, actorId, next.legalEntityId);
    await requireBenefitCurrency(db, orgId, next.currency, next.legalEntityId);
    await requireProgramPayComponent(db, orgId, before.code, next.payComponentId, next.deliveryMethod);
    await requireRoleMembershipWeights(db, orgId, programId, before.code, next.allocation);
    const previousSourceIds = (await db.execute<{ account_id: string }>(sql`
      select account_id from hrm_benefit_program_sources where org_id = ${orgId} and program_id = ${programId} order by account_id
    `)).rows.map((row) => String(row.account_id));
    const selectedSourceIds = query.sourceAccountIds ?? previousSourceIds;
    if (next.metric === "transactions") await requireTransactionPolicyStorage(db);
    await requireProgramSourceAccounts(db, orgId, before.code, next.legalEntityId, next.metric, selectedSourceIds, next.payComponentId);
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_programs
             set name = ${next.name}, description = ${next.description},
                 legal_entity_id = ${next.legalEntityId}, currency = ${next.currency},
                 effective_from = ${next.effectiveFrom}::date,
                 effective_to = ${next.effectiveTo}::date,
                 pay_component_id = ${next.payComponentId},
                 approval_mode = ${next.approvalMode}, delivery_method = ${next.deliveryMethod}, valuation = ${next.valuation},
                 metric = ${next.metric}, metric_scope = ${next.metricScope},
                 allocation = ${next.allocation}, percent_rate = ${next.percentRate},
                 fixed_amount = ${next.fixedAmount}, cap_amount = ${next.capAmount},
                 budget_amount = ${next.budgetAmount}, threshold_amount = ${next.thresholdAmount},
                 frequency = ${next.frequency}, period_basis = ${next.periodBasis},
                 payment_delay_days = ${next.paymentDelayDays},
                 revision = revision + 1, updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${programId}
          returning ${PROGRAM_COLUMNS}
        `)
      ).rows,
      "updating the benefit program",
    );
    await writeProgramScopes(db, orgId, actorId, programId, before.code, next.legalEntityId, next.metricScope, next.scopeIds);
    if (query.sourceAccountIds !== undefined) {
      await db.execute(sql`
        delete from hrm_benefit_program_sources
         where org_id = ${orgId} and program_id = ${programId}
      `);
      for (const accountId of query.sourceAccountIds) {
        const stored = (
          await db.execute(sql`
            insert into hrm_benefit_program_sources (org_id, program_id, account_id, created_by, updated_by)
            values (${orgId}, ${programId}, ${String(accountId)}, ${actorId}, ${actorId})
            returning id
          `)
        ).rows;
        requireOneRow(stored, "recording the program funding source");
      }
    }
    const after = toProgram(updated, await loadProgramScopes(db, orgId, programId));
    await auditProgramWrite(db, orgId, actorId, programId, "updated",
      { ...before, sourceAccountIds: previousSourceIds },
      { ...after, sourceAccountIds: [...selectedSourceIds].sort() }, reason);
    return after;
  });
}

async function setProgramStatus(
  orgId: string,
  actorId: string,
  programId: string,
  from: BenefitProgramStatus,
  to: BenefitProgramStatus,
  event: string,
  reason: string,
): Promise<BenefitProgram> {
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const locked = (
      await db.execute<Record<string, unknown>>(sql`
        select ${PROGRAM_COLUMNS} from hrm_benefit_programs
         where org_id = ${orgId} and id = ${programId}
         for update
      `)
    ).rows[0];
    if (!locked) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit program not found in this organization — reload the program list and retry",
      );
    }
    const scopes = await loadProgramScopes(db, orgId, programId);
    const before = toProgram(locked, scopes);
    await requireLegalEntityVisibleToActor(db, orgId, actorId, before.legalEntityId);
    if (before.status !== from) {
      throw new BenefitsError(
        "BAD_STATE",
        `program ${before.code} is ${before.status} — this move needs ${from}; reload and retry`,
      );
    }
    if (to === "active") {
      if (before.legalEntityId === null) {
        throw new BenefitsError(
          "REFUSED",
          `program ${before.code} names no responsible legal entity — assign the employing subsidiary in program setup before activation`,
        );
      }
      requireResolvableRules(before.code, {
        family: before.family,
        deliveryMethod: before.deliveryMethod,
        valuation: before.valuation,
        allocation: before.allocation,
        metric: before.metric,
        metricScope: before.metricScope,
        scopeIds: before.scopeIds,
        percentRate: before.percentRate,
        fixedAmount: before.fixedAmount,
        capAmount: before.capAmount,
        budgetAmount: before.budgetAmount,
        thresholdAmount: before.thresholdAmount,
        frequency: before.frequency,
        periodBasis: before.periodBasis,
        paymentDelayDays: before.paymentDelayDays,
      });
      await requireBenefitCurrency(db, orgId, before.currency, before.legalEntityId);
      await requireProgramPayComponent(db, orgId, before.code, before.payComponentId, before.deliveryMethod);
      await requireRoleMembershipWeights(db, orgId, programId, before.code, before.allocation);
      if (before.metric === "transactions") {
        if (before.allocation !== "responsibility") throw new BenefitsError("REFUSED","Transaction programs allocate through dated responsibilities — select responsibility allocation before activation.");
        const policy=await readTransactionPolicy(db,orgId,programId);
        if (!policy) throw new BenefitsError("REFUSED","Configure transaction source items, recipient positions, dated assignments and group ceiling decisions in this program's Transaction rules before activation.");
        await validateTransactionPolicy(db,orgId,before.legalEntityId,policy,before.currency);
        if (!policy.responsibilities.length || !policy.limits.length) throw new BenefitsError("REFUSED","Record dated recipient responsibilities and explicit group ceilings in Transaction rules before activation.");
      }
      const storedAccounts = (
        await db.execute<{ account_id: string }>(sql`
          select account_id from hrm_benefit_program_sources
           where org_id = ${orgId} and program_id = ${programId}
        `)
      ).rows.map((row) => String(row.account_id));
      await requireProgramSourceAccounts(db, orgId, before.code, before.legalEntityId, before.metric, storedAccounts, before.payComponentId);
      const needsMeasurementAccount =
        before.family === "incentive" &&
        before.metric !== null &&
        before.metric !== "approved_hours" && before.metric !== "transactions";
      if (needsMeasurementAccount) {
        const shape = (await db.execute<{ income: number; costs: number }>(sql`
          select count(*) filter (where a.type = 'income')::int as income,
                 count(*) filter (where a.type in ('cogs', 'expense', 'expense_other', 'expense_deferred'))::int as costs
            from hrm_benefit_program_sources s join accounts a on a.org_id = s.org_id and a.id = s.account_id
           where s.org_id = ${orgId} and s.program_id = ${programId}
        `)).rows[0];
        if (!shape?.income) {
          throw new BenefitsError("REFUSED", `program ${before.code} measures ${before.metric} without an income source — select at least one actual income account before activation`);
        }
        if (before.metric !== "revenue" && !shape.costs) {
          throw new BenefitsError("REFUSED", `program ${before.code} measures ${before.metric} without cost sources — select the explicit cost accounts subtracted from income before activation`);
        }
      }
    }
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_programs
             set status = ${to}, revision = revision + 1,
                 updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${programId}
          returning ${PROGRAM_COLUMNS}
        `)
      ).rows,
      `${event} the benefit program`,
    );
    const after = toProgram(updated, await loadProgramScopes(db, orgId, programId));
    await auditProgramWrite(db, orgId, actorId, programId, event, before, after, reason);
    return after;
  });
}

/** Draft → active. Activation proves the configuration resolves and dates are valid. */
export async function activateBenefitProgram(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId: string;
}): Promise<BenefitProgram> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const programId = requireId(query.programId, "programId");
  return setProgramStatus(orgId, actorId, programId, "draft", "active", "activated", "activation");
}

/** Active → closed. Closing preserves history; data and audit trail stay. */
export async function closeBenefitProgram(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId: string;
  readonly reason: string;
}): Promise<BenefitProgram> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const programId = requireId(query.programId, "programId");
  const reason = typeof query.reason === "string" ? query.reason.trim() : "";
  if (reason.length === 0) {
    throw new BenefitsError("INVALID_INPUT", "closing a program needs a reason — it is the closure evidence");
  }
  return setProgramStatus(orgId, actorId, programId, "active", "closed", "closed", reason);
}

/** Setup-registry compat: create-or-update by code. */
export async function saveBenefitProgram(
  query: CreateBenefitProgramQuery & { readonly reason?: string },
): Promise<BenefitProgram> {
  return createBenefitProgram(query);
}

function toMember(row: Record<string, unknown>): BenefitProgramMember {
  return {
    id: String(row.id),
    programId: String(row.programId),
    employmentId: String(row.employmentId),
    effectiveFrom: String(row.effectiveFrom).slice(0, 10),
    effectiveTo: row.effectiveTo != null ? String(row.effectiveTo).slice(0, 10) : null,
    weight: row.weight != null ? String(row.weight) : null,
    role: row.role != null ? String(row.role) : null,
  };
}

export async function listProgramMemberships(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId: string;
}): Promise<BenefitProgramMember[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const programId = requireId(query.programId, "programId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmEnabled(db, orgId);
    await getBenefitProgram(db, orgId, actorId, programId);
    const rows = (
      await db.execute<Record<string, unknown>>(sql`
        select id, program_id as "programId", employment_id as "employmentId",
               effective_from::text as "effectiveFrom",
               effective_to::text as "effectiveTo",
               weight::text as "weight", role
          from hrm_benefit_program_members
         where org_id = ${orgId} and program_id = ${programId}
         order by effective_from
      `)
    ).rows;
    return rows.map(toMember);
  });
}

export async function addProgramMembership(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId: string;
  readonly employmentId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly weight?: string | number | null;
  readonly role?: string | null;
}): Promise<BenefitProgramMember> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const programId = requireId(query.programId, "programId");
  const employmentId = requireId(query.employmentId, "employmentId");
  const effectiveFrom = requireCivilDate(query.effectiveFrom, "effectiveFrom");
  const effectiveTo =
    query.effectiveTo === undefined || query.effectiveTo === null
      ? null
      : requireCivilDate(query.effectiveTo, "effectiveTo");
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    throw new BenefitsError("INVALID_INPUT", "membership effectiveTo ends on or after effectiveFrom");
  }
  const weight = query.weight === undefined ? null : canonicalAmount(query.weight, "weight");
  const role =
    query.role === undefined || query.role === null || String(query.role).trim().length === 0
      ? null
      : String(query.role).trim();
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, employmentId);
    await assertHrmEnabled(db, orgId);
    const lockedProgram = (
      await db.execute(sql`
        select id from hrm_benefit_programs
         where org_id = ${orgId} and id = ${programId}
         for update
      `)
    ).rows[0];
    if (!lockedProgram) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit program not found in this organization — reload the program list and retry",
      );
    }
    const program = await getBenefitProgram(db, orgId, actorId, programId);
    if (program.allocation === "role" && (weight === null || BigInt(weight.replace(".", "")) <= 0n)) {
      throw new BenefitsError("REFUSED", `program ${program.code} allocates by role weight — enter a positive membership weight before enrolling this employee`);
    }
    if (program.status === "closed") {
      throw new BenefitsError(
        "BAD_STATE",
        `program ${program.code} is closed — closed programs take no new members; create a replacement program with a new code`,
      );
    }
    if (program.legalEntityId !== null) {
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
          `program ${program.code} belongs to a different legal entity than this employment — enroll employments of the program's entity`,
        );
      }
    }
    if (program.family === "incentive") {
      const settledThrough = (await db.execute<{ end_date: string | null }>(sql`
        select max(coalesce(period_to, period_from))::text as end_date from hrm_benefit_awards
         where org_id = ${orgId} and program_id = ${programId} and status <> 'voided'
      `)).rows[0]?.end_date;
      if (settledThrough && effectiveFrom <= settledThrough) {
        throw new BenefitsError("REFUSED", `membership starts inside an already settled period ending ${settledThrough} — start after that period to preserve recorded allocation history`);
      }
    }
    const overlap = (
      await db.execute<{ id: string }>(sql`
        select id from hrm_benefit_program_members
         where org_id = ${orgId} and program_id = ${programId} and employment_id = ${employmentId}
           and effective_from <= ${effectiveTo ?? "9999-12-31"}::date
           and (effective_to is null or effective_to >= ${effectiveFrom}::date)
         limit 1
      `)
    ).rows;
    if (overlap.length > 0) {
      throw new BenefitsError(
        "REFUSED",
        "this employment already holds membership over those dates — end the existing membership instead of adding twice",
      );
    }
    const inserted = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_program_members
            (org_id, program_id, employment_id, effective_from, effective_to,
             weight, role, created_by, updated_by)
          values (${orgId}, ${programId}, ${employmentId},
                  ${effectiveFrom}::date, ${effectiveTo}::date,
                  ${weight}, ${role}, ${actorId}, ${actorId})
          returning id, program_id as "programId", employment_id as "employmentId",
                    effective_from::text as "effectiveFrom",
                    effective_to::text as "effectiveTo",
                    weight::text as "weight", role
        `)
      ).rows,
      "recording program membership",
    );
    await db.execute(sql`
      update hrm_benefit_programs
         set revision = revision + 1, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${programId}
    `);
    await auditProgramWrite(db, orgId, actorId, programId, "member_added", null, inserted, null);
    return toMember(inserted);
  });
}

/**
 * End a membership prospectively: the row keeps its history with an
 * effective end instead of deleting it. Backdating into closed or settled
 * periods would rewrite source history, so the end lands today or later.
 */
export async function removeProgramMembership(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly membershipId: string;
  readonly reason: string;
  readonly effectiveTo?: string | null;
}): Promise<BenefitProgramMember> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const membershipId = requireId(query.membershipId, "membershipId");
  const reason = typeof query.reason === "string" ? query.reason.trim() : "";
  if (reason.length === 0) {
    throw new BenefitsError("INVALID_INPUT", "ending membership needs a reason — it is the evidence");
  }
  return withOrgTransaction(orgId, async () => {
    const membershipProgram = (
      await db.execute<{ program_id: string }>(sql`
        select program_id from hrm_benefit_program_members
         where org_id = ${orgId} and id = ${membershipId}
      `)
    ).rows[0];
    if (!membershipProgram) {
      throw new BenefitsError(
        "NOT_FOUND",
        "program membership not found in this organization — reload and retry",
      );
    }
    const lockedMembershipProgram = (
      await db.execute(sql`
        select id from hrm_benefit_programs
         where org_id = ${orgId} and id = ${membershipProgram.program_id}
         for update
      `)
    ).rows[0];
    if (!lockedMembershipProgram) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit program not found in this organization — reload the program list and retry",
      );
    }
    await getBenefitProgram(db, orgId, actorId, String(membershipProgram.program_id));
    const businessToday = await businessTodayInTx(db, orgId);
    const endDate =
      query.effectiveTo === undefined || query.effectiveTo === null
        ? businessToday
        : requireCivilDate(query.effectiveTo, "effectiveTo");
    if (endDate < businessToday) {
      throw new BenefitsError(
        "REFUSED",
        `membership ends ${endDate} but today is ${businessToday} — backdating into closed or settled periods rewrites source history; end today or later`,
      );
    }
    const locked = (
      await db.execute<{ employment_id: string; program_id: string; effective_from: string; effective_to: string | null }>(sql`
        select employment_id,
               program_id,
               effective_from::text as effective_from,
               effective_to::text as effective_to
          from hrm_benefit_program_members
         where org_id = ${orgId} and id = ${membershipId}
         for update
      `)
    ).rows[0];
    if (!locked) {
      throw new BenefitsError(
        "NOT_FOUND",
        "program membership not found in this organization — reload and retry",
      );
    }
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, String(locked.employment_id));
    await assertHrmEnabled(db, orgId);
    if (locked.effective_to !== null && locked.effective_to <= businessToday) {
      throw new BenefitsError(
        "BAD_STATE",
        "membership already ended — history stays as recorded; add a new membership instead of rewriting it",
      );
    }
    if (endDate < String(locked.effective_from).slice(0, 10)) {
      throw new BenefitsError(
        "INVALID_INPUT",
        "membership cannot end before it starts — choose an end on or after the membership start",
      );
    }
    const awardedThrough = (await db.execute<{ end_date: string | null }>(sql`
      select max(coalesce(period_to, period_from))::text as end_date from hrm_benefit_awards
       where org_id = ${orgId} and program_id = ${locked.program_id}
         and employment_id = ${locked.employment_id} and status <> 'voided'
    `)).rows[0]?.end_date;
    if (awardedThrough && endDate < awardedThrough) {
      throw new BenefitsError("REFUSED", `membership already supports awards through ${awardedThrough} — end on or after that date to preserve their recorded eligibility`);
    }
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_program_members
             set effective_to = ${endDate}::date, updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${membershipId}
          returning id, program_id as "programId", employment_id as "employmentId",
                    effective_from::text as "effectiveFrom",
                    effective_to::text as "effectiveTo",
                    weight::text as "weight", role
        `)
      ).rows,
      "ending program membership",
    );
    const after = toMember(updated);
    await db.execute(sql`
      update hrm_benefit_programs
         set revision = revision + 1, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${String(locked.program_id)}
    `);
    await auditProgramWrite(
      db,
      orgId,
      actorId,
      String(locked.program_id),
      "member_ended",
      { membershipId, effectiveTo: locked.effective_to },
      after,
      reason,
    );
    return after;
  });
}

export async function listProgramSources(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  programId: string,
): Promise<ReadonlyArray<{ id: string; accountId: string; weightBps: number | null }>> {
  const program = await getBenefitProgram(exec, orgId, actorId, programId);
  if (program.metricScope === "project" && !(await lockAndCheckOrgFeature(exec, orgId, "projects"))) {
    throw new BenefitsError("REFUSED", "project measurement sources are unavailable while Projects is off — enable Projects under Company Settings → Features to use this program");
  }
  const rows = (
    await exec.execute<{ id: string; accountId: string; weightBps: number | null }>(sql`
      select id, account_id as "accountId", weight_bps as "weightBps"
        from hrm_benefit_program_sources
       where org_id = ${orgId} and program_id = ${programId}
       order by account_id
    `)
  ).rows;
  return rows;
}

export { BENEFIT_ALLOCATIONS, BENEFIT_DELIVERY_METHODS, BENEFIT_FREQUENCIES, BENEFIT_METRIC_SCOPES, BENEFIT_METRICS, BENEFIT_PROGRAM_FAMILIES, BENEFIT_PROGRAM_STATUSES, BENEFIT_VALUATIONS };

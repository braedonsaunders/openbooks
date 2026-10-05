/**
 * Capitalized contract costs (ASC 340-40 / IFRS 15 costs to obtain a
 * contract).
 *
 * Incremental costs of obtaining a contract — sales commissions, and where
 * the policy elects it, fulfilment costs — are held as an asset and amortized
 * on a systematic basis consistent with the transfer of the related goods or
 * services: over the contract term, or over the expected customer life when
 * the renewal commission is not commensurate with the initial commission.
 * Costs whose benefit period is twelve months or less are expensed
 * immediately when the policy elects the one-year practical expedient.
 *
 * Postings run through the journal kernel, so every entry is balanced,
 * deterministic and idempotent:
 * - capitalize: DR contract-cost asset, CR the cost's original
 *   expense/accrual account;
 * - amortize: DR amortization expense, CR contract-cost asset;
 * - impair: DR amortization expense, CR contract-cost asset.
 *
 * The asset legs carry contributor_kind 'contract_cost_asset' with the asset
 * id, so the carrying amount is always the general ledger itself — never a
 * parallel balance. Amortization rows are immutable posted history.
 *
 * Commission sources: manual entry and CaptivateIQ/QuotaPath-style imports
 * arrive here directly. Payroll holds only a `paid_on_commission` profile
 * flag — there is no per-earning commission atom to link — so a payroll
 * earning line can be recorded as the source reference, while automatic
 * derivation of the commission amount from a pay run is a later step.
 */
import { sql } from "drizzle-orm";
import { postEntry } from "../journal/post-entry.ts";
import { fromUnits, roundDiv, toCents, toUnits } from "../money/money.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../organization/org-feature-lock.ts";
import { defaultPostingSubsidiaryId, loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { arePeriodModulesOpen } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { addMonthsStart, daysInCivilMonth, startOfMonth } from "../platform/civil-date.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";

export type ContractCostType = "commission" | "fulfilment";
export type ContractCostMethod = "straight_line" | "pattern";
export type ContractCostStatus = "active" | "fully_amortized" | "impaired" | "expensed";

export class ContractCostError extends Error {
  readonly name = "ContractCostError";
  readonly status: 422 | 409 | 403;
  readonly code: string;
  readonly remedy: string;

  constructor(
    message: string,
    options: { status?: 422 | 409 | 403; code?: string; remedy?: string } = {},
  ) {
    super(message);
    this.status = options.status ?? 422;
    this.code = options.code ?? "contract_cost_invalid";
    this.remedy =
      options.remedy ?? "Correct the contract cost input and submit it again.";
  }
}

const FEATURE_REMEDY = "Enable Contract costs in Company Settings → Features (it requires Revenue recognition).";

/** Registry default is off — absence must not capitalize costs. */
export async function contractCostsFeatureEnabled(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<boolean> {
  return orgFeatureEnabled(orgId, "contractCosts", runner as SqlExecutor);
}

async function assertFeatureOn(runner: SqlExecutor, orgId: string): Promise<void> {
  await acquireOrgFeatureGateLock(runner, orgId);
  if (!(await lockAndCheckOrgFeature(runner, orgId, "contractCosts"))) {
    throw new ContractCostError("Contract costs are not enabled for this organization.", {
      code: "contract_costs_feature_off",
      remedy: FEATURE_REMEDY,
    });
  }
}

/**
 * Service-boundary authority: the actor's live grants must cover the duty.
 * The refusal names the missing permission and who can grant it.
 */
async function requireCostAuthority(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  subsidiaryId: string | null,
  permission: "contract_costs.manage" | "contract_costs.approve",
): Promise<void> {
  let allowed = false;
  try {
    await lockActorCommandAuthority(runner, orgId, actorId, subsidiaryId, permission);
    allowed = true;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new ContractCostError(
      `This action requires the ${permission} permission.`,
      {
        status: 403,
        code: "contract_cost_forbidden",
        remedy: `Ask an administrator to grant ${permission} (Company Settings → Roles), then try again.`,
      },
    );
  }
}

interface ContractCostPolicy {
  id: string;
  effectiveFrom: string;
  capitalizeCommissions: boolean;
  capitalizeFulfilment: boolean;
  practicalExpedient: boolean;
  basis: "contract_term" | "customer_life";
  customerLifeSource: "manual" | "derived";
  customerLifeMonths: number | null;
  renewalThreshold: string;
  assetAccountId: string | null;
  amortizationExpenseAccountId: string | null;
}

/** The policy in effect on a date: the latest effective_from on or before it. */
async function activePolicy(
  runner: SqlExecutor,
  orgId: string,
  onDate: string,
): Promise<ContractCostPolicy> {
  const row = (await runner.execute<{
    id: string;
    effective_from: string;
    capitalize_commissions: boolean;
    capitalize_fulfilment: boolean;
    practical_expedient: boolean;
    basis: ContractCostPolicy["basis"];
    customer_life_source: ContractCostPolicy["customerLifeSource"];
    customer_life_months: number | null;
    renewal_commensurate_threshold_percent: string;
    asset_account_id: string | null;
    amortization_expense_account_id: string | null;
  }>(sql`
    select id, effective_from::text, capitalize_commissions, capitalize_fulfilment,
           practical_expedient, basis, customer_life_source, customer_life_months,
           renewal_commensurate_threshold_percent::text,
           asset_account_id, amortization_expense_account_id
      from contract_cost_policies
     where org_id = ${orgId} and effective_from <= ${onDate}
     order by effective_from desc limit 1`)).rows[0];
  if (!row) {
    throw new ContractCostError(`No contract cost policy is in effect on ${onDate}.`, {
      code: "contract_cost_policy_missing",
      remedy:
        "Create a contract cost policy in Company Settings → Setup → Revenue (effective on or before the capitalization date), then capitalize again.",
    });
  }
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    capitalizeCommissions: row.capitalize_commissions,
    capitalizeFulfilment: row.capitalize_fulfilment,
    practicalExpedient: row.practical_expedient,
    basis: row.basis,
    customerLifeSource: row.customer_life_source,
    customerLifeMonths: row.customer_life_months,
    renewalThreshold: row.renewal_commensurate_threshold_percent,
    assetAccountId: row.asset_account_id,
    amortizationExpenseAccountId: row.amortization_expense_account_id,
  };
}

function requirePolicyAccounts(policy: ContractCostPolicy): {
  assetAccountId: string;
  amortizationExpenseAccountId: string;
} {
  if (!policy.assetAccountId || !policy.amortizationExpenseAccountId) {
    throw new ContractCostError(
      "The contract cost policy names no asset or amortization expense account.",
      {
        code: "contract_cost_policy_accounts_missing",
        remedy:
          "Set the asset account and the amortization expense account on the contract cost policy in Company Settings → Setup → Revenue, then try again.",
      },
    );
  }
  return {
    assetAccountId: policy.assetAccountId,
    amortizationExpenseAccountId: policy.amortizationExpenseAccountId,
  };
}

// ---------------------------------------------------------------------------
// Pure schedule math (bigint minor units; no floats, no Number)
// ---------------------------------------------------------------------------

/**
 * Split a total across non-negative weights, largest remainder: every share
 * is floored, then the leftover minor units go one each to the largest
 * fractional parts (ties break by position), so the shares sum exactly.
 */
export function allocateMinorUnits(totalMinor: bigint, weights: bigint[]): bigint[] {
  if (totalMinor < 0n) throw new ContractCostError("Cannot allocate a negative cost.");
  if (weights.length === 0) throw new ContractCostError("Cannot allocate across no periods.");
  if (weights.some((w) => w < 0n)) throw new ContractCostError("Cannot allocate across negative weights.");
  const totalWeight = weights.reduce((acc, w) => acc + w, 0n);
  if (totalWeight <= 0n) {
    throw new ContractCostError("Cannot allocate: every period weight is zero.", {
      code: "contract_cost_zero_weights",
      remedy:
        "For a pattern-method asset, build the revenue schedule first so each period carries a planned amount; for straight-line, the month count must be positive.",
    });
  }
  const floors = weights.map((w) => (totalMinor * w) / totalWeight);
  const remainders = weights.map((w, i) => ({ i, r: totalMinor * w - floors[i]! * totalWeight }));
  let leftover = totalMinor - floors.reduce((acc, f) => acc + f, 0n);
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  const out = [...floors];
  for (const { i } of remainders) {
    if (leftover <= 0n) break;
    out[i]! += 1n;
    leftover -= 1n;
  }
  return out;
}

/** Even monthly shares of a total, summing exactly (the straight-line plan). */
export function projectAmortizationSchedule(totalMinor: bigint, months: number): bigint[] {
  if (!Number.isInteger(months) || months <= 0) {
    throw new ContractCostError("The amortization window must span at least one month.");
  }
  return allocateMinorUnits(totalMinor, Array<bigint>(months).fill(1n));
}

/** First day of the month containing a date. */
export function monthStartOf(iso: string): string {
  return startOfMonth(iso);
}

/** Month starts from a start month, count many: ['2026-07-01', ...]. */
export function monthStartsFrom(startMonth: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(addMonthsStart(startMonth, i));
  return out;
}

/** Inclusive month count between two month starts ('YYYY-MM-DD' firsts). */
export function monthsBetweenInclusive(startMonth: string, endMonth: string): number {
  const sy = Number(startMonth.slice(0, 4));
  const sm = Number(startMonth.slice(5, 7));
  const ey = Number(endMonth.slice(0, 4));
  const em = Number(endMonth.slice(5, 7));
  return (ey - sy) * 12 + (em - sm) + 1;
}

export function lastDayOfMonth(monthStart: string): string {
  const year = Number(monthStart.slice(0, 4));
  const month1 = Number(monthStart.slice(5, 7));
  return `${monthStart.slice(0, 8)}${String(daysInCivilMonth(year, month1)).padStart(2, "0")}`;
}

/**
 * Minor units (cents for two-decimal currencies) to a canonical ledger
 * string through the currency's ISO exponent. Exponents past 4dp cannot
 * reach numeric(19,4) exactly, so they are refused by name.
 */
export function minorUnitsToCanonical(amountMinor: bigint, exponent: number): string {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) {
    throw new ContractCostError(`Unsupported currency exponent ${exponent}.`, {
      code: "contract_cost_currency_exponent",
      remedy: "Record the cost in a currency with at most 4 minor-unit decimals.",
    });
  }
  return fromUnits(amountMinor * 10n ** BigInt(4 - exponent));
}

/**
 * ISO minor-unit exponent for one currency code. Shared with read paths so a
 * missing registry row refuses by name instead of guessing 2dp (which would
 * misprice zero- and three-decimal currencies). History is never
 * reinterpreted: the remedy restores the missing or damaged registry row
 * from the canonical seed, which only repairs precision and leaves every
 * posted amount untouched.
 */
export async function currencyExponent(runner: SqlExecutor, currency: string): Promise<number> {
  const row = (await runner.execute<{ minor_units: number }>(sql`
    select minor_units from currencies where code = ${currency}`)).rows[0];
  const restoreRemedy =
    "Restore the currency row with the canonical registry seed (seedCurrencies), which restores its precision without changing posted history.";
  if (!row) {
    throw new ContractCostError(`Unknown currency ${currency}.`, {
      code: "contract_cost_currency_unknown",
      remedy: restoreRemedy,
    });
  }
  const precision = row.minor_units;
  if (!Number.isInteger(precision) || (precision as number) < 0 || (precision as number) > 4) {
    throw new ContractCostError(`Currency ${currency} has an unsupported precision ${String(precision)}.`, {
      code: "contract_cost_currency_exponent",
      remedy: restoreRemedy,
    });
  }
  return precision;
}

function checkDate(value: string, what: string): void {
  if (!isIsoCalendarDate(value)) {
    throw new ContractCostError(`${what} must be a valid YYYY-MM-DD calendar date.`, {
      code: "contract_cost_date_invalid",
      remedy: `Enter ${what} as YYYY-MM-DD.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Posting context: book, subsidiary, period, carrying amount
// ---------------------------------------------------------------------------

async function postingBookId(runner: SqlExecutor, orgId: string): Promise<string> {
  const id = await activePostingPrimaryBookId(orgId, runner);
  if (!id) {
    throw new ContractCostError("No active primary posting book.", {
      code: "contract_cost_book_missing",
      remedy: "Activate a primary posting book before capitalizing contract costs.",
    });
  }
  return id;
}

async function postingSubsidiaryId(runner: SqlExecutor, orgId: string): Promise<string> {
  return defaultPostingSubsidiaryId(await loadSubsidiaryContext(runner, orgId));
}

async function coveringPeriodId(runner: SqlExecutor, orgId: string, date: string): Promise<string> {
  const period = await resolveCoveringPeriod(runner, orgId, date);
  if (!period) {
    throw new ContractCostError(`No accounting period covers ${date}.`, {
      code: "contract_cost_period_missing",
      remedy: `Create the accounting period covering ${date} before posting.`,
    });
  }
  return period.id;
}

async function orgBaseCurrency(runner: SqlExecutor, orgId: string): Promise<string> {
  const row = (await runner.execute<{ base_currency: string }>(sql`
    select base_currency from orgs where id = ${orgId}`)).rows[0];
  if (!row) throw new ContractCostError("Organization not found.");
  return row.base_currency;
}

/**
 * The asset's carrying amount, read from the general ledger itself: the
 * signed sum of its tagged asset legs over live entries. Posted entries
 * count alongside their reversals, so a reversed posting never inflates
 * the balance.
 */
export async function assetCarryingMinor(
  runner: SqlExecutor,
  orgId: string,
  assetId: string,
): Promise<bigint> {
  const row = (await runner.execute<{ carrying: string }>(sql`
    select coalesce(sum(jl.amount), 0)::text as carrying
      from journal_lines jl
      join journal_entries je
        on je.org_id = jl.org_id and je.id = jl.entry_id
     where jl.org_id = ${orgId}
       and jl.contributor_kind = 'contract_cost_asset'
       and jl.contributor_ref = ${assetId}
       and je.status in ('posted', 'reversed')`)).rows[0];
  return toCents(row?.carrying ?? "0");
}

async function writeAudit(
  runner: SqlExecutor,
  orgId: string,
  table: string,
  rowId: string,
  action: string,
  actorId: string | null,
  changes: Record<string, unknown>,
): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const written = (await runner.execute<{ id: string }>(sql`
    insert into audit_log (id, org_id, table_name, row_id, action, changes, actor_id)
    values (${randomUUID()}, ${orgId}, ${table}, ${rowId}, ${action},
      ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`)).rows;
  if (written.length !== 1) {
    throw new ContractCostError("The audit write matched no rows; the change was not recorded.");
  }
}

// ---------------------------------------------------------------------------
// Expected customer life from the SaaS metrics ledger
// ---------------------------------------------------------------------------

/**
 * Derive the expected customer life in months from trailing SaaS metrics
 * facts: lifetime is the inverse of the logo churn rate (1 / churned ÷
 * started, summed over the trailing twelve months). Reads the stored facts
 * directly — no billing-module import — so the revenue module gains no new
 * edge. With no facts, zero exposure, or zero churn, derivation refuses by
 * name and asks for a manual life: guessing a life invents amortization.
 */
export async function deriveCustomerLifeMonths(
  runner: SqlExecutor,
  orgId: string,
): Promise<number> {
  const row = (await runner.execute<{ started: string; churned: string; months: string }>(sql`
    select coalesce(sum(customers_start), 0)::text as started,
           coalesce(sum(customers_churned), 0)::text as churned,
           count(*)::text as months
      from saas_metrics_facts_monthly
     where org_id = ${orgId}
       and month >= (current_date - interval '12 months')`)).rows[0];
  const started = BigInt(row?.started ?? "0");
  const churned = BigInt(row?.churned ?? "0");
  if ((row?.months ?? "0") === "0" || started <= 0n) {
    throw new ContractCostError(
      "No SaaS metrics facts cover the trailing twelve months.",
      {
        code: "contract_cost_life_no_metrics",
        remedy:
          "Compute SaaS metrics for recent months (Reports → SaaS metrics), or enter a manual customer life on the contract cost policy.",
      },
    );
  }
  if (churned <= 0n) {
    throw new ContractCostError("Recorded churn is zero, so no finite customer life derives from it.", {
      code: "contract_cost_life_no_churn",
      remedy: "Enter a manual customer life on the contract cost policy.",
    });
  }
  const life = roundDiv(started, churned);
  return life < 1n ? 1 : Number(life);
}

// ---------------------------------------------------------------------------
// Capitalize
// ---------------------------------------------------------------------------

export interface CapitalizeContractCostInput {
  orgId: string;
  actorId: string;
  revenueContractId?: string | null;
  repPartyId?: string | null;
  customerPartyId?: string | null;
  costType: ContractCostType;
  amountMinor: bigint;
  currency: string;
  capitalizedOn: string;
  method?: ContractCostMethod;
  originalExpenseAccountId: string;
  /** Current-period renewal commission, for the commensurate test. */
  renewalCommissionMinor?: bigint;
  source: { kind: "manual" | "import" | "payroll_earning" | "vendor_bill"; ref?: string | null; contractNumber?: string | null; [key: string]: unknown };
}

export interface CapitalizeContractCostResult {
  assetId: string;
  status: ContractCostStatus;
  /** 'YYYY-MM' months of the amortization window (one month when expensed). */
  months: string[];
  /** Planned minor-unit amounts per month, as decimal strings. */
  scheduleMinor: string[];
  capitalizeEntryId: string | null;
  /** Why an active asset amortizes where it does. */
  basisApplied: "contract_term" | "customer_life" | "expensed" | "pending";
}

interface BenefitWindow {
  months: string[];
  basisApplied: "contract_term" | "customer_life";
}

async function resolveBenefitWindow(
  runner: SqlExecutor,
  orgId: string,
  policy: ContractCostPolicy,
  contractId: string | null | undefined,
  capitalizedOn: string,
  renewalCommissionMinor: bigint | undefined,
  initialCommissionMinor: bigint,
): Promise<BenefitWindow> {
  if (!contractId) {
    throw new ContractCostError("Link the revenue contract before scheduling amortization.", {
      code: "contract_cost_contract_missing",
      remedy:
        "Link the commission to its revenue contract (Contract costs → Needs attention → Link), or capitalize it directly from the contract.",
    });
  }
  const contract = (await runner.execute<{
    starts_on: string | null;
    ends_on: string | null;
    number: string;
  }>(sql`
    select starts_on::text, ends_on::text, contract_number as number
      from revenue_contracts where org_id = ${orgId} and id = ${contractId}`)).rows[0];
  if (!contract) {
    throw new ContractCostError("The linked revenue contract does not exist in this organization.", {
      code: "contract_cost_contract_unknown",
      remedy: "Link a revenue contract from this organization, then capitalize again.",
    });
  }
  if (!contract.starts_on || !contract.ends_on) {
    throw new ContractCostError(`Revenue contract ${contract.number} names no start or end date.`, {
      code: "contract_cost_contract_undated",
      remedy: `Enter start and end dates on revenue contract ${contract.number}, then capitalize again.`,
    });
  }
  const termMonths = monthsBetweenInclusive(
    monthStartOf(contract.starts_on),
    monthStartOf(contract.ends_on),
  );
  if (termMonths <= 0) {
    throw new ContractCostError(`Revenue contract ${contract.number} ends before it starts.`, {
      code: "contract_cost_contract_inverted",
      remedy: `Correct the dates on revenue contract ${contract.number}, then capitalize again.`,
    });
  }
  let basisApplied: "contract_term" | "customer_life" = "contract_term";
  let count = termMonths;
  if (policy.basis === "customer_life") {
    let life: number | null = null;
    if (policy.customerLifeSource === "derived") {
      life = await deriveCustomerLifeMonths(runner, orgId);
    } else if (policy.customerLifeMonths !== null) {
      life = policy.customerLifeMonths;
    } else {
      throw new ContractCostError("The policy names manual customer life but no life in months.", {
        code: "contract_cost_life_missing",
        remedy:
          "Enter the expected customer life in months on the contract cost policy, or switch its source to derived SaaS metrics.",
      });
    }
    // A renewal commission commensurate with the initial one confines the
    // benefit to the contract that paid the initial commission.
    const threshold = toUnits(policy.renewalThreshold);
    const commensurate =
      renewalCommissionMinor !== undefined &&
      initialCommissionMinor > 0n &&
      renewalCommissionMinor * 100n * 10000n >= threshold * initialCommissionMinor;
    if (!commensurate) {
      basisApplied = "customer_life";
      count = life;
    }
  }
  return { months: monthStartsFrom(monthStartOf(capitalizedOn), count).map((m) => m.slice(0, 7)), basisApplied };
}

/** Pattern weights per period from the contract's live revenue schedule. */
async function patternWeights(
  runner: SqlExecutor,
  orgId: string,
  contractId: string,
  months: string[],
): Promise<{ periodIds: (string | null)[]; weights: bigint[]; totalWeight: bigint }> {
  const rows = (await runner.execute<{ period_id: string; planned: string }>(sql`
    select line.period_id, sum(line.planned_amount)::text as planned
      from recognition_schedule_lines line
      join recognition_schedules schedule
        on schedule.org_id = line.org_id and schedule.id = line.schedule_id
      join performance_obligations obligation
        on obligation.org_id = schedule.org_id and obligation.id = schedule.obligation_id
     where line.org_id = ${orgId} and obligation.contract_id = ${contractId}
     group by line.period_id`)).rows;
  const byPeriod = new Map(rows.map((r) => [r.period_id, toUnits(r.planned)]));
  const totalWeight = [...byPeriod.values()].reduce((acc, w) => acc + w, 0n);
  if (totalWeight <= 0n) {
    throw new ContractCostError("The contract's revenue schedule carries no planned amounts.", {
      code: "contract_cost_pattern_no_schedule",
      remedy:
        "Build the revenue schedule for the contract (Revenue → contract → Build schedule), or capitalize with straight-line amortization.",
    });
  }
  const periodIds: (string | null)[] = [];
  const weights: bigint[] = [];
  for (const month of months) {
    const period = await resolveCoveringPeriod(runner, orgId, `${month}-01`);
    periodIds.push(period?.id ?? null);
    weights.push(period ? (byPeriod.get(period.id) ?? 0n) : 0n);
  }
  return { periodIds, weights, totalWeight };
}

export async function capitalizeContractCost(
  input: CapitalizeContractCostInput,
): Promise<CapitalizeContractCostResult> {
  const { orgId, actorId } = input;
  validateCapitalizeInput(input);
  return withOrgTransaction(orgId, async () => {
    await assertFeatureOn(db, orgId);
    const subsidiaryId = await postingSubsidiaryId(db, orgId);
    await requireCostAuthority(db, orgId, actorId, subsidiaryId, "contract_costs.manage");
    return capitalizeOnRunner(db, orgId, actorId, subsidiaryId, input);
  });
}

function validateCapitalizeInput(input: CapitalizeContractCostInput): void {
  if (input.amountMinor <= 0n) {
    throw new ContractCostError("Capitalize a positive cost amount.", {
      remedy: "Enter the commission or fulfilment cost above zero minor units.",
    });
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new ContractCostError(`Currency ${input.currency} is not an ISO 4217 code.`, {
      code: "contract_cost_currency_invalid",
      remedy: "Enter the cost currency as a three-letter ISO code such as CAD.",
    });
  }
  checkDate(input.capitalizedOn, "capitalization date");
  if (input.source.kind === undefined) {
    throw new ContractCostError("Name the cost source.", {
      code: "contract_cost_source_missing",
      remedy: "Record whether the cost was entered manually, imported, or came from a payroll earning or vendor bill line.",
    });
  }
}

/**
 * The single capitalization path: the public entry and every import row
 * run this, so one policy read, one window computation and one journal
 * shape serve both. A cost without a contract becomes an unlinked asset
 * for the workspace queue — visible, never dropped.
 */
async function capitalizeOnRunner(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  subsidiaryId: string,
  input: CapitalizeContractCostInput,
): Promise<CapitalizeContractCostResult> {
  validateCapitalizeInput(input);
  const month = monthStartOf(input.capitalizedOn).slice(0, 7);
  if (!input.revenueContractId) {
    // The original expense account rides in the source so linking can post
    // the capitalization journal when the contract arrives.
    const unlinked = {
      ...input,
      source: { ...input.source, originalExpenseAccountId: input.originalExpenseAccountId },
    };
    const assetId = await insertAsset(runner, orgId, actorId, unlinked, {
      startOn: input.capitalizedOn,
      endOn: input.capitalizedOn,
      status: "active",
      entryId: null,
    });
    await writeAudit(runner, orgId, "contract_cost_assets", assetId, "create", actorId, {
      event: "cost_recorded_unlinked",
      costType: input.costType,
      amountMinor: input.amountMinor.toString(),
      reason: "Recorded without a revenue contract; link it to schedule amortization.",
    });
    return {
      assetId,
      status: "active" as const,
      months: [month],
      scheduleMinor: [],
      capitalizeEntryId: null,
      basisApplied: "pending" as const,
    };
  }
  {
    const policy = await activePolicy(runner, orgId, input.capitalizedOn);
    const capitalizes =
      input.costType === "commission" ? policy.capitalizeCommissions : policy.capitalizeFulfilment;
    if (!capitalizes) {
      const assetId = await insertAsset(runner, orgId, actorId, input, {
        startOn: input.capitalizedOn,
        endOn: input.capitalizedOn,
        status: "expensed",
        entryId: null,
      });
      await writeAudit(runner, orgId, "contract_cost_assets", assetId, "expense", actorId, {
        event: "cost_expensed_policy_excluded",
        costType: input.costType,
        amountMinor: input.amountMinor.toString(),
        reason: "The policy does not capitalize this cost type, so the cost stays in its original account.",
      });
      return {
        assetId,
        status: "expensed" as const,
        months: [monthStartOf(input.capitalizedOn).slice(0, 7)],
        scheduleMinor: [],
        capitalizeEntryId: null,
        basisApplied: "expensed" as const,
      };
    }
    const accounts = requirePolicyAccounts(policy);
    const baseCurrency = await orgBaseCurrency(runner, orgId);
    if (input.currency !== baseCurrency) {
      throw new ContractCostError(
        `Contract costs post in the organization base currency ${baseCurrency}; ${input.currency} would need conversion.`,
        {
          code: "contract_cost_currency_mismatch",
          remedy: `Record the cost in ${baseCurrency}, or convert it at the day rate before capitalizing.`,
        },
      );
    }
    const window = await resolveBenefitWindow(
      runner,
      orgId,
      policy,
      input.revenueContractId ?? null,
      input.capitalizedOn,
      input.renewalCommissionMinor,
      input.amountMinor,
    );
    if (policy.practicalExpedient && window.months.length <= 12) {
      const assetId = await insertAsset(runner, orgId, actorId, input, {
        startOn: `${window.months[0]}-01`,
        endOn: `${window.months[window.months.length - 1]}-01`,
        status: "expensed",
        entryId: null,
      });
      await writeAudit(runner, orgId, "contract_cost_assets", assetId, "expense", actorId, {
        event: "cost_expensed_practical_expedient",
        months: window.months.length,
        amountMinor: input.amountMinor.toString(),
        reason: "The one-year practical expedient applies: the benefit period is twelve months or less.",
      });
      return {
        assetId,
        status: "expensed" as const,
        months: window.months,
        scheduleMinor: [],
        capitalizeEntryId: null,
        basisApplied: "expensed" as const,
      };
    }
    const exponent = await currencyExponent(runner, input.currency);
    const canonical = minorUnitsToCanonical(input.amountMinor, exponent);
    const bookId = await postingBookId(runner, orgId);
    const periodId = await coveringPeriodId(runner, orgId, input.capitalizedOn);
    const assetId = (await import("node:crypto")).randomUUID();
    const posted = await postEntry(runner, {
      orgId,
      bookId,
      subsidiaryId,
      entryNumber: `CC-CAP-${assetId}`,
      postingDate: input.capitalizedOn,
      periodId,
      origin: "contract_cost_capitalize",
      idempotencyKey: `contract-cost:capitalize:${assetId}`,
      currency: input.currency,
      actorId,
      auditAction: "contract_cost.capitalize",
      lines: [
        {
          accountId: accounts.assetAccountId,
          amount: canonical,
          currency: input.currency,
          txnAmount: canonical,
          contributorKind: "contract_cost_asset",
          contributorRef: assetId,
        },
        {
          accountId: input.originalExpenseAccountId,
          amount: fromUnits(-toUnits(canonical)),
          currency: input.currency,
          txnAmount: fromUnits(-toUnits(canonical)),
        },
      ],
    });
    const startMonth = `${window.months[0]}-01`;
    const endMonth = `${window.months[window.months.length - 1]}-01`;
    const stored = await insertAsset(runner, orgId, actorId, { ...input, }, {
      id: assetId,
      startOn: startMonth,
      endOn: lastDayOfMonth(endMonth),
      status: "active",
      entryId: posted.entryId,
    });
    if (stored !== assetId) {
      throw new ContractCostError("The capitalized cost was not stored; nothing was saved.");
    }
    await writeAudit(runner, orgId, "contract_cost_assets", assetId, "create", actorId, {
      event: "cost_capitalized",
      costType: input.costType,
      amountMinor: input.amountMinor.toString(),
      currency: input.currency,
      basis: window.basisApplied,
      months: window.months.length,
      method: input.method ?? "straight_line",
      entryId: posted.entryId,
    });
    const schedule = await scheduleForAsset(runner, orgId, assetId);
    return {
      assetId,
      status: "active",
      months: schedule.map((s) => s.month),
      scheduleMinor: schedule.map((s) => s.amountMinor.toString()),
      capitalizeEntryId: posted.entryId,
      basisApplied: window.basisApplied,
    };
  }
}

async function insertAsset(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  input: CapitalizeContractCostInput,
  fixed: { id?: string; startOn: string; endOn: string; status: ContractCostStatus; entryId: string | null },
): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const id = fixed.id ?? randomUUID();
  const rows = (await runner.execute<{ id: string }>(sql`
    insert into contract_cost_assets
      (id, org_id, revenue_contract_id, rep_party_id, customer_party_id,
       cost_type, amount_minor, currency, capitalized_on, amort_start_on, amort_end_on,
       method, status, source, capitalize_entry_id, created_by, updated_by)
    values (${id}, ${orgId}, ${input.revenueContractId ?? null}, ${input.repPartyId ?? null},
      ${input.customerPartyId ?? null}, ${input.costType}, ${input.amountMinor.toString()}::bigint,
      ${input.currency}, ${input.capitalizedOn}, ${fixed.startOn}, ${fixed.endOn},
      ${input.method ?? "straight_line"}, ${fixed.status},
      ${JSON.stringify(input.source)}::jsonb, ${fixed.entryId}, ${actorId}, ${actorId})
    returning id`)).rows;
  // A write that matches zero rows is a failure, never a success.
  if (rows.length !== 1 || !rows[0]) {
    throw new ContractCostError("The capitalized cost was not stored; nothing was saved.");
  }
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Schedule projection for one asset
// ---------------------------------------------------------------------------

export interface AssetScheduleLine {
  month: string;
  periodId: string | null;
  amountMinor: bigint;
  posted: boolean;
}

interface StoredAsset {
  id: string;
  revenueContractId: string | null;
  amountMinor: bigint;
  currency: string;
  capitalizedOn: string;
  startOn: string;
  endOn: string;
  method: ContractCostMethod;
  status: ContractCostStatus;
  capitalizeEntryId: string | null;
  source: Record<string, unknown>;
}

async function loadAsset(runner: SqlExecutor, orgId: string, assetId: string): Promise<StoredAsset> {
  const row = (await runner.execute<{
    id: string;
    revenue_contract_id: string | null;
    amount_minor: string;
    currency: string;
    capitalized_on: string;
    amort_start_on: string;
    amort_end_on: string;
    method: ContractCostMethod;
    status: ContractCostStatus;
    capitalize_entry_id: string | null;
    source: Record<string, unknown>;
  }>(sql`
    select id, revenue_contract_id, amount_minor::text, currency,
           capitalized_on::text, amort_start_on::text, amort_end_on::text, method, status,
           capitalize_entry_id, source
      from contract_cost_assets where org_id = ${orgId} and id = ${assetId}`)).rows[0];
  if (!row) {
    throw new ContractCostError("The contract cost asset does not exist in this organization.", {
      code: "contract_cost_asset_unknown",
      remedy: "Open the asset from Contract costs; it may belong to another organization.",
    });
  }
  return {
    id: row.id,
    revenueContractId: row.revenue_contract_id,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    capitalizedOn: row.capitalized_on,
    startOn: row.amort_start_on,
    endOn: row.amort_end_on,
    method: row.method,
    status: row.status,
    capitalizeEntryId: row.capitalize_entry_id,
    source: row.source ?? {},
  };
}

/**
 * The full amortization plan for an asset: one line per window month with
 * its covering period and planned minor units. Straight-line shares are
 * fixed at capitalization; pattern shares follow the contract's live
 * revenue schedule, so a rebuilt schedule reweights the remaining plan —
 * the run always caps at the remaining carrying amount.
 */
export async function scheduleForAsset(
  runner: SqlExecutor,
  orgId: string,
  assetId: string,
): Promise<AssetScheduleLine[]> {
  const asset = await loadAsset(runner, orgId, assetId);
  const months = monthStartsFrom(
    monthStartOf(asset.startOn),
    monthsBetweenInclusive(monthStartOf(asset.startOn), monthStartOf(asset.endOn)),
  ).map((m) => m.slice(0, 7));
  const postedMonths = new Set(
    (await runner.execute<{ month: string }>(sql`
      select to_char(p.starts_on, 'YYYY-MM') as month
        from contract_cost_amortization a
        join accounting_periods p on p.org_id = a.org_id and p.id = a.period_id
       where a.org_id = ${orgId} and a.asset_id = ${assetId}`)).rows.map((r) => r.month),
  );
  if (asset.method === "pattern" && asset.revenueContractId) {
    const { periodIds, weights } = await patternWeights(runner, orgId, asset.revenueContractId, months);
    const amounts = allocateMinorUnits(asset.amountMinor, weights.map((w) => (w === 0n ? 0n : w)));
    return months.map((month, i) => ({
      month,
      periodId: periodIds[i] ?? null,
      amountMinor: amounts[i]!,
      posted: postedMonths.has(month),
    }));
  }
  const amounts = projectAmortizationSchedule(asset.amountMinor, months.length);
  const out: AssetScheduleLine[] = [];
  for (let i = 0; i < months.length; i++) {
    const period = await resolveCoveringPeriod(runner, orgId, `${months[i]}-01`);
    out.push({
      month: months[i]!,
      periodId: period?.id ?? null,
      amountMinor: amounts[i]!,
      posted: postedMonths.has(months[i]!),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Amortization run: explicit per period, idempotent per asset and period
// ---------------------------------------------------------------------------

export interface AmortizationRunEntry {
  assetId: string;
  periodId: string;
  amountMinor: string;
  entryId: string;
}

export interface RunAmortizationResult {
  posted: number;
  skipped: number;
  /** Posted minor-unit total, as a decimal string. */
  totalMinor: string;
  entries: AmortizationRunEntry[];
  problems: string[];
}

function isDuplicateKey(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === "23505") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key value/i.test(message);
}

export async function runContractCostAmortization(input: {
  orgId: string;
  actorId: string;
  periodId: string;
}): Promise<RunAmortizationResult> {
  const { orgId, actorId, periodId } = input;
  return withOrgTransaction(orgId, async () => {
    await assertFeatureOn(db, orgId);
    const subsidiaryId = await postingSubsidiaryId(db, orgId);
    await requireCostAuthority(db, orgId, actorId, subsidiaryId, "contract_costs.manage");
    const period = (await db.execute<{
      name: string;
      starts_on: string;
      ends_on: string;
    }>(sql`
      select name, starts_on::text, ends_on::text from accounting_periods
       where org_id = ${orgId} and id = ${periodId}`)).rows[0];
    if (!period) {
      throw new ContractCostError("The amortization period does not exist in this organization.", {
        code: "contract_cost_period_unknown",
        remedy: "Run amortization for a period of this organization.",
      });
    }
    const bookId = await postingBookId(db, orgId);
    const result: RunAmortizationResult = { posted: 0, skipped: 0, totalMinor: "0", entries: [], problems: [] };
    let total = 0n;
    const candidates = (await db.execute<{ id: string }>(sql`
      select id from contract_cost_assets
       where org_id = ${orgId} and status = 'active'
         and revenue_contract_id is not null
         and amort_start_on <= ${period.ends_on} and amort_end_on >= ${period.starts_on}`)).rows;
    for (const { id: assetId } of candidates) {
      try {
        const posted = await amortizeAssetInPeriod(
          db, orgId, actorId, assetId, periodId, period.starts_on, bookId, subsidiaryId,
        );
        if (posted) {
          result.posted += 1;
          total += BigInt(posted.amountMinor);
          result.entries.push(posted);
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        if (isDuplicateKey(error)) {
          // A concurrent run posted this asset and period first: the unique
          // (asset, period) row arbitrates, so count the skip, never a double.
          result.skipped += 1;
          continue;
        }
        throw error;
      }
    }
    const unlinked = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from contract_cost_assets
       where org_id = ${orgId} and status = 'active' and revenue_contract_id is null`)).rows[0];
    if (unlinked && unlinked.n !== "0") {
      result.problems.push(
        `${unlinked.n} capitalized cost(s) are not linked to a revenue contract and were not amortized — link them from Contract costs → Needs attention.`,
      );
    }
    result.totalMinor = total.toString();
    return result;
  });
}

/**
 * Post one asset's amortization for one period. Returns the entry, or null
 * when the asset already carries an amortization row for the period (the
 * idempotent re-run) or the period is closed for it (a skip with no write,
 * matching recognition's discovery semantics).
 */
async function amortizeAssetInPeriod(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  assetId: string,
  periodId: string,
  periodStart: string,
  bookId: string,
  subsidiaryId: string,
): Promise<AmortizationRunEntry | null> {
  const locked = (await runner.execute<{ id: string }>(sql`
    select id from contract_cost_assets
     where org_id = ${orgId} and id = ${assetId} and status = 'active' for update of contract_cost_assets`)).rows[0];
  if (!locked) return null;
  const existing = (await runner.execute<{ id: string }>(sql`
    select id from contract_cost_amortization
     where org_id = ${orgId} and asset_id = ${assetId} and period_id = ${periodId}`)).rows[0];
  if (existing) return null;
  if (!(await arePeriodModulesOpen(runner, {
    orgId, periodId, bookId, subsidiaryIds: [subsidiaryId], modules: ["gl"],
  }))) {
    return null;
  }
  const schedule = await scheduleForAsset(runner, orgId, assetId);
  const line = schedule.find((s) => s.periodId === periodId);
  if (!line || line.amountMinor <= 0n) return null;
  const asset = await loadAsset(runner, orgId, assetId);
  const carrying = await assetCarryingMinor(runner, orgId, assetId);
  if (carrying <= 0n) {
    await markFullyAmortized(runner, orgId, actorId, assetId);
    return null;
  }
  // The plan never posts more than the ledger still carries.
  const amount = line.amountMinor > carrying ? carrying : line.amountMinor;
  const policy = await activePolicy(runner, orgId, asset.capitalizedOn);
  const accounts = requirePolicyAccounts(policy);
  const exponent = await currencyExponent(runner, asset.currency);
  const canonical = minorUnitsToCanonical(amount, exponent);
  const posted = await postEntry(runner, {
    orgId,
    bookId,
    subsidiaryId,
    entryNumber: `CC-AMO-${assetId}-${periodId}`,
    // The posting lands inside the run period, never before capitalization.
    postingDate: asset.capitalizedOn > periodStart ? asset.capitalizedOn : periodStart,
    periodId,
    origin: "contract_cost_amortization",
    idempotencyKey: `contract-cost:amort:${assetId}:${periodId}`,
    currency: asset.currency,
    actorId,
    auditAction: "contract_cost.amortize",
    lines: [
      {
        accountId: accounts.amortizationExpenseAccountId,
        amount: canonical,
        currency: asset.currency,
        txnAmount: canonical,
      },
      {
        accountId: accounts.assetAccountId,
        amount: fromUnits(-toUnits(canonical)),
        currency: asset.currency,
        txnAmount: fromUnits(-toUnits(canonical)),
        contributorKind: "contract_cost_asset",
        contributorRef: assetId,
      },
    ],
  });
  const inserted = (await runner.execute<{ id: string }>(sql`
    insert into contract_cost_amortization
      (id, org_id, asset_id, period_id, amount_minor, journal_entry_id, created_by, updated_by)
    values (uuid_generate_v7(), ${orgId}, ${assetId}, ${periodId},
      ${amount.toString()}::bigint, ${posted.entryId}, ${actorId}, ${actorId})
    returning id`)).rows;
  if (inserted.length !== 1) {
    throw new ContractCostError("The amortization row was not stored; the entry was rolled back.");
  }
  const remaining = await assetCarryingMinor(runner, orgId, assetId);
  if (remaining <= 0n) {
    await markFullyAmortized(runner, orgId, actorId, assetId);
  }
  return { assetId, periodId, amountMinor: amount.toString(), entryId: posted.entryId };
}

async function markFullyAmortized(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  assetId: string,
): Promise<void> {
  const updated = (await runner.execute<{ id: string }>(sql`
    update contract_cost_assets
       set status = 'fully_amortized', updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${assetId} and status = 'active'
    returning id`)).rows;
  if (updated.length !== 1) {
    throw new ContractCostError("The asset status change matched no rows; nothing was saved.", {
      code: "contract_cost_status_race",
      remedy: "Reopen the asset and try again; a concurrent run may have changed it.",
    });
  }
  await writeAudit(runner, orgId, "contract_cost_assets", assetId, "update", actorId, {
    event: "cost_fully_amortized",
    before: { status: "active" },
    after: { status: "fully_amortized" },
    reason: "Amortization reached the capitalized amount.",
  });
}

// ---------------------------------------------------------------------------
// Impairment (ASC 340-40-35-3): carrying vs remaining consideration less
// costs not yet recognized. Approval is segregated from day-to-day work.
// ---------------------------------------------------------------------------

export interface ImpairmentAssessment {
  posted: boolean;
  /** Minor units written down, as a decimal string ("0" when clean). */
  impairmentMinor: string;
  carryingMinor: string;
  recoverableMinor: string;
  entryId: string | null;
}

export async function recognizeContractCostImpairment(input: {
  orgId: string;
  actorId: string;
  assetId: string;
  remainingConsiderationMinor: bigint;
  costsNotYetRecognizedMinor: bigint;
  reason: string;
  /** Assessment date, YYYY-MM-DD: the impairment posts in its period. */
  assessedOn: string;
}): Promise<ImpairmentAssessment> {
  const { orgId, actorId, assetId } = input;
  if (input.remainingConsiderationMinor < 0n || input.costsNotYetRecognizedMinor < 0n) {
    throw new ContractCostError("Remaining consideration and unrecognized costs cannot be negative.");
  }
  checkDate(input.assessedOn, "assessment date");
  if (input.reason.trim().length < 8) {
    throw new ContractCostError("Record an impairment reason of at least 8 characters.", {
      code: "contract_cost_impairment_reason",
      remedy: "Describe what changed (churn, contraction, cancelled renewal) in at least 8 characters.",
    });
  }
  return withOrgTransaction(orgId, async () => {
    await assertFeatureOn(db, orgId);
    const subsidiaryId = await postingSubsidiaryId(db, orgId);
    await requireCostAuthority(db, orgId, actorId, subsidiaryId, "contract_costs.approve");
    const locked = (await db.execute<{ id: string }>(sql`
      select id from contract_cost_assets
       where org_id = ${orgId} and id = ${assetId} for update of contract_cost_assets`)).rows[0];
    if (!locked) {
      throw new ContractCostError("The contract cost asset does not exist in this organization.", {
        code: "contract_cost_asset_unknown",
        remedy: "Open the asset from Contract costs; it may belong to another organization.",
      });
    }
    const asset = await loadAsset(db, orgId, assetId);
    if (asset.status !== "active") {
      throw new ContractCostError(`Only an active asset can be impaired; this one is ${asset.status}.`, {
        code: "contract_cost_impairment_state",
        remedy: "Impairment applies to active assets. A fully amortized or expensed cost carries nothing to write down.",
      });
    }
    const carrying = await assetCarryingMinor(db, orgId, assetId);
    const recoverable = input.remainingConsiderationMinor - input.costsNotYetRecognizedMinor;
    const writeDown = carrying > recoverable ? carrying - recoverable : 0n;
    if (writeDown <= 0n) {
      await writeAudit(db, orgId, "contract_cost_assets", assetId, "assess", actorId, {
        event: "impairment_assessed_clean",
        carryingMinor: carrying.toString(),
        recoverableMinor: recoverable.toString(),
        reason: input.reason,
      });
      return {
        posted: false,
        impairmentMinor: "0",
        carryingMinor: carrying.toString(),
        recoverableMinor: recoverable.toString(),
        entryId: null,
      };
    }
    const policy = await activePolicy(db, orgId, asset.capitalizedOn);
    const accounts = requirePolicyAccounts(policy);
    const exponent = await currencyExponent(db, asset.currency);
    const canonical = minorUnitsToCanonical(writeDown, exponent);
    const bookId = await postingBookId(db, orgId);
    const periodId = await coveringPeriodId(db, orgId, input.assessedOn);
    const posted = await postEntry(db, {
      orgId,
      bookId,
      subsidiaryId,
      entryNumber: `CC-IMP-${assetId}-${input.assessedOn}`,
      postingDate: input.assessedOn,
      periodId,
      origin: "contract_cost_impairment",
      idempotencyKey: `contract-cost:impair:${assetId}:${input.assessedOn}`,
      currency: asset.currency,
      actorId,
      auditAction: "contract_cost.impair",
      lines: [
        {
          accountId: accounts.amortizationExpenseAccountId,
          amount: canonical,
          currency: asset.currency,
          txnAmount: canonical,
        },
        {
          accountId: accounts.assetAccountId,
          amount: fromUnits(-toUnits(canonical)),
          currency: asset.currency,
          txnAmount: fromUnits(-toUnits(canonical)),
          contributorKind: "contract_cost_asset",
          contributorRef: assetId,
        },
      ],
    });
    const updated = (await db.execute<{ id: string }>(sql`
      update contract_cost_assets
         set status = 'impaired', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${assetId} and status = 'active'
      returning id`)).rows;
    if (updated.length !== 1) {
      throw new ContractCostError("The asset status change matched no rows; nothing was saved.", {
        code: "contract_cost_status_race",
        remedy: "Reopen the asset and try again; a concurrent run may have changed it.",
      });
    }
    await writeAudit(db, orgId, "contract_cost_assets", assetId, "impair", actorId, {
      event: "cost_impaired",
      before: { status: "active", carryingMinor: carrying.toString() },
      after: { status: "impaired", carryingMinor: (carrying - writeDown).toString() },
      impairmentMinor: writeDown.toString(),
      remainingConsiderationMinor: input.remainingConsiderationMinor.toString(),
      costsNotYetRecognizedMinor: input.costsNotYetRecognizedMinor.toString(),
      reason: input.reason,
      entryId: posted.entryId,
    });
    return {
      posted: true,
      impairmentMinor: writeDown.toString(),
      carryingMinor: carrying.toString(),
      recoverableMinor: recoverable.toString(),
      entryId: posted.entryId,
    };
  });
}

// ---------------------------------------------------------------------------
// Link an imported commission to its contract; import commission rows
// ---------------------------------------------------------------------------

/**
 * Link a commission that arrived without a contract (import queue) to its
 * revenue contract, recomputing the amortization window from the live
 * policy. An asset the run has already posted against keeps its window:
 * later insight arrives as impairment, never a rewrite.
 */
export async function linkContractCostAsset(input: {
  orgId: string;
  actorId: string;
  assetId: string;
  revenueContractId: string;
}): Promise<{ assetId: string; months: string[] }> {
  const { orgId, actorId, assetId, revenueContractId } = input;
  return withOrgTransaction(orgId, async () => {
    await assertFeatureOn(db, orgId);
    const subsidiaryId = await postingSubsidiaryId(db, orgId);
    await requireCostAuthority(db, orgId, actorId, subsidiaryId, "contract_costs.manage");
    const locked = (await db.execute<{
      status: string;
      capitalized_on: string;
      amount_minor: string;
      method: ContractCostMethod;
    }>(sql`
      select status, capitalized_on::text, amount_minor::text, method
        from contract_cost_assets
       where org_id = ${orgId} and id = ${assetId} for update of contract_cost_assets`)).rows[0];
    if (!locked) {
      throw new ContractCostError("The contract cost asset does not exist in this organization.", {
        code: "contract_cost_asset_unknown",
        remedy: "Open the asset from Contract costs; it may belong to another organization.",
      });
    }
    if (locked.status !== "active") {
      throw new ContractCostError(`Only an active asset can be linked; this one is ${locked.status}.`, {
        code: "contract_cost_link_state",
        remedy: "Link commissions before the amortization run reaches them.",
      });
    }
    const posted = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from contract_cost_amortization
       where org_id = ${orgId} and asset_id = ${assetId}`)).rows[0];
    if (posted && posted.n !== "0") {
      throw new ContractCostError("This asset already carries posted amortization; its window is fixed.", {
        code: "contract_cost_link_posted",
        remedy: "Leave the window and recognize later insight as impairment instead.",
      });
    }
    const policy = await activePolicy(db, orgId, locked.capitalized_on);
    const window = await resolveBenefitWindow(
      db, orgId, policy, revenueContractId, locked.capitalized_on, undefined, BigInt(locked.amount_minor),
    );
    const asset = await loadAsset(db, orgId, assetId);
    // An asset recorded without a contract carries no capitalization
    // journal yet: linking posts it now, so the ledger always holds the
    // debit before amortization credits it.
    let entryId = asset.capitalizeEntryId;
    if (!entryId) {
      const originalExpense = asset.source["originalExpenseAccountId"];
      if (typeof originalExpense !== "string" || !originalExpense) {
        throw new ContractCostError("The asset names no original expense account for its capitalization.", {
          code: "contract_cost_link_account_missing",
          remedy:
            "Re-record the cost with its original expense (or accrual) account, then link it to the contract.",
        });
      }
      const accounts = requirePolicyAccounts(policy);
      const exponent = await currencyExponent(db, asset.currency);
      const canonical = minorUnitsToCanonical(asset.amountMinor, exponent);
      const bookId = await postingBookId(db, orgId);
      const periodId = await coveringPeriodId(db, orgId, asset.capitalizedOn);
      entryId = (await postEntry(db, {
        orgId,
        bookId,
        subsidiaryId,
        entryNumber: `CC-CAP-${assetId}`,
        postingDate: asset.capitalizedOn,
        periodId,
        origin: "contract_cost_capitalize",
        idempotencyKey: `contract-cost:capitalize:${assetId}`,
        currency: asset.currency,
        actorId,
        auditAction: "contract_cost.capitalize",
        lines: [
          {
            accountId: accounts.assetAccountId,
            amount: canonical,
            currency: asset.currency,
            txnAmount: canonical,
            contributorKind: "contract_cost_asset",
            contributorRef: assetId,
          },
          {
            accountId: originalExpense,
            amount: fromUnits(-toUnits(canonical)),
            currency: asset.currency,
            txnAmount: fromUnits(-toUnits(canonical)),
          },
        ],
      })).entryId;
    }
    const startMonth = `${window.months[0]}-01`;
    const endMonth = `${window.months[window.months.length - 1]}-01`;
    const updated = (await db.execute<{ id: string }>(sql`
      update contract_cost_assets
         set revenue_contract_id = ${revenueContractId},
             amort_start_on = ${startMonth}, amort_end_on = ${lastDayOfMonth(endMonth)},
             capitalize_entry_id = ${entryId},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${assetId} and status = 'active'
      returning id`)).rows;
    if (updated.length !== 1) {
      throw new ContractCostError("Linking the contract matched no rows; nothing was saved.", {
        code: "contract_cost_status_race",
        remedy: "Reopen the asset and try again; a concurrent run may have changed it.",
      });
    }
    await writeAudit(db, orgId, "contract_cost_assets", assetId, "update", actorId, {
      event: "cost_linked",
      after: { revenueContractId, months: window.months.length, basis: window.basisApplied, entryId },
      reason: "Imported commission linked to its revenue contract.",
    });
    return { assetId, months: window.months };
  });
}

export interface CommissionImportRow {
  /** Sales-rep party id, when known. */
  repPartyId?: string | null;
  /** Customer party id, when known. */
  customerPartyId?: string | null;
  /** Revenue contract number (CaptivateIQ/QuotaPath `contract` reference). */
  contractNumber?: string | null;
  costType?: ContractCostType;
  amountMinor: bigint;
  currency: string;
  /** Payout/earned date, YYYY-MM-DD. */
  date: string;
  method?: ContractCostMethod;
  originalExpenseAccountId: string;
  renewalCommissionMinor?: bigint;
  /** Import batch reference (file name, row number). */
  ref?: string;
}

export interface CommissionImportResult {
  assetId: string | null;
  ok: boolean;
  error?: string;
  remedy?: string;
}

/**
 * Import CaptivateIQ/QuotaPath-style commission rows. A row whose contract
 * number resolves becomes a scheduled asset; anything else (unknown
 * contract, missing contract) becomes an unlinked asset for the workspace
 * queue — never a dropped row. One bad row refuses itself with its remedy
 * and never blocks its batch siblings.
 */
export async function importCommissionCosts(input: {
  orgId: string;
  actorId: string;
  rows: CommissionImportRow[];
}): Promise<CommissionImportResult[]> {
  const { orgId, actorId, rows } = input;
  return withOrgTransaction(orgId, async () => {
    await assertFeatureOn(db, orgId);
    const subsidiaryId = await postingSubsidiaryId(db, orgId);
    await requireCostAuthority(db, orgId, actorId, subsidiaryId, "contract_costs.manage");
    const out: CommissionImportResult[] = [];
    for (const row of rows) {
      try {
        let contractId: string | null = null;
        if (row.contractNumber) {
          const found = (await db.execute<{ id: string }>(sql`
            select id from revenue_contracts
             where org_id = ${orgId} and contract_number = ${row.contractNumber}`)).rows[0];
          contractId = found?.id ?? null;
        }
        // Unknown or missing contract references become unlinked queue
        // assets inside the shared path — never a dropped row.
        const capitalized = await capitalizeOnRunner(db, orgId, actorId, subsidiaryId, {
          orgId,
          actorId,
          revenueContractId: contractId,
          repPartyId: row.repPartyId ?? null,
          customerPartyId: row.customerPartyId ?? null,
          costType: row.costType ?? "commission",
          amountMinor: row.amountMinor,
          currency: row.currency,
          capitalizedOn: row.date,
          method: row.method ?? "straight_line",
          originalExpenseAccountId: row.originalExpenseAccountId,
          renewalCommissionMinor: row.renewalCommissionMinor,
          source: {
            kind: "import",
            ref: row.ref ?? null,
            contractNumber: row.contractNumber ?? null,
          },
        });
        out.push({ assetId: capitalized.assetId, ok: true });
      } catch (error) {
        const refusal = error instanceof ContractCostError ? error : null;
        out.push({
          assetId: null,
          ok: false,
          error: refusal?.message ?? "The import row failed validation.",
          remedy: refusal?.remedy ?? "Correct the row and import it again.",
        });
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Workspace queue: unlinked commissions, churned contracts awaiting review
// ---------------------------------------------------------------------------

export interface AttentionItem {
  assetId: string;
  kind: "unlinked" | "churned";
  contractNumber: string | null;
  carryingMinor: string;
  capitalizedOn: string;
}

/**
 * The workspace's "Needs attention" queue: commissions not yet linked to a
 * contract, and active assets on cancelled contracts whose unamortized
 * balance awaits an impairment decision. Read-only; the operator acts with
 * linkContractCostAsset and recognizeContractCostImpairment.
 */
export async function contractCostAttentionItems(
  runner: SqlExecutor,
  orgId: string,
): Promise<AttentionItem[]> {
  const rows = (await runner.execute<{
    id: string;
    revenue_contract_id: string | null;
    contract_number: string | null;
    contract_status: string | null;
    capitalized_on: string;
  }>(sql`
    select asset.id, asset.revenue_contract_id,
           contract.contract_number, contract.status as contract_status,
           asset.capitalized_on::text
      from contract_cost_assets asset
      left join revenue_contracts contract
        on contract.org_id = asset.org_id and contract.id = asset.revenue_contract_id
     where asset.org_id = ${orgId} and asset.status = 'active'`)).rows;
  const out: AttentionItem[] = [];
  for (const row of rows) {
    if (!row.revenue_contract_id) {
      out.push({
        assetId: row.id,
        kind: "unlinked",
        contractNumber: null,
        carryingMinor: (await assetCarryingMinor(runner, orgId, row.id)).toString(),
        capitalizedOn: row.capitalized_on,
      });
    } else if (row.contract_status === "cancelled") {
      const carrying = await assetCarryingMinor(runner, orgId, row.id);
      if (carrying > 0n) {
        out.push({
          assetId: row.id,
          kind: "churned",
          contractNumber: row.contract_number,
          carryingMinor: carrying.toString(),
          capitalizedOn: row.capitalized_on,
        });
      }
    }
  }
  return out;
}


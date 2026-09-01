import { sql } from "drizzle-orm";
import { db, inDbTransaction } from "./db.ts";
import {
  add,
  cmp,
  div,
  mul,
  mulPercent,
  mulRate,
  neg,
  isZero,
  normalizeDecimal,
  normalizeMoney,
} from "./money.ts";
import {
  postProjectGlEntryWithinTransaction,
  recognitionAccounts,
  reverseProjectGlEntryWithinTransaction,
} from "./project-recognition.ts";

/**
 * Labor costing — resolve an employee's standard cost rate for a work date and
 * snapshot it onto approved time.
 *
 * Doctrine (see /admin/setup/labor-costing):
 *   cost/hr = wage(scope, date) × timeType.costMultiplier
 *           + Σ estimate components (statutory burden %, per-diem, …)
 * The wage comes from labor_cost_rates (employee > job title > trade >
 * department > subsidiary > org default, latest effective_from wins).
 * Components are org settings — pure calculator inputs
 * that make pre-payroll job cost realistic; payroll actuals later wash them
 * through the labor clearing account. Overhead is a SEPARATE statistical layer
 * (Overhead Model) and never enters this rate.
 */

export interface LaborCostComponent {
  key: string;
  /** worker_comp: a % of wage whose RATE comes from the employee's assigned
   * worker-comp/WSIB group (value is only the fallback when unassigned). */
  kind: "percent_of_wage" | "per_hour" | "per_day" | "worker_comp";
  name: string;
  value: number | string;
  /** percent_of_wage/worker_comp/per_hour: apply to (or alongside) the
   * OT-multiplied wage. */
  scaleWithOvertime?: boolean;
}

export interface LaborCostingSettings {
  /** off = never post; post = standard cost posts to jobs at approval. */
  mode: "off" | "post";
  hoursPerDay: number;
  annualHours: number;
  components: LaborCostComponent[];
}

export const DEFAULT_LABOR_COSTING: LaborCostingSettings = {
  mode: "off",
  hoursPerDay: 8,
  annualHours: 2080,
  components: [],
};

export async function laborCostingSettings(
  orgId: string,
): Promise<LaborCostingSettings> {
  const r = (await db.execute<{ c: Partial<LaborCostingSettings> | null }>(
    sql`select settings->'laborCosting' as c from orgs where id = ${orgId}`,
  ));
  const c = r.rows[0]?.c ?? {};
  return {
    mode: c.mode === "post" ? "post" : "off",
    hoursPerDay: Number(c.hoursPerDay) > 0 ? Number(c.hoursPerDay) : 8,
    annualHours: Number(c.annualHours) > 0 ? Number(c.annualHours) : 2080,
    components: Array.isArray(c.components)
      ? (c.components as LaborCostComponent[])
      : [],
  };
}

export interface ResolvedWage {
  /** Hourly wage (annual rates already divided by annualHours). */
  wage: string;
  currency: string;
  scope:
    "employee" | "job_title" | "trade" | "department" | "subsidiary" | "org";
  rateId: string;
}

/**
 * Resolve the standard hourly wage for an employee on a date. Most-specific
 * scope wins (employee > job title > trade > department > subsidiary > org);
 * within a scope the latest effective_from ≤ workedOn wins. Returns null when
 * no rate covers the date.
 */
export async function resolveWage(
  orgId: string,
  employeePartyId: string,
  workedOn: string,
  opts?: {
    jobTitle?: string | null;
    tradeId?: string | null;
    departmentId?: string | null;
    subsidiaryId?: string | null;
    annualHoursDefault?: number;
  },
): Promise<ResolvedWage | null> {
  let jobTitle = opts?.jobTitle;
  let tradeId = opts?.tradeId;
  let departmentId = opts?.departmentId;
  let subsidiaryId = opts?.subsidiaryId;
  if (
    jobTitle === undefined ||
    tradeId === undefined ||
    departmentId === undefined ||
    subsidiaryId === undefined
  ) {
    const t = (await db.execute<{
        job_title: string | null;
        trade_id: string | null;
        department_id: string | null;
        subsidiary_id: string | null;
      }>(sql`
      select er.job_title, er.trade_id, er.department_id, p.subsidiary_id
        from employee_roles er
        join parties p on p.id = er.party_id and p.org_id = er.org_id
       where er.org_id = ${orgId} and er.party_id = ${employeePartyId}`));
    const employee = t.rows[0];
    jobTitle =
      jobTitle === undefined ? (employee?.job_title ?? null) : jobTitle;
    tradeId = tradeId === undefined ? (employee?.trade_id ?? null) : tradeId;
    departmentId =
      departmentId === undefined
        ? (employee?.department_id ?? null)
        : departmentId;
    subsidiaryId =
      subsidiaryId === undefined
        ? (employee?.subsidiary_id ?? null)
        : subsidiaryId;
  }
  const r = (await db.execute<{
      id: string;
      rate: string;
      basis: string;
      annual_hours: string;
      currency: string;
      scope: ResolvedWage["scope"];
    }>(sql`
    select id, rate, basis, annual_hours, currency,
           case when employee_party_id is not null then 'employee'
                when job_title is not null then 'job_title'
                when trade_id is not null then 'trade'
                when department_id is not null then 'department'
                when subsidiary_id is not null then 'subsidiary'
                else 'org' end as scope
      from labor_cost_rates
     where org_id = ${orgId} and is_active
       and effective_from <= ${workedOn}
       and (effective_to is null or effective_to >= ${workedOn})
       and (employee_party_id = ${employeePartyId}
            or (employee_party_id is null and job_title is not null and lower(job_title) = lower(${jobTitle}))
            or (employee_party_id is null and trade_id is not distinct from ${tradeId} and trade_id is not null)
            or (employee_party_id is null and department_id is not distinct from ${departmentId} and department_id is not null)
            or (employee_party_id is null and subsidiary_id is not distinct from ${subsidiaryId} and subsidiary_id is not null)
            or (num_nonnulls(employee_party_id, job_title, trade_id, department_id, subsidiary_id) = 0))
     order by case when employee_party_id is not null then 0
                   when job_title is not null then 1
                   when trade_id is not null then 2
                   when department_id is not null then 3
                   when subsidiary_id is not null then 4 else 5 end,
              effective_from desc
     limit 1`));
  const row = r.rows[0];
  if (!row) return null;
  const wage =
    row.basis === "year"
      ? div(
          String(row.rate),
          cmp(String(row.annual_hours), "0") > 0
            ? String(row.annual_hours)
            : String(opts?.annualHoursDefault ?? 2080),
        )
      : String(row.rate);
  return { wage, currency: row.currency, scope: row.scope, rateId: row.id };
}

/** Convert a wage to functional currency using an exact decimal FX rate. */
export function convertLaborWage(wage: string, fxRate: string): string {
  return mulRate(wage, fxRate);
}

/** Convert only fixed-amount components; percentage components are unitless. */
export function convertFixedLaborComponents(
  components: LaborCostComponent[],
  fxRate: string,
): LaborCostComponent[] {
  return components.map((component) =>
    component.kind === "per_hour" || component.kind === "per_day"
      ? {
          ...component,
          value: convertLaborWage(String(component.value), fxRate),
        }
      : component,
  );
}

/**
 * Latest spot rate on or before a date, direct or inverted. Exported because
 * the PAY RUN needs exactly this rate: a wage row denominated in one currency
 * paid by an entity that reports in another must be converted before it is
 * paid, and it must be converted by the same rule that costs the hour.
 */
export async function laborFxRate(
  orgId: string,
  from: string,
  to: string,
  workedOn: string,
): Promise<string | null> {
  if (from === to) return "1";
  const result = (await db.execute<{ rate: string }>(sql`
    select rate::text from (
      select rate, as_of, 0 as priority from fx_rates
       where org_id = ${orgId} and from_currency = ${from} and to_currency = ${to}
         and rate_type = 'spot' and as_of <= ${workedOn}
      union all
      select (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority from fx_rates
       where org_id = ${orgId} and from_currency = ${to} and to_currency = ${from}
         and rate_type = 'spot' and as_of <= ${workedOn}
    ) candidates order by as_of desc, priority asc limit 1`));
  return result.rows[0]?.rate ?? null;
}

/**
 * Combine a resolved wage with the time type's multiplier and the org's
 * estimate components into the standard cost rate per hour. Pure — unit-tested
 * without a database.
 */
export function computeCostRate(
  wage: string,
  costMultiplier: string,
  settings: Pick<LaborCostingSettings, "hoursPerDay" | "components">,
  opts: { workerCompPercent?: number | string } = {},
): string {
  // Wage x time-type multiplier: both numeric(19,4) money-scale values, not
  // an FX conversion. mulRate additionally rejected a zero multiplier.
  const base = mul(wage, costMultiplier);
  let rate = base;
  for (const c of settings.components) {
    if (c.kind === "worker_comp") {
      // Rate = the employee's assigned comp-group %, else the component's
      // fallback value. A 0% group means no worker comp for that person.
      const pct = String(opts.workerCompPercent ?? c.value);
      let exactPercent: string;
      try {
        exactPercent = normalizeMoney(pct);
      } catch {
        continue;
      }
      if (cmp(exactPercent, "0") === 0) continue;
      const on = c.scaleWithOvertime ? base : wage;
      rate = add(rate, mulPercent(on, exactPercent));
      continue;
    }
    let value: string;
    try {
      value = normalizeMoney(c.value);
    } catch {
      continue;
    }
    if (isZero(value)) continue;
    if (c.kind === "percent_of_wage") {
      const on = c.scaleWithOvertime ? base : wage;
      rate = add(rate, mulPercent(on, value));
    } else if (c.kind === "per_hour") {
      rate = add(
        rate,
        c.scaleWithOvertime ? mul(value, costMultiplier) : value,
      );
    } else if (c.kind === "per_day") {
      const perDay =
        settings.hoursPerDay > 0
          ? div(value, String(settings.hoursPerDay))
          : "0.0000";
      rate = add(rate, perDay);
    }
  }
  return rate;
}

/**
 * Snapshot standard cost rates onto time entries that don't have one yet
 * (imported entries arrive with cost_rate already set — those are never
 * touched). Safe to call for any id set; skips silently when the org has no
 * covering wage. Returns the number of entries stamped.
 */
export async function snapshotLaborCostRates(
  orgId: string,
  timeEntryIds: string[],
): Promise<number> {
  if (timeEntryIds.length === 0) return 0;
  const settings = await laborCostingSettings(orgId);
  const idArr = `{${timeEntryIds.join(",")}}`;
  // Approval executes this helper inside a withOrg transaction, which pins one
  // PostgreSQL client. Do not dispatch parallel queries on that client.
  const rows = (await db.execute<{
      id: string;
      employee_party_id: string;
      worked_on: string;
      cost_multiplier: string;
      job_title: string | null;
      trade_id: string | null;
      department_id: string | null;
      subsidiary_id: string | null;
      target_currency: string | null;
      target_subsidiary_id: string | null;
      worker_comp_percent: string | null;
    }>(sql`
    select te.id, te.employee_party_id, te.worked_on,
           coalesce(tt.cost_multiplier, '1') as cost_multiplier,
           er.job_title, er.trade_id, er.department_id, employee.subsidiary_id,
           coalesce(project_sub.base_currency, employee_sub.base_currency) as target_currency,
           coalesce(project.subsidiary_id, employee.subsidiary_id) as target_subsidiary_id,
           wcg.rate_percent as worker_comp_percent
      from time_entries te
      left join time_types tt on tt.id = te.time_type_id and tt.org_id = te.org_id
      left join employee_roles er on er.org_id = te.org_id and er.party_id = te.employee_party_id
      left join parties employee on employee.id = te.employee_party_id and employee.org_id = te.org_id
      left join subsidiaries employee_sub on employee_sub.id = employee.subsidiary_id and employee_sub.org_id = te.org_id
      left join projects project on project.id = te.project_id and project.org_id = te.org_id
      left join subsidiaries project_sub on project_sub.id = project.subsidiary_id and project_sub.org_id = te.org_id
      left join worker_comp_groups wcg on wcg.id = er.worker_comp_group_id and wcg.org_id = te.org_id
     where te.org_id = ${orgId} and te.id = any(${idArr}::uuid[]) and te.cost_rate is null`));
  const org = (await db.execute<{ base_currency: string; root_subsidiary_id: string | null }>(sql`
      select o.base_currency,
             (select id from subsidiaries where org_id = o.id and parent_id is null and is_active limit 1) as root_subsidiary_id
        from orgs o where o.id = ${orgId}`));
  const orgCurrency = org.rows[0]?.base_currency;
  if (!orgCurrency)
    throw new Error("organization base currency is not configured");
  const rootSubsidiaryId = org.rows[0]?.root_subsidiary_id;
  if (!rootSubsidiaryId)
    throw new Error("organization root subsidiary is not configured");
  let stamped = 0;
  // Cache wage resolution per employee+date (a week of entries shares both).
  const cache = new Map<string, ResolvedWage | null>();
  const fxCache = new Map<string, string>();
  for (const r of rows.rows) {
    const targetCurrency = r.target_currency ?? orgCurrency;
    const targetSubsidiaryId = r.target_subsidiary_id ?? rootSubsidiaryId;
    const key = `${r.employee_party_id}|${r.worked_on}|${targetSubsidiaryId}`;
    let wage = cache.get(key);
    if (wage === undefined) {
      wage = await resolveWage(orgId, r.employee_party_id, r.worked_on, {
        jobTitle: r.job_title,
        tradeId: r.trade_id,
        departmentId: r.department_id,
        subsidiaryId: targetSubsidiaryId,
        annualHoursDefault: settings.annualHours,
      });
      cache.set(key, wage);
    }
    if (!wage) continue;
    const fxKey = `${wage.currency}|${targetCurrency}|${r.worked_on}`;
    let fxRate = fxCache.get(fxKey);
    if (!fxRate) {
      fxRate =
        (await laborFxRate(
          orgId,
          wage.currency,
          targetCurrency,
          r.worked_on,
        )) ?? undefined;
      if (!fxRate)
        throw new Error(
          `no spot rate for labor wage ${wage.currency}→${targetCurrency} on or before ${r.worked_on}`,
        );
      fxCache.set(fxKey, fxRate);
    }
    const functionalWage = convertLaborWage(wage.wage, fxRate);
    const componentFxKey = `${orgCurrency}|${targetCurrency}|${r.worked_on}`;
    let componentFxRate = fxCache.get(componentFxKey);
    if (!componentFxRate) {
      componentFxRate =
        (await laborFxRate(orgId, orgCurrency, targetCurrency, r.worked_on)) ??
        undefined;
      if (!componentFxRate)
        throw new Error(
          `no spot rate for labor components ${orgCurrency}→${targetCurrency} on or before ${r.worked_on}`,
        );
      fxCache.set(componentFxKey, componentFxRate);
    }
    const functionalSettings = {
      ...settings,
      components: convertFixedLaborComponents(
        settings.components,
        componentFxRate,
      ),
    };
    const workerCompPercent =
      r.worker_comp_percent != null ? String(r.worker_comp_percent) : undefined;
    const rate = computeCostRate(
      functionalWage,
      String(r.cost_multiplier),
      functionalSettings,
      { workerCompPercent },
    );
    await db.execute(sql`
      update time_entries
         set cost_rate = ${rate},
             labor_cost_rate_id = ${wage.rateId},
             wage_rate = ${wage.wage},
             wage_currency = ${wage.currency},
             wage_fx_rate = ${normalizeDecimal(fxRate, 10)},
             cost_rate_currency = ${targetCurrency},
             cost_rate_subsidiary_id = ${targetSubsidiaryId}
       where id = ${r.id} and org_id = ${orgId} and cost_rate is null`);
    stamped++;
  }
  return stamped;
}

/* ------------------------------------------------------------------ */
/* Payroll true-up — the labor clearing reconciliation                 */
/* ------------------------------------------------------------------ */

export interface ClearingReconciliation {
  subsidiaryId: string;
  currency: string;
  /** Σ standard labor CREDITED to clearing this period (origin labor_burden). */
  standardPosted: string;
  /** Σ payroll actuals DEBITED to clearing this period (all other postings). */
  payrollPosted: string;
  /** standardPosted − payrollPosted for the period (+ = payroll hasn't landed / under-posted). */
  periodVariance: string;
  /** The clearing account's all-time net balance (should trend to ~0). */
  openBalance: string;
  /** Standard labor cost by project this period, for the drill table. */
  perProject: { projectId: string; name: string; standard: string }[];
}

type LaborTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LaborExecutor = Pick<LaborTransaction, "execute">;

async function laborClearingReconciliationFrom(
  executor: LaborExecutor,
  orgId: string,
  periodStart: string,
  periodEnd: string,
  subsidiaryId: string,
  laborClearingAccountId: string,
): Promise<ClearingReconciliation> {
  // Reversed originals AND their posted mirrors are both included everywhere so
  // reversal pairs cancel instead of double- or half-counting.
  const sums = (await executor.execute<{ standard_posted: string; payroll_posted: string }>(sql`
    select
      coalesce(-sum(l.amount) filter (where e.origin = 'labor_burden'), 0) as standard_posted,
      coalesce(sum(l.amount) filter (where e.origin is distinct from 'labor_burden'
                                       and e.origin is distinct from 'payroll_variance'), 0) as payroll_posted
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
     where l.org_id = ${orgId} and l.account_id = ${laborClearingAccountId}
       and l.subsidiary_id = ${subsidiaryId}
       and e.posting_date >= ${periodStart} and e.posting_date <= ${periodEnd}`));
  const open = (await executor.execute<{ balance: string }>(sql`
    select coalesce(sum(l.amount), 0) as balance
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
     where l.org_id = ${orgId} and l.account_id = ${laborClearingAccountId}
       and l.subsidiary_id = ${subsidiaryId}`));
  // The drill reads the job-tagged labor WIP debit, whose ledger amount is
  // already positive. Keep the headline's clearing-credit negation separate.
  const perProject = (await executor.execute<{ project_id: string; name: string; standard: string }>(sql`
    select l.project_id, p.name, sum(l.amount) as standard
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed') and e.origin = 'labor_burden'
      join projects p on p.id = l.project_id and p.org_id = l.org_id
     where l.org_id = ${orgId} and l.project_id is not null
       and l.subsidiary_id = ${subsidiaryId}
       and e.posting_date >= ${periodStart} and e.posting_date <= ${periodEnd}
     group by l.project_id, p.name
     having sum(l.amount) <> 0
     order by sum(l.amount) desc
     limit 25`));
  const subsidiary = (await executor.execute<{ base_currency: string }>(sql`
    select base_currency
      from subsidiaries
     where org_id = ${orgId} and id = ${subsidiaryId} and is_active`));
  const currency = subsidiary.rows[0]?.base_currency;
  if (!currency)
    throw new Error("labor reconciliation subsidiary is not available");

  const s = sums.rows[0] ?? { standard_posted: "0", payroll_posted: "0" };
  return {
    subsidiaryId,
    currency,
    standardPosted: String(s.standard_posted),
    payrollPosted: String(s.payroll_posted),
    periodVariance: add(
      String(s.standard_posted),
      neg(String(s.payroll_posted)),
    ),
    openBalance: String(open.rows[0]?.balance ?? "0"),
    perProject: perProject.rows.map((r) => ({
      projectId: r.project_id,
      name: r.name,
      standard: String(r.standard),
    })),
  };
}

/**
 * The wash: standard labor postings CREDIT the clearing account at approval;
 * the payroll journal (imported through data-io or entered manually) DEBITS
 * the same account when actuals land. This reads both sides for a period.
 * Doctrine: the estimated components dissolve here — after payroll posts, job
 * labor cost is anchored by real GL and the residue is the payroll variance.
 */
export async function laborClearingReconciliation(
  orgId: string,
  periodStart: string,
  periodEnd: string,
  subsidiaryId: string,
): Promise<ClearingReconciliation | null> {
  const accts = await recognitionAccounts(orgId);
  if (!accts.laborClearing) return null;
  return laborClearingReconciliationFrom(
    db,
    orgId,
    periodStart,
    periodEnd,
    subsidiaryId,
    accts.laborClearing,
  );
}

/**
 * Post the period's residue out of clearing into the payroll variance account
 * (Deltek's pattern): DR variance / CR clearing when standards exceeded
 * payroll, mirrored otherwise. Idempotent per period — re-posting reverses
 * the prior variance entry first, so re-runs after late payroll converge.
 */
export async function postPayrollVariance(opts: {
  orgId: string;
  actorId: string;
  periodStart: string;
  periodEnd: string;
  subsidiaryId: string;
}): Promise<{ entryId: string | null; variance: string }> {
  const { orgId, actorId, periodStart, periodEnd, subsidiaryId } = opts;
  // Business key of the current variance journal is (subsidiary, period-end);
  // the stored entry number is unique per physical journal because re-runs
  // reverse the prior generation and repost (journal_entries_org_number).
  const entryNumberBase = `PVAR-${periodEnd}-${subsidiaryId.slice(0, 8)}`;
  return inDbTransaction(async (tx) => {
    // The organization row is the stable serialization point even before the
    // first variance journal exists. It also freezes both account mappings for
    // the complete reverse/recompute/repost unit.
    const config = (await tx.execute<{
        labor_clearing: string | null;
        payroll_variance: string | null;
      }>(sql`
      select settings->'controlAccounts'->>'laborClearing' as labor_clearing,
             settings->'controlAccounts'->>'payrollVariance' as payroll_variance
        from orgs
       where id = ${orgId}
       for update`));
    const laborClearing = config.rows[0]?.labor_clearing;
    const varianceAccount = config.rows[0]?.payroll_variance;
    if (!laborClearing || !varianceAccount) {
      throw new Error(
        "labor clearing and payroll variance accounts must be configured",
      );
    }

    const prior = (await tx.execute<{ id: string }>(sql`
      select id
        from journal_entries
       where org_id = ${orgId} and origin = 'payroll_variance' and status = 'posted'
         and subsidiary_id = ${subsidiaryId}
         and posting_date = ${periodEnd}
       order by created_at desc, id desc
       limit 1
       for update`));
    if (prior.rows[0]) {
      const reversal = await reverseProjectGlEntryWithinTransaction(
        tx,
        orgId,
        actorId,
        prior.rows[0].id,
        "Superseded by recalculated payroll variance",
        periodEnd,
      );
      if (reversal.status !== "reversed") {
        throw new Error(
          `payroll variance journal ${prior.rows[0].id} could not be reversed`,
        );
      }
    }

    const rec = await laborClearingReconciliationFrom(
      tx,
      orgId,
      periodStart,
      periodEnd,
      subsidiaryId,
      laborClearing,
    );
    const variance = rec.periodVariance;
    if (isZero(variance)) return { entryId: null, variance: "0" };

    // Advance past every prior physical journal (posted, reversed, and their
    // -R mirrors) for this business key so the insert cannot collide with
    // controlled history.
    const generations = (await tx.execute<{ n: number }>(sql`
      select count(*)::int as n
        from journal_entries
       where org_id = ${orgId} and origin = 'payroll_variance'
         and subsidiary_id = ${subsidiaryId}
         and posting_date = ${periodEnd}
         and entry_number like ${`PVAR-%`}`));
    const genN = (generations.rows[0]?.n ?? 0) + 1;
    const entryNumber =
      genN === 1 ? entryNumberBase : `${entryNumberBase}-${genN}`;

    // Standards credited more than payroll debited → clearing carries a credit
    // residue for the period: DR clearing / CR variance clears it (and vice versa).
    const entryId = await postProjectGlEntryWithinTransaction(tx, {
      orgId,
      actorId,
      origin: "payroll_variance",
      entryNumber,
      postingDate: periodEnd,
      memo: `Payroll variance ${periodStart} → ${periodEnd} (standard − actuals)`,
      subsidiaryId,
      currency: rec.currency,
      lines: [
        {
          accountId: laborClearing,
          amount: variance,
          memo: "Clear labor clearing residue",
        },
        {
          accountId: varianceAccount,
          amount: neg(variance),
          memo: "Payroll variance",
        },
      ],
    });
    return { entryId, variance };
  });
}

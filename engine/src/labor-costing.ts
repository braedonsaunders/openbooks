import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, divRate, mulRate, neg, isZero } from "./money.ts";
import { postProjectGlEntry, reverseProjectGlEntry, recognitionAccounts } from "./project-recognition.ts";

/**
 * Labor costing — resolve an employee's standard cost rate for a work date and
 * snapshot it onto approved time.
 *
 * Doctrine (see /admin/setup/labor-costing):
 *   cost/hr = wage(scope, date) × timeType.costMultiplier
 *           + Σ estimate components (statutory burden %, per-diem, …)
 * The wage comes from labor_cost_rates (employee > trade > org default, latest
 * effective_from wins). Components are org settings — pure calculator inputs
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
  value: number;
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

export async function laborCostingSettings(orgId: string): Promise<LaborCostingSettings> {
  const r = (await db.execute(sql`select settings->'laborCosting' as c from orgs where id = ${orgId}`)) as unknown as {
    rows: { c: Partial<LaborCostingSettings> | null }[];
  };
  const c = r.rows[0]?.c ?? {};
  return {
    mode: c.mode === "post" ? "post" : "off",
    hoursPerDay: Number(c.hoursPerDay) > 0 ? Number(c.hoursPerDay) : 8,
    annualHours: Number(c.annualHours) > 0 ? Number(c.annualHours) : 2080,
    components: Array.isArray(c.components) ? (c.components as LaborCostComponent[]) : [],
  };
}

export interface ResolvedWage {
  /** Hourly wage (annual rates already divided by annualHours). */
  wage: string;
  scope: "employee" | "trade" | "org";
  rateId: string;
}

/**
 * Resolve the standard hourly wage for an employee on a date. Most-specific
 * scope wins (employee > trade > org default); within a scope the latest
 * effective_from ≤ workedOn wins. Returns null when no rate covers the date.
 */
export async function resolveWage(
  orgId: string,
  employeePartyId: string,
  workedOn: string,
  opts?: { tradeId?: string | null; annualHoursDefault?: number },
): Promise<ResolvedWage | null> {
  let tradeId = opts?.tradeId;
  if (tradeId === undefined) {
    const t = (await db.execute(sql`
      select trade_id from employee_roles where org_id = ${orgId} and party_id = ${employeePartyId}`)) as unknown as {
      rows: { trade_id: string | null }[];
    };
    tradeId = t.rows[0]?.trade_id ?? null;
  }
  const r = (await db.execute(sql`
    select id, rate, basis, annual_hours,
           case when employee_party_id is not null then 'employee'
                when trade_id is not null then 'trade' else 'org' end as scope
      from labor_cost_rates
     where org_id = ${orgId} and is_active
       and effective_from <= ${workedOn}
       and (effective_to is null or effective_to >= ${workedOn})
       and (employee_party_id = ${employeePartyId}
            or (employee_party_id is null and trade_id is not distinct from ${tradeId} and trade_id is not null)
            or (employee_party_id is null and trade_id is null))
     order by case when employee_party_id is not null then 0
                   when trade_id is not null then 1 else 2 end,
              effective_from desc
     limit 1`)) as unknown as {
    rows: { id: string; rate: string; basis: string; annual_hours: string; scope: "employee" | "trade" | "org" }[];
  };
  const row = r.rows[0];
  if (!row) return null;
  const wage =
    row.basis === "year"
      ? divRate(String(row.rate), String(Number(row.annual_hours) > 0 ? row.annual_hours : opts?.annualHoursDefault ?? 2080))
      : String(row.rate);
  return { wage, scope: row.scope, rateId: row.id };
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
  opts: { workerCompPercent?: number } = {},
): string {
  const base = mulRate(wage, costMultiplier);
  let rate = base;
  for (const c of settings.components) {
    if (c.kind === "worker_comp") {
      // Rate = the employee's assigned comp-group %, else the component's
      // fallback value. A 0% group means no worker comp for that person.
      const pct = opts.workerCompPercent ?? Number(c.value);
      if (!Number.isFinite(pct) || pct === 0) continue;
      const on = c.scaleWithOvertime ? base : wage;
      rate = add(rate, mulRate(on, String(pct / 100)));
      continue;
    }
    const v = Number(c.value);
    if (!Number.isFinite(v) || v === 0) continue;
    if (c.kind === "percent_of_wage") {
      const on = c.scaleWithOvertime ? base : wage;
      rate = add(rate, mulRate(on, String(v / 100)));
    } else if (c.kind === "per_hour") {
      rate = add(rate, c.scaleWithOvertime ? mulRate(String(v), costMultiplier) : String(v));
    } else if (c.kind === "per_day") {
      const perDay = settings.hoursPerDay > 0 ? v / settings.hoursPerDay : 0;
      rate = add(rate, String(perDay));
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
export async function snapshotLaborCostRates(orgId: string, timeEntryIds: string[]): Promise<number> {
  if (timeEntryIds.length === 0) return 0;
  const settings = await laborCostingSettings(orgId);
  const idArr = `{${timeEntryIds.join(",")}}`;
  const rows = (await db.execute(sql`
    select te.id, te.employee_party_id, te.worked_on,
           coalesce(tt.cost_multiplier, '1') as cost_multiplier,
           er.trade_id, wcg.rate_percent as worker_comp_percent
      from time_entries te
      left join time_types tt on tt.id = te.time_type_id
      left join employee_roles er on er.org_id = te.org_id and er.party_id = te.employee_party_id
      left join worker_comp_groups wcg on wcg.id = er.worker_comp_group_id
     where te.org_id = ${orgId} and te.id = any(${idArr}::uuid[]) and te.cost_rate is null`)) as unknown as {
    rows: { id: string; employee_party_id: string; worked_on: string; cost_multiplier: string; trade_id: string | null; worker_comp_percent: string | null }[];
  };
  let stamped = 0;
  // Cache wage resolution per employee+date (a week of entries shares both).
  const cache = new Map<string, ResolvedWage | null>();
  for (const r of rows.rows) {
    const key = `${r.employee_party_id}|${r.worked_on}`;
    let wage = cache.get(key);
    if (wage === undefined) {
      wage = await resolveWage(orgId, r.employee_party_id, r.worked_on, {
        tradeId: r.trade_id,
        annualHoursDefault: settings.annualHours,
      });
      cache.set(key, wage);
    }
    if (!wage) continue;
    const workerCompPercent = r.worker_comp_percent != null ? Number(r.worker_comp_percent) : undefined;
    const rate = computeCostRate(wage.wage, String(r.cost_multiplier), settings, { workerCompPercent });
    await db.execute(sql`update time_entries set cost_rate = ${rate} where id = ${r.id} and org_id = ${orgId} and cost_rate is null`);
    stamped++;
  }
  return stamped;
}

/* ------------------------------------------------------------------ */
/* Payroll true-up — the labor clearing reconciliation                 */
/* ------------------------------------------------------------------ */

export interface ClearingReconciliation {
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
): Promise<ClearingReconciliation | null> {
  const accts = await recognitionAccounts(orgId);
  if (!accts.laborClearing) return null;
  // Reversed originals AND their posted mirrors are both included everywhere so
  // reversal pairs cancel instead of double- or half-counting.
  const sums = (await db.execute(sql`
    select
      coalesce(-sum(l.amount) filter (where e.origin = 'labor_burden'), 0) as standard_posted,
      coalesce(sum(l.amount) filter (where e.origin is distinct from 'labor_burden'
                                       and e.origin is distinct from 'payroll_variance'), 0) as payroll_posted
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
     where l.org_id = ${orgId} and l.account_id = ${accts.laborClearing}
       and e.posting_date >= ${periodStart} and e.posting_date <= ${periodEnd}`)) as unknown as {
    rows: { standard_posted: string; payroll_posted: string }[];
  };
  const open = (await db.execute(sql`
    select coalesce(sum(l.amount), 0) as balance
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
     where l.org_id = ${orgId} and l.account_id = ${accts.laborClearing}`)) as unknown as {
    rows: { balance: string }[];
  };
  const perProject = (await db.execute(sql`
    select l.project_id, p.name, sum(l.amount) as standard
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed') and e.origin = 'labor_burden'
      join projects p on p.id = l.project_id
     where l.org_id = ${orgId} and l.project_id is not null
       and e.posting_date >= ${periodStart} and e.posting_date <= ${periodEnd}
     group by l.project_id, p.name
     having sum(l.amount) <> 0
     order by sum(l.amount) desc
     limit 25`)) as unknown as { rows: { project_id: string; name: string; standard: string }[] };

  const s = sums.rows[0] ?? { standard_posted: "0", payroll_posted: "0" };
  return {
    standardPosted: String(s.standard_posted),
    payrollPosted: String(s.payroll_posted),
    periodVariance: add(String(s.standard_posted), neg(String(s.payroll_posted))),
    openBalance: String(open.rows[0]?.balance ?? "0"),
    perProject: perProject.rows.map((r) => ({ projectId: r.project_id, name: r.name, standard: String(r.standard) })),
  };
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
}): Promise<{ entryId: string | null; variance: string }> {
  const { orgId, actorId, periodStart, periodEnd } = opts;
  const accts = await recognitionAccounts(orgId);
  const varianceAccount = (
    (await db.execute(sql`select settings->'controlAccounts'->>'payrollVariance' as a from orgs where id = ${orgId}`)) as unknown as {
      rows: { a: string | null }[];
    }
  ).rows[0]?.a;
  if (!accts.laborClearing || !varianceAccount) throw new Error("labor clearing and payroll variance accounts must be configured");

  const prior = (await db.execute(sql`
    select id from journal_entries
     where org_id = ${orgId} and origin = 'payroll_variance' and status = 'posted'
       and entry_number = ${`PVAR-${periodEnd}`} limit 1`)) as unknown as { rows: { id: string }[] };
  if (prior.rows[0]) await reverseProjectGlEntry(orgId, actorId, prior.rows[0].id);

  const rec = await laborClearingReconciliation(orgId, periodStart, periodEnd);
  const variance = rec?.periodVariance ?? "0";
  if (isZero(variance)) return { entryId: null, variance: "0" };

  // Standards credited more than payroll debited → clearing carries a credit
  // residue for the period: DR clearing / CR variance clears it (and vice versa).
  const entryId = await postProjectGlEntry({
    orgId,
    actorId,
    origin: "payroll_variance",
    entryNumber: `PVAR-${periodEnd}`,
    postingDate: periodEnd,
    memo: `Payroll variance ${periodStart} → ${periodEnd} (standard − actuals)`,
    lines: [
      { accountId: accts.laborClearing, amount: variance, memo: "Clear labor clearing residue" },
      { accountId: varianceAccount, amount: neg(variance), memo: "Payroll variance" },
    ],
  });
  return { entryId, variance };
}

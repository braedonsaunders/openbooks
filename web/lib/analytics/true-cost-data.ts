import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { resolveAccountGroups } from "../account-groups";

/**
 * True Cost — a faithful port of Gantry's Burden (Rate Engine) dashboard
 * (Dashboard.Burden.js + Lib_Burden_Data.js).
 *
 * The engine is DEPARTMENT-BASED: burden categories (native account groups in
 * the `burden` dimension — Gantry's category manager maps onto the rule+pin
 * primitive) × departments form a rate MATRIX of $/hr rates. The composite
 * burden rate = total burden expense ÷ billed labour hours; each department
 * gets its own composite from its department-tagged expense and its own billed
 * hours (untagged expense is allocated across departments by billed-hours
 * share, Gantry's allocation-base behaviour).
 *
 * Burden scope: overhead-type expense accounts — expense/expense_other/
 * expense_deferred accounts EXCLUDING direct labour (per the `cost_pool`
 * dimension); COGS is direct cost, never burden. Accounts with spend that no
 * burden category matches surface as "Unassigned", exactly like Gantry's
 * classifier.
 *
 * Absorption: this ledger HAS an "Overhead Burden" GL account (5200) + a
 * clearing account, but neither carries postings — the applied-burden
 * mechanism is unused. Until it is, absorption uses the utilization-recovery
 * model: burden is only recovered on BILLABLE hours, so
 * applied = actual × utilization and The Gap = applied − actual. Stated in
 * the Configuration tab.
 */

export interface Dept {
  id: string;
  name: string;
  billedHours: number;
  totalHours: number;
  composite: number; // dept burden ÷ dept billed hours
}

export interface BurdenAccount {
  id: string;
  number: string | null;
  name: string;
  amount: number;
  /** Classification source: explicitly pinned vs matched by the group's rule. */
  pinned: boolean;
  /** Department-TAGGED amounts (untagged remainder allocates by hours share). */
  deptAmounts: Record<string, number>;
  untaggedAmount: number;
}

export interface BurdenCategory {
  id: string;
  key: string;
  name: string;
  color: string | null;
  /** The group's auto-match rule (editable in the category flyout). */
  match: { accountTypes?: string[]; numberPrefixes?: string[]; namePattern?: string };
  totalAmount: number;
  rate: number; // totalAmount ÷ total billed hours
  accounts: BurdenAccount[];
  /** deptId → { amount, rate } (allocated where untagged). */
  byDept: Record<string, { amount: number; rate: number }>;
}

export interface MonthPoint {
  month: string;
  label: string;
  burden: number;
  billedHours: number;
  rate: number;
  byCategory: Record<string, number>; // category key → rate
  byDept: Record<string, number>; // dept id → composite
}

export interface EmployeeRate {
  id: string;
  name: string;
  deptId: string | null;
  deptName: string;
  title: string;
  rate: number; // hours-weighted avg cost rate
  hours: number;
}

export interface TrueCostData {
  period: { from: string; to: string; label: string };
  departments: Dept[];
  kpis: {
    compositeRate: number;
    compositeRateChangePct: number | null; // vs immediately-preceding equal window
    totalOverhead: number;
    overheadAccounts: number;
    burdenApplied: number;
    gap: number; // applied − actual (negative = under-absorbed)
    gapPerHour: number;
    absorptionPct: number;
    billedHours: number;
    totalHours: number;
    utilization: number;
    employeeCount: number;
  };
  categories: BurdenCategory[];
  unassigned: BurdenAccount[];
  totals: { byDept: Record<string, number>; overall: number };
  labor: { employees: EmployeeRate[]; count: number; min: number; max: number; weighted: number };
  monthly: MonthPoint[];
  forecast: { month: string; label: string; rate: number }[];
  hasBurdenGL: boolean; // the 5200 applied account carries postings
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} '${String(y).slice(2)}`;
}

export async function trueCostData(orgId: string, period: { from: string; to: string; label: string }): Promise<TrueCostData> {
  const { from, to } = period;
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const priorFrom = new Date(start.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const priorTo = new Date(start.getTime() - 86_400_000).toISOString().slice(0, 10);

  const [burdenGroups, poolGroups, acctRows, hoursRows, empRows, priorRows, appliedRows, deptRows] = await Promise.all([
    resolveAccountGroups("burden", orgId),
    resolveAccountGroups("cost_pool", orgId),
    // Expense account totals per account × department × month.
    db.execute(sql`
      select l.account_id, a.number, a.name, to_char(e.posting_date, 'YYYY-MM') as month,
        l.department_id, sum(l.amount) as amount
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
      where l.org_id = ${orgId}
        and a.type in ('expense', 'expense_other', 'expense_deferred')
        and a.is_summary = false
        and e.posting_date >= ${from} and e.posting_date <= ${to}
      group by 1, 2, 3, 4, 5
    `) as Promise<any>,
    // Labour hours per department × month (billed = is_billable).
    db.execute(sql`
      select t.department_id, to_char(t.worked_on, 'YYYY-MM') as month,
        sum(t.hours) as total_hours,
        coalesce(sum(t.hours) filter (where t.is_billable), 0) as billed_hours
      from time_entries t
      where t.org_id = ${orgId} and t.worked_on >= ${from} and t.worked_on <= ${to}
      group by 1, 2
    `) as Promise<any>,
    // Per-employee weighted labour rate + dominant dept/labour class.
    db.execute(sql`
      with per_emp as (
        select t.employee_party_id, coalesce(p.display_name, 'Unknown') as name,
          sum(t.hours) as hours,
          sum(coalesce(t.cost_rate, 0) * t.hours) / nullif(sum(t.hours) filter (where t.cost_rate > 0), 0) as rate
        from time_entries t
        left join parties p on p.id = t.employee_party_id
        where t.org_id = ${orgId} and t.worked_on >= ${from} and t.worked_on <= ${to}
        group by 1, 2
      ), dom_dept as (
        select distinct on (employee_party_id) employee_party_id, department_id
        from (select employee_party_id, department_id, sum(hours) h from time_entries
              where org_id = ${orgId} and worked_on >= ${from} and worked_on <= ${to} group by 1, 2) x
        order by employee_party_id, h desc
      ), dom_item as (
        select distinct on (x.employee_party_id) x.employee_party_id, i.name as title
        from (select employee_party_id, item_id, sum(hours) h from time_entries
              where org_id = ${orgId} and worked_on >= ${from} and worked_on <= ${to} group by 1, 2) x
        join items i on i.id = x.item_id
        order by x.employee_party_id, x.h desc
      )
      select pe.employee_party_id as id, pe.name, pe.hours, coalesce(pe.rate, 0) as rate,
        dd.department_id as dept_id, coalesce(d.name, '—') as dept_name, coalesce(di.title, '—') as title
      from per_emp pe
      left join dom_dept dd on dd.employee_party_id = pe.employee_party_id
      left join departments d on d.id = dd.department_id
      left join dom_item di on di.employee_party_id = pe.employee_party_id
      where pe.hours > 0
    `) as Promise<any>,
    // Prior equal window: per-account expense (classified below) + billed hours.
    db.execute(sql`
      select l.account_id, sum(l.amount) as amount,
        (select coalesce(sum(t.hours) filter (where t.is_billable), 0) from time_entries t
          where t.org_id = ${orgId} and t.worked_on >= ${priorFrom} and t.worked_on <= ${priorTo}) as billed_hours
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
      where l.org_id = ${orgId} and a.type in ('expense', 'expense_other', 'expense_deferred')
        and a.is_summary = false and e.posting_date >= ${priorFrom} and e.posting_date <= ${priorTo}
      group by 1
    `) as Promise<any>,
    // Does the "burden applied" GL mechanism carry postings in the period?
    db.execute(sql`
      select coalesce(-sum(l.amount), 0) as applied, count(*) as lines
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
      where l.org_id = ${orgId} and a.name ~* 'burden applied|overhead burden'
        and e.posting_date >= ${from} and e.posting_date <= ${to}
    `) as Promise<any>,
    db.execute(sql`select id, name from departments where org_id = ${orgId} order by name`) as Promise<any>,
  ]);

  // ---- hours by department --------------------------------------------------
  const deptHours = new Map<string, { billed: number; total: number }>();
  const monthHours = new Map<string, { billed: number; total: number }>();
  const deptMonthBilled = new Map<string, number>(); // `${dept}|${month}`
  let billedHours = 0, totalHours = 0;
  for (const r of hoursRows.rows as any[]) {
    const dept = r.department_id ?? "none";
    const billed = Number(r.billed_hours ?? 0);
    const total = Number(r.total_hours ?? 0);
    const dh = deptHours.get(dept) ?? { billed: 0, total: 0 };
    dh.billed += billed; dh.total += total;
    deptHours.set(dept, dh);
    const mh = monthHours.get(r.month) ?? { billed: 0, total: 0 };
    mh.billed += billed; mh.total += total;
    monthHours.set(r.month, mh);
    deptMonthBilled.set(`${dept}|${r.month}`, (deptMonthBilled.get(`${dept}|${r.month}`) ?? 0) + billed);
    billedHours += billed; totalHours += total;
  }

  // Burden centres = departments with BILLED hours (a dept that bills nothing
  // has no rate denominator; its tagged burden is reallocated like untagged).
  const departmentsBase = (deptRows.rows as any[])
    .map((d) => ({ id: d.id as string, name: d.name as string, hours: deptHours.get(d.id) ?? { billed: 0, total: 0 } }))
    .filter((d) => d.hours.billed > 0)
    .sort((a, b) => b.hours.billed - a.hours.billed);
  const billedShare = new Map(departmentsBase.map((d) => [d.id, billedHours > 0 ? d.hours.billed / billedHours : 0]));

  // ---- classify expense into burden categories --------------------------------
  const directLabor = new Set(
    [...poolGroups.byAccount.entries()].filter(([, g]) => g.key === "direct_labor").map(([id]) => id),
  );

  interface CatAgg {
    id: string; key: string; name: string; color: string | null;
    total: number;
    accounts: Map<string, BurdenAccount>;
    byDept: Map<string, number>;
    byMonth: Map<string, number>;
  }
  const cats = new Map<string, CatAgg>();
  for (const g of burdenGroups.groups) {
    cats.set(g.id, { id: g.id, key: g.key, name: g.name, color: g.color, total: 0, accounts: new Map(), byDept: new Map(), byMonth: new Map() });
  }
  const unassignedMap = new Map<string, BurdenAccount>();
  const monthBurden = new Map<string, number>();
  const monthCatRate = new Map<string, Map<string, number>>(); // month → cat key → amount
  const monthDeptBurden = new Map<string, Map<string, number>>(); // month → dept → amount

  for (const r of acctRows.rows as any[]) {
    if (directLabor.has(r.account_id)) continue; // direct labour is not burden
    const amount = Number(r.amount ?? 0);
    if (amount === 0) continue;
    const group = burdenGroups.byAccount.get(r.account_id);

    if (!group) {
      const u = unassignedMap.get(r.account_id) ?? {
        id: r.account_id, number: r.number, name: r.name, amount: 0,
        pinned: false, deptAmounts: {} as Record<string, number>, untaggedAmount: 0,
      };
      u.amount += amount;
      if (r.department_id && billedShare.has(r.department_id)) {
        u.deptAmounts[r.department_id] = (u.deptAmounts[r.department_id] ?? 0) + amount;
      } else {
        u.untaggedAmount += amount;
      }
      unassignedMap.set(r.account_id, u);
      continue;
    }
    const cat = cats.get(group.groupId);
    if (!cat) continue;
    cat.total += amount;
    const acct = cat.accounts.get(r.account_id) ?? {
      id: r.account_id, number: r.number, name: r.name, amount: 0,
      pinned: burdenGroups.pinned.has(r.account_id), deptAmounts: {} as Record<string, number>, untaggedAmount: 0,
    };
    acct.amount += amount;
    if (r.department_id && billedShare.has(r.department_id)) {
      acct.deptAmounts[r.department_id] = (acct.deptAmounts[r.department_id] ?? 0) + amount;
    } else {
      acct.untaggedAmount += amount;
    }
    cat.accounts.set(r.account_id, acct);
    cat.byMonth.set(r.month, (cat.byMonth.get(r.month) ?? 0) + amount);
    monthBurden.set(r.month, (monthBurden.get(r.month) ?? 0) + amount);
    if (!monthCatRate.has(r.month)) monthCatRate.set(r.month, new Map());
    monthCatRate.get(r.month)!.set(cat.key, (monthCatRate.get(r.month)!.get(cat.key) ?? 0) + amount);

    // Department attribution: tagged stays; untagged allocated by billed-hours share.
    const spread = (deptId: string, amt: number) => {
      cat.byDept.set(deptId, (cat.byDept.get(deptId) ?? 0) + amt);
      if (!monthDeptBurden.has(r.month)) monthDeptBurden.set(r.month, new Map());
      const md = monthDeptBurden.get(r.month)!;
      md.set(deptId, (md.get(deptId) ?? 0) + amt);
    };
    if (r.department_id && billedShare.has(r.department_id)) {
      spread(r.department_id, amount);
    } else {
      for (const d of departmentsBase) spread(d.id, amount * (billedShare.get(d.id) ?? 0));
    }
  }

  const totalOverhead = [...cats.values()].reduce((s, c) => s + c.total, 0);
  const compositeRate = billedHours > 0 ? totalOverhead / billedHours : 0;

  const categories: BurdenCategory[] = burdenGroups.groups.map((g) => {
    const c = cats.get(g.id)!;
    const byDept: Record<string, { amount: number; rate: number }> = {};
    for (const d of departmentsBase) {
      const amount = c.byDept.get(d.id) ?? 0;
      byDept[d.id] = { amount, rate: d.hours.billed > 0 ? amount / d.hours.billed : 0 };
    }
    return {
      id: c.id, key: c.key, name: c.name, color: c.color,
      match: g.match ?? {},
      totalAmount: c.total,
      rate: billedHours > 0 ? c.total / billedHours : 0,
      accounts: [...c.accounts.values()].sort((a, b) => b.amount - a.amount),
      byDept,
    };
  }).filter((c) => Math.abs(c.totalAmount) > 0.005);

  const totalsByDept: Record<string, number> = {};
  const departments: Dept[] = departmentsBase.map((d) => {
    const deptBurden = categories.reduce((s, c) => s + (c.byDept[d.id]?.amount ?? 0), 0);
    const composite = d.hours.billed > 0 ? deptBurden / d.hours.billed : 0;
    totalsByDept[d.id] = composite;
    return { id: d.id, name: d.name, billedHours: d.hours.billed, totalHours: d.hours.total, composite };
  });

  // ---- absorption (utilization-recovery model unless the GL mechanism is live) --
  const glApplied = Number(appliedRows.rows[0]?.applied ?? 0);
  const hasBurdenGL = Number(appliedRows.rows[0]?.lines ?? 0) > 0 && Math.abs(glApplied) > 0.005;
  const utilization = totalHours > 0 ? billedHours / totalHours : 0;
  const burdenApplied = hasBurdenGL ? glApplied : totalOverhead * utilization;
  const gap = burdenApplied - totalOverhead;

  // ---- prior-window composite for the change chip (same classification) -----------
  const priorBilled = Number(priorRows.rows[0]?.billed_hours ?? 0);
  let priorBurden = 0;
  for (const r of priorRows.rows as any[]) {
    if (directLabor.has(r.account_id)) continue;
    if (burdenGroups.byAccount.has(r.account_id)) priorBurden += Number(r.amount ?? 0);
  }
  const priorComposite = priorBilled > 0 ? priorBurden / priorBilled : 0;
  const compositeRateChangePct = priorComposite > 0 ? ((compositeRate - priorComposite) / priorComposite) * 100 : null;

  // ---- monthly history + linear forecast ---------------------------------------------
  const months = [...new Set([...monthBurden.keys(), ...monthHours.keys()])].sort();
  const monthly: MonthPoint[] = months.map((m) => {
    const burden = monthBurden.get(m) ?? 0;
    const billed = monthHours.get(m)?.billed ?? 0;
    const catAmounts = monthCatRate.get(m);
    const byCategory: Record<string, number> = {};
    if (catAmounts) for (const [k, amt] of catAmounts) byCategory[k] = billed > 0 ? amt / billed : 0;
    const deptAmounts = monthDeptBurden.get(m);
    const byDept: Record<string, number> = {};
    if (deptAmounts) {
      for (const [deptId, amt] of deptAmounts) {
        const db_ = deptMonthBilled.get(`${deptId}|${m}`) ?? 0;
        byDept[deptId] = db_ > 0 ? amt / db_ : 0;
      }
    }
    return { month: m, label: monthLabel(m), burden, billedHours: billed, rate: billed > 0 ? burden / billed : 0, byCategory, byDept };
  });

  // Linear regression over monthly composite → next 3 months. Outlier months
  // (one-off postings like year-end bonuses) are excluded from the FIT via a
  // median/MAD screen but still shown in the chart.
  const fitPoints = monthly
    .map((m, i) => ({ i, rate: m.rate }))
    .filter((p) => monthly[p.i].billedHours > 0);
  const forecast: TrueCostData["forecast"] = [];
  if (fitPoints.length >= 3 && months.length > 0) {
    const sortedRates = fitPoints.map((p) => p.rate).sort((a, b) => a - b);
    const median = sortedRates[Math.floor(sortedRates.length / 2)];
    const mad = fitPoints.map((p) => Math.abs(p.rate - median)).sort((a, b) => a - b)[Math.floor(fitPoints.length / 2)] || 1;
    const clean = fitPoints.filter((p) => Math.abs(p.rate - median) <= 3 * mad);
    const pts = clean.length >= 3 ? clean : fitPoints;
    const n = pts.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of pts) { sumX += p.i; sumY += p.rate; sumXY += p.i * p.rate; sumXX += p.i * p.i; }
    const denom = n * sumXX - sumX * sumX;
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;
    const last = months[months.length - 1];
    const lastIdx = monthly.length - 1;
    const [ly, lm] = last.split("-").map(Number);
    for (let i = 1; i <= 3; i++) {
      const d = new Date(Date.UTC(ly, lm - 1 + i, 1));
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      forecast.push({ month: ym, label: monthLabel(ym), rate: Math.max(0, intercept + slope * (lastIdx + i)) });
    }
  }

  // ---- labour rates ------------------------------------------------------------------------
  const employees: EmployeeRate[] = (empRows.rows as any[])
    .map((r) => ({
      id: r.id, name: r.name, deptId: r.dept_id, deptName: r.dept_name, title: r.title,
      rate: Number(r.rate ?? 0), hours: Number(r.hours ?? 0),
    }))
    .filter((e) => e.rate > 0);
  const laborHoursSum = employees.reduce((s, e) => s + e.hours, 0);
  const weighted = laborHoursSum > 0 ? employees.reduce((s, e) => s + e.rate * e.hours, 0) / laborHoursSum : 0;

  return {
    period,
    departments,
    kpis: {
      compositeRate,
      compositeRateChangePct,
      totalOverhead,
      overheadAccounts: categories.reduce((s, c) => s + c.accounts.length, 0),
      burdenApplied,
      gap,
      gapPerHour: billedHours > 0 ? gap / billedHours : 0,
      absorptionPct: totalOverhead > 0 ? (burdenApplied / totalOverhead) * 100 : 100,
      billedHours,
      totalHours,
      utilization,
      employeeCount: employees.length,
    },
    categories,
    unassigned: [...unassignedMap.values()].filter((u) => Math.abs(u.amount) > 0.005).sort((a, b) => b.amount - a.amount),
    totals: { byDept: totalsByDept, overall: compositeRate },
    labor: {
      employees: employees.sort((a, b) => b.hours - a.hours),
      count: employees.length,
      min: employees.length ? Math.min(...employees.map((e) => e.rate)) : 0,
      max: employees.length ? Math.max(...employees.map((e) => e.rate)) : 0,
      weighted,
    },
    monthly,
    forecast,
    hasBurdenGL,
  };
}

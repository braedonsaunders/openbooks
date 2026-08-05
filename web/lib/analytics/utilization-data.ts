import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { analyticsConfig } from "./config";
import { getMoneyFormatter } from '../money-server'

/**
 * Utilization (Billable IQ) — data and metrics for the Time dashboard.
 *
 * Source data = `time_entries` (per-entry hours / is_billable / cost_rate),
 * grouped by employee × department × item.
 * Schema behavior is stated plainly:
 *  - billable = the `is_billable` flag; every billable entry carries a project
 *    linked to a customer;
 *  - non-billable cost = Σ hours × per-entry `cost_rate` on non-billable rows
 *    (richer than the employee.laborcost single rate);
 *  - job title: employees have no title field — an employee's `title` is their
 *    DOMINANT LABOUR CLASS (the item they logged the most hours to, e.g.
 *    "MECH:Foreman"), which is what timebill items encode in this dataset;
 *  - noBillable departments are auto-flagged when they logged 0 billable hours
 *    in the current AND prior range
 *    (e.g. the "Overhead" department).
 *
 * The prior range is the same duration immediately preceding, and history is
 * 5 rolling prior periods of the same month-length — both stable.
 */

export interface UStat {
  hours: number;
  billableHours: number;
  nonBillableHours: number;
  percentBilled: number; // 0-100
  nonBillableCost: number;
}

export interface UGroupRow {
  id: string;
  name: string;
  /** Employees: dominant labour class ("title"). */
  title?: string;
  /** Employees/items: primary department (most hours). */
  departmentId?: string;
  departmentName?: string;
  range: UStat;
  prior: UStat;
  deltas: { pctDelta: number; costDelta: number };
  meetsMinHours: boolean;
  noBillable?: boolean;
}

export interface UAlert {
  type: "warning" | "danger";
  message: string;
}

export interface UHistoryPeriod {
  label: string;
  start: string;
  end: string;
  companyPct: number;
  deptPct: Record<string, number>;
}

export interface UtilizationData {
  period: { from: string; to: string; label: string; days: number };
  prior: { from: string; to: string };
  config: { target: number; costSpike: number; minHours: number };
  company: {
    range: UStat & { nonBillableCostPerDay: number; nonBillableCostPerHour: number };
    prior: UStat & { nonBillableCostPerDay: number; nonBillableCostPerHour: number };
    deltas: { pctDelta: number; costDelta: number };
    alerts: UAlert[];
  };
  departments: UGroupRow[];
  items: UGroupRow[];
  employees: UGroupRow[];
  history: { periodMonths: number; periods: UHistoryPeriod[] };
}

// Threshold defaults live in lib/analytics/config.ts; per-org overrides come
// from orgs.settings.analytics.utilization.

interface StatRow {
  employee: string;
  employee_name: string;
  department: string | null;
  department_name: string | null;
  item: string | null;
  item_name: string | null;
  total_hours: number;
  billable_hours: number;
  non_billable_cost: number;
}

/** One grouped scan per range.
 *  org filter is EXPLICIT (defense in depth — do not rely on ambient RLS). */
async function fetchTimeStats(orgId: string, from: string, to: string): Promise<StatRow[]> {
  const res: any = await db.execute(sql`
    select
      t.employee_party_id as employee,
      coalesce(p.display_name, 'Unknown') as employee_name,
      t.department_id as department,
      d.name as department_name,
      t.item_id as item,
      i.name as item_name,
      sum(t.hours) as total_hours,
      coalesce(sum(t.hours) filter (where t.is_billable), 0) as billable_hours,
      coalesce(sum(coalesce(t.cost_rate, 0) * t.hours) filter (where not t.is_billable), 0) as non_billable_cost
    from time_entries t
    left join parties p on p.id = t.employee_party_id
    left join departments d on d.id = t.department_id
    left join items i on i.id = t.item_id
    where t.org_id = ${orgId} and t.worked_on >= ${from} and t.worked_on <= ${to}
    group by 1, 2, 3, 4, 5, 6
  `);
  return (res.rows as any[]).map((r) => ({
    employee: r.employee,
    employee_name: r.employee_name,
    department: r.department,
    department_name: r.department_name,
    item: r.item,
    item_name: r.item_name,
    total_hours: Number(r.total_hours ?? 0),
    billable_hours: Number(r.billable_hours ?? 0),
    non_billable_cost: Number(r.non_billable_cost ?? 0),
  }));
}

const ymd = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

function calcStat(hours: number, billable: number, cost: number): UStat {
  return {
    hours,
    billableHours: billable,
    nonBillableHours: hours - billable,
    percentBilled: hours > 0 ? (billable / hours) * 100 : 0,
    nonBillableCost: cost,
  };
}

const ZERO: UStat = { hours: 0, billableHours: 0, nonBillableHours: 0, percentBilled: 0, nonBillableCost: 0 };

type Key = "department" | "item" | "employee";

/** Build current/prior utilization groups for one reporting dimension. */
function buildGroup(curr: StatRow[], prior: StatRow[], key: Key, titleByEmp: Map<string, string>, noBillDepts: Set<string>, minHours: number): UGroupRow[] {
  const deptName = new Map<string, string>();
  for (const r of curr) if (r.department && r.department_name) deptName.set(r.department, r.department_name);

  const groupBy = (rows: StatRow[]) => {
    const groups = new Map<
      string,
      { name: string; deptHours: Map<string, number>; department: string | null; hours: number; billable: number; cost: number }
    >();
    for (const r of rows) {
      const id = (key === "department" ? r.department : key === "item" ? r.item : r.employee) ?? "0";
      let g = groups.get(id);
      if (!g) {
        const name = key === "department" ? r.department_name : key === "item" ? r.item_name : r.employee_name;
        g = { name: name ?? "Unknown", deptHours: new Map(), department: r.department, hours: 0, billable: 0, cost: 0 };
        groups.set(id, g);
      }
      g.hours += r.total_hours;
      g.billable += r.billable_hours;
      g.cost += r.non_billable_cost;
      if (key !== "department" && r.department) g.deptHours.set(r.department, (g.deptHours.get(r.department) ?? 0) + r.total_hours);
    }
    // Primary department = most hours (the departmentHours logic).
    if (key !== "department") {
      for (const g of groups.values()) {
        let max = 0;
        for (const [dId, h] of g.deptHours) if (h > max) { max = h; g.department = dId; }
      }
    }
    return groups;
  };

  const cGroups = groupBy(curr);
  const pGroups = groupBy(prior);
  const rows: UGroupRow[] = [];
  for (const [id, c] of cGroups) {
    const p = pGroups.get(id);
    const range = calcStat(c.hours, c.billable, c.cost);
    const pr = p ? calcStat(p.hours, p.billable, p.cost) : ZERO;
    const row: UGroupRow = {
      id,
      name: c.name,
      range,
      prior: pr,
      deltas: { pctDelta: range.percentBilled - pr.percentBilled, costDelta: range.nonBillableCost - pr.nonBillableCost },
      meetsMinHours: range.hours >= minHours,
    };
    if (key === "employee") {
      row.title = titleByEmp.get(id) ?? "No Title";
      row.departmentId = c.department ?? undefined;
      row.departmentName = (c.department && deptName.get(c.department)) || "Unknown";
    }
    if (key === "item") {
      row.departmentId = c.department ?? undefined;
      row.departmentName = (c.department && deptName.get(c.department)) || "Unknown";
    }
    if (key === "department") row.noBillable = noBillDepts.has(id);
    rows.push(row);
  }
  // Sort groups by non-billable cost descending.
  return rows.sort((a, b) => b.range.nonBillableCost - a.range.nonBillableCost);
}

export async function utilizationData(orgId: string, period: { from: string; to: string; label: string }): Promise<UtilizationData> {
  const { money } = await getMoneyFormatter(orgId)
  const cfg = await analyticsConfig(orgId, "utilization");
  const rangeStart = new Date(period.from + "T00:00:00Z");
  const rangeEnd = new Date(period.to + "T00:00:00Z");
  const days = Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000) + 1;

  // Prior range: same duration immediately preceding.
  const priorEnd = new Date(rangeStart.getTime() - 86_400_000);
  const priorStart = new Date(priorEnd.getTime() - (days - 1) * 86_400_000);
  const priorFrom = ymd(priorStart);
  const priorTo = ymd(priorEnd);

  // History period plan: same month-length, 5 prior periods, deduplicated labels.
  const periodMonths =
    (rangeEnd.getUTCFullYear() - rangeStart.getUTCFullYear()) * 12 + (rangeEnd.getUTCMonth() - rangeStart.getUTCMonth()) + 1;
  const histPlans: { start: string; end: string; label: string }[] = [];
  const seen = new Set<string>();
  for (let i = 1; i <= 5; i++) {
    const pEnd = new Date(Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth() - i * periodMonths + 1, 0));
    const pStart = new Date(Date.UTC(pEnd.getUTCFullYear(), pEnd.getUTCMonth() - periodMonths + 1, 1));
    const label = `${pEnd.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })} '${String(pEnd.getUTCFullYear()).slice(2)}`;
    if (seen.has(label)) continue;
    seen.add(label);
    histPlans.push({ start: ymd(pStart), end: ymd(pEnd), label });
  }

  const [curr, prior, ...histStats] = await Promise.all([
    fetchTimeStats(orgId, period.from, period.to),
    fetchTimeStats(orgId, priorFrom, priorTo),
    ...histPlans.map((p) => fetchTimeStats(orgId, p.start, p.end)),
  ]);

  // noBillable departments: zero billable hours across current + prior.
  const deptBillable = new Map<string, number>();
  const deptTotal = new Map<string, number>();
  for (const r of [...curr, ...prior]) {
    if (!r.department) continue;
    deptBillable.set(r.department, (deptBillable.get(r.department) ?? 0) + r.billable_hours);
    deptTotal.set(r.department, (deptTotal.get(r.department) ?? 0) + r.total_hours);
  }
  const noBillDepts = new Set<string>();
  for (const [id, tot] of deptTotal) if (tot > 0 && (deptBillable.get(id) ?? 0) === 0) noBillDepts.add(id);

  // Employee "title" = dominant labour class (most hours in current range).
  const empItemHours = new Map<string, Map<string, number>>();
  for (const r of curr) {
    if (!r.item_name) continue;
    let m = empItemHours.get(r.employee);
    if (!m) { m = new Map(); empItemHours.set(r.employee, m); }
    m.set(r.item_name, (m.get(r.item_name) ?? 0) + r.total_hours);
  }
  const titleByEmp = new Map<string, string>();
  for (const [emp, m] of empItemHours) {
    let best = "No Title", max = 0;
    for (const [item, h] of m) if (h > max) { max = h; best = item; }
    titleByEmp.set(emp, best);
  }

  // Company rollup — billable-expected departments only ().
  const companySum = (rows: StatRow[]) => {
    let hours = 0, billable = 0, cost = 0;
    for (const r of rows) {
      if (r.department && noBillDepts.has(r.department)) continue;
      hours += r.total_hours;
      billable += r.billable_hours;
      cost += r.non_billable_cost;
    }
    const s = calcStat(hours, billable, cost);
    return {
      ...s,
      nonBillableCostPerDay: days > 0 ? s.nonBillableCost / days : 0,
      nonBillableCostPerHour: s.nonBillableHours > 0 ? s.nonBillableCost / s.nonBillableHours : 0,
    };
  };
  const cCompany = companySum(curr);
  const pCompany = companySum(prior);

  const alerts: UAlert[] = [];
  if (cCompany.percentBilled < cfg.targetBillablePct)
    alerts.push({ type: "warning", message: `Billable % below ${cfg.targetBillablePct}% target` });
  if (cCompany.nonBillableCost - pCompany.nonBillableCost > cfg.costSpikeThreshold)
    alerts.push({
      type: "danger",
      message: `Non-billable cost spiked by ${money(cCompany.nonBillableCost - pCompany.nonBillableCost, { maximumFractionDigits: 0 })}`,
    });

  // Rolling history: company % (excl. noBill depts) + per-dept % (all depts).
  const periods: UHistoryPeriod[] = histPlans.map((plan, i) => {
    const rows = histStats[i] ?? [];
    let hours = 0, billable = 0;
    const dept = new Map<string, { h: number; b: number }>();
    for (const r of rows) {
      if (!(r.department && noBillDepts.has(r.department))) { hours += r.total_hours; billable += r.billable_hours; }
      if (r.department) {
        const d = dept.get(r.department) ?? { h: 0, b: 0 };
        d.h += r.total_hours; d.b += r.billable_hours;
        dept.set(r.department, d);
      }
    }
    const deptPct: Record<string, number> = {};
    for (const [id, d] of dept) deptPct[id] = d.h > 0 ? (d.b / d.h) * 100 : 0;
    return { label: plan.label, start: plan.start, end: plan.end, companyPct: hours > 0 ? (billable / hours) * 100 : 0, deptPct };
  });

  return {
    period: { ...period, days },
    prior: { from: priorFrom, to: priorTo },
    config: { target: cfg.targetBillablePct, costSpike: cfg.costSpikeThreshold, minHours: cfg.minHours },
    company: {
      range: cCompany,
      prior: pCompany,
      deltas: {
        pctDelta: cCompany.percentBilled - pCompany.percentBilled,
        costDelta: cCompany.nonBillableCost - pCompany.nonBillableCost,
      },
      alerts,
    },
    departments: buildGroup(curr, prior, "department", titleByEmp, noBillDepts, cfg.minHours),
    items: buildGroup(curr, prior, "item", titleByEmp, noBillDepts, cfg.minHours),
    employees: buildGroup(curr, prior, "employee", titleByEmp, noBillDepts, cfg.minHours),
    history: { periodMonths, periods },
  };
}

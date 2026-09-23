import "server-only";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { isFeatureEnabled } from "../features";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { utcDateFromParts } from "@openbooks/engine/src/platform/business-date.ts";
import { add, cmp, div, mulDecimal, neg } from "@openbooks/engine/src/money/money.ts";
import { flowRates } from "../fx-presentation";
import { analyticsConfig } from "./config";
import { englishUtilizationStrings, type UtilizationStrings } from "./utilization-strings";
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
  // Exact decimal strings at the ledger's numeric(19,4) grain. Hours and cost
  // accumulate across rows, currencies and groups — a float hop anywhere in
  // that chain compounds per row and can flip cost sorts and spike alerts.
  // The single Number() conversion happens in calcStat, at the rendering
  // boundary.
  total_hours: string;
  billable_hours: string;
  non_billable_cost: string;
}

interface RawStatRow extends Record<string, unknown> {
  employee: string;
  employee_name: string;
  department: string | null;
  department_name: string | null;
  item: string | null;
  item_name: string | null;
  func: string | null;
  late: string | null;
  total_hours: string | number;
  billable_hours: string | number;
  non_billable_cost: string | number;
}

/** One grouped scan per range.
 *  org filter is EXPLICIT (defense in depth — do not rely on ambient RLS). */
async function fetchTimeStats(orgId: string, from: string, to: string, allowed: ReadonlySet<string> | null): Promise<StatRow[]> {
  // Cost rates are stamped in the worker's own functional (the posting
  // kernel groups labour the same way and never fuses currencies), so the
  // scan arrives per (group, functional) and each cost leg translates to
  // presentation at its latest worked date before merging. Hours are
  // currency-blind: splitting then re-adding them is exact.
  const res = await db.execute<RawStatRow>(sql`
    select
      t.employee_party_id as employee,
      coalesce(p.display_name, 'Unknown') as employee_name,
      t.department_id as department,
      d.name as department_name,
      t.item_id as item,
      i.name as item_name,
      coalesce(t.cost_rate_currency, crs.base_currency, o.base_currency) as func,
      max(t.worked_on)::text as late,
      sum(t.hours) as total_hours,
      coalesce(sum(t.hours) filter (where t.is_billable), 0) as billable_hours,
      coalesce(sum(coalesce(t.cost_rate, 0) * t.hours) filter (where not t.is_billable), 0) as non_billable_cost
    from time_entries t
    left join parties p on p.id = t.employee_party_id and p.org_id = t.org_id
    left join projects project on project.id = t.project_id and project.org_id = t.org_id
    left join departments d on d.id = t.department_id and d.org_id = t.org_id
    left join items i on i.id = t.item_id and i.org_id = t.org_id
    left join subsidiaries crs on crs.id = t.cost_rate_subsidiary_id and crs.org_id = t.org_id
    join orgs o on o.id = t.org_id
    where t.org_id = ${orgId} and t.worked_on >= ${from} and t.worked_on <= ${to}
      -- Draft, submitted and rejected hours are not worked reality (rejected
      -- hours never will be) — the same approved-only rule as project
      -- profitability hours and the time drill-down.
      and t.status = 'approved'
      ${subsidiaryVisibleFilter(sql`coalesce(project.subsidiary_id, p.subsidiary_id)`, allowed)}
    group by 1, 2, 3, 4, 5, 6, 7
  `);
  const ctx = await flowRates(orgId, res.rows.map((r) => ({
    func: (r.func as string | null) ?? null, date: String(r.late ?? to).slice(0, 10),
  })));
  const merged = new Map<string, StatRow>();
  for (const r of res.rows) {
    const key = JSON.stringify([r.employee, r.employee_name, r.department, r.department_name, r.item, r.item_name]);
    const prev = merged.get(key) ?? {
      employee: r.employee,
      employee_name: r.employee_name,
      department: r.department,
      department_name: r.department_name,
      item: r.item,
      item_name: r.item_name,
      total_hours: "0",
      billable_hours: "0",
      non_billable_cost: "0",
    };
    const leg = String(r.non_billable_cost ?? 0);
    const translated = Number(leg) === 0
      ? "0"
      : mulDecimal(leg, ctx.rateAt(r.func ?? null, String(r.late ?? to).slice(0, 10)));
    prev.total_hours = add(prev.total_hours, String(r.total_hours ?? 0));
    prev.billable_hours = add(prev.billable_hours, String(r.billable_hours ?? 0));
    prev.non_billable_cost = add(prev.non_billable_cost, translated);
    merged.set(key, prev);
  }
  return [...merged.values()];
}

const ymd = (d: Date) =>
  // Year zero-padded so the YYYY-MM-DD contract holds below year 1000 too.
  `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

function calcStat(hours: string, billable: string, cost: string): UStat {
  // The single float hop, at the rendering boundary: ratios render as
  // doubles, but every total summed or compared upstream stays exact.
  const h = Number(hours);
  const b = Number(billable);
  return {
    hours: h,
    billableHours: b,
    nonBillableHours: h - b,
    percentBilled: h > 0 ? (b / h) * 100 : 0,
    nonBillableCost: Number(cost),
  };
}

const ZERO: UStat = { hours: 0, billableHours: 0, nonBillableHours: 0, percentBilled: 0, nonBillableCost: 0 };

type Key = "department" | "item" | "employee";

/** Build current/prior utilization groups for one reporting dimension. */
function buildGroup(curr: StatRow[], prior: StatRow[], key: Key, titleByEmp: Map<string, string>, noBillDepts: Set<string>, minHours: number, strings: UtilizationStrings = englishUtilizationStrings): UGroupRow[] {
  const deptName = new Map<string, string>();
  for (const r of curr) if (r.department && r.department_name) deptName.set(r.department, r.department_name);

  const groupBy = (rows: StatRow[]) => {
    const groups = new Map<
      string,
      { name: string; deptHours: Map<string, string>; department: string | null; hours: string; billable: string; cost: string }
    >();
    for (const r of rows) {
      const id = (key === "department" ? r.department : key === "item" ? r.item : r.employee) ?? "0";
      let g = groups.get(id);
      if (!g) {
        const name = key === "department" ? r.department_name : key === "item" ? r.item_name : r.employee_name;
        g = { name: strings.displayGroupName(name), deptHours: new Map(), department: r.department, hours: "0", billable: "0", cost: "0" };
        groups.set(id, g);
      }
      g.hours = add(g.hours, r.total_hours);
      g.billable = add(g.billable, r.billable_hours);
      g.cost = add(g.cost, r.non_billable_cost);
      if (key !== "department" && r.department) g.deptHours.set(r.department, add(g.deptHours.get(r.department) ?? "0", r.total_hours));
    }
    // Primary department = most hours (the departmentHours logic).
    if (key !== "department") {
      for (const g of groups.values()) {
        let max = "0";
        for (const [dId, h] of g.deptHours) if (cmp(h, max) > 0) { max = h; g.department = dId; }
      }
    }
    return groups;
  };

  const cGroups = groupBy(curr);
  const pGroups = groupBy(prior);
  const rows: { row: UGroupRow; cost: string }[] = [];
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
      row.title = strings.displayEmployeeTitle(titleByEmp.get(id) ?? null);
      row.departmentId = c.department ?? undefined;
      row.departmentName = strings.displayDepartmentName((c.department && deptName.get(c.department)) || null);
    }
    if (key === "item") {
      row.departmentId = c.department ?? undefined;
      row.departmentName = strings.displayDepartmentName((c.department && deptName.get(c.department)) || null);
    }
    if (key === "department") row.noBillable = noBillDepts.has(id);
    rows.push({ row, cost: c.cost });
  }
  // Sort groups by non-billable cost descending — on the exact totals, so a
  // sub-cent gap still orders deterministically.
  return rows.sort((a, b) => cmp(b.cost, a.cost)).map(({ row }) => row);
}

export async function utilizationData(
  orgId: string,
  period: { from: string; to: string; label: string },
  allowed: ReadonlySet<string> | null,
  strings: UtilizationStrings = englishUtilizationStrings,
): Promise<UtilizationData> {
  if (!(await isFeatureEnabled(orgId, "timeTracking"))) throw new Error("time tracking feature is disabled");
  const { money } = await getMoneyFormatter(orgId)
  const cfg = await analyticsConfig(orgId, "utilization");
  // mergeConfig always materializes every default key for the dashboard.
  const targetBillablePct = cfg.targetBillablePct!;
  const costSpikeThreshold = cfg.costSpikeThreshold!;
  const minHours = cfg.minHours!;
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
    // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would
    // remap onto 1900-1999.
    const pEnd = utcDateFromParts(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth() - i * periodMonths + 1, 0);
    const pStart = utcDateFromParts(pEnd.getUTCFullYear(), pEnd.getUTCMonth() - periodMonths + 1, 1);
    const ym = `${pEnd.getUTCFullYear()}-${String(pEnd.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = strings.monthLabel(ym);
    if (seen.has(label)) continue;
    seen.add(label);
    histPlans.push({ start: ymd(pStart), end: ymd(pEnd), label });
  }

  const [curr, prior, ...histStats] = await Promise.all([
    fetchTimeStats(orgId, period.from, period.to, allowed),
    fetchTimeStats(orgId, priorFrom, priorTo, allowed),
    ...histPlans.map((p) => fetchTimeStats(orgId, p.start, p.end, allowed)),
  ]);

  // noBillable departments: zero billable hours across current + prior.
  const deptBillable = new Map<string, string>();
  const deptTotal = new Map<string, string>();
  for (const r of [...curr, ...prior]) {
    if (!r.department) continue;
    deptBillable.set(r.department, add(deptBillable.get(r.department) ?? "0", r.billable_hours));
    deptTotal.set(r.department, add(deptTotal.get(r.department) ?? "0", r.total_hours));
  }
  const noBillDepts = new Set<string>();
  for (const [id, tot] of deptTotal) if (cmp(tot, "0") > 0 && cmp(deptBillable.get(id) ?? "0", "0") === 0) noBillDepts.add(id);

  // Employee "title" = dominant labour class (most hours in current range).
  const empItemHours = new Map<string, Map<string, string>>();
  for (const r of curr) {
    if (!r.item_name) continue;
    let m = empItemHours.get(r.employee);
    if (!m) { m = new Map(); empItemHours.set(r.employee, m); }
    m.set(r.item_name, add(m.get(r.item_name) ?? "0", r.total_hours));
  }
  const titleByEmp = new Map<string, string>();
  for (const [emp, m] of empItemHours) {
    let best = "No Title", max = "0";
    for (const [item, h] of m) if (cmp(h, max) > 0) { max = h; best = item; }
    titleByEmp.set(emp, best);
  }

  // Company rollup — billable-expected departments only ().
  const companySum = (rows: StatRow[]) => {
    let hours = "0", billable = "0", cost = "0";
    for (const r of rows) {
      if (r.department && noBillDepts.has(r.department)) continue;
      hours = add(hours, r.total_hours);
      billable = add(billable, r.billable_hours);
      cost = add(cost, r.non_billable_cost);
    }
    const s = calcStat(hours, billable, cost);
    const nonBillableHours = add(hours, neg(billable));
    return {
      ...s,
      nonBillableCostPerDay: days > 0 ? Number(div(cost, String(days))) : 0,
      nonBillableCostPerHour: cmp(nonBillableHours, "0") > 0 ? Number(div(cost, nonBillableHours)) : 0,
    };
  };
  const cCompany = companySum(curr);
  const pCompany = companySum(prior);

  // The spike decision compares exact decimals: a float hop here fires (or
  // misses) the alert on binary dust at exact threshold equality.
  const exactCompanyCost = (rows: StatRow[]): string => {
    let cost = "0";
    for (const r of rows) {
      if (r.department && noBillDepts.has(r.department)) continue;
      cost = add(cost, r.non_billable_cost);
    }
    return cost;
  };
  const costDeltaExact = add(exactCompanyCost(curr), neg(exactCompanyCost(prior)));

  const alerts: UAlert[] = [];
  if (cCompany.percentBilled < targetBillablePct)
    alerts.push(strings.alertBelowTarget(targetBillablePct));
  if (cmp(costDeltaExact, String(costSpikeThreshold)) > 0)
    alerts.push(strings.alertCostSpike(money(costDeltaExact, { maximumFractionDigits: 0 })));

  // Rolling history: company % (excl. noBill depts) + per-dept % (all depts).
  const periods: UHistoryPeriod[] = histPlans.map((plan, i) => {
    const rows = histStats[i] ?? [];
    let hours = "0", billable = "0";
    const dept = new Map<string, { h: string; b: string }>();
    for (const r of rows) {
      if (!(r.department && noBillDepts.has(r.department))) { hours = add(hours, r.total_hours); billable = add(billable, r.billable_hours); }
      if (r.department) {
        const d = dept.get(r.department) ?? { h: "0", b: "0" };
        d.h = add(d.h, r.total_hours); d.b = add(d.b, r.billable_hours);
        dept.set(r.department, d);
      }
    }
    const deptPct: Record<string, number> = {};
    for (const [id, d] of dept) {
      const h = Number(d.h), b = Number(d.b);
      deptPct[id] = h > 0 ? (b / h) * 100 : 0;
    }
    const h = Number(hours), b = Number(billable);
    return { label: plan.label, start: plan.start, end: plan.end, companyPct: h > 0 ? (b / h) * 100 : 0, deptPct };
  });

  return {
    period: { ...period, days },
    prior: { from: priorFrom, to: priorTo },
    config: { target: targetBillablePct, costSpike: costSpikeThreshold, minHours },
    company: {
      range: cCompany,
      prior: pCompany,
      deltas: {
        pctDelta: cCompany.percentBilled - pCompany.percentBilled,
        costDelta: Number(costDeltaExact),
      },
      alerts,
    },
    departments: buildGroup(curr, prior, "department", titleByEmp, noBillDepts, minHours, strings),
    items: buildGroup(curr, prior, "item", titleByEmp, noBillDepts, minHours, strings),
    employees: buildGroup(curr, prior, "employee", titleByEmp, noBillDepts, minHours, strings),
    history: { periodMonths, periods },
  };
}

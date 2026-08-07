import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  add, cmp, formatMoney, fromUnits, mul, mulPercent, neg, roundMoney, sum, toUnits,
} from "./money.ts";

/**
 * Derived earnings — money produced by operational facts rather than typed in.
 *
 * Per diem for nights stayed on site, on-call days, travel pay costed to the
 * first job of the day, site incentives on field time, monthly equipment
 * incentives: today these leave a field app as a CSV, get re-keyed into
 * payroll, and are then corrected by hand (deleting the site incentive off the
 * PMs' stubs is a weekly manual step). Every one of those hand steps is an
 * unauditable edit to pay.
 *
 * A pay_derived_rules row replaces the hand step. Rules emit INPUTS — pay
 * component earning lines shaped exactly like the ones calculateStub builds
 * from time, recurring components, and pay_run_adjustments — which then feed
 * the statutory engine. Nothing here ever edits a computed output, so CPP/EI/
 * tax remain the engine's numbers for the money actually paid.
 *
 * The operational fact always comes from time_entries. The timesheet is
 * already the approved, job-tagged, org-isolated record of what happened in
 * the field; a second event table would be a parallel truth about the same
 * days. Facts a supervisor ASSERTS (an on-call day, a claimed per-diem night)
 * are entered against a time type flagged exclude_from_wages, so they price as
 * events and never as hours. Facts that are INFERABLE (nights stayed, read off
 * consecutive jobsite days) need no entry at all.
 *
 * All arithmetic is bigint-exact through money.ts. Never floats.
 */

export type DerivedTrigger =
  | "time_entry"
  | "distinct_day"
  | "distinct_project_day"
  | "night_stayed"
  | "month_end";

export type DerivedQuantityMode = "count" | "sum_hours" | "count_nights";
export type DerivedRateMode = "fixed_per_unit" | "percent_of_gross" | "rate_card";
export type DerivedCostingMode = "source" | "first_project_of_day" | "none";

export interface DerivedRule {
  id: string;
  code: string;
  name: string;
  componentId: string;
  trigger: DerivedTrigger;
  timeTypeId: string | null;
  projectId: string | null;
  departmentId: string | null;
  tradeId: string | null;
  jobTitle: string | null;
  billableOnly: boolean;
  /** Empty = everyone; non-empty = only these titles. Exclusions still win. */
  includedJobTitles: string[];
  excludedJobTitles: string[];
  quantityMode: DerivedQuantityMode;
  rateMode: DerivedRateMode;
  rateValue: string | null;
  costingMode: DerivedCostingMode;
  sequence: number;
}

/** The slice of a time entry a rule can see. */
export interface DerivedTimeEntry {
  id: string;
  workedOn: string;
  hours: string;
  timeTypeId: string | null;
  projectId: string | null;
  departmentId: string | null;
  isBillable: boolean;
  /** Capture order within a day — time_entries carry no clock time, so this is
   * the only ordering "the job he went to FIRST" can honestly resolve against. */
  createdAt?: string | null;
}

/** Employee-scope facts a rule filters on (employee_roles). */
export interface DerivedEmployeeScope {
  jobTitle: string | null;
  tradeId: string | null;
  departmentId: string | null;
}

/** The emitting component's statutory treatment, inherited by every line. */
export interface DerivedComponent {
  id: string;
  name: string;
  value: string | null;
  taxable: boolean;
  pensionable: boolean;
  insurable: boolean;
  vacationable: boolean;
  nonPeriodic: boolean;
}

/** An earning line shaped for calculateStub's line set. */
export interface DerivedEarningLine {
  componentId: string;
  kind: "earning";
  description: string;
  rate: string | null;
  amount: string;
  projectId: string | null;
  departmentId: string | null;
  timeTypeId: string | null;
  sequence: number;
  taxable: boolean;
  pensionable: boolean;
  insurable: boolean;
  vacationable: boolean;
  nonPeriodic: boolean;
  /** Provenance: which rule paid this, for the stub trace and the preview. */
  ruleId: string;
  ruleCode: string;
}

/** One payable fact, before it is grouped onto a line. Surfaced by the
 * preview so an operator sees the actual days, not just a total. */
export interface DerivedUnit {
  day: string;
  quantity: string;
  amount: string;
  projectId: string | null;
  departmentId: string | null;
  entryIds: string[];
}

export interface DerivedEarningsInput {
  rules: DerivedRule[];
  components: Map<string, DerivedComponent>;
  employee: DerivedEmployeeScope;
  /** Approved entries covering the period, the day before it (nights), and the
   * settled month (month_end rules). Extra rows are harmless — every trigger
   * windows what it reads. */
  entries: DerivedTimeEntry[];
  periodStart: string;
  periodEnd: string;
  /** Earnings accumulated so far, the basis for percent_of_gross rules. */
  gross: string;
  /** rate_card per-employee overrides, by component id. */
  rateOverrides?: Record<string, string>;
}

export class DerivedEarningsError extends Error {}

const DAY = 24 * 60 * 60 * 1000;
const at = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shiftDays = (s: string, days: number) => iso(new Date(at(s).getTime() + days * DAY));

/** Job titles are free text typed by whoever set the employee up. */
const normalizeTitle = (value: string | null | undefined) =>
  (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Display only: drop the trailing zeros a fixed-decimal string carries. */
const trimZeros = (value: string) =>
  value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;

/** Does a configured title list name the employee's title? */
function titleListNames(list: string[], jobTitle: string | null): boolean {
  const title = normalizeTitle(jobTitle);
  return list.some((entry) => {
    const candidate = normalizeTitle(entry);
    return candidate !== "" && candidate === title;
  });
}

/** Exclusions win over inclusions: not paying is the safe failure. */
function titleIsExcluded(rule: DerivedRule, jobTitle: string | null): boolean {
  return titleListNames(rule.excludedJobTitles, jobTitle);
}

/**
 * The calendar month a month_end rule settles in this period: the month whose
 * LAST day the period covers. A period that spans no month end settles
 * nothing, so the incentive is paid exactly once, on the first run after the
 * month closed.
 */
export function settlementMonth(
  periodStart: string,
  periodEnd: string,
): { start: string; end: string } | null {
  const end = at(periodEnd);
  for (
    let cursor = at(periodStart);
    cursor.getTime() <= end.getTime();
    cursor = new Date(cursor.getTime() + DAY)
  ) {
    const monthEnd = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0),
    );
    if (iso(monthEnd) === iso(cursor)) {
      return {
        start: iso(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1))),
        end: iso(cursor),
      };
    }
  }
  return null;
}

/** The widest span of time a rule set needs to read, including lookbacks. */
export function derivedEntryWindow(
  rules: DerivedRule[],
  periodStart: string,
  periodEnd: string,
): { from: string; to: string } {
  let from = periodStart;
  // A night is credited to the morning after, so the first day of the period
  // can only be judged with the last day of the previous one.
  if (rules.some((r) => r.trigger === "night_stayed")) from = shiftDays(from, -1);
  if (rules.some((r) => r.trigger === "month_end")) {
    const month = settlementMonth(periodStart, periodEnd);
    if (month && month.start < from) from = month.start;
  }
  return { from, to: periodEnd };
}

/** Deterministic within-day order: capture order, then id. */
function byCaptureOrder(a: DerivedTimeEntry, b: DerivedTimeEntry): number {
  const ca = a.createdAt ?? "";
  const cb = b.createdAt ?? "";
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether a rule's employee-scope filters admit this employee at all. */
export function ruleAdmitsEmployee(rule: DerivedRule, employee: DerivedEmployeeScope): boolean {
  if (titleIsExcluded(rule, employee.jobTitle)) return false;
  if (rule.includedJobTitles.length > 0 && !titleListNames(rule.includedJobTitles, employee.jobTitle)) {
    return false;
  }
  if (rule.jobTitle && normalizeTitle(rule.jobTitle) !== normalizeTitle(employee.jobTitle)) return false;
  if (rule.tradeId && rule.tradeId !== employee.tradeId) return false;
  return true;
}

function entryMatches(
  rule: DerivedRule,
  entry: DerivedTimeEntry,
  employee: DerivedEmployeeScope,
): boolean {
  if (rule.timeTypeId && rule.timeTypeId !== entry.timeTypeId) return false;
  if (rule.projectId && rule.projectId !== entry.projectId) return false;
  if (rule.billableOnly && !entry.isBillable) return false;
  if (rule.departmentId) {
    // Field time is routinely tagged to the job and not to the crew's home
    // department; fall back to the employee's department in that case.
    const effective = entry.departmentId ?? employee.departmentId;
    if (rule.departmentId !== effective) return false;
  }
  return true;
}

interface PendingUnit {
  day: string;
  quantity: string;
  projectId: string | null;
  departmentId: string | null;
  entryIds: string[];
}

/** The job the employee went to FIRST on a day, across ALL their time — a
 * travel entry itself carries no job, so the answer cannot come from the
 * rule's own qualifying rows. */
function firstProjectOfDay(
  entries: DerivedTimeEntry[],
  day: string,
): { projectId: string | null; departmentId: string | null } {
  const first = entries
    .filter((entry) => entry.workedOn === day && entry.projectId)
    .sort(byCaptureOrder)[0];
  return {
    projectId: first?.projectId ?? null,
    departmentId: first?.departmentId ?? null,
  };
}

function unitQuantity(rule: DerivedRule, entries: DerivedTimeEntry[]): string {
  return rule.quantityMode === "sum_hours"
    ? sum(entries.map((entry) => entry.hours))
    : "1";
}

/** The payable facts a rule finds, before pricing. */
function unitsForRule(
  rule: DerivedRule,
  input: DerivedEarningsInput,
): PendingUnit[] {
  const window = rule.trigger === "month_end"
    ? settlementMonth(input.periodStart, input.periodEnd)
    : { start: input.periodStart, end: input.periodEnd };
  if (!window) return [];

  const qualifying = input.entries
    .filter((entry) => entryMatches(rule, entry, input.employee))
    .sort(byCaptureOrder);
  const inWindow = qualifying.filter(
    (entry) => entry.workedOn >= window.start && entry.workedOn <= window.end,
  );

  if (rule.trigger === "night_stayed") {
    // A night lies between two consecutive qualifying days. Credit it to the
    // later day — the morning after — so a period is decided entirely by time
    // that has already been approved, and cost it to the job the employee
    // slept at, which is the EARLIER day's job.
    const byDay = new Map<string, DerivedTimeEntry[]>();
    for (const entry of qualifying) {
      const bucket = byDay.get(entry.workedOn);
      if (bucket) bucket.push(entry);
      else byDay.set(entry.workedOn, [entry]);
    }
    const units: PendingUnit[] = [];
    for (const day of [...byDay.keys()].sort()) {
      if (day < window.start || day > window.end) continue;
      const previous = byDay.get(shiftDays(day, -1));
      if (!previous) continue;
      const slept = previous[0]!;
      units.push({
        day,
        quantity: unitQuantity(rule, byDay.get(day)!),
        projectId: slept.projectId,
        departmentId: slept.departmentId,
        entryIds: [slept.id, ...byDay.get(day)!.map((entry) => entry.id)],
      });
    }
    return units;
  }

  const grouped = new Map<string, DerivedTimeEntry[]>();
  for (const entry of inWindow) {
    // month_end reads the settled month one entry at a time, exactly like
    // time_entry — only the window differs.
    const key = rule.trigger === "distinct_day"
      ? entry.workedOn
      : rule.trigger === "distinct_project_day"
        ? `${entry.workedOn}|${entry.projectId ?? ""}`
        : entry.id;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(entry);
    else grouped.set(key, [entry]);
  }
  return [...grouped.values()].map((bucket) => ({
    day: bucket[0]!.workedOn,
    quantity: unitQuantity(rule, bucket),
    projectId: bucket[0]!.projectId,
    departmentId: bucket[0]!.departmentId,
    entryIds: bucket.map((entry) => entry.id),
  }));
}

/**
 * The rule's configured rate. An ABSENT rate is an unconfigured rule, not a
 * zero one.
 *
 * `rateValue ?? "0"` made those indistinguishable, and the consequence was
 * invisible rather than wrong-looking: a zero amount makes `applyDerivedRule`
 * drop the bucket, so no line appears at all — not on the stub, and not in the
 * pre-enable preview an operator reads precisely to "look before enabling".
 * The `rate_card` branch below already throws for exactly this; its two
 * siblings now agree.
 */
function requiredRateValue(rule: DerivedRule): string {
  const value = rule.rateValue;
  if (value == null || String(value).trim() === "") {
    throw new DerivedEarningsError(
      `derived rule ${rule.code} is ${rule.rateMode} but carries no rate value`,
    );
  }
  return value;
}

function perUnitRate(rule: DerivedRule, input: DerivedEarningsInput): string {
  if (rule.rateMode !== "rate_card") return requiredRateValue(rule);
  // The component IS the rate card: its value, overridable per employee
  // through employee_pay_components, the same one-home rule wages follow.
  const override = input.rateOverrides?.[rule.componentId];
  if (override != null) return override;
  const component = input.components.get(rule.componentId);
  if (component?.value == null) {
    throw new DerivedEarningsError(
      `derived rule ${rule.code} is rate-carded but its pay component carries no value`,
    );
  }
  return component.value;
}

/**
 * Split an exact money total across facts in proportion to their quantities,
 * to the cent, by LARGEST REMAINDER. Returns null when the quantities sum to
 * zero (nothing to split against).
 *
 * The property that matters and is kept: `sum(result) === total`, exactly.
 *
 * The property that was missing: every share must also be a faithful rounding
 * of its own exact value. Handing the whole residual to the LAST fact does
 * keep the sum, but each of the first n−1 shares can round UP, so the last one
 * absorbs all of it and can go NEGATIVE. Real case: gross 2,000.00 at 0.25% is
 * a 5.00 total over 40 time entries; the exact share is 0.1250, which rounds
 * to 0.13, the first 39 sum to 5.07, and the fortieth is paid −0.07.
 *
 * A negative earning is not cosmetic. If that last fact sits on a different
 * project from the other 39 — routine for a crew that moves jobs — the bucket
 * rollup emits a negative earning line for that job, and downstream it is a
 * live tripwire: the WCB job split throws "ratio numerator cannot be negative",
 * and disposable earnings throws "an earning cannot be negative" as soon as the
 * employee has any protected deduction. Same input, silently wrong in one
 * tenant configuration and a hard run failure in another.
 *
 * Largest remainder gives every fact floor(exact) cents and then hands out the
 * leftover cents one at a time, in descending order of the fractional part
 * (index order breaking ties, so the result is deterministic). Every share is
 * therefore floor or floor+1 of its own exact value — never negative for a
 * non-negative total — and they still sum to exactly `total`.
 */
export function allocateByQuantity(total: string, quantities: string[]): string[] | null {
  const CENT = 100n; // money.ts units are 1e-4; a cent is 100 of them
  const totalUnits = toUnits(total);
  const sign = totalUnits < 0n ? -1n : 1n;
  const cents = (sign * totalUnits) / CENT;
  const q = quantities.map((value) => {
    const units = toUnits(value);
    if (units < 0n) {
      throw new DerivedEarningsError("a derived quantity cannot be negative");
    }
    return units;
  });
  const totalQuantity = q.reduce((acc, value) => acc + value, 0n);
  if (totalQuantity === 0n) return null;

  const shares = q.map((value) => (cents * value) / totalQuantity);
  const remainders = q.map((value, index) => cents * value - shares[index]! * totalQuantity);
  let leftover = cents - shares.reduce((acc, value) => acc + value, 0n);
  const order = shares
    .map((_, index) => index)
    .sort((a, b) => {
      const diff = remainders[b]! - remainders[a]!;
      return diff === 0n ? a - b : diff > 0n ? 1 : -1;
    });
  for (let i = 0; leftover > 0n && i < order.length; i++, leftover--) {
    shares[order[i]!] = shares[order[i]!]! + 1n;
  }
  return shares.map((value) => fromUnits(sign * value * CENT));
}

/** Human trace of how an amount was reached, on the line the employee sees. */
function describe(rule: DerivedRule, quantity: string, rate: string): string {
  if (rule.rateMode === "percent_of_gross") {
    return `${rule.name} (${trimZeros(formatMoney(requiredRateValue(rule), 4))}% of gross)`;
  }
  const qty = trimZeros(formatMoney(quantity, 2));
  const unit = rule.quantityMode === "sum_hours" ? `${qty} h` : qty;
  return `${rule.name} (${unit} × ${formatMoney(rate, 2)})`;
}

/**
 * Apply one rule to one employee. Returns the priced facts and the earning
 * lines they roll up to, so the pay run and the pre-enable preview are the
 * same calculation seen at two resolutions.
 */
export function applyDerivedRule(
  rule: DerivedRule,
  input: DerivedEarningsInput,
): { units: DerivedUnit[]; lines: DerivedEarningLine[] } {
  const empty = { units: [] as DerivedUnit[], lines: [] as DerivedEarningLine[] };
  if (!ruleAdmitsEmployee(rule, input.employee)) return empty;
  const component = input.components.get(rule.componentId);
  if (!component) {
    throw new DerivedEarningsError(`derived rule ${rule.code} has no pay component`);
  }
  const pending = unitsForRule(rule, input);
  if (pending.length === 0) return empty;

  const costed = pending.map((unit) => {
    if (rule.costingMode === "none") {
      return { ...unit, projectId: null, departmentId: null };
    }
    if (rule.costingMode === "first_project_of_day") {
      return { ...unit, ...firstProjectOfDay(input.entries, unit.day) };
    }
    return unit;
  });

  const rate = perUnitRate(rule, input);
  let units: DerivedUnit[];
  if (rule.rateMode === "percent_of_gross") {
    // One exact total, then an exact proportional split across the facts. The
    // rule can never pay a penny more or less than the percentage of gross it
    // declares, and no fact can be paid a negative amount.
    const total = mulPercent(input.gross, requiredRateValue(rule), 2);
    const shares = allocateByQuantity(total, costed.map((unit) => unit.quantity));
    if (shares === null) return empty;
    units = costed.map((unit, index) => ({ ...unit, amount: shares[index]! }));
  } else {
    units = costed.map((unit) => ({
      ...unit,
      amount: roundMoney(mul(rate, unit.quantity), 2),
    }));
  }

  // Roll the facts up to one line per job-costing bucket. Summing already
  // exact per-fact amounts keeps the line total penny-identical to the facts
  // the preview showed.
  const buckets = new Map<string, { unit: DerivedUnit; quantity: string; amount: string }>();
  for (const unit of units) {
    const key = `${unit.projectId ?? ""}|${unit.departmentId ?? ""}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.quantity = add(bucket.quantity, unit.quantity);
      bucket.amount = add(bucket.amount, unit.amount);
    } else {
      buckets.set(key, { unit, quantity: unit.quantity, amount: unit.amount });
    }
  }

  const lines: DerivedEarningLine[] = [];
  for (const bucket of [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [, value] = bucket;
    if (cmp(value.amount, "0") === 0) continue;
    lines.push({
      componentId: rule.componentId,
      kind: "earning",
      description: describe(rule, value.quantity, rate),
      // Deliberately no `hours`: nights and on-call days are not worked hours,
      // and even hour-shaped derived quantities are already on the wage lines.
      // calculateStub prices per-hour components off line hours, so carrying
      // them here would pay those components twice.
      rate: rule.rateMode === "percent_of_gross" ? null : roundMoney(rate, 4),
      amount: value.amount,
      projectId: value.unit.projectId,
      departmentId: value.unit.departmentId,
      timeTypeId: rule.timeTypeId,
      sequence: rule.sequence,
      taxable: component.taxable,
      pensionable: component.pensionable,
      insurable: component.insurable,
      vacationable: component.vacationable,
      nonPeriodic: component.nonPeriodic,
      ruleId: rule.id,
      ruleCode: rule.code,
    });
  }
  return { units, lines };
}

/** Every active rule's lines for one employee. Pure — no database. */
export function computeDerivedEarnings(input: DerivedEarningsInput): DerivedEarningLine[] {
  const lines: DerivedEarningLine[] = [];
  for (const rule of [...input.rules].sort((a, b) => a.sequence - b.sequence || (a.code < b.code ? -1 : 1))) {
    lines.push(...applyDerivedRule(rule, input).lines);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Database-backed entry points
// ---------------------------------------------------------------------------

interface RuleRow {
  id: string; code: string; name: string; component_id: string;
  trigger: DerivedTrigger; time_type_id: string | null; project_id: string | null;
  department_id: string | null; trade_id: string | null; job_title: string | null;
  billable_only: boolean; included_job_titles: unknown; excluded_job_titles: unknown;
  quantity_mode: DerivedQuantityMode; rate_mode: DerivedRateMode;
  rate_value: string | null; costing_mode: DerivedCostingMode; sequence: number;
  is_active?: boolean; effective_from?: string; effective_to?: string | null;
}

function toRule(row: RuleRow): DerivedRule {
  const titles = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
  const excluded = titles(row.excluded_job_titles);
  return {
    id: row.id, code: row.code, name: row.name, componentId: row.component_id,
    trigger: row.trigger, timeTypeId: row.time_type_id, projectId: row.project_id,
    departmentId: row.department_id, tradeId: row.trade_id, jobTitle: row.job_title,
    billableOnly: row.billable_only === true,
    includedJobTitles: titles(row.included_job_titles), excludedJobTitles: excluded,
    quantityMode: row.quantity_mode, rateMode: row.rate_mode,
    rateValue: row.rate_value, costingMode: row.costing_mode,
    sequence: Number(row.sequence),
  };
}

/** Active rules effective on the pay period end (the employee_pay_components
 * convention: one date decides the whole period). */
export async function loadActiveDerivedRules(
  tx: Pick<typeof db, "execute">, orgId: string, periodEnd: string,
): Promise<DerivedRule[]> {
  const r = (await tx.execute(sql`
    select * from pay_derived_rules
     where org_id = ${orgId} and is_active
       and effective_from <= ${periodEnd}
       and (effective_to is null or effective_to >= ${periodEnd})
     order by sequence, code
  `)) as unknown as { rows: RuleRow[] };
  return r.rows.map(toRule);
}

async function loadComponents(
  tx: Pick<typeof db, "execute">, orgId: string, componentIds: string[],
): Promise<Map<string, DerivedComponent>> {
  if (componentIds.length === 0) return new Map();
  const r = (await tx.execute(sql`
    select id, name, value, kind, taxable, pensionable, insurable, vacationable, non_periodic
      from pay_components
     where org_id = ${orgId} and id = any(${`{${componentIds.join(",")}}`}::uuid[])
  `)) as unknown as {
    rows: {
      id: string; name: string; value: string | null; kind: string;
      taxable: boolean; pensionable: boolean; insurable: boolean;
      vacationable: boolean; non_periodic: boolean;
    }[];
  };
  const map = new Map<string, DerivedComponent>();
  for (const row of r.rows) {
    if (row.kind !== "earning") {
      throw new DerivedEarningsError(
        `pay component ${row.name} is not an earning — a derived rule can only emit earnings`,
      );
    }
    map.set(row.id, {
      id: row.id, name: row.name, value: row.value,
      taxable: row.taxable === true, pensionable: row.pensionable === true,
      insurable: row.insurable === true, vacationable: row.vacationable === true,
      nonPeriodic: row.non_periodic === true,
    });
  }
  return map;
}

async function loadEmployeeScope(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string,
): Promise<DerivedEmployeeScope> {
  const r = (await tx.execute(sql`
    select job_title, trade_id, department_id from employee_roles
     where org_id = ${orgId} and party_id = ${employeePartyId} limit 1
  `)) as unknown as {
    rows: { job_title: string | null; trade_id: string | null; department_id: string | null }[];
  };
  const row = r.rows[0];
  return {
    jobTitle: row?.job_title ?? null,
    tradeId: row?.trade_id ?? null,
    departmentId: row?.department_id ?? null,
  };
}

async function loadEntries(
  tx: Pick<typeof db, "execute">, orgId: string,
  employeePartyIds: string[], from: string, to: string,
): Promise<Map<string, DerivedTimeEntry[]>> {
  const byEmployee = new Map<string, DerivedTimeEntry[]>();
  if (employeePartyIds.length === 0) return byEmployee;
  // Deliberately no payroll_batch_ref filter: lookback and settled-month rows
  // were claimed by the runs that paid their wages, and reading them proves
  // the employee stayed / operated the equipment. Wages are not re-paid here.
  const r = (await tx.execute(sql`
    select id, employee_party_id, worked_on, hours, time_type_id, project_id,
           department_id, is_billable, created_at
      from time_entries
     where org_id = ${orgId} and status = 'approved'
       and employee_party_id = any(${`{${employeePartyIds.join(",")}}`}::uuid[])
       and worked_on between ${from} and ${to}
     order by employee_party_id, worked_on, created_at, id
  `)) as unknown as {
    rows: {
      id: string; employee_party_id: string; worked_on: string; hours: string;
      time_type_id: string | null; project_id: string | null;
      department_id: string | null; is_billable: boolean; created_at: string | Date;
    }[];
  };
  for (const row of r.rows) {
    const entry: DerivedTimeEntry = {
      id: row.id,
      workedOn: String(row.worked_on).slice(0, 10),
      hours: row.hours,
      timeTypeId: row.time_type_id,
      projectId: row.project_id,
      departmentId: row.department_id,
      isBillable: row.is_billable === true,
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    };
    const bucket = byEmployee.get(row.employee_party_id);
    if (bucket) bucket.push(entry);
    else byEmployee.set(row.employee_party_id, [entry]);
  }
  return byEmployee;
}

/** rate_card overrides assigned to an employee, effective at the period end. */
async function loadRateOverrides(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string, periodEnd: string,
): Promise<Record<string, string>> {
  const r = (await tx.execute(sql`
    select component_id, value from employee_pay_components
     where org_id = ${orgId} and employee_party_id = ${employeePartyId} and is_active
       and value is not null
       and effective_from <= ${periodEnd}
       and (effective_to is null or effective_to >= ${periodEnd})
     order by effective_from
  `)) as unknown as { rows: { component_id: string; value: string }[] };
  const overrides: Record<string, string> = {};
  for (const row of r.rows) overrides[row.component_id] = row.value;
  return overrides;
}

/**
 * The derived earning lines to add to one employee's stub. `timeEntries` is
 * the period's approved time the caller already read; the lookback day that
 * decides the period's first night, and the settled month a month_end rule
 * reads, are fetched here and merged.
 */
export async function resolveDerivedEarnings(
  tx: Pick<typeof db, "execute">,
  params: {
    orgId: string;
    employeePartyId: string;
    periodStart: string;
    periodEnd: string;
    rules: DerivedRule[];
    timeEntries: DerivedTimeEntry[];
    gross: string;
  },
): Promise<DerivedEarningLine[]> {
  const { orgId, employeePartyId, periodStart, periodEnd, rules } = params;
  if (rules.length === 0) return [];

  const employee = await loadEmployeeScope(tx, orgId, employeePartyId);
  // Cheap exit before any further reads: an excluded PM is excluded from every
  // rule that names their title, whatever time they booked.
  const applicable = rules.filter((rule) => ruleAdmitsEmployee(rule, employee));
  if (applicable.length === 0) return [];

  const window = derivedEntryWindow(applicable, periodStart, periodEnd);
  const entries = [...params.timeEntries];
  if (window.from < periodStart) {
    const extra = await loadEntries(tx, orgId, [employeePartyId], window.from, shiftDays(periodStart, -1));
    entries.push(...(extra.get(employeePartyId) ?? []));
  }
  const seen = new Set<string>();
  const deduped = entries.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));

  const [components, rateOverrides] = await Promise.all([
    loadComponents(tx, orgId, [...new Set(applicable.map((rule) => rule.componentId))]),
    loadRateOverrides(tx, orgId, employeePartyId, periodEnd),
  ]);

  return computeDerivedEarnings({
    rules: applicable,
    components,
    employee,
    entries: deduped,
    periodStart,
    periodEnd,
    gross: params.gross,
    rateOverrides,
  });
}

export interface DerivedRulePreviewRow {
  employeePartyId: string;
  employeeName: string;
  jobTitle: string | null;
  day: string;
  quantity: string;
  amount: string;
  projectId: string | null;
  projectName: string | null;
}

export interface DerivedRulePreview {
  rule: {
    id: string; code: string; name: string; isActive: boolean;
    trigger: DerivedTrigger; quantityMode: DerivedQuantityMode;
    rateMode: DerivedRateMode; rateValue: string | null;
    costingMode: DerivedCostingMode; componentName: string;
    effectiveFrom: string; effectiveTo: string | null;
  };
  periodStart: string;
  periodEnd: string;
  rows: DerivedRulePreviewRow[];
  /** Employees the rule's own exclusion list kept out — the weekly manual
   * deletion, shown as evidence instead of performed by hand. */
  excluded: { employeePartyId: string; employeeName: string; jobTitle: string | null }[];
  employeeCount: number;
  total: string;
  /**
   * percent_of_gross previews price against gross ESTIMATED from approved time
   * × the effective wage, because no stub exists before the run is calculated.
   * The pay run's own calculation stays authoritative.
   */
  grossIsEstimated: boolean;
  errors: string[];
}

/**
 * What a rule WOULD pay over a period, per employee and per day — deliberately
 * ignoring is_active and the effective dates, because the whole point is to
 * look before enabling. Nobody should turn on a money rule blind.
 */
export async function previewDerivedRule(
  orgId: string, ruleId: string, periodStart: string, periodEnd: string,
): Promise<DerivedRulePreview> {
  const ruleRes = (await db.execute(sql`
    select r.*, c.name as component_name from pay_derived_rules r
      join pay_components c on c.id = r.component_id and c.org_id = r.org_id
     where r.org_id = ${orgId} and r.id = ${ruleId}
  `)) as unknown as { rows: (RuleRow & { component_name: string })[] };
  const row = ruleRes.rows[0];
  if (!row) throw new DerivedEarningsError("derived earnings rule not found");
  const rule = toRule(row);

  // Everyone who could be paid by this run of rules: active employees with a
  // payroll profile, which is exactly the population calculatePayRun walks.
  const peopleRes = (await db.execute(sql`
    select p.id as party_id, p.display_name, er.job_title, er.trade_id, er.department_id
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
     where prof.org_id = ${orgId} and prof.is_active
       and (er.terminated_on is null or er.terminated_on >= ${periodStart})
     order by p.display_name
  `)) as unknown as {
    rows: {
      party_id: string; display_name: string; job_title: string | null;
      trade_id: string | null; department_id: string | null;
    }[];
  };
  const people = peopleRes.rows;

  const window = derivedEntryWindow([rule], periodStart, periodEnd);
  const [entriesByEmployee, components] = await Promise.all([
    loadEntries(db, orgId, people.map((person) => person.party_id), window.from, window.to),
    loadComponents(db, orgId, [rule.componentId]),
  ]);

  // Gross basis for percent_of_gross only: approved hours × the effective
  // employee wage × the time type's cost multiplier — the same inputs
  // calculateStub prices wages from, labelled as the estimate it is.
  const grossByEmployee = new Map<string, string>();
  if (rule.rateMode === "percent_of_gross") {
    const grossRes = (await db.execute(sql`
      select te.employee_party_id,
             coalesce(sum(te.hours * coalesce(tt.cost_multiplier, 1) * lcr.rate), 0)::text as gross
        from time_entries te
        left join time_types tt on tt.id = te.time_type_id
        join lateral (
          select rate from labor_cost_rates lcr
           where lcr.org_id = te.org_id and lcr.employee_party_id = te.employee_party_id
             and lcr.is_active and lcr.basis = 'hour' and lcr.effective_from <= te.worked_on
             and (lcr.effective_to is null or lcr.effective_to >= te.worked_on)
           order by lcr.effective_from desc limit 1
        ) lcr on true
       where te.org_id = ${orgId} and te.status = 'approved'
         and te.worked_on between ${periodStart} and ${periodEnd}
         and coalesce(tt.exclude_from_wages, false) = false
       group by te.employee_party_id
    `)) as unknown as { rows: { employee_party_id: string; gross: string }[] };
    for (const gross of grossRes.rows) {
      grossByEmployee.set(gross.employee_party_id, roundMoney(gross.gross, 2));
    }
  }

  const rows: DerivedRulePreviewRow[] = [];
  const excluded: DerivedRulePreview["excluded"] = [];
  const errors: string[] = [];
  const paid = new Set<string>();
  for (const person of people) {
    const employee: DerivedEmployeeScope = {
      jobTitle: person.job_title, tradeId: person.trade_id, departmentId: person.department_id,
    };
    if (titleIsExcluded(rule, person.job_title)) {
      excluded.push({
        employeePartyId: person.party_id,
        employeeName: person.display_name,
        jobTitle: person.job_title,
      });
      continue;
    }
    try {
      const { units } = applyDerivedRule(rule, {
        rules: [rule], components, employee,
        entries: entriesByEmployee.get(person.party_id) ?? [],
        periodStart, periodEnd,
        gross: grossByEmployee.get(person.party_id) ?? "0",
      });
      for (const unit of units) {
        if (cmp(unit.amount, "0") === 0) continue;
        paid.add(person.party_id);
        rows.push({
          employeePartyId: person.party_id,
          employeeName: person.display_name,
          jobTitle: person.job_title,
          day: unit.day,
          quantity: unit.quantity,
          amount: unit.amount,
          projectId: unit.projectId,
          projectName: null,
        });
      }
    } catch (error) {
      errors.push(`${person.display_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const projectIds = [...new Set(rows.map((r) => r.projectId).filter(Boolean))] as string[];
  if (projectIds.length > 0) {
    const projects = (await db.execute(sql`
      select id, case when coalesce(code, '') <> '' then code || ' · ' || name else name end as label
        from projects where org_id = ${orgId} and id = any(${`{${projectIds.join(",")}}`}::uuid[])
    `)) as unknown as { rows: { id: string; label: string }[] };
    const byId = new Map(projects.rows.map((project) => [project.id, project.label]));
    for (const preview of rows) {
      preview.projectName = preview.projectId ? (byId.get(preview.projectId) ?? null) : null;
    }
  }

  return {
    rule: {
      id: rule.id, code: rule.code, name: rule.name,
      isActive: row.is_active === true, trigger: rule.trigger,
      quantityMode: rule.quantityMode, rateMode: rule.rateMode,
      rateValue: rule.rateValue, costingMode: rule.costingMode,
      componentName: row.component_name,
      effectiveFrom: String(row.effective_from ?? "").slice(0, 10),
      effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
    },
    periodStart,
    periodEnd,
    rows: rows.sort((a, b) =>
      a.employeeName.localeCompare(b.employeeName) || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    excluded,
    employeeCount: paid.size,
    total: sum(rows.map((r) => r.amount)),
    grossIsEstimated: rule.rateMode === "percent_of_gross",
    errors,
  };
}

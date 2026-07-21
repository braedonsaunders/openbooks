import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, fromUnits, mul, mulRate, sum, toUnits } from "./money.ts";

export type LaborLane = "direct_cost" | "bill" | "transfer" | "planning_cost" | "planning_bill";
export type RateMethod = "fixed" | "at_cost" | "markup_on_cost" | "margin_on_cost";
export type ComponentLane = "cost" | "bill" | "transfer";
export type ComponentMethod = "fixed_per_hour" | "percent_of_base_direct" | "percent_of_direct" | "percent_of_subtotal";

export interface LaborDimensions {
  employeePartyId: string;
  laborClassId?: string | null;
  itemId?: string | null;
  timeTypeId?: string | null;
  subsidiaryId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  workerCompGroupId?: string | null;
}

export interface LaborRateLineInput {
  id: string;
  code: string;
  name: string;
  lane: LaborLane;
  method: RateMethod;
  amount: string | null;
  percent: string | null;
  currency: string;
  baseHours: string;
  priority: number;
  employeePartyId?: string | null;
  laborClassId?: string | null;
  itemId?: string | null;
  timeTypeId?: string | null;
  subsidiaryId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  workerCompGroupId?: string | null;
}

export interface LaborRateComponentInput {
  id: string;
  code: string;
  name: string;
  lane: ComponentLane;
  method: ComponentMethod;
  value: string;
  currency: string | null;
  sequence: number;
  employeePartyId?: string | null;
  laborClassId?: string | null;
  itemId?: string | null;
  timeTypeId?: string | null;
  subsidiaryId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  workerCompGroupId?: string | null;
}

export interface LaborRateSnapshotComponent {
  lane: "direct_cost" | "burden" | "bill" | "transfer";
  sourceLineId: string | null;
  sourceComponentId: string | null;
  code: string;
  name: string;
  method: string;
  sourceCurrency: string;
  fxRate: string;
  ratePerHour: string;
  amount: string;
  sequence: number;
  explanation: string;
}

export interface LaborRateResult {
  rateBookId: string;
  rateBookName: string;
  rateVersionId: string;
  rateVersionDate: string;
  assignmentExplanation: string;
  baseCurrency: string;
  directCostRate: string;
  burdenRate: string;
  costRate: string;
  billRate: string;
  transferRate: string;
  planningCostRate: string | null;
  planningBillRate: string | null;
  standardCostAmount: string;
  billAmount: string;
  components: LaborRateSnapshotComponent[];
  resolutionHash: string;
  lockProjectVersion: boolean;
}

export class LaborRateError extends Error {
  constructor(message: string, public readonly code: "missing" | "ambiguous" | "configuration") {
    super(message);
    this.name = "LaborRateError";
  }
}

const DIMENSIONS: { key: keyof LaborDimensions; weight: number }[] = [
  { key: "employeePartyId", weight: 128 },
  { key: "laborClassId", weight: 64 },
  { key: "itemId", weight: 32 },
  { key: "workerCompGroupId", weight: 16 },
  { key: "timeTypeId", weight: 8 },
  { key: "subsidiaryId", weight: 4 },
  { key: "departmentId", weight: 2 },
  { key: "locationId", weight: 1 },
];

function matchesDimensions(candidate: Record<string, unknown>, dimensions: LaborDimensions): boolean {
  return DIMENSIONS.every(({ key }) => candidate[key] == null || candidate[key] === dimensions[key]);
}

function specificity(candidate: Record<string, unknown>): number {
  return DIMENSIONS.reduce((score, { key, weight }) => score + (candidate[key] == null ? 0 : weight), 0);
}

function chooseLine(lines: LaborRateLineInput[], lane: LaborLane, dimensions: LaborDimensions): LaborRateLineInput | null {
  const matches = lines
    .filter((line) => line.lane === lane && matchesDimensions(line as unknown as Record<string, unknown>, dimensions))
    .sort((a, b) => b.priority - a.priority || specificity(b as any) - specificity(a as any) || a.code.localeCompare(b.code));
  const winner = matches[0];
  if (!winner) return null;
  const tied = matches.filter((line) => line.priority === winner.priority && specificity(line as any) === specificity(winner as any));
  if (tied.length > 1) {
    throw new LaborRateError(`Ambiguous ${lane.replaceAll("_", " ")} rate: ${tied.map((line) => line.code).join(", ")}`, "ambiguous");
  }
  return winner;
}

function divide(a: string, b: string): string {
  const denominator = toUnits(b);
  if (denominator <= 0n) throw new LaborRateError("Rate unit hours must be greater than zero", "configuration");
  const numerator = toUnits(a) * 10_000n;
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const rounded = (abs + denominator / 2n) / denominator;
  return fromUnits(negative ? -rounded : rounded);
}

function percentOf(base: string, percent: string): string {
  const numerator = toUnits(base) * toUnits(percent);
  const denominator = 100n * 10_000n;
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const rounded = (abs + denominator / 2n) / denominator;
  return fromUnits(negative ? -rounded : rounded);
}

function marginPrice(cost: string, percent: string): string {
  const denominator = toUnits("100") - toUnits(percent);
  if (denominator <= 0n) throw new LaborRateError("Margin must be less than 100%", "configuration");
  const numerator = toUnits(cost) * toUnits("100");
  return fromUnits((numerator + denominator / 2n) / denominator);
}

export function resolveLaborRateStack(input: {
  dimensions: LaborDimensions;
  hours: string;
  isBillable: boolean;
  baseCurrency: string;
  lines: LaborRateLineInput[];
  components: LaborRateComponentInput[];
  employeeCompensation?: { hourlyRate: string; currency: string; fxRate: string } | null;
  timeCostMultiplier: string;
  timeBillMultiplier: string;
  fx: (currency: string) => { rate: string; source: string };
}): Omit<LaborRateResult, "rateBookId" | "rateBookName" | "rateVersionId" | "rateVersionDate" | "assignmentExplanation" | "resolutionHash" | "lockProjectVersion"> {
  const { dimensions, baseCurrency, hours } = input;
  const directLine = chooseLine(input.lines, "direct_cost", dimensions);
  let baseDirect: string;
  let directSourceCurrency: string;
  let directFx: string;
  let directCode: string;
  let directName: string;
  let directMethod: string;
  let directLineId: string | null;

  if (directLine) {
    if (directLine.method !== "fixed" || directLine.amount == null) {
      throw new LaborRateError("Direct-cost lines must use a fixed rate", "configuration");
    }
    const fx = input.fx(directLine.currency);
    baseDirect = mulRate(divide(directLine.amount, directLine.baseHours), fx.rate);
    directSourceCurrency = directLine.currency;
    directFx = fx.rate;
    directCode = directLine.code;
    directName = directLine.name;
    directMethod = directLine.method;
    directLineId = directLine.id;
  } else if (input.employeeCompensation) {
    baseDirect = mulRate(input.employeeCompensation.hourlyRate, input.employeeCompensation.fxRate);
    directSourceCurrency = input.employeeCompensation.currency;
    directFx = input.employeeCompensation.fxRate;
    directCode = "EMPLOYEE_COMPENSATION";
    directName = "Employee standard compensation";
    directMethod = "employee_compensation";
    directLineId = null;
  } else {
    throw new LaborRateError("No direct labor cost rate matches this employee and work", "missing");
  }

  const directCostRate = dimensions.timeTypeId && !directLine?.timeTypeId
    ? mul(baseDirect, input.timeCostMultiplier)
    : baseDirect;

  const snapshots: LaborRateSnapshotComponent[] = [{
    lane: "direct_cost",
    sourceLineId: directLineId,
    sourceComponentId: null,
    code: directCode,
    name: directName,
    method: directMethod,
    sourceCurrency: directSourceCurrency,
    fxRate: directFx,
    ratePerHour: directCostRate,
    amount: mul(hours, directCostRate),
    sequence: 0,
    explanation: `${directName}: ${directSourceCurrency} hourly rate converted to ${baseCurrency}${dimensions.timeTypeId && !directLine?.timeTypeId ? ` × time-type multiplier ${input.timeCostMultiplier}` : ""}`,
  }];

  const applicableComponents = input.components
    .filter((component) => matchesDimensions(component as unknown as Record<string, unknown>, dimensions))
    .sort((a, b) => a.sequence - b.sequence || a.code.localeCompare(b.code));

  function applyComponents(lane: ComponentLane, starting: string, snapshotLane: "burden" | "bill" | "transfer"): { subtotal: string; added: string } {
    let subtotal = starting;
    const additions: string[] = [];
    let seq = 1;
    for (const component of applicableComponents.filter((c) => c.lane === lane)) {
      let rate: string;
      let fxRate = "1.0000000000";
      let sourceCurrency = baseCurrency;
      if (component.method === "fixed_per_hour") {
        if (!component.currency) throw new LaborRateError(`Component ${component.code} needs a currency`, "configuration");
        const fx = input.fx(component.currency);
        rate = mulRate(component.value, fx.rate);
        fxRate = fx.rate;
        sourceCurrency = component.currency;
      } else if (component.method === "percent_of_base_direct") {
        rate = percentOf(baseDirect, component.value);
      } else if (component.method === "percent_of_direct") {
        rate = percentOf(directCostRate, component.value);
      } else {
        rate = percentOf(subtotal, component.value);
      }
      subtotal = add(subtotal, rate);
      additions.push(rate);
      snapshots.push({
        lane: snapshotLane,
        sourceLineId: null,
        sourceComponentId: component.id,
        code: component.code,
        name: component.name,
        method: component.method,
        sourceCurrency,
        fxRate,
        ratePerHour: rate,
        amount: mul(hours, rate),
        sequence: seq++,
        explanation: component.method === "fixed_per_hour"
          ? `${component.name}: fixed ${sourceCurrency} amount converted to ${baseCurrency}`
          : `${component.name}: ${component.value}% using ${component.method.replaceAll("_", " ")}`,
      });
    }
    return { subtotal, added: sum(additions) };
  }

  const costStack = applyComponents("cost", directCostRate, "burden");
  const costRate = costStack.subtotal;
  const burdenRate = costStack.added;

  const calculateLane = (lane: "bill" | "transfer" | "planning_cost" | "planning_bill", required: boolean): { rate: string | null; line: LaborRateLineInput | null } => {
    const line = chooseLine(input.lines, lane, dimensions);
    if (!line) {
      if (required) throw new LaborRateError(`No ${lane.replaceAll("_", " ")} rate matches this work`, "missing");
      return { rate: null, line: null };
    }
    if (line.method === "fixed") {
      if (line.amount == null) throw new LaborRateError(`Rate ${line.code} needs an amount`, "configuration");
      const fx = input.fx(line.currency);
      let rate = mulRate(divide(line.amount, line.baseHours), fx.rate);
      if (lane === "bill" && dimensions.timeTypeId && !line.timeTypeId) rate = mul(rate, input.timeBillMultiplier);
      return { rate, line };
    }
    if (line.method === "at_cost") return { rate: costRate, line };
    if (line.method === "markup_on_cost") return { rate: add(costRate, percentOf(costRate, line.percent ?? "0")), line };
    return { rate: marginPrice(costRate, line.percent ?? "0"), line };
  };

  const billBase = calculateLane("bill", input.isBillable);
  const billStack = billBase.rate == null ? { subtotal: "0.0000", added: "0.0000" } : applyComponents("bill", billBase.rate, "bill");
  const billRate = billBase.rate == null ? "0.0000" : billStack.subtotal;
  if (billBase.line && billBase.rate != null) {
    const line = billBase.line;
    snapshots.push({
      lane: "bill", sourceLineId: line.id, sourceComponentId: null, code: line.code, name: line.name,
      method: line.method, sourceCurrency: line.currency, fxRate: input.fx(line.currency).rate,
      ratePerHour: billBase.rate, amount: mul(hours, billBase.rate), sequence: 0,
      explanation: `${line.name}: ${line.method.replaceAll("_", " ")}${dimensions.timeTypeId && !line.timeTypeId && line.method === "fixed" ? ` × time-type multiplier ${input.timeBillMultiplier}` : ""}`,
    });
  }

  const transferBase = calculateLane("transfer", false);
  const transferStack = transferBase.rate == null ? { subtotal: "0.0000" } : applyComponents("transfer", transferBase.rate, "transfer");
  const transferRate = transferBase.rate == null ? "0.0000" : transferStack.subtotal;
  if (transferBase.line && transferBase.rate != null) {
    snapshots.push({
      lane: "transfer", sourceLineId: transferBase.line.id, sourceComponentId: null,
      code: transferBase.line.code, name: transferBase.line.name, method: transferBase.line.method,
      sourceCurrency: transferBase.line.currency, fxRate: input.fx(transferBase.line.currency).rate,
      ratePerHour: transferBase.rate, amount: mul(hours, transferBase.rate), sequence: 0,
      explanation: `${transferBase.line.name}: ${transferBase.line.method.replaceAll("_", " ")}`,
    });
  }

  return {
    baseCurrency,
    directCostRate,
    burdenRate,
    costRate,
    billRate,
    transferRate,
    planningCostRate: calculateLane("planning_cost", false).rate,
    planningBillRate: calculateLane("planning_bill", false).rate,
    standardCostAmount: mul(hours, costRate),
    billAmount: mul(hours, billRate),
    components: snapshots.sort((a, b) => a.lane.localeCompare(b.lane) || a.sequence - b.sequence),
  };
}

type SqlExecutor = { execute(query: unknown): Promise<unknown> };

function rows<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

async function fxRateFor(executor: SqlExecutor, orgId: string, from: string, to: string, onDate: string): Promise<{ rate: string; source: string }> {
  if (from === to) return { rate: "1.0000000000", source: "same currency" };
  const direct = rows<{ rate: string; source: string; as_of: string }>(await executor.execute(sql`
    select rate, source, as_of from fx_rates where org_id = ${orgId} and from_currency = ${from} and to_currency = ${to}
      and rate_type = 'spot' and as_of <= ${onDate} order by as_of desc limit 1`))[0];
  if (direct) return { rate: String(direct.rate), source: `${direct.source} ${direct.as_of}` };
  const inverse = rows<{ rate: string; source: string; as_of: string }>(await executor.execute(sql`
    select (1 / rate)::numeric(19,10) as rate, source, as_of from fx_rates where org_id = ${orgId} and from_currency = ${to} and to_currency = ${from}
      and rate_type = 'spot' and as_of <= ${onDate} order by as_of desc limit 1`))[0];
  if (inverse) return { rate: String(inverse.rate), source: `${inverse.source} inverse ${inverse.as_of}` };
  throw new LaborRateError(`No spot FX rate converts ${from} to ${to} on or before ${onDate}`, "missing");
}

/** Resolve the one explainable labor price for a time entry. Pass a Drizzle
 * transaction executor during approval so selection, snapshots, and GL posting
 * share one database transaction. */
export async function resolveLaborRate(input: {
  orgId: string;
  employeePartyId: string;
  projectId?: string | null;
  projectTaskId?: string | null;
  itemId?: string | null;
  timeTypeId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  workedOn: string;
  hours: string;
  isBillable: boolean;
}, executor: SqlExecutor = db as unknown as SqlExecutor): Promise<LaborRateResult> {
  const context = rows<any>(await executor.execute(sql`
    select p.id as project_id, p.customer_id, p.subsidiary_id, p.labor_rate_book_id, p.labor_rate_policy,
           p.labor_rate_locked_version_id, p.labor_rate_lock_date, p.starts_on, p.created_at::date as created_on,
           pt.labor_rate_book_id as project_type_labor_rate_book_id,
           pt.labor_rate_policy as project_type_labor_rate_policy,
           er.worker_comp_group_id, o.base_currency, o.settings,
           coalesce(${input.departmentId ?? null}::uuid, er.department_id) as department_id
      from orgs o
      left join projects p on p.id = ${input.projectId ?? null} and p.org_id = o.id
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = o.id
      left join employee_roles er on er.party_id = ${input.employeePartyId} and er.org_id = o.id and er.is_active
     where o.id = ${input.orgId}`))[0];
  if (!context || (input.projectId && !context.project_id)) {
    throw new LaborRateError("Project or employee context was not found", "missing");
  }

  const classRows = rows<{ labor_class_id: string }>(await executor.execute(sql`
    select labor_class_id from employee_labor_class_assignments
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId} and is_active
       and effective_from <= ${input.workedOn} and (effective_to is null or effective_to >= ${input.workedOn})
     order by is_primary desc, effective_from desc, id limit 2`));
  if (classRows.length > 1) {
    throw new LaborRateError("Employee has overlapping labor-class assignments on the work date", "ambiguous");
  }
  const dimensions: LaborDimensions = {
    employeePartyId: input.employeePartyId,
    laborClassId: classRows[0]?.labor_class_id ?? null,
    itemId: input.itemId ?? null,
    timeTypeId: input.timeTypeId ?? null,
    subsidiaryId: context.subsidiary_id ?? null,
    departmentId: context.department_id ?? null,
    locationId: input.locationId ?? null,
    workerCompGroupId: context.worker_comp_group_id ?? null,
  };

  let bookId: string | null = context.labor_rate_book_id ?? null;
  let assignmentExplanation = bookId ? "Project labor-rate book override" : "";
  if (!bookId) {
    const assignments = rows<any>(await executor.execute(sql`
      select a.*, b.name as book_name,
        ((a.project_task_id is not null)::int * 64 + (a.project_id is not null)::int * 32 +
         (a.customer_id is not null)::int * 16 + (a.subsidiary_id is not null)::int * 8 +
         (a.department_id is not null)::int * 4 + (a.location_id is not null)::int * 2) as specificity
        from item_rate_book_assignments a join item_rate_books b on b.id = a.rate_book_id and b.is_active
       where a.org_id = ${input.orgId} and a.is_active
         and (a.effective_from is null or a.effective_from <= ${input.workedOn})
         and (a.effective_to is null or a.effective_to >= ${input.workedOn})
         and (a.project_task_id is null or a.project_task_id = ${input.projectTaskId ?? null})
         and (a.project_id is null or a.project_id = ${input.projectId ?? null})
         and (a.customer_id is null or a.customer_id = ${context.customer_id})
         and (a.subsidiary_id is null or a.subsidiary_id = ${dimensions.subsidiaryId})
         and (a.department_id is null or a.department_id = ${dimensions.departmentId})
         and (a.location_id is null or a.location_id = ${dimensions.locationId})
       order by a.priority desc, specificity desc, a.effective_from desc nulls last, a.id`));
    if (assignments.length) {
      const top = assignments[0];
      const tied = assignments.filter((a) => Number(a.priority) === Number(top.priority) && Number(a.specificity) === Number(top.specificity));
      const books = new Set(tied.map((a) => a.rate_book_id));
      if (books.size > 1) throw new LaborRateError(`Ambiguous rate-book assignments: ${tied.map((a) => a.name ?? a.book_name).join(", ")}`, "ambiguous");
      bookId = top.rate_book_id;
      assignmentExplanation = top.name || `Matched ${top.book_name} assignment`;
    }
  }
  if (!bookId && context.project_type_labor_rate_book_id) {
    bookId = context.project_type_labor_rate_book_id;
    assignmentExplanation = "Project type labor-rate book default";
  }
  if (!bookId) {
    const defaults = rows<any>(await executor.execute(sql`
      select id, name from item_rate_books where org_id = ${input.orgId} and is_active and is_default order by name`));
    if (defaults.length !== 1) throw new LaborRateError(defaults.length ? "Multiple default rate books are active" : "No labor rate book assignment or default exists", defaults.length ? "ambiguous" : "missing");
    bookId = defaults[0].id;
    assignmentExplanation = "Organization default rate book";
  }
  if (!bookId) throw new LaborRateError("No labor rate book could be selected", "missing");
  const selectedBookId = bookId;

  const companyLaborSettings = (context.settings?.laborCosting ?? {}) as Record<string, unknown>;
  const policy = String(
    context.labor_rate_policy
      ?? context.project_type_labor_rate_policy
      ?? companyLaborSettings.defaultRatePolicy
      ?? "work_date",
  );
  let lockedVersionId: string | null = ["locked", "manual_reprice"].includes(policy) ? context.labor_rate_locked_version_id : null;
  const derivationDate = ["locked", "manual_reprice"].includes(policy)
    ? String(context.labor_rate_lock_date ?? context.starts_on ?? context.created_on ?? input.workedOn)
    : input.workedOn;
  const versionRows = lockedVersionId
    ? rows<any>(await executor.execute(sql`
        select v.id, v.effective_from, b.name as book_name from item_rate_versions v join item_rate_books b on b.id = v.rate_book_id
         where v.id = ${lockedVersionId} and v.org_id = ${input.orgId} and v.rate_book_id = ${selectedBookId} and v.status = 'active'`))
    : rows<any>(await executor.execute(sql`
        select v.id, v.effective_from, b.name as book_name from item_rate_versions v join item_rate_books b on b.id = v.rate_book_id
         where v.org_id = ${input.orgId} and v.rate_book_id = ${selectedBookId} and v.status = 'active'
           and v.effective_from <= ${derivationDate} and (v.effective_to is null or v.effective_to >= ${derivationDate})
         order by v.effective_from desc limit 2`));
  if (versionRows.length > 1) {
    throw new LaborRateError(`Multiple active labor-rate versions cover ${derivationDate}`, "ambiguous");
  }
  const version = versionRows[0];
  if (!version) throw new LaborRateError(`No active labor-rate version covers ${derivationDate}`, "missing");

  const [lineRows, componentRows, compensationRows, timeTypeRows] = await Promise.all([
    executor.execute(sql`select * from labor_rate_lines where org_id = ${input.orgId} and version_id = ${version.id} and is_active order by lane, priority desc, code`),
    executor.execute(sql`select * from labor_rate_components where org_id = ${input.orgId} and version_id = ${version.id} and is_active order by lane, sequence, code`),
    executor.execute(sql`select amount, currency, basis, annual_hours from employee_compensation_rates
      where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId} and is_active
        and effective_from <= ${input.workedOn} and (effective_to is null or effective_to >= ${input.workedOn})
      order by effective_from desc limit 2`),
    executor.execute(sql`select cost_multiplier, bill_multiplier from time_types where id = ${input.timeTypeId ?? null} and org_id = ${input.orgId}`),
  ]);
  const compensation = rows<any>(compensationRows);
  if (compensation.length > 1) throw new LaborRateError("Employee has overlapping compensation rates on the work date", "ambiguous");

  const fxCache = new Map<string, { rate: string; source: string }>();
  const neededCurrencies = new Set<string>([
    ...rows<any>(lineRows).map((r) => r.currency),
    ...rows<any>(componentRows).map((r) => r.currency).filter(Boolean),
    ...compensation.map((r) => r.currency),
  ]);
  for (const currency of neededCurrencies) fxCache.set(currency, await fxRateFor(executor, input.orgId, currency, context.base_currency, input.workedOn));
  const fx = (currency: string) => fxCache.get(currency) ?? { rate: "1.0000000000", source: "same currency" };

  const mapDimensions = (r: any) => ({
    employeePartyId: r.employee_party_id, laborClassId: r.labor_class_id, itemId: r.item_id,
    timeTypeId: r.time_type_id, subsidiaryId: r.subsidiary_id, departmentId: r.department_id,
    locationId: r.location_id, workerCompGroupId: r.worker_comp_group_id,
  });
  const lines: LaborRateLineInput[] = rows<any>(lineRows).map((r) => ({
    id: r.id, code: r.code, name: r.name, lane: r.lane, method: r.method,
    amount: r.amount == null ? null : String(r.amount), percent: r.percent == null ? null : String(r.percent),
    currency: r.currency, baseHours: String(r.base_hours), priority: Number(r.priority), ...mapDimensions(r),
  }));
  const components: LaborRateComponentInput[] = rows<any>(componentRows).map((r) => ({
    id: r.id, code: r.code, name: r.name, lane: r.lane, method: r.method, value: String(r.value),
    currency: r.currency, sequence: Number(r.sequence), ...mapDimensions(r),
  }));
  const comp = compensation[0];
  const employeeCompensation = comp ? {
    hourlyRate: comp.basis === "year" ? divide(String(comp.amount), String(comp.annual_hours)) : String(comp.amount),
    currency: comp.currency,
    fxRate: fx(comp.currency).rate,
  } : null;
  const timeType = rows<any>(timeTypeRows)[0] ?? { cost_multiplier: "1", bill_multiplier: "1" };
  const stack = resolveLaborRateStack({
    dimensions, hours: input.hours, isBillable: input.isBillable, baseCurrency: context.base_currency,
    lines, components, employeeCompensation,
    timeCostMultiplier: String(timeType.cost_multiplier), timeBillMultiplier: String(timeType.bill_multiplier), fx,
  });
  const lockProjectVersion = ["locked", "manual_reprice"].includes(policy) && !context.labor_rate_locked_version_id;
  const resolved = {
    ...stack,
    rateBookId: selectedBookId,
    rateBookName: version.book_name,
    rateVersionId: version.id,
    rateVersionDate: String(version.effective_from),
    assignmentExplanation,
    lockProjectVersion,
  };
  const resolutionHash = createHash("sha256").update(JSON.stringify(resolved)).digest("hex");
  return { ...resolved, resolutionHash };
}

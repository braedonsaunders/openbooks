import {
  add,
  apportion,
  cmp,
  fromUnits,
  mulDecimal,
  mulRate,
  normalizeMoney,
  toUnits,
} from "../money/money.ts";
import {
  decimal8ToFour as dec8ToFour,
  decimal8Units as dec8Units,
  fromDecimal8Units as fromDec8,
} from "./budget-decimal.ts";

/**
 * Quote-to-budget planning: how an awarded quote's lines become project
 * tasks and the budget each task is sold at. Pure and deterministic — no
 * database — so the preview and the award compute exactly the same plan.
 *
 * Money is functional currency: line amounts and line costs convert at the
 * quote's own exchange rate; an item's standard cost is already functional.
 * Hours and production quantities keep eight decimals on each line; a task's
 * hour budget rounds the exact sum to the four decimals the task stores.
 */

export class AwardPlanError extends Error {
  readonly name = "AwardPlanError";
  readonly status = 422;
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

/** One quote line with the catalog facts the plan reads. */
export interface AwardSourceLine {
  lineId: string;
  lineNumber: number;
  description: string | null;
  itemId: string | null;
  itemName: string | null;
  itemKind: string | null;
  itemUnit: string | null;
  unit: string | null;
  /** numeric(28,8) quantity as text. */
  quantity: string;
  /** Net (pre-tax) line amount in the quote currency. */
  amount: string;
  /** Line cost in the quote currency, when the quote carries one. */
  costAmount: string | null;
  /** The item's standard cost per unit (functional), when it has one. */
  itemDefaultCost: string | null;
  /** The quote's exchange rate to functional currency. */
  fxRate: string;
}

export interface AwardTaskSpec {
  key: string;
  code?: string | null;
  name: string;
  /** Add this group's budget to an existing task of the target project. */
  existingTaskId?: string | null;
}

export interface AwardLineMapping {
  lineId: string;
  taskKey: string;
}

export interface AwardPlanInput {
  lines: AwardSourceLine[];
  /** Task groups; omitted means one task per priced line. */
  tasks?: AwardTaskSpec[];
  /** Line → task assignment; required with `tasks`, covering every line. */
  mapping?: AwardLineMapping[];
  /** Operator-supplied total cost (functional) for lines the quote does not cost. */
  lineCosts?: { lineId: string; cost: string }[];
  /** Budget production quantities from each task's non-time lines. */
  productionQuantities?: boolean;
  /** Task codes already used on the target project; defaults skip them. */
  usedCodes?: ReadonlySet<string>;
}

export type AwardCostSource = "line" | "item" | "explicit" | "none" | "missing";

export interface PlannedLine {
  lineId: string;
  lineNumber: number;
  taskKey: string;
  description: string | null;
  itemId: string | null;
  /** Budgeted hours, eight decimals. */
  hours: string;
  /** Production quantity contribution, eight decimals, with its unit. */
  quantity: string | null;
  unit: string | null;
  cost: string;
  /** Functional price after any discount on the same task is spread over it. */
  price: string;
  costSource: AwardCostSource;
}

export interface PlannedTask {
  key: string;
  code: string | null;
  name: string;
  existingTaskId: string | null;
  /** Hour budget as stored on the task (four decimals). */
  hours: string;
  cost: string;
  price: string;
  budgetQuantity: string | null;
  budgetUnit: string | null;
  lineIds: string[];
}

export interface AwardPlan {
  tasks: PlannedTask[];
  lines: PlannedLine[];
  totals: { hours: string; cost: string; price: string };
  /** Priced lines with no cost basis; the award refuses until each has a cost. */
  missingCost: PlannedLine[];
}

/** Units that measure time worked in hours. */
const HOUR_UNITS = new Set([
  "h", "hr", "hrs", "hour", "hours", "hour(s)",
  "manhour", "manhours", "man-hour", "man-hours", "man hour", "man hours",
  "labor hour", "labor hours", "labour hour", "labour hours",
]);

function normalizeUnit(unit: string | null | undefined): string | null {
  if (typeof unit !== "string") return null;
  const u = unit.trim().toLowerCase().replace(/\.$/, "").replace(/\s+/g, " ");
  return u === "" ? null : u;
}

/** True when a unit of measure counts hours. */
export function isHourUnit(unit: string | null | undefined): boolean {
  const u = normalizeUnit(unit);
  return u !== null && HOUR_UNITS.has(u);
}

/**
 * Hours a quote line budgets: its quantity when the item is labor or the
 * line (else the item) is measured in an hour unit; otherwise none. Only a
 * positive quantity on a non-discount line budgets hours.
 */
export function budgetHoursForLine(line: Pick<AwardSourceLine, "itemKind" | "unit" | "itemUnit" | "quantity" | "amount">): string {
  const quantity = dec8Units(line.quantity);
  if (quantity <= 0n || cmp(normalizeMoney(line.amount), "0") < 0) return fromDec8(0n);
  const unit = line.unit && line.unit.trim() !== "" ? line.unit : line.itemUnit;
  if (line.itemKind === "labor" || isHourUnit(unit)) return fromDec8(quantity);
  return fromDec8(0n);
}

function lineLabel(line: AwardSourceLine): string {
  return `line ${line.lineNumber}`;
}

function defaultTaskName(line: AwardSourceLine): string {
  const firstLine = (line.description ?? "").split(/\r?\n/)[0]!.trim();
  const name = firstLine || (line.itemName ?? "").trim() || `Line ${line.lineNumber}`;
  return name.length > 300 ? `${name.slice(0, 299)}…` : name;
}

/** Sequential two-digit codes ("01", "02", …) that skip codes already in use. */
function codeSequence(used: ReadonlySet<string>): () => string {
  let next = 1;
  return () => {
    for (;;) {
      const code = String(next).padStart(2, "0");
      next += 1;
      if (!used.has(code)) return code;
    }
  };
}

/**
 * The default grouping: one task per priced line, in line order. A discount
 * line (negative amount) joins the task of the line before it — the line it
 * discounts — or the next priced line when it comes first.
 */
export function defaultAwardMapping(
  lines: AwardSourceLine[],
  usedCodes: ReadonlySet<string> = new Set(),
): { tasks: AwardTaskSpec[]; mapping: AwardLineMapping[] } {
  const ordered = [...lines].sort((a, b) => a.lineNumber - b.lineNumber);
  const nextCode = codeSequence(usedCodes);
  const tasks: AwardTaskSpec[] = [];
  const mapping: AwardLineMapping[] = [];
  const pending: AwardSourceLine[] = [];
  let current: string | null = null;
  for (const line of ordered) {
    if (cmp(normalizeMoney(line.amount), "0") < 0) {
      if (current) mapping.push({ lineId: line.lineId, taskKey: current });
      else pending.push(line);
      continue;
    }
    const key = `line:${line.lineId}`;
    tasks.push({ key, code: nextCode(), name: defaultTaskName(line), existingTaskId: null });
    mapping.push({ lineId: line.lineId, taskKey: key });
    current = key;
    for (const discount of pending.splice(0)) mapping.push({ lineId: discount.lineId, taskKey: key });
  }
  // Only discounts and no priced line: nothing to group them under; the plan
  // refuses them by name.
  for (const discount of pending) mapping.push({ lineId: discount.lineId, taskKey: "" });
  return { tasks, mapping };
}

function validateTasks(tasks: AwardTaskSpec[]): void {
  const keys = new Set<string>();
  const existing = new Set<string>();
  for (const task of tasks) {
    if (typeof task.key !== "string" || task.key.trim() === "") {
      throw new AwardPlanError("Every task needs a key", "tasks");
    }
    if (keys.has(task.key)) throw new AwardPlanError(`Task key ${JSON.stringify(task.key)} is used twice`, "tasks");
    keys.add(task.key);
    if (typeof task.name !== "string" || task.name.trim() === "") {
      throw new AwardPlanError(`Task ${task.code ?? task.key} needs a name`, "tasks");
    }
    if (task.name.trim().length > 300) {
      throw new AwardPlanError(`Task ${task.code ?? task.key} name must be 300 characters or fewer`, "tasks");
    }
    if (task.code != null && task.code.trim().length > 80) {
      throw new AwardPlanError(`Task code ${task.code} must be 80 characters or fewer`, "tasks");
    }
    if (task.existingTaskId) {
      if (existing.has(task.existingTaskId)) {
        throw new AwardPlanError("Two task groups point at the same existing task — merge them into one group", "tasks");
      }
      existing.add(task.existingTaskId);
    }
  }
}

function lineCost(
  line: AwardSourceLine,
  price: string,
  explicit: Map<string, string>,
): { cost: string; source: AwardCostSource } {
  const supplied = explicit.get(line.lineId);
  if (supplied !== undefined) return { cost: supplied, source: "explicit" };
  if (cmp(price, "0") < 0) return { cost: "0.0000", source: "none" };
  if (line.costAmount !== null) {
    const cost = mulRate(normalizeMoney(line.costAmount), line.fxRate);
    if (cmp(cost, "0") < 0) {
      throw new AwardPlanError(`Quote ${lineLabel(line)} carries a negative cost — correct the quote line's cost before awarding`, "lines");
    }
    return { cost, source: "line" };
  }
  const quantity = dec8Units(line.quantity);
  if (line.itemDefaultCost !== null && quantity > 0n) {
    return { cost: mulDecimal(normalizeMoney(line.itemDefaultCost), fromDec8(quantity)), source: "item" };
  }
  if (cmp(price, "0") === 0) return { cost: "0.0000", source: "none" };
  return { cost: "0.0000", source: "missing" };
}

/**
 * Build the award plan. Refuses (AwardPlanError) a mapping that does not
 * cover every line exactly once, a task with no lines, a discount larger than
 * the priced lines it shares a task with, a negative supplied cost, and mixed
 * production units on one task. Lines without a cost basis are returned in
 * `missingCost` so the preview can ask for them; the award refuses them.
 */
export function planQuoteAward(input: AwardPlanInput): AwardPlan {
  const lines = [...input.lines].sort((a, b) => a.lineNumber - b.lineNumber);
  if (lines.length === 0) throw new AwardPlanError("The quote has no lines to budget — add its priced lines before awarding it");
  const byId = new Map(lines.map((line) => [line.lineId, line]));

  let tasks: AwardTaskSpec[];
  let mapping: AwardLineMapping[];
  if (input.tasks && input.tasks.length > 0) {
    if (!input.mapping) throw new AwardPlanError("Map every quote line to a task", "mapping");
    tasks = input.tasks.map((task) => ({
      key: task.key,
      code: task.code == null || task.code.trim() === "" ? null : task.code.trim(),
      name: typeof task.name === "string" ? task.name.trim() : task.name,
      existingTaskId: task.existingTaskId ?? null,
    }));
    mapping = input.mapping;
  } else {
    if (input.mapping && input.mapping.length > 0) throw new AwardPlanError("Line mappings need their task groups", "tasks");
    ({ tasks, mapping } = defaultAwardMapping(lines, input.usedCodes));
  }
  validateTasks(tasks);
  const taskByKey = new Map(tasks.map((task) => [task.key, task]));

  const assigned = new Map<string, string>();
  for (const entry of mapping) {
    const line = byId.get(entry.lineId);
    if (!line) throw new AwardPlanError("A mapped line is not on this quote — reload the award", "mapping");
    if (assigned.has(entry.lineId)) throw new AwardPlanError(`Quote ${lineLabel(line)} is mapped twice`, "mapping");
    if (!taskByKey.has(entry.taskKey)) {
      throw new AwardPlanError(
        cmp(normalizeMoney(line.amount), "0") < 0
          ? `Quote ${lineLabel(line)} is a discount with no priced line to apply to — map it to the task it discounts`
          : `Quote ${lineLabel(line)} is mapped to a task that is not in the plan`,
        "mapping",
      );
    }
    assigned.set(entry.lineId, entry.taskKey);
  }
  const unmapped = lines.find((line) => !assigned.has(line.lineId));
  if (unmapped) throw new AwardPlanError(`Quote ${lineLabel(unmapped)} is not mapped to a task`, "mapping");

  const explicit = new Map<string, string>();
  for (const entry of input.lineCosts ?? []) {
    const line = byId.get(entry.lineId);
    if (!line) throw new AwardPlanError("A supplied cost names a line that is not on this quote — reload the award", "lineCosts");
    let cost: string;
    try {
      cost = normalizeMoney(entry.cost);
    } catch {
      throw new AwardPlanError(`The cost for quote ${lineLabel(line)} is not an amount`, "lineCosts");
    }
    if (cmp(cost, "0") < 0) throw new AwardPlanError(`The cost for quote ${lineLabel(line)} cannot be negative`, "lineCosts");
    explicit.set(entry.lineId, cost);
  }

  // Price each line in functional currency, then spread each task's
  // discounts across its priced lines in proportion to their price.
  const priced = lines.map((line) => ({ line, price: mulRate(normalizeMoney(line.amount), line.fxRate) }));
  const finalPrice = new Map<string, string>();
  for (const task of tasks) {
    const members = priced.filter((p) => assigned.get(p.line.lineId) === task.key);
    if (members.length === 0) throw new AwardPlanError(`Task ${task.code ?? task.name} has no quote lines — remove it or map a line to it`, "tasks");
    const positives = members.filter((p) => cmp(p.price, "0") > 0);
    const discount = members
      .filter((p) => cmp(p.price, "0") < 0)
      .reduce((acc, p) => acc + toUnits(p.price), 0n);
    for (const p of members) finalPrice.set(p.line.lineId, cmp(p.price, "0") < 0 ? "0.0000" : p.price);
    if (discount === 0n) continue;
    const positiveTotal = positives.reduce((acc, p) => acc + toUnits(p.price), 0n);
    if (positiveTotal + discount < 0n || positives.length === 0) {
      throw new AwardPlanError(
        `The discount on task ${task.code ?? task.name} exceeds the priced lines it applies to — map the discount to the task it discounts`,
        "mapping",
      );
    }
    const shares = apportion(discount, positives.map((p) => toUnits(p.price)));
    positives.forEach((p, i) => finalPrice.set(p.line.lineId, fromUnits(toUnits(p.price) + shares[i]!)));
  }

  const plannedLines: PlannedLine[] = [];
  for (const { line, price } of priced) {
    const { cost, source } = lineCost(line, price, explicit);
    const hours = budgetHoursForLine(line);
    const unit = line.unit && line.unit.trim() !== "" ? line.unit.trim() : line.itemUnit?.trim() || null;
    const quantity = dec8Units(line.quantity);
    const production = input.productionQuantities === true
      && cmp(price, "0") > 0
      && quantity > 0n
      && unit !== null
      && !isHourUnit(unit)
      && line.itemKind !== "labor";
    if (production && unit!.length > 32) {
      throw new AwardPlanError(`Quote ${lineLabel(line)} unit "${unit}" is longer than 32 characters — shorten the unit or leave production quantities off`, "productionQuantities");
    }
    plannedLines.push({
      lineId: line.lineId,
      lineNumber: line.lineNumber,
      taskKey: assigned.get(line.lineId)!,
      description: line.description,
      itemId: line.itemId,
      hours,
      quantity: production ? fromDec8(quantity) : null,
      unit: production ? unit : null,
      cost,
      price: finalPrice.get(line.lineId)!,
      costSource: source,
    });
  }

  const plannedTasks: PlannedTask[] = tasks.map((task) => {
    const members = plannedLines.filter((line) => line.taskKey === task.key);
    const hoursUnits = members.reduce((acc, line) => acc + dec8Units(line.hours), 0n);
    const units = new Map<string, string>();
    let quantityUnits = 0n;
    for (const line of members) {
      if (line.quantity === null || line.unit === null) continue;
      if (!units.has(line.unit.toLowerCase())) units.set(line.unit.toLowerCase(), line.unit);
      quantityUnits += dec8Units(line.quantity);
    }
    if (units.size > 1) {
      throw new AwardPlanError(
        `Task ${task.code ?? task.name} combines lines measured in ${[...units.values()].join(" and ")} — split them into separate tasks or leave production quantities off`,
        "productionQuantities",
      );
    }
    return {
      key: task.key,
      code: task.code ?? null,
      name: task.name,
      existingTaskId: task.existingTaskId ?? null,
      hours: dec8ToFour(hoursUnits),
      cost: members.reduce((acc, line) => add(acc, line.cost), "0.0000"),
      price: members.reduce((acc, line) => add(acc, line.price), "0.0000"),
      budgetQuantity: units.size === 1 ? fromDec8(quantityUnits) : null,
      budgetUnit: units.size === 1 ? [...units.values()][0]! : null,
      lineIds: members.map((line) => line.lineId),
    };
  });

  return {
    tasks: plannedTasks,
    lines: plannedLines,
    totals: {
      hours: fromDec8(plannedLines.reduce((acc, line) => acc + dec8Units(line.hours), 0n)),
      cost: plannedLines.reduce((acc, line) => add(acc, line.cost), "0.0000"),
      price: plannedLines.reduce((acc, line) => add(acc, line.price), "0.0000"),
    },
    missingCost: plannedLines.filter((line) => line.costSource === "missing"),
  };
}

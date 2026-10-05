import { createHash } from "node:crypto";
import { compileExpression as compileExactExpression, ExpressionError, type ExpressionInput } from "../money/expression.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { decimalNullRefusal } from "../money/decimal-refusal.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { assignmentCoveredDays } from "./assignment-windows.ts";
import { compileCompensationRules, compensationRuleDefinitionHash, type CompensationRule, type CompensationRuleComponent, type CompensationRuleDefinition, type CompensationRuleResult, type CompensationRuleSettlement } from "./compensation-rules.ts";
import { PayrollError } from "./error.ts";

function compileExpression(...args: Parameters<typeof compileExactExpression>): ReturnType<typeof compileExactExpression> {
  try { return compileExactExpression(...args); }
  catch (error) { if (error instanceof ExpressionError) throw new PayrollError(error.message); throw error; }
}

export interface CompensationPackageInput extends ExpressionInput {
  readonly source: "constant" | "assignment" | "period_gross" | "period_hours" | "hourly_wage";
  readonly value?: string | boolean;
  readonly minimum?: string;
  readonly maximum?: string;
}
export interface CompensationPackageRule extends CompensationRule {
  /** Proration applies to the result before its declared rounding, never to eligibility conditions. */
  readonly proration: "none" | "calendar_days";
}
export interface CompensationPackageDefinition extends CompensationRuleDefinition {
  readonly inputs: readonly CompensationPackageInput[];
  readonly rules: readonly CompensationPackageRule[];
  readonly partialPeriod: "allow" | "refuse";
}
export interface CompensationPackageEvaluationContext {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly values: Readonly<Record<string, unknown>>;
  readonly occupiedComponentIds: readonly string[];
  readonly replacementComponentIds: readonly string[];
  /** Actual native or replacement amounts, keyed by component, when another package rule depends on them. */
  readonly suppliedComponentAmounts?: Readonly<Record<string, string>>;
}
export interface CompensationPackageEvaluation {
  readonly algorithm: "compensation-package-v1";
  readonly definitionHash: string;
  readonly inputs: Readonly<Record<string, string | boolean>>;
  readonly coveredDays: number;
  readonly periodDays: number;
  readonly partialPeriod: CompensationPackageDefinition["partialPeriod"];
  readonly lines: readonly CompensationRuleResult[];
  readonly suppressedComponentIds: readonly string[];
}

/** Compiled rule validation plus the bounded, explicitly sourced package inputs. */
export function validateCompensationPackage(definition: CompensationPackageDefinition, components: readonly CompensationRuleComponent[]): string {
  compileCompensationRules(definition, components);
  if (!["allow", "refuse"].includes(definition.partialPeriod)) throw new PayrollError("Choose whether this package allows partial pay periods before saving.");
  for (const input of definition.inputs) {
    if (!["constant", "assignment", "period_gross", "period_hours", "hourly_wage"].includes(input.source)) throw new PayrollError(`Package input ${input.name} has no supported source — select a typed native payroll source or an assignment value.`);
    const expected = input.source === "period_gross" ? "money" : input.source === "period_hours" ? "hours" : input.source === "hourly_wage" ? "hourly_rate" : input.type.kind;
    if (input.type.kind !== expected || ("currency" in input.type && input.type.currency !== definition.currency)) throw new PayrollError(`Package input ${input.name} has incompatible units — match its native source and package currency.`);
    if (input.type.kind === "boolean") {
      if (input.minimum !== undefined || input.maximum !== undefined) throw new PayrollError(`Boolean input ${input.name} cannot have decimal bounds — remove its minimum and maximum.`);
    } else {
      for (const bound of ["minimum", "maximum"] as const) {
        if (canonicalDecimal(input[bound], 18) === null) throw new PayrollError(decimalNullRefusal(`Package input ${input.name} ${bound}`, "a decimal bound", input[bound], 18));
        checkedInput({ ...input, minimum: input[bound], maximum: input[bound] }, input[bound]);
      }
      if (compareDecimal(input.minimum!, input.maximum!) > 0) throw new PayrollError(`Package input ${input.name} needs ordered exact decimal bounds — supply its minimum and maximum.`);
    }
    if (input.source === "constant") checkedInput(input, input.value);
    else if (input.value !== undefined) throw new PayrollError(`Package input ${input.name} has a value on a native or assignment source — move the value to its assignment or select a constant.`);
  }
  const declarations: ExpressionInput[] = [...definition.inputs, ...definition.rules.map((rule) => ({ name: rule.key, type: { kind: "money" as const, currency: definition.currency } }))];
  const byKey = new Map(definition.rules.map((rule) => [rule.key, rule]));
  for (const rule of definition.rules) {
    if (!["none", "calendar_days"].includes(rule.proration)) throw new PayrollError(`Package rule ${rule.key} needs an explicit proration policy — choose no proration or calendar days.`);
    if (rule.proration === "none") continue;
    try { compileExpression(`(${rule.expression}) * (9999999 / 9999999)`, declarations); }
    catch (error) {
      if (error instanceof PayrollError) throw new PayrollError(`Package rule ${rule.key} exceeds formula bounds with its declared calendar proration — shorten or simplify the expression before approving it. ${error.message}`);
      throw error;
    }
    const dependencies = new Set<string>();
    const collect = (key: string): void => {
      if (dependencies.has(key)) return;
      dependencies.add(key);
      const dependency = byKey.get(key);
      if (dependency) compileExpression(dependency.expression, declarations).dependencies.forEach(collect);
    };
    compileExpression(rule.expression, declarations).dependencies.forEach(collect);
    for (const key of dependencies) {
      if (byKey.get(key)?.proration === "calendar_days") throw new PayrollError(`Package rule ${rule.key} depends on calendar-prorated rule ${key} — choose no proration on ${rule.key} so the amount is not prorated twice.`);
      const input = definition.inputs.find((candidate) => candidate.name === key);
      if (input && ["period_gross", "period_hours", "hourly_wage"].includes(input.source)) throw new PayrollError(`Package rule ${rule.key} uses native period input ${key} — choose no proration; actual period pay and worked hours already reflect the period.`);
    }
  }
  return compensationPackageDefinitionHash(definition);
}

/** Hash already validated policy or its controlled tenant-reference rebase; this never grants approval or permits use. */
export function compensationPackageDefinitionHash(definition: CompensationPackageDefinition): string {
  return createHash("sha256").update(canonicalJson({ algorithm: "compensation-package-v1", rules: compensationRuleDefinitionHash(definition),
    partialPeriod: definition.partialPeriod,
    proration: definition.rules.map(({ key, proration }) => ({ key, proration })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    inputs: definition.inputs.map((input) => ({ name: input.name, type: "currency" in input.type ? { kind: input.type.kind, currency: input.type.currency } : { kind: input.type.kind },
      source: input.source, ...(input.source === "constant" ? { value: checkedInput(input, input.value) } : {}),
      ...(input.type.kind === "boolean" ? {} : { minimum: canonicalDecimal(input.minimum, 18), maximum: canonicalDecimal(input.maximum, 18) })
    })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) })).digest("hex");
}
function checkedInput(input: CompensationPackageInput, raw: unknown): string | boolean {
  const result = (() => {
    try { return compileExpression(input.name, [input]).evaluate({ [input.name]: raw }, { scale: 18, maxWholeDigits: 15, mode: "half_even" }); }
    catch (error) { if (error instanceof ExpressionError) throw new PayrollError(error.message); throw error; }
  })();
  const value = result.inputs[input.name]!;
  if (typeof value === "string" && (compareDecimal(value, input.minimum!) < 0 || compareDecimal(value, input.maximum!) > 0)) throw new PayrollError(`Package input ${input.name} is outside its approved bounds (${input.minimum} through ${input.maximum}) — correct the assignment or approve a new version.`);
  return value;
}

/** Assignments retain only declared employee-specific values; native wage and period inputs are never overrides. */
export function compensationPackageAssignmentInputs(definition: CompensationPackageDefinition, raw: Readonly<Record<string, unknown>>): Readonly<Record<string, string | boolean>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PayrollError("Package assignment inputs must be declared values — supply its employee-specific inputs.");
  const declarations = definition.inputs.filter((input) => input.source === "assignment");
  for (const key of Object.keys(raw)) if (!declarations.some((input) => input.name === key)) throw new PayrollError(`Package assignment input ${key} is not employee-configurable — remove it; native wage and period values come from payroll.`);
  const result: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
  for (const input of declarations) result[input.name] = checkedInput(input, raw[input.name]);
  return Object.freeze(result);
}

/** Store only declared financial policy; caller metadata never enters approved definitions or evidence. */
export function canonicalCompensationPackageDefinition(definition: CompensationPackageDefinition): CompensationPackageDefinition {
  return {
    orgId: definition.orgId, country: definition.country, currency: definition.currency, partialPeriod: definition.partialPeriod,
    inputs: definition.inputs.map((input) => ({ name: input.name,
      type: "currency" in input.type ? { kind: input.type.kind, currency: input.type.currency } : { kind: input.type.kind },
      source: input.source, ...(input.source === "constant" ? { value: checkedInput(input, input.value) } : {}),
      ...(input.type.kind === "boolean" ? {} : { minimum: canonicalDecimal(input.minimum, 18)!, maximum: canonicalDecimal(input.maximum, 18)! }) })),
    rules: definition.rules.map((rule) => ({ key: rule.key, componentId: rule.componentId, expression: rule.expression, condition: rule.condition ?? null,
      rounding: { scale: rule.rounding.scale, mode: rule.rounding.mode, maxWholeDigits: rule.rounding.maxWholeDigits }, proration: rule.proration })),
  };
}

/** Preview and payroll share the same pure calculation; supplied replacements never receive a second default. */
export function evaluateCompensationPackage(definition: CompensationPackageDefinition, components: readonly CompensationRuleComponent[], context: CompensationPackageEvaluationContext, settlement?: CompensationRuleSettlement): CompensationPackageEvaluation {
  const definitionHash = validateCompensationPackage(definition, components);
  for (const date of [context.periodStart, context.periodEnd, context.effectiveFrom, context.effectiveTo]) if (date !== null && !isIsoCalendarDate(date)) throw new PayrollError("A package calculation needs valid calendar dates — correct the period and assignment window.");
  if (context.periodEnd < context.periodStart || (context.effectiveTo !== null && context.effectiveTo < context.effectiveFrom)) throw new PayrollError("A package window ends before it starts — correct its effective dates.");
  const { coveredDays, periodDays } = assignmentCoveredDays(context);
  const suppressed = new Set([...context.occupiedComponentIds, ...context.replacementComponentIds]);
  const payable = definition.rules.filter((rule) => !suppressed.has(rule.componentId));
  const suppressedComponentIds = definition.rules.filter((rule) => suppressed.has(rule.componentId)).map((rule) => rule.componentId).sort();
  const empty = { algorithm: "compensation-package-v1" as const, definitionHash, coveredDays, periodDays, partialPeriod: definition.partialPeriod, suppressedComponentIds, inputs: {}, lines: [] };
  if (coveredDays === 0 || payable.length === 0) return empty;
  if (definition.partialPeriod === "refuse" && coveredDays !== periodDays) throw new PayrollError("This package requires full-period coverage — align its assignment with the pay period or approve a version that explicitly allows partial periods.");
  // Retain formula dependencies of payable defaults, but do not require unrelated suppressed inputs.
  const inputs: ExpressionInput[] = [...definition.inputs, ...definition.rules.map((rule) => ({ name: rule.key, type: { kind: "money" as const, currency: definition.currency } }))];
  const byKey = new Map(definition.rules.map((rule) => [rule.key, rule]));
  const needed = new Set<string>();
  function retain(rule: CompensationRule): void {
    if (needed.has(rule.key)) return;
    needed.add(rule.key);
    const dependencies = [...compileExpression(rule.expression, inputs).dependencies,
      ...(rule.condition ? compileExpression(rule.condition, inputs).dependencies : [])];
    for (const key of dependencies) if (byKey.has(key)) retain(byKey.get(key)!);
  }
  payable.forEach(retain);
  const rules = definition.rules.filter((rule) => needed.has(rule.key) && !suppressed.has(rule.componentId));
  const suppliedRules = definition.rules.filter((rule) => needed.has(rule.key) && suppressed.has(rule.componentId));
  const declared = definition.inputs.filter((input) => rules.some((rule) =>
    [...compileExpression(rule.expression, inputs).dependencies, ...(rule.condition ? compileExpression(rule.condition, inputs).dependencies : [])].includes(input.name)));
  const suppliedInputs: ExpressionInput[] = suppliedRules.map((rule) => ({ name: rule.key, type: { kind: "money", currency: definition.currency } }));
  const program = compileCompensationRules({ ...definition, inputs: [...declared, ...suppliedInputs], rules: rules.map((rule) => ({ ...rule,
    expression: coveredDays === periodDays || byKey.get(rule.key)!.proration === "none" ? rule.expression : `(${rule.expression}) * (${coveredDays} / ${periodDays})` })) }, components);
  const values: Record<string, string | boolean> = {};
  for (const name of program.requiredInputs) {
    const supplied = suppliedRules.find((rule) => rule.key === name);
    if (supplied) {
      const amount = context.suppliedComponentAmounts?.[supplied.componentId];
      if (amount === undefined) throw new PayrollError(`Package rule ${name} is supplied by another payroll source and a dependent rule needs its actual amount — supply the native replacement amount before calculating this package.`);
      if (canonicalDecimal(amount, 4) === null) throw new PayrollError(decimalNullRefusal(`Replacement for package rule ${name}`, "an amount", amount, 4));
      if (compareDecimal(amount, "0") < 0) throw new PayrollError(`Replacement for package rule ${name} is negative — use a controlled correction instead of a negative package input.`);
      values[name] = amount;
      continue;
    }
    const input = definition.inputs.find((candidate) => candidate.name === name)!;
    try { values[name] = checkedInput(input, input.source === "constant" ? input.value : context.values[name]); }
    catch (error) { throw new PayrollError(`Package input ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const evaluated = program.evaluate(values, settlement ? {
    inputCeilings: Object.fromEntries(Object.entries(settlement.inputCeilings ?? {}).filter(([componentId]) => rules.some(rule => rule.componentId === componentId))),
    amountCaps: Object.fromEntries(Object.entries(settlement.amountCaps ?? {}).filter(([componentId]) => rules.some(rule => rule.componentId === componentId))),
  } : undefined);
  return { ...empty, inputs: evaluated.inputs, lines: evaluated.lines.filter((line) => !suppressed.has(line.componentId)) };
}

export { compensationPackagePattern } from "./compensation-package-pattern.ts";

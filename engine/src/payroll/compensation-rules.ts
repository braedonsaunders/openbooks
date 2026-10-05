import { createHash } from "node:crypto";
import { compileExpression, ExpressionError, type CompiledExpression, type ExpressionInput, type ExpressionRounding } from "../money/expression.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { PayrollError } from "./error.ts";
import { applyBasisCaps, type BasisCapContext } from './limits.ts';

/** Employer component formulas and their explicit rounding policies. */
export interface CompensationRule {
  readonly key: string;
  readonly componentId: string;
  readonly expression: string;
  readonly condition?: string | null;
  readonly rounding: ExpressionRounding;
}

/** Component metadata must be loaded from the organization's authoritative payroll register. */
export interface CompensationRuleComponent {
  readonly orgId: string;
  readonly id: string;
  readonly code: string;
  readonly kind: "earning" | "deduction" | "employer_contribution";
  readonly country: string | null;
  readonly systemKey: string | null;
  readonly isActive: boolean;
}

export interface CompensationRuleDefinition {
  readonly orgId: string;
  readonly country: string;
  readonly currency: string;
  readonly inputs: readonly ExpressionInput[];
  readonly rules: readonly CompensationRule[];
}

export interface CompensationRuleResult {
  readonly key: string;
  readonly componentId: string;
  readonly applicable: boolean;
  readonly amount: string;
  readonly evidence: {
    readonly expression: string;
    readonly condition: string | null;
    readonly rounding: ExpressionRounding;
    readonly amountInputs: Readonly<Record<string, string | boolean>>;
    readonly conditionInputs: Readonly<Record<string, string | boolean>>;
    readonly settlement?: {
      readonly requestedAmount: string;
      readonly amountCaps: CompensationRuleAmountCaps | null;
      readonly inputCeilings: Readonly<Record<string, string>>;
      readonly capRounding: ExpressionRounding | null;
    };
  };
}

/** Native caps may reduce amount inputs and payable money; eligibility keeps the original facts. */
export interface CompensationRuleSettlement {
  readonly inputCeilings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly amountCaps?: Readonly<Record<string, CompensationRuleAmountCaps>>;
}
export interface CompensationRuleAmountCaps {
  readonly hoursCap?: string | null;
  readonly periodCap?: string | null;
  readonly yearCap?: string | null;
  readonly context: BasisCapContext;
}

export interface CompiledCompensationRules {
  readonly definitionHash: string;
  readonly requiredInputs: readonly string[];
  readonly evaluationOrder: readonly string[];
  evaluate(inputs: Readonly<Record<string, unknown>>, settlement?: CompensationRuleSettlement): {
    readonly algorithm: "compensation-rules-v1";
    readonly definitionHash: string;
    readonly inputs: Readonly<Record<string, string | boolean>>;
    readonly lines: readonly CompensationRuleResult[];
  };
}

const MAX_RULES = 64;
const MONEY_ROUNDING: ExpressionRounding = Object.freeze({ scale: 4, mode: "half_away_from_zero", maxWholeDigits: 15 });
type RuleNode = {
  rule: CompensationRule;
  amount: CompiledExpression;
  condition: CompiledExpression | null;
  dependencies: readonly string[];
};

/** Canonical policy identity, independent of mutable component availability; validation remains mandatory before use. */
export function compensationRuleDefinitionHash(definition: CompensationRuleDefinition): string {
  return createHash("sha256").update(canonicalJson({
    algorithm: "compensation-rules-v1", orgId: definition.orgId, country: definition.country, currency: definition.currency,
    inputs: definition.inputs.map((input) => ({ name: input.name, type: "currency" in input.type
      ? { kind: input.type.kind, currency: input.type.currency } : { kind: input.type.kind } })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    rules: definition.rules.map((rule) => ({ key: rule.key, componentId: rule.componentId, expression: rule.expression, condition: rule.condition ?? null,
      rounding: { scale: rule.rounding.scale, mode: rule.rounding.mode, maxWholeDigits: rule.rounding.maxWholeDigits } })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  })).digest("hex");
}

function namedRuleError(key: string, error: unknown): never {
  if (error instanceof ExpressionError) throw new PayrollError(`Compensation rule ${JSON.stringify(key)}: ${error.message}`);
  throw error;
}

/**
 * Compile all amounts and conditions into one deterministic dependency graph.
 * Statutory components stay pack-owned; a formula never replaces a pack amount.
 * Compilation and evaluation are pure. This does not assign packages, grant
 * approval, mutate run inputs, or publish payroll calculation results.
 */
export function compileCompensationRules(
  definition: CompensationRuleDefinition,
  components: readonly CompensationRuleComponent[],
): CompiledCompensationRules {
  if (!definition || !isUuid(definition.orgId)) throw new PayrollError("A compensation rule program needs a valid organization identifier — reload the company context.");
  if (typeof definition.country !== "string" || typeof definition.currency !== "string" || !/^[A-Z]{2}$/.test(definition.country) || !/^[A-Z]{3}$/.test(definition.currency)) {
    throw new PayrollError("A compensation rule program needs a payroll country and currency — select both before configuring its components.");
  }
  if (!Array.isArray(definition.rules) || definition.rules.length < 1 || definition.rules.length > MAX_RULES) {
    throw new PayrollError(`A compensation rule program needs 1 through ${MAX_RULES} rules — add a rule or reduce the package size.`);
  }
  if (!Array.isArray(definition.inputs) || definition.inputs.length > 64) throw new PayrollError("A compensation program can declare at most 64 external inputs — supply a bounded list of typed inputs.");
  if (!Array.isArray(components) || components.length > MAX_RULES) throw new PayrollError(`Supply the authoritative metadata for at most ${MAX_RULES} targeted payroll components — do not pass an unbounded register.`);
  const byComponent = new Map<string, CompensationRuleComponent>();
  for (const component of components) {
    if (!component || !isUuid(component.id)) throw new PayrollError("A compensation component needs a valid identifier — reload its Payroll setup record.");
    if (byComponent.has(component.id)) throw new PayrollError("A payroll component was supplied more than once — reload the authoritative component register.");
    byComponent.set(component.id, component);
  }
  const inputNames = new Set(definition.inputs.map((input) => input?.name));
  const names = new Set<string>();
  const targets = new Set<string>();
  const rules: CompensationRule[] = [];
  for (const rule of definition.rules) {
    if (!rule || typeof rule.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(rule.key) || names.has(rule.key) || inputNames.has(rule.key)) {
      throw new PayrollError("Every compensation rule needs a unique input-style key — do not reuse another rule key or an external input name.");
    }
    names.add(rule.key);
    if (!isUuid(rule.componentId)) throw new PayrollError(`Compensation rule ${JSON.stringify(rule.key)} needs a payroll component — choose one from Payroll setup.`);
    const component = byComponent.get(rule.componentId);
    if (!component || component.orgId !== definition.orgId) throw new PayrollError(`The component for compensation rule ${JSON.stringify(rule.key)} is not visible in this organization — choose a component from its Payroll setup.`);
    if (component.systemKey !== null) throw new PayrollError(`Compensation rule ${JSON.stringify(rule.key)} targets statutory component ${component.code} — statutory amounts remain country-pack-owned; choose a user-defined component.`);
    if (component.isActive !== true) throw new PayrollError(`Compensation rule ${JSON.stringify(rule.key)} targets inactive component ${component.code} — enable it in Payroll setup before using it.`);
    if (!["earning", "deduction", "employer_contribution"].includes(component.kind)) throw new PayrollError(`Compensation rule ${JSON.stringify(rule.key)} targets an unsupported component kind — choose an earning, deduction, or employer contribution.`);
    if (component.country !== null && component.country !== definition.country) {
      throw new PayrollError(`Compensation rule ${JSON.stringify(rule.key)} targets ${component.code} in ${component.country}, while the package belongs to ${definition.country} — choose a component available to this payroll country.`);
    }
    if (targets.has(rule.componentId)) throw new PayrollError(`Payroll component ${component.code} has more than one compensation rule — combine the expressions into a single rule to avoid paying it twice.`);
    targets.add(rule.componentId);
    if (!rule.rounding || !Number.isInteger(rule.rounding.scale) || rule.rounding.scale < 0 || rule.rounding.scale > 4
        || rule.rounding.maxWholeDigits !== 15 || !["half_away_from_zero", "half_even", "towards_zero"].includes(rule.rounding.mode)) {
      throw new PayrollError(`Compensation rule ${JSON.stringify(rule.key)} needs an explicit rounding mode and a scale from 0 through 4 with the ledger's 15-whole-digit limit — correct its rounding policy.`);
    }
    if (rule.condition != null && (typeof rule.condition !== "string" || rule.condition.trim().length === 0)) {
      throw new PayrollError(`Compensation rule ${JSON.stringify(rule.key)} has an empty condition — remove it or enter a boolean expression.`);
    }
    rules.push(Object.freeze({ key: rule.key, componentId: rule.componentId, expression: rule.expression, condition: rule.condition ?? null,
      rounding: Object.freeze({ scale: rule.rounding.scale, mode: rule.rounding.mode, maxWholeDigits: rule.rounding.maxWholeDigits }) }));
  }
  const inputs: ExpressionInput[] = [
    ...definition.inputs,
    ...rules.map((rule): ExpressionInput => ({ name: rule.key, type: { kind: "money", currency: definition.currency } })),
  ];
  const nodes = new Map<string, RuleNode>();
  for (const rule of rules) {
    try {
      const amount = compileExpression(rule.expression, inputs);
      if (amount.resultType.kind !== "money" || amount.resultType.currency !== definition.currency) {
        throw new PayrollError(`Compensation rule ${JSON.stringify(rule.key)} must produce money in ${definition.currency} — multiply a payroll amount by a scalar factor, or hours by a compatible hourly rate.`);
      }
      const condition = rule.condition == null ? null : compileExpression(rule.condition, inputs);
      if (condition && condition.resultType.kind !== "boolean") throw new PayrollError(`The condition for compensation rule ${JSON.stringify(rule.key)} must be boolean — use a comparison or a declared boolean input.`);
      const dependencies = [...new Set([...amount.dependencies, ...(condition?.dependencies ?? [])])].sort();
      nodes.set(rule.key, { rule, amount, condition, dependencies });
    } catch (error) { namedRuleError(rule.key, error); }
  }
  const order: string[] = [];
  const visited = new Set<string>();
  const active: string[] = [];
  function visit(key: string): void {
    if (visited.has(key)) return;
    const cycleAt = active.indexOf(key);
    if (cycleAt !== -1) throw new PayrollError(`Compensation rules form a circular dependency: ${[...active.slice(cycleAt), key].join(" → ")} — remove a reference so each component can be calculated once.`);
    active.push(key);
    for (const dependency of nodes.get(key)!.dependencies) if (nodes.has(dependency)) visit(dependency);
    active.pop(); visited.add(key); order.push(key);
  }
  for (const key of [...nodes.keys()].sort()) visit(key);
  const requiredInputs = Object.freeze([...new Set([...nodes.values()].flatMap((node) => node.dependencies.filter((key) => !nodes.has(key))))].sort());
  const inputValidation = new Map(requiredInputs.map((name) => [name, compileExpression(name, definition.inputs)]));
  const definitionHash = compensationRuleDefinitionHash({ ...definition, rules });
  return Object.freeze({
    definitionHash, requiredInputs, evaluationOrder: Object.freeze(order),
    evaluate(rawInputs: Readonly<Record<string, unknown>>, settlement?: CompensationRuleSettlement) {
      if (!rawInputs || typeof rawInputs !== "object" || Array.isArray(rawInputs)) throw new PayrollError("Compensation rule inputs must be a record of declared values — supply every required input before calculating.");
      for (const componentId of new Set([...Object.keys(settlement?.inputCeilings ?? {}), ...Object.keys(settlement?.amountCaps ?? {})])) {
        if (!targets.has(componentId)) throw new PayrollError('A native compensation cap names an unrelated component — reload the package calculation sources before retrying.');
      }
      const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const inputEvidence: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
      // Caller values cannot override derived components or flow into result evidence unused.
      for (const name of requiredInputs) {
        if (!Object.hasOwn(rawInputs, name) || rawInputs[name] == null) throw new PayrollError(`Compensation input ${JSON.stringify(name)} is missing — supply it before calculating; missing values never become zero.`);
        try {
          const checked = inputValidation.get(name)!.evaluate({ [name]: rawInputs[name] }, { ...MONEY_ROUNDING, scale: 18 });
          values[name] = checked.inputs[name];
          inputEvidence[name] = checked.inputs[name]!;
        } catch (error) {
          if (error instanceof ExpressionError) throw new PayrollError(`Compensation input ${JSON.stringify(name)}: ${error.message}`);
          throw error;
        }
      }
      const lines: CompensationRuleResult[] = [];
      for (const key of order) {
        const node = nodes.get(key)!;
        try {
          const condition = node.condition?.evaluate(values, MONEY_ROUNDING) ?? null;
          const applicable = condition?.value !== false;
          const inputCeilings = settlement?.inputCeilings?.[node.rule.componentId] ?? {};
          const amountValues = { ...values };
          for (const [name, ceiling] of Object.entries(inputCeilings)) {
            const input = definition.inputs.find(input => input.name === name);
            if (!input || !['money', 'hours'].includes(input.type.kind) || !node.amount.dependencies.includes(name)
              || canonicalDecimal(ceiling, 18) === null || compareDecimal(ceiling, '0') < 0) {
              throw new PayrollError(`Compensation rule ${JSON.stringify(key)} has an invalid native basis cap — reload its native money or hours sources before retrying.`);
            }
            if (compareDecimal(values[name] as string, ceiling) > 0) amountValues[name] = ceiling;
          }
          const calculated = applicable ? node.amount.evaluate(amountValues, node.rule.rounding) : null;
          const rawAmount = calculated?.value ?? "0.0000";
          if (typeof rawAmount !== "string") throw new PayrollError(`Compensation rule ${JSON.stringify(key)} produced a boolean amount — correct its expression.`);
          if (compareDecimal(rawAmount, "0") < 0) throw new PayrollError(`Compensation rule ${JSON.stringify(key)} produced a negative amount — correct the rule; use a controlled payroll adjustment for a correction.`);
          // Components feed dependants at their actual payable amount, after their own rounding boundary.
          const configuredCaps = settlement?.amountCaps?.[node.rule.componentId] ?? null;
          const amountCaps = configuredCaps ? Object.freeze({
            hoursCap: configuredCaps.hoursCap ?? null, periodCap: configuredCaps.periodCap ?? null, yearCap: configuredCaps.yearCap ?? null,
            context: Object.freeze({
              ...(configuredCaps.hoursCap != null ? { lines: configuredCaps.context.lines ? Object.freeze(configuredCaps.context.lines.map(line => Object.freeze({ hours: line.hours,
                ...(line.amount !== undefined ? { amount: line.amount } : {}), ...(line.exemptFromHoursCap !== undefined ? { exemptFromHoursCap: line.exemptFromHoursCap } : {}) }))) : undefined } : {}),
              ...(configuredCaps.periodCap != null ? { periodToDate: configuredCaps.context.periodToDate } : {}),
              ...(configuredCaps.yearCap != null ? { yearToDate: configuredCaps.context.yearToDate } : {}),
            }),
          }) : null;
          if (amountCaps?.hoursCap != null && (canonicalDecimal(amountCaps.hoursCap, 4) === null
            || compareDecimal(amountCaps.hoursCap, '0') < 0 || !amountCaps.context.lines)) {
            throw new PayrollError(`Compensation rule ${JSON.stringify(key)} needs its native hours cap and earning lines — reload its payroll basis before retrying.`);
          }
          if (amountCaps) for (const [cap, prior] of [[amountCaps.periodCap, amountCaps.context.periodToDate], [amountCaps.yearCap, amountCaps.context.yearToDate]]) {
            if (cap != null && (canonicalDecimal(cap, 4) === null || compareDecimal(cap, '0') < 0
              || canonicalDecimal(prior, 4) === null || compareDecimal(prior!, '0') < 0)) {
              throw new PayrollError(`Compensation rule ${JSON.stringify(key)} needs its exact native cap and consumed amount — reload its period and opening-inclusive annual limits before retrying; missing consumption never becomes zero.`);
            }
          }
          // The expression has already produced money, so native amount limits use a unit rate of one.
          const settledAmount = amountCaps ? applyBasisCaps({ basis: 'fixed_amount',
            basisCapHoursPerPeriod: amountCaps.hoursCap, basisCapAmountPerPeriod: amountCaps.periodCap,
            basisCapAmountPerYear: amountCaps.yearCap }, rawAmount, amountCaps.context) : rawAmount;
          const capRounding = amountCaps && compareDecimal(settledAmount, rawAmount) < 0
            ? Object.freeze({ ...node.rule.rounding, mode: 'towards_zero' as const }) : null;
          const capped = capRounding ? compileExpression('bounded_amount', [{ name: 'bounded_amount', type: { kind: 'money', currency: definition.currency } }])
            .evaluate({ bounded_amount: settledAmount }, capRounding).value : settledAmount;
          if (typeof capped !== 'string') throw new PayrollError('A native compensation cap did not produce money — reload its payroll calculation sources before retrying.');
          const canonical = fromUnits(toUnits(capped));
          values[key] = canonical;
          lines.push(Object.freeze({
            key, componentId: node.rule.componentId, applicable, amount: canonical,
            evidence: Object.freeze({ expression: node.rule.expression, condition: node.rule.condition ?? null, rounding: node.rule.rounding,
              amountInputs: calculated?.inputs ?? Object.freeze({}), conditionInputs: condition?.inputs ?? Object.freeze({}),
              ...(amountCaps !== null || Object.keys(inputCeilings).length ? { settlement: Object.freeze({ requestedAmount: fromUnits(toUnits(rawAmount)),
                amountCaps, inputCeilings: Object.freeze({ ...inputCeilings }), capRounding }) } : {}) }),
          }));
        } catch (error) { namedRuleError(key, error); }
      }
      return Object.freeze({ algorithm: "compensation-rules-v1" as const, definitionHash, inputs: Object.freeze(inputEvidence), lines: Object.freeze(lines) });
    },
  });
}

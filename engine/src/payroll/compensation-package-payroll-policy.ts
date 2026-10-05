import { compileExpression, type ExpressionInput } from '../money/expression.ts';
import { applyBasisCaps, type BasisCapContext } from './limits.ts';
import { validateCompensationPackage, type CompensationPackageDefinition } from './compensation-package.ts';
import type { CompensationRuleAmountCaps, CompensationRuleComponent, CompensationRuleSettlement } from './compensation-rules.ts';
import { PayrollError } from './error.ts';

function declarations(definition: CompensationPackageDefinition): ExpressionInput[] {
  return [...definition.inputs, ...definition.rules.map(rule => ({ name: rule.key, type: { kind: 'money' as const, currency: definition.currency } }))];
}

export interface CompensationPackagePayrollComponent extends CompensationRuleComponent {
  readonly basis: 'fixed_amount' | 'per_hour' | 'percent_of_gross';
  readonly basisCapHoursPerPeriod: string | null;
  readonly basisCapAmountPerPeriod: string | null;
  readonly basisCapAmountPerYear: string | null;
  readonly protectionBase: string;
  readonly protectionClass: string | null;
}

/** Earnings precede deductions and statutory protection; approved dependencies must respect those boundaries. */
export function validateCompensationPackagePayrollPolicy(definition: CompensationPackageDefinition,
  components: readonly CompensationPackagePayrollComponent[]): void {
  validateCompensationPackage(definition, components);
  const inputs = declarations(definition);
  for (const rule of definition.rules) {
    const component = components.find(component => component.id === rule.componentId)!;
    const amount = compileExpression(rule.expression, inputs);
    const dependencies = new Set([...amount.dependencies, ...(rule.condition ? compileExpression(rule.condition, inputs).dependencies : [])]);
    for (const key of dependencies) {
      const sourceRule = definition.rules.find(rule => rule.key === key);
      if (!sourceRule) continue;
      const sourceComponent = components.find(component => component.id === sourceRule.componentId)!;
      if (component.kind === 'earning' && sourceComponent.kind !== 'earning') {
        throw new PayrollError(`Package earning ${rule.key} depends on ${key}, which is calculated after earnings — use earned amounts as its basis or move the later dependency into a deduction or employer contribution rule.`);
      }
      if (sourceComponent.protectionBase !== 'none' || sourceComponent.protectionClass !== null) {
        throw new PayrollError(`Package rule ${rule.key} depends on protected component ${sourceComponent.code} before statutory protection determines its payable amount — remove that dependency and base this rule on declared earnings or employee inputs.`);
      }
    }
    if (component.basisCapHoursPerPeriod !== null && component.basis !== 'fixed_amount') {
      const requiredSource = component.basis === 'per_hour' ? 'period_hours' : 'period_gross';
      if (!definition.inputs.some(input => input.source === requiredSource && amount.dependencies.includes(input.name))) {
        throw new PayrollError(`Package rule ${rule.key} targets hours-capped component ${component.code} without its native ${requiredSource === 'period_hours' ? 'worked hours' : 'gross pay'} basis — add that native amount input, or choose a fixed-amount component with the intended limits.`);
      }
    }
  }
}

/** Resolve limits from native caps and opening-inclusive consumption; formula output remains exact money. */
export function compensationPackageNativeSettlement(definition: CompensationPackageDefinition,
  components: readonly CompensationPackagePayrollComponent[], values: Readonly<Record<string, string | boolean>>,
  contextFor: (componentId: string) => BasisCapContext): CompensationRuleSettlement {
  validateCompensationPackagePayrollPolicy(definition, components);
  const settlement: { inputCeilings: Record<string, Record<string, string>>; amountCaps: Record<string, CompensationRuleAmountCaps> } = {
    inputCeilings: {}, amountCaps: {},
  };
  const inputs = declarations(definition);
  for (const rule of definition.rules) {
    const component = components.find(component => component.id === rule.componentId)!;
    const context = contextFor(component.id);
    if (component.basisCapHoursPerPeriod !== null && component.basis !== 'fixed_amount') {
      const dependencies = compileExpression(rule.expression, inputs).dependencies;
      for (const input of definition.inputs.filter(input => dependencies.includes(input.name) &&
        input.source === (component.basis === 'per_hour' ? 'period_hours' : 'period_gross'))) {
        const value = values[input.name];
        if (typeof value !== 'string') throw new PayrollError(`Package input ${input.name} needs its native capped basis — reload the payroll calculation sources before retrying.`);
        (settlement.inputCeilings[component.id] ??= {})[input.name] = applyBasisCaps({ basis: component.basis,
          basisCapHoursPerPeriod: component.basisCapHoursPerPeriod }, value, context);
      }
    }
    if (component.basisCapAmountPerPeriod !== null || component.basisCapAmountPerYear !== null
      || component.basis === 'fixed_amount' && component.basisCapHoursPerPeriod !== null) {
      settlement.amountCaps[component.id] = { hoursCap: component.basis === 'fixed_amount' ? component.basisCapHoursPerPeriod : null,
        periodCap: component.basisCapAmountPerPeriod, yearCap: component.basisCapAmountPerYear, context };
    }
  }
  return settlement;
}

/** Approved money must be payable in its registered currency, including every dependent rule result. */
export function validateCompensationPackageCurrencyRounding(definition: CompensationPackageDefinition, minorUnits: number): void {
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
    throw new PayrollError(`Currency ${definition.currency} has no supported payable precision — complete its currency registry before approving or calculating compensation packages.`);
  }
  for (const rule of definition.rules) if (rule.rounding.scale > minorUnits) {
    throw new PayrollError(`Package rule ${rule.key} rounds to ${rule.rounding.scale} places, but ${definition.currency} supports ${minorUnits} — use at most ${minorUnits} decimal places; correct the draft, or approve and assign a replacement version before recalculating.`);
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileCompensationRules, type CompensationRule, type CompensationRuleComponent, type CompensationRuleDefinition } from "./compensation-rules.ts";
import { PayrollError } from "./error.ts";

const orgId = "00000000-0000-0000-0000-000000000001";
const otherOrgId = "00000000-0000-0000-0000-000000000002";
const firstId = "00000000-0000-0000-0000-000000000011";
const secondId = "00000000-0000-0000-0000-000000000012";
const components: CompensationRuleComponent[] = [
  { id: firstId, orgId, code: "ALLOWANCE", kind: "earning", country: "CA", systemKey: null, isActive: true },
  { id: secondId, orgId, code: "BONUS", kind: "earning", country: null, systemKey: null, isActive: true },
];
const rounding = { scale: 2, mode: "half_away_from_zero", maxWholeDigits: 15 } as const;
function rule(key: string, componentId: string, expression: string, condition: string | null = null): CompensationRule {
  return { key, componentId, expression, condition, rounding };
}
function definition(rules: readonly CompensationRule[]): CompensationRuleDefinition {
  return { orgId, country: "CA", currency: "CAD", inputs: [
    { name: "base", type: { kind: "money", currency: "CAD" } },
    { name: "hours", type: { kind: "hours" } },
    { name: "rate", type: { kind: "hourly_rate", currency: "CAD" } },
    { name: "eligible", type: { kind: "boolean" } },
  ], rules };
}
function refuses(action: () => unknown, message: RegExp): void {
  assert.throws(action, (error: unknown) => error instanceof PayrollError && message.test(error.message));
}

test("package rules resolve dependencies independently of definition order", () => {
  const rules = [rule("bonus", secondId, "allowance * 0.1"), rule("allowance", firstId, "hours * rate")];
  const program = compileCompensationRules(definition(rules), components);
  assert.deepEqual(program.evaluationOrder, ["allowance", "bonus"]);
  assert.deepEqual(program.requiredInputs, ["hours", "rate"]);
  const calculated = program.evaluate({ hours: "7.5", rate: "23.45", bonus: "9999", unused: "private" });
  assert.deepEqual(calculated.lines.map((line) => line.amount), ["175.8800", "17.5900"]);
  assert.equal(calculated.lines[1]!.evidence.amountInputs.allowance, "175.88");
  const reversed = compileCompensationRules(definition([...rules].reverse()), [...components].reverse());
  assert.equal(reversed.definitionHash, program.definitionHash);
  assert.deepEqual(reversed.evaluate({ hours: "7.5", rate: "23.45" }), calculated);
});

test('native limits settle before dependent amounts without changing eligibility facts', () => {
  const program = compileCompensationRules(definition([rule('allowance', firstId, 'hours * rate', 'hours >= 8'), rule('bonus', secondId, 'allowance * 0.1')]), components);
  const limits = { inputCeilings: { [firstId]: { hours: '4' } }, amountCaps: { [firstId]: { yearCap: '100', context: { yearToDate: '70.1234' } } } };
  const result = program.evaluate({ hours: '8', rate: '25' }, limits);
  assert.deepEqual(result.lines.map(line => line.amount), ['29.8700', '2.9900']);
  assert.equal(result.lines[0]!.evidence.conditionInputs.hours, '8');
  assert.equal(result.lines[0]!.evidence.amountInputs.hours, '4');
  assert.equal(result.lines[0]!.evidence.settlement!.requestedAmount, '100.0000');
  assert.equal(result.lines[1]!.evidence.amountInputs.allowance, '29.87');
  refuses(() => program.evaluate({ hours: '8', rate: '25' }, { inputCeilings: { [firstId]: { allowance: '0' } } }), /invalid native basis cap.*reload/);
  refuses(() => program.evaluate({ hours: '8', rate: '25' }, { inputCeilings: { [firstId]: { rate: '0' } } }), /invalid native basis cap.*reload/);
  refuses(() => program.evaluate({ hours: '8', rate: '25' }, { amountCaps: { [otherOrgId]: limits.amountCaps[firstId]! } }), /unrelated component.*reload/);
  refuses(() => program.evaluate({ hours: '8', rate: '25' }, { amountCaps: { [firstId]: { yearCap: '100', context: {} } } }), /opening-inclusive.*missing consumption never becomes zero/);
  for (const [scale, expected] of ['29.0000', '29.8000', '29.8800', '29.8800', '29.8800'].entries()) {
    const coarse = compileCompensationRules(definition([{ ...rule('allowance', firstId, 'base'), rounding: { ...rounding, scale } }]), components);
    const line = coarse.evaluate({ base: '200' }, { amountCaps: { [firstId]: { yearCap: '130.0045', context: { yearToDate: '100.1234' } } } }).lines[0]!;
    assert.equal(line.amount, expected, 'cap settlement must respect the component precision without rounding above its remaining room');
    assert.equal(line.evidence.settlement!.capRounding!.mode, 'towards_zero');
  }
});

test("conditional rules leave explicit zero evidence and do not pay an inapplicable component", () => {
  const program = compileCompensationRules(definition([rule("allowance", firstId, "base * 0.1", "eligible")]), components);
  const skipped = program.evaluate({ base: "1000", eligible: false }).lines[0]!;
  assert.equal(skipped.applicable, false);
  assert.equal(skipped.amount, "0.0000");
  assert.deepEqual(skipped.evidence.conditionInputs.eligible, false);
  assert.equal(program.evaluate({ base: "1000", eligible: true }).lines[0]!.amount, "100.0000");
  refuses(() => program.evaluate({ eligible: false }), /"base" is missing.*never become zero/);
  refuses(() => program.evaluate({ base: "12,34", eligible: false }), /as "12.34"/);
});

test("the same line cannot target a statutory or cross-country component", () => {
  const rules = definition([rule("allowance", firstId, "base * 0.1")]);
  refuses(() => compileCompensationRules(rules, [{ ...components[0]!, systemKey: "cpp" }]), /statutory component ALLOWANCE.*country-pack-owned.*user-defined/);
  refuses(() => compileCompensationRules(rules, [{ ...components[0]!, country: "US" }]), /ALLOWANCE in US.*package belongs to CA/);
  refuses(() => compileCompensationRules(rules, [{ ...components[0]!, isActive: false }]), /inactive component ALLOWANCE.*enable/);
  refuses(() => compileCompensationRules(rules, [{ ...components[0]!, orgId: otherOrgId }]), /not visible in this organization/);
  refuses(() => compileCompensationRules(rules, []), /not visible in this organization/);
});

test("duplicate target components and input collisions refuse instead of paying twice", () => {
  refuses(() => compileCompensationRules(definition([rule("first", firstId, "base"), rule("second", firstId, "base")]), components), /ALLOWANCE has more than one compensation rule.*avoid paying it twice/);
  refuses(() => compileCompensationRules(definition([rule("base", firstId, "base")]), components), /do not reuse.*external input name/);
  refuses(() => compileCompensationRules(definition([rule("same", firstId, "base"), rule("same", secondId, "base")]), components), /unique.*key/);
});

test("realistic amount and condition cycles name each participating rule", () => {
  refuses(() => compileCompensationRules(definition([
    rule("commission", firstId, "retention_bonus * 0.1"),
    rule("retention_bonus", secondId, "commission * 0.2"),
  ]), components), /commission → retention_bonus → commission.*remove a reference/);
  refuses(() => compileCompensationRules(definition([
    rule("allowance", firstId, "base", "bonus > 0"), rule("bonus", secondId, "allowance * 0.1"),
  ]), components), /allowance → bonus → allowance/);
  refuses(() => compileCompensationRules(definition([rule("allowance", firstId, "allowance + 1")]), components), /allowance → allowance/);
});

test("formula outputs must be money and conditions must be boolean", () => {
  refuses(() => compileCompensationRules(definition([rule("allowance", firstId, "hours")]), components), /must produce money in CAD/);
  refuses(() => compileCompensationRules(definition([rule("allowance", firstId, "base", "base")]), components), /condition.*must be boolean/);
  refuses(() => compileCompensationRules(definition([rule("allowance", firstId, "unknown_amount")]), components), /rule "allowance".*names "unknown_amount"/);
});

test("negative amounts, zero divisors and decimal commas retain their specific remedies", () => {
  const negative = compileCompensationRules(definition([rule("allowance", firstId, "-base")]), components);
  refuses(() => negative.evaluate({ base: "100" }), /rule "allowance".*negative amount.*controlled payroll adjustment/);
  const division = compileCompensationRules(definition([rule("allowance", firstId, "base / (base / base - 1)")]), components);
  refuses(() => division.evaluate({ base: "100" }), /rule "allowance".*divides by zero.*correct the divisor/);
  const plain = compileCompensationRules(definition([rule("allowance", firstId, "base")]), components);
  refuses(() => plain.evaluate({ base: "12,34" }), /as "12.34"/);
  refuses(() => plain.evaluate({ base: "1,234" }), /could mean 1234.*1.234/);
});

test("program evidence binds source, rounding, identifiers and inputs without retaining caller secrets", () => {
  const source = definition([rule("allowance", firstId, "base * 0.05")]);
  const compiled = compileCompensationRules(source, components);
  const snapshot = compiled.evaluate({ base: "100", password: "private" });
  assert.match(snapshot.definitionHash, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.algorithm, "compensation-rules-v1");
  assert.equal(snapshot.lines[0]!.componentId, firstId);
  assert.equal(snapshot.lines[0]!.evidence.expression, "base * 0.05");
  assert.equal(snapshot.lines[0]!.evidence.rounding.scale, 2);
  assert.equal(Object.hasOwn(snapshot.lines[0]!.evidence.amountInputs, "password"), false);
  assert.equal(snapshot.inputs.base, "100");
  assert.equal(Object.hasOwn(snapshot.inputs, "password"), false);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.lines) && Object.isFrozen(snapshot.lines[0]!.evidence));
  const changed = compileCompensationRules(definition([rule("allowance", firstId, "base * 0.06")]), components);
  assert.notEqual(changed.definitionHash, compiled.definitionHash);
  const differentlyRounded = compileCompensationRules(definition([{ ...source.rules[0]!, rounding: { ...rounding, mode: "half_even" } }]), components);
  assert.notEqual(differentlyRounded.definitionHash, compiled.definitionHash);
});

test("malformed definitions and unbounded programs refuse before evaluation", () => {
  refuses(() => compileCompensationRules(definition([]), components), /1 through 64 rules/);
  refuses(() => compileCompensationRules({ ...definition([rule("allowance", firstId, "base")]), orgId: "invalid" }, components), /valid organization identifier/);
  refuses(() => compileCompensationRules(definition([{ ...rule("allowance", firstId, "base"), rounding: { ...rounding, scale: 5 } }]), components), /scale from 0 through 4/);
  refuses(() => compileCompensationRules(definition([rule("allowance", firstId, "base", " ")]), components), /empty condition.*remove it/);
});

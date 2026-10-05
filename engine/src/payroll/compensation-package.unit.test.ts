import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCompensationPackage, validateCompensationPackage, compensationPackagePattern, type CompensationPackageDefinition } from "./compensation-package.ts";
import { PayrollError } from "./error.ts";

const orgId = "10000000-0000-4000-8000-000000000001";
const componentId = "10000000-0000-4000-8000-000000000002";
const bonusId = "10000000-0000-4000-8000-000000000003";
const rounding = { scale: 2, mode: "half_even" as const, maxWholeDigits: 15 };
const components = [componentId, bonusId].map((id) => ({ orgId, id, code: id === componentId ? "TRAVEL" : "BONUS", kind: "earning" as const, country: "CA", systemKey: null, isActive: true }));
const definition: CompensationPackageDefinition = {
  orgId, country: "CA", currency: "CAD", partialPeriod: "allow",
  inputs: [{ name: "allowance", type: { kind: "money", currency: "CAD" }, source: "assignment", minimum: "0", maximum: "10000" }],
  rules: [{ key: "travel", componentId, expression: "allowance", rounding, proration: "calendar_days" }],
};
const context = { periodStart: "2026-01-01", periodEnd: "2026-01-31", effectiveFrom: "2026-01-16", effectiveTo: null, values: { allowance: "310.00" }, occupiedComponentIds: [], replacementComponentIds: [] };

test("every inclusive assignment slice prices exact calendar coverage before its rounding boundary", () => {
  for (let day = 1; day <= 31; day++) {
    const result = evaluateCompensationPackage(definition, components, { ...context, effectiveFrom: `2026-01-${String(day).padStart(2, "0")}` });
    assert.equal(result.lines[0]!.amount, `${(32 - day) * 10}.0000`);
  }
  assert.equal(evaluateCompensationPackage(definition, components, { ...context, effectiveFrom: "2026-02-01" }).lines.length, 0);
  assert.throws(() => evaluateCompensationPackage({ ...definition, partialPeriod: "refuse" }, components, context), /requires full-period.*align/);
  assert.throws(() => evaluateCompensationPackage(definition, components, { ...context, periodEnd: "2026-02-30" }), /valid calendar dates/);
});

test("proration includes additive literals and leaves eligibility thresholds unchanged", () => {
  const rule = { ...definition.rules[0]!, expression: "allowance + 31", condition: "allowance >= 300" };
  assert.equal(evaluateCompensationPackage({ ...definition, rules: [rule] }, components, context).lines[0]!.amount, "176.0000");
  const fine = { ...context, values: { allowance: "0.01" }, periodEnd: "2026-01-03", effectiveFrom: "2026-01-03" };
  assert.equal(evaluateCompensationPackage({ ...definition, rules: [{ ...rule, expression: "allowance / 2", condition: null, rounding: { ...rounding, scale: 4 } }] }, components, fine).lines[0]!.amount, "0.0017");
});

test("dependent components consume actual rounded pay and cannot prorate it twice", () => {
  const bonus = { key: "bonus", componentId: bonusId, expression: "travel * 10 / 100", rounding, proration: "none" as const };
  const packageDefinition = { ...definition, rules: [...definition.rules, bonus] };
  assert.deepEqual(evaluateCompensationPackage(packageDefinition, components, context).lines.map((line) => line.amount), ["160.0000", "16.0000"]);
  assert.throws(() => validateCompensationPackage({ ...packageDefinition, rules: [...definition.rules, { ...bonus, proration: "calendar_days" }] }, components), /bonus.*travel.*not prorated twice/);
  const replacement = { ...context, replacementComponentIds: [componentId], values: {} };
  assert.throws(() => evaluateCompensationPackage(packageDefinition, components, replacement), /travel.*actual amount.*native replacement/);
  const result = evaluateCompensationPackage(packageDefinition, components, { ...replacement, suppliedComponentAmounts: { [componentId]: "200.00" } });
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0]!.componentId, bonusId);
  assert.equal(result.lines[0]!.amount, "20.0000");
});

test("replacement-only defaults need no missing assignment values and never pay twice", () => {
  for (const field of ["occupiedComponentIds", "replacementComponentIds"] as const) {
    const result = evaluateCompensationPackage(definition, components, { ...context, [field]: [componentId], values: {} });
    assert.equal(result.lines.length, 0);
    assert.deepEqual(result.suppressedComponentIds, [componentId]);
  }
});

test("bounded inputs and component ownership refuse with usable remedies", () => {
  assert.throws(() => evaluateCompensationPackage(definition, components, { ...context, values: { allowance: "10000.01" } }), /allowance.*bound.*correct.*assignment/);
  assert.throws(() => evaluateCompensationPackage(definition, components, { ...context, values: { allowance: "12,34" } }),
    (error: unknown) => error instanceof PayrollError && /write "12,34" as "12.34"/.test(error.message));
  assert.throws(() => evaluateCompensationPackage(definition, components, { ...context, values: {} }), /allowance.*missing/);
  assert.throws(() => validateCompensationPackage({ ...definition, inputs: [{ ...definition.inputs[0]!, minimum: "1,234" }] }, components), /ambiguous/);
  assert.throws(() => validateCompensationPackage(definition, [{ ...components[0]!, systemKey: "base_pay" }]), /statutory.*owned/);
  assert.throws(() => validateCompensationPackage(definition, [{ ...components[0]!, orgId: bonusId }]), /not visible.*organization/);
  const longest = "allowance" + " ".repeat(4096 - "allowance".length);
  assert.ok(validateCompensationPackage({ ...definition, rules: [{ ...definition.rules[0]!, expression: longest, proration: "none" }] }, components));
  assert.throws(() => validateCompensationPackage({ ...definition, rules: [{ ...definition.rules[0]!, expression: longest }] }, components), /declared calendar proration.*shorten or simplify/);
});

test("native worked hours and pay cannot receive a second calendar fraction", () => {
  const hourly: CompensationPackageDefinition = { ...definition,
    inputs: [{ name: "hours", type: { kind: "hours" }, source: "period_hours", minimum: "0", maximum: "1000" },
      { name: "wage", type: { kind: "hourly_rate", currency: "CAD" }, source: "hourly_wage", minimum: "0", maximum: "10000" }],
    rules: [{ ...definition.rules[0]!, expression: "hours * wage", proration: "none" }] };
  assert.equal(evaluateCompensationPackage(hourly, components, { ...context, values: { hours: "4.5", wage: "25.1234" } }).lines[0]!.amount, "113.0600");
  assert.throws(() => validateCompensationPackage({ ...hourly, rules: [{ ...hourly.rules[0]!, proration: "calendar_days" }] }, components), /native period input.*no proration/);
});

test("hashes use canonical declared policy and patterns share the formula language", () => {
  const hash = validateCompensationPackage(definition, components);
  const equivalent = { ...definition, ignored: "not financial policy", inputs: [{ ...definition.inputs[0]!, minimum: "0.00", ignored: "metadata" }] };
  assert.equal(validateCompensationPackage(equivalent, components), hash);
  assert.notEqual(validateCompensationPackage({ ...definition, rules: [{ ...definition.rules[0]!, proration: "none" }] }, components), hash);
  assert.equal(compensationPackagePattern({ pattern: "percentage", amountInput: "base", factorInput: "percent" }), "base * percent / 100");
  assert.throws(() => compensationPackagePattern({ pattern: "hourly", amountInput: "wage" }), /factor input/);
});

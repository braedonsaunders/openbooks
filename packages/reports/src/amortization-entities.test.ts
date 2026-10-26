import assert from "node:assert/strict";
import test from "node:test";
import { AMORTIZATION_REPORT_ENTITIES } from "./amortization-entities";
import { REPORT_ENTITY_MAP } from "./entities";
import { BUILT_IN_REPORT_DEFINITION_MAP } from "./built-ins";
import { validateCustomQuery } from "./validate";
import { compileCustomQuery } from "./custom-query";

const ORG = "00000000-0000-4000-8000-000000000001";

test("amortization reports are gated, org-bounded and scoped to entity and book", () => {
  assert.equal(AMORTIZATION_REPORT_ENTITIES.length, 2);
  for (const entity of AMORTIZATION_REPORT_ENTITIES) {
    assert.equal(REPORT_ENTITY_MAP[entity.key], entity);
    assert.equal(entity.requiredPermission, "amortization.read");
    assert.equal(entity.featureKey, "expenseAmortization");
    assert.ok(entity.subsidiaryScope?.column, `${entity.key} carries a subsidiary boundary`);
    assert.ok(entity.bookScope?.column, `${entity.key} carries a book boundary`);
    const definition = BUILT_IN_REPORT_DEFINITION_MAP[entity.key.replaceAll("_", "-")];
    assert.ok(definition, entity.key);
    const compiled = compileCustomQuery(entity, validateCustomQuery(definition.query), ORG);
    assert.match(compiled.text, new RegExp(entity.orgColumn.replace(".", "\\.")));
  }
});

test("the waterfall summarizes amortized against scheduled amounts by month", () => {
  const waterfall = BUILT_IN_REPORT_DEFINITION_MAP["prepaid-expense-waterfall"];
  assert.ok(waterfall);
  const query = validateCustomQuery(waterfall.query);
  assert.equal(query.entity, "prepaid_amortization_plan");
  const compiled = compileCustomQuery(REPORT_ENTITY_MAP.prepaid_amortization_plan!, query, ORG);
  // Superseded and cancelled plan lines never reach the waterfall.
  assert.match(compiled.text, /l\.status/);
  assert.deepEqual(
    waterfall.query.measures?.map((measure) => measure.column),
    ["amortized", "scheduled"],
  );
});

test("the reconciliation sets ledger movements beside schedule movements and their difference", () => {
  const definition = BUILT_IN_REPORT_DEFINITION_MAP["prepaid-expense-reconciliation"];
  assert.ok(definition);
  const entity = REPORT_ENTITY_MAP.prepaid_amortization_reconciliation!;
  const difference = entity.columns.find((column) => column.key === "difference");
  assert.equal(difference?.expr, "r.ledger_amount - r.subledger_amount");
  // Reversed entries stay in: their reversals are separate posted entries.
  assert.match(entity.from, /je\.status in \('posted','reversed'\)/);
  // Posted plan lines relieve the subledger on their posting date.
  assert.match(entity.from, /-l\.planned_amount/);
  const compiled = compileCustomQuery(entity, validateCustomQuery(definition.query), ORG);
  assert.match(compiled.text, /r\.org_id/);
});

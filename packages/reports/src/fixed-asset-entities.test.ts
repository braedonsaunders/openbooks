import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_ASSET_REPORT_ENTITIES } from "./fixed-asset-entities";
import { REPORT_ENTITY_MAP } from "./entities";
import { BUILT_IN_REPORT_DEFINITION_MAP } from "./built-ins";
import { validateCustomQuery } from "./validate";
import { compileCustomQuery } from "./custom-query";

const ORG = "00000000-0000-4000-8000-000000000001";

test("fixed-asset reports are native, permissioned, feature-gated and entity-scoped", () => {
  const features: Record<string, string> = {
    fixed_asset_register: "fixedAssets",
    fixed_asset_rollforward: "fixedAssets",
    fixed_asset_depreciation_forecast: "fixedAssets",
    asset_proposals: "assetProposals",
    asset_maintenance_due: "assetMaintenance",
    asset_insured_values: "assetInsurance",
    asset_cip_costs: "constructionInProgress",
  };
  assert.deepEqual(
    FIXED_ASSET_REPORT_ENTITIES.map((entity) => entity.key).sort(),
    Object.keys(features).sort(),
  );
  for (const entity of FIXED_ASSET_REPORT_ENTITIES) {
    assert.equal(REPORT_ENTITY_MAP[entity.key], entity);
    assert.equal(entity.requiredPermission, "assets.read");
    assert.equal(entity.featureKey, features[entity.key]);
    assert.ok(entity.subsidiaryScope?.column, `${entity.key} scopes by legal entity`);
    assert.equal(entity.baseCurrencyColumn, "base_currency");
    for (const column of entity.columns.filter((candidate) => candidate.kind === "money")) {
      assert.equal(
        column.baseMoney,
        true,
        `${entity.key}.${column.key} is functional-currency money`,
      );
    }
  }
});

test("every fixed-asset built-in validates and compiles against its tenant boundary", () => {
  for (const slug of [
    "fixed-asset-register",
    "fixed-asset-roll-forward",
    "depreciation-roll-forward",
    "depreciation-forecast",
    "asset-proposals-pending",
    "asset-maintenance-due",
    "insured-value-vs-net-book-value",
    "construction-in-progress-costs",
  ]) {
    const definition = BUILT_IN_REPORT_DEFINITION_MAP[slug];
    assert.ok(definition, slug);
    const entity = REPORT_ENTITY_MAP[definition.query.entity];
    assert.ok(entity, slug);
    const validated = validateCustomQuery(definition.query);
    // The web executor resolves fiscal period presets to dates before compiling.
    const windowed = JSON.stringify(validated.filters ?? null).includes("period_preset");
    const compiled = compileCustomQuery(
      entity,
      windowed ? { ...validated, filters: null } : validated,
      ORG,
      { asOf: "2026-07-31" },
    );
    assert.match(compiled.text, new RegExp(entity.orgColumn.replace(".", "\\.")), slug);
  }
});

test("the roll-forward balances open and close semi-additively and sum only movements", () => {
  const rollforward = REPORT_ENTITY_MAP.fixed_asset_rollforward!;
  assert.equal(rollforward.timeKey, "month");
  assert.equal(rollforward.bookScope?.column, "rf.book_id");
  for (const key of [
    "cost_opening",
    "cost_closing",
    "accumulated_opening",
    "accumulated_closing",
  ]) {
    assert.equal(
      rollforward.columns.find((column) => column.key === key)?.snapshot,
      true,
      `${key} is a balance, never summed`,
    );
  }
  for (const key of [
    "additions",
    "transfers",
    "disposals",
    "capitalized",
    "depreciation",
    "remeasurement",
  ]) {
    assert.notEqual(
      rollforward.columns.find((column) => column.key === key)?.snapshot,
      true,
      `${key} is a movement`,
    );
  }
  const plan = BUILT_IN_REPORT_DEFINITION_MAP["fixed-asset-roll-forward"]!.query;
  assert.ok(plan.measures);
  assert.deepEqual(
    plan.measures.map((measure) => measure.fn),
    ["opening", "sum", "sum", "sum", "sum", "closing"],
  );
});

test("point-in-time reports bind the report date and refuse to run without one", () => {
  for (const key of ["asset_maintenance_due", "asset_insured_values"]) {
    const entity = REPORT_ENTITY_MAP[key]!;
    const definition = Object.values(BUILT_IN_REPORT_DEFINITION_MAP).find(
      (candidate) => candidate.query.entity === key,
    )!;
    const validated = validateCustomQuery(definition.query);
    assert.throws(() => compileCustomQuery(entity, validated, ORG, {}), /asOf/);
  }
});

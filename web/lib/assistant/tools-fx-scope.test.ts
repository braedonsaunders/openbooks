import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const fx = read("./tools-fx.ts");
const catalog = read("../application/tool-catalog.ts");
const engine = read("../../../engine/src/fx-revaluation.ts");

// FX reads reuse the tables the close/consolidation engine reads — never a
// parallel rate source. Rates are exact numeric strings, never floats.
test("fx tools read the engine rate tables with exact decimals", () => {
  assert.match(fx, /name: "list_currencies"/);
  assert.match(fx, /name: "list_fx_rates"/);
  assert.match(fx, /name: "list_fx_revaluations"/);
  assert.match(fx, /name: "get_consolidation_view"/);
  assert.match(fx, /from currencies/);
  assert.match(fx, /from fx_rates/);
  assert.match(fx, /fx_revaluation/);
  assert.match(fx, /from consolidated_fx_rates/);
  assert.match(fx, /ownership_consolidation_runs/);
  assert.ok(engine.includes("origin='fx_revaluation'"), "revaluation entries carry the fx_revaluation origin");
});

// The rates table has no single-entity viewer page: it feeds revaluation
// (close/gl) and settlement. The read gate admits exactly those two.
test("fx rate reads match the revaluation permission boundary", () => {
  assert.match(fx, /perms: \["gl\.read", "close\.read"\]/);
  assert.match(fx, /feature: "multiCurrency"/);
  const consolidation = fx.slice(fx.indexOf('name: "get_consolidation_view"'));
  assert.match(consolidation, /feature: "multiSubsidiary"/);
  assert.match(fx, /import \{ closeScopeDenied \} from "\.\/tools-close"/);
  assert.match(consolidation, /closeScopeDenied\(authz\)/);
});

// Revaluation entries are posted journal entries: subsidiary-scoped like
// every other journal read, with aggregates over all matches.
test("revaluation listing carries subsidiary scoping and aggregates", () => {
  const list = fx.slice(fx.indexOf('name: "list_fx_revaluations"'));
  assert.match(list, /subsidiaryVisibleFilter\(sql`e\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(list, /sumDebits/);
});

test("run_revaluation is registered as a governed close action", () => {
  assert.ok(catalog.includes('name: "run_revaluation"'), "catalog must register run_revaluation");
  const block = catalog.slice(catalog.indexOf('name: "run_revaluation"'));
  assert.match(block, /featureKey: "multiCurrency"/);
  assert.match(block, /assistantConfirmation: "always"/);
  assert.match(block, /idempotencyKey: IDEMPOTENCY_KEY/);
  assert.match(block, /close\.run/);
});

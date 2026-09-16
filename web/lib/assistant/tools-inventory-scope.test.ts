import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tools = read("./tools-inventory.ts");

test("inventory tools expose the item catalog under the items.read gate with no feature fence", () => {
  const search = tools.slice(tools.indexOf('name: "search_items"'), tools.indexOf('name: "get_item"'));
  assert.match(search, /perms: \["items\.read"\]/);
  assert.doesNotMatch(search, /feature:/);
  const get = tools.slice(tools.indexOf('name: "get_item"'), tools.indexOf('name: "inventory_levels"'));
  assert.match(get, /perms: \["items\.read"\]/);
  assert.doesNotMatch(get, /feature:/);
});

test("stock reads declare the inventory feature and fail closed while it is off", () => {
  for (const name of ["inventory_levels", "inventory_movements", "inventory_writedowns"]) {
    const start = tools.indexOf(`name: "${name}"`);
    assert.ok(start >= 0, `missing tool ${name}`);
    const section = tools.slice(start, tools.indexOf("export const INVENTORY_TOOLS"));
    assert.match(section, /feature: "inventory"/);
    assert.match(section, /isFeatureEnabled\(authz\.user\.orgId, "inventory"\)/);
    assert.match(section, /inventory_feature_disabled/);
  }
});

test("every stock query carries the caller subsidiary allowlist", () => {
  assert.match(tools, /subsidiaryVisibleFilter\(sql`m\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /subsidiaryVisibleFilter\(sql`w\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
});

test("get_item reuses the catalog drawer's loader, not a parallel query", () => {
  assert.match(tools, /import \{ loadItem \} from "\.\.\/\.\.\/app\/api\/items\/_lib"/);
  assert.match(tools, /await loadItem\(a\.id, authz\.user\.orgId\)/);
});

test("inventory lists return aggregates over all matches plus capped rows", () => {
  assert.match(tools, /sumTotal|sumQuantity|sumValue|sumAmount/);
  assert.match(tools, /truncated/);
  assert.match(tools, /href: "\/inventory"/);
});

test("money leaves inventory tools as canonical decimal strings", () => {
  assert.match(tools, /normalizeMoney/);
});

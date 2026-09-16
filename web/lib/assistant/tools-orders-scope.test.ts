import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tools = read("./tools-orders.ts");

test("order tools declare the orders feature and fail closed while it is off", () => {
  for (const name of ["search_orders", "get_order"]) {
    const start = tools.indexOf(`name: "${name}"`);
    assert.ok(start >= 0, `missing tool ${name}`);
    const section = tools.slice(start, tools.indexOf("export const ORDERS_TOOLS"));
    assert.match(section, /feature: "orders"/);
    assert.match(section, /isFeatureEnabled\(authz\.user\.orgId, "orders"\)/);
    assert.match(section, /orders_feature_disabled/);
  }
});

test("order reads keep the sales/purchase permission split of the _order handlers", () => {
  assert.match(tools, /kind === "purchase_order" \? "ap\.read" : "ar\.read"/);
  assert.match(tools, /gate: \{ mode: "anyOf", perms: \["ar\.read", "ap\.read"\] \}/);
  assert.match(tools, /if \(a\.kind && !can\(authz, kindPerm\(a\.kind\)\)\) return \{ ok: false, error: "forbidden" \}/);
});

test("get_order reuses the drawer loader and the exact quantity math", () => {
  assert.match(tools, /import \{ loadOrder \} from "\.\.\/\.\.\/api\/_order\/lib"/);
  assert.match(tools, /await loadOrder\(a\.id, authz\.user\.orgId, a\.kind, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /billableRemainderQuantityUnits/);
  assert.match(tools, /toQuantityUnits/);
  assert.match(tools, /fromQuantityUnits/);
});

test("order search scopes to visible subsidiaries and pages with backlog totals", () => {
  assert.match(tools, /subsidiaryVisibleFilter\(sql`d\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /backlogTotal/);
  assert.match(tools, /truncated/);
  assert.match(tools, /fulfilment/);
  assert.match(tools, /normalizeMoney/);
});

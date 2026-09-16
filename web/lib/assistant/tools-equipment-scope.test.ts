import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tools = read("./tools-equipment.ts");

test("equipment tools declare the equipment feature and fail closed while it is off", () => {
  for (const name of ["search_equipment", "get_equipment"]) {
    const start = tools.indexOf(`name: "${name}"`);
    assert.ok(start >= 0, `missing tool ${name}`);
    const section = tools.slice(start, tools.indexOf("export const EQUIPMENT_TOOLS"));
    assert.match(section, /feature: "equipment"/);
    assert.match(section, /isFeatureEnabled\(authz\.user\.orgId, "equipment"\)/);
    assert.match(section, /equipment_feature_disabled/);
  }
});

test("equipment reads use the assets.read gate from the equipment routes", () => {
  assert.match(tools, /perms: \["assets\.read"\]/);
  assert.doesNotMatch(tools, /assets\.manage/);
});

test("get_equipment reuses the drawer loader and mirrors the route's subsidiary fence", () => {
  assert.match(tools, /import \{ loadEquipment \} from "\.\.\/\.\.\/app\/api\/equipment\/_lib"/);
  assert.match(tools, /await loadEquipment\(a\.id, authz\.user\.orgId\)/);
  assert.match(tools, /allowedSubsidiaryIds\.has\(String\(.*subsidiary_id\)\)/);
});

test("register search carries the subsidiary allowlist and mirrors the page KPIs", () => {
  assert.match(tools, /subsidiaryVisibleFilter\(sql`e\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /sumPurchasePrice/);
  assert.match(tools, /project_charge/);
  assert.match(tools, /truncated/);
  assert.match(tools, /normalizeMoney/);
});

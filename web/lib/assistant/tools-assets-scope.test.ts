import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tools = read("./tools-assets.ts");

test("asset tools declare the fixedAssets feature and fail closed while it is off", () => {
  for (const name of ["search_assets", "get_asset", "asset_tax_pools"]) {
    const start = tools.indexOf(`name: "${name}"`);
    assert.ok(start >= 0, `missing tool ${name}`);
    const section = tools.slice(start, tools.indexOf("export const ASSETS_TOOLS"));
    assert.match(section, /feature: "fixedAssets"/);
    assert.match(section, /isFeatureEnabled\(authz\.user\.orgId, "fixedAssets"\)/);
    assert.match(section, /fixedAssets_feature_disabled/);
  }
});

test("asset reads use the assets.read gate from the asset routes", () => {
  assert.match(tools, /perms: \["assets\.read"\]/);
  assert.doesNotMatch(tools, /assets\.manage/);
});

test("get_asset reuses the drawer loader and mirrors the route's subsidiary fence", () => {
  assert.match(tools, /import \{ loadAsset \} from "\.\.\/\.\.\/app\/api\/assets\/_lib"/);
  assert.match(tools, /await loadAsset\(a\.id, authz\.user\.orgId/);
  assert.match(tools, /!\s*authz\.allowedSubsidiaryIds\.has\(String\(payload\.asset\.subsidiary_id\)\)/);
});

test("register search carries the subsidiary allowlist and totals cost plus NBV", () => {
  assert.match(tools, /subsidiaryVisibleFilter\(sql`f\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /sumNetBookValue/);
  assert.match(tools, /disposed', 'written_off'/);
  assert.match(tools, /truncated/);
});

test("tax pools mirror the tax-pools route scoping and money stays canonical", () => {
  assert.match(tools, /subsidiaryVisibleFilter\(sql`tp\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /tax_pool_periods/);
  assert.match(tools, /normalizeMoney/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tools = read("./tools-assets.ts");

test("asset tools declare the fixedAssets feature and fail closed while it is off", () => {
  for (const name of ["search_assets", "get_asset", "asset_tax_pools", "search_lease_agreements", "get_lease_agreement"]) {
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
  assert.match(tools, /left join asset_book_carrying_values dep on dep\.org_id=f\.org_id and dep\.asset_id=f\.id/);
  assert.match(tools, /dep\.carrying_value as "netBookValue"/);
  assert.match(tools, /sum\(dep\.carrying_value\)/);
  const basisView = read("../../../schema/migrations/generated/0204_asset_lifecycle_changes.sql");
  assert.match(basisView, /CASE WHEN a\.status IN\('disposed','written_off'\) THEN 0 ELSE[^\n]+ END AS carrying_value/);
  assert.match(tools, /truncated/);
});

test("tax pools mirror the tax-pools route scoping and money stays canonical", () => {
  assert.match(tools, /subsidiaryVisibleFilter\(sql`tp\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /tax_pool_periods/);
  assert.match(tools, /normalizeMoney/);
  assert.match(tools, /pp\.tax_year_window_id as "taxYearWindowId"/);
  assert.match(tools, /pp\.year_start::text as "yearStart"/);
  assert.match(tools, /pp\.year_end::text as "yearEnd"/);
  assert.match(tools, /tp\.subsidiary_id as "subsidiaryId"/);
});

test("lessee reads use the native scoped lease loader and the actual lease register", () => {
  assert.match(tools, /from lease_agreements la where \$\{predicate\}/);
  assert.match(tools, /la\.org_id=\$\{authz\.user\.orgId\}/);
  assert.match(tools, /subsidiaryVisibleFilter\(sql`la\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /await loadLease\(authz\.user\.orgId, input\.id, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /if \(!payload\) return \{ ok: false, error: "not found" \}/);
});

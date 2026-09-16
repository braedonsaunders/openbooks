import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tools = read("./tools-subcontracts.ts");

test("subcontract tools require projects plus subcontracts and fail closed", () => {
  for (const name of ["search_subcontracts", "get_subcontract"]) {
    const start = tools.indexOf(`name: "${name}"`);
    assert.ok(start >= 0, `missing tool ${name}`);
    const section = tools.slice(start, tools.indexOf("export const SUBCONTRACTS_TOOLS"));
    assert.match(section, /feature: "subcontracts"/);
    assert.match(section, /subcontractsEnabled\(authz\.user\.orgId\)/);
    assert.match(section, /subcontracts_feature_disabled/);
  }
  const helper = tools.slice(tools.indexOf("async function subcontractsEnabled"), tools.indexOf("const searchSubcontracts"));
  assert.match(helper, /isFeatureEnabled\(orgId, "projects"\)/);
  assert.match(helper, /isFeatureEnabled\(orgId, "subcontracts"\)/);
});

test("wip tools require projects plus wipBilling and fail closed", () => {
  for (const name of ["list_wip_prebills", "get_wip_prebill", "wip_analytics"]) {
    const start = tools.indexOf(`name: "${name}"`);
    assert.ok(start >= 0, `missing tool ${name}`);
    const section = tools.slice(start, tools.indexOf("export const SUBCONTRACTS_TOOLS"));
    assert.match(section, /feature: "wipBilling"/);
    assert.match(section, /wipBillingEnabled\(authz\.user\.orgId\)/);
    assert.match(section, /wipBilling_feature_disabled/);
  }
});

test("subcontract reads keep the route's permission split and project-subsidiary scope", () => {
  const search = tools.slice(tools.indexOf('name: "search_subcontracts"'), tools.indexOf('name: "get_subcontract"'));
  assert.match(search, /perms: \["ap\.read"\]/);
  const get = tools.slice(tools.indexOf('name: "get_subcontract"'), tools.indexOf('name: "list_wip_prebills"'));
  assert.match(get, /perms: \["ap\.read"\]/);
  assert.match(tools, /subsidiaryVisibleFilter\(sql`p\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /allowedSubsidiaryIds\.has\(String\(projectSubsidiaryId\)\)/);
  const prebills = tools.slice(tools.indexOf('name: "list_wip_prebills"'), tools.indexOf('name: "get_wip_prebill"'));
  assert.match(prebills, /perms: \["projects\.read"\]/);
  const analytics = tools.slice(tools.indexOf('name: "wip_analytics"'), tools.indexOf("export const SUBCONTRACTS_TOOLS"));
  assert.match(analytics, /perms: \["reports\.read"\]/);
});

test("wip reads reuse the governed wip-billing library, not parallel SQL", () => {
  assert.match(tools, /import \{ listPrebills, loadPrebill, wipAnalytics \} from "\.\.\/wip-billing"/);
  assert.match(tools, /await listPrebills\(authz\.user\.orgId, a\.projectId, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /await loadPrebill\(authz\.user\.orgId, a\.id, authz\.allowedSubsidiaryIds\)/);
  assert.match(tools, /await wipAnalytics\(authz\.user\.orgId, a\.asOf, authz\.allowedSubsidiaryIds\)/);
});

test("subcontract lists total commitment, billing, and retainage over all matches", () => {
  assert.match(tools, /sumRevisedCommitment/);
  assert.match(tools, /sumBilledToDate/);
  assert.match(tools, /sumRetainageWithheld/);
  assert.match(tools, /truncated/);
  assert.match(tools, /normalizeMoney/);
});

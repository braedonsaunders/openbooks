import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("./tools-crm.ts");

/**
 * Source contract for the CRM assistant tools: every tool must carry the
 * permission its screen/route enforces, the `crm` feature declaration, the
 * CRM subsidiary-scope helper its list path needs, and — for detail reads —
 * the exact loader the drawer/route calls. No CRM tool may be a write.
 */
test("every CRM tool declares the crm feature and a read-side category", () => {
  for (const name of [
    "search_opportunities",
    "get_opportunity",
    "search_crm_accounts",
    "get_crm_account",
    "search_crm_activities",
    "get_crm_activity",
    "crm_forecast",
  ]) {
    assert.match(source, new RegExp(`name: "${name}"`), `${name} is registered`);
  }
  assert.equal(source.match(/feature: "crm"/g)?.length, 7, "all seven tools declare feature crm");
  assert.doesNotMatch(source, /category: "write"/, "CRM tools are read-only");
});

test("CRM tool gates equal the gates the routes enforce", () => {
  for (const [tool, perm] of [
    ["search_opportunities", "crm.opportunities.read"],
    ["get_opportunity", "crm.opportunities.read"],
    ["search_crm_accounts", "crm.accounts.read"],
    ["get_crm_account", "crm.accounts.read"],
    ["search_crm_activities", "crm.activities.read"],
    ["get_crm_activity", "crm.activities.read"],
    ["crm_forecast", "crm.forecasts.read"],
  ] as const) {
    const start = source.indexOf(`name: "${tool}"`);
    assert.ok(start >= 0, `${tool} is registered`);
    const window = source.slice(start, start + 600);
    assert.ok(window.includes(`"${perm}"`), `${tool} gates on ${perm}`);
  }
});

test("CRM lists carry the caller's subsidiary allowlist through the shared scope helpers", () => {
  assert.match(source, /crmOpportunityScope\(authz\.allowedSubsidiaryIds\)/);
  assert.match(source, /crmSharedScope\(sql`p\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(source, /crmActivityScope\(authz\.allowedSubsidiaryIds\)/);
  assert.match(
    source,
    /allowedSubsidiaryIds: authz\.allowedSubsidiaryIds/,
    "forecast passes the allowlist into calculateForecast",
  );
});

test("CRM detail tools reuse the drawer/route loaders instead of parallel SQL", () => {
  assert.match(source, /loadOpportunity\(a\.opportunityId, authz\.user\.orgId, authz\.allowedSubsidiaryIds\)/);
  assert.match(source, /loadCrmAccount\(a\.partyId, authz\.user\.orgId, authz\.allowedSubsidiaryIds\)/);
  assert.match(source, /loadActivity\(a\.activityId, authz\.user\.orgId, authz\.allowedSubsidiaryIds\)/);
  assert.match(source, /calculateForecast\(\{/);
});

test("CRM tools fail closed with stable error codes", () => {
  assert.match(source, /crm_feature_disabled/);
  assert.match(source, /opportunity_not_found/);
  assert.match(source, /crm_account_not_found/);
  assert.match(source, /crm_activity_not_found/);
  assert.match(source, /invalid_forecast_period/);
});

test("CRM tools are exported and every list returns totals plus an href", () => {
  assert.match(source, /export const CRM_TOOLS: AssistantToolDef\[\]/);
  assert.ok(source.includes("searchOpportunities,\n  getOpportunity,"));
  assert.ok(source.includes("crmForecast,\n];"));
  assert.ok(source.includes('href: "/crm/opportunities"'));
  assert.ok(source.includes('href: "/crm/activities"'));
  assert.ok(source.includes('href: "/crm/forecasts"'));
});

import assert from "node:assert/strict";
import test from "node:test";
import { FEATURES, featureRequirements } from "../organization/feature-registry.ts";
import { SAMPLE_COMPANY_PROFILES } from "./catalog.ts";
import { DEMO_FEATURES_BY_INDUSTRY, sampleCompanyFeatures } from "./features.ts";
import { DEMO_FEATURE_EVIDENCE, demoFeatureEvidence } from "./coverage.ts";
import { demoRecords, demoRecordId, type DemoContext } from "./scenarios.ts";

export function demoContext(industryKey: string): DemoContext {
  const uuid = (key: string) => demoRecordId("00000000-0000-4000-8000-000000000001", "fixture", key);
  return { orgId: uuid("org"), industryKey, companyName: "Example Company", actorId: uuid("actor"), subsidiaryId: uuid("subsidiary"), bookId: uuid("book"), periodId: uuid("period"), customerId: uuid("customer"), vendorId: uuid("vendor"), employeeId: uuid("employee"), opportunityStatusId: uuid("opportunity-status"), currency: "USD", date: "2026-09-30", year: 2026,
    accounts: { bank: uuid("bank"), receivable: uuid("receivable"), revenue: uuid("revenue"), expense: uuid("expense"), inventory: uuid("inventory"), payable: uuid("payable"), equipment: uuid("equipment"), accumulatedDepreciation: uuid("accumulated"), deferredRevenue: uuid("deferred") } };
}

test("industry demos collectively cover every authoritative feature and its dependencies", () => {
  const registry = new Set(FEATURES.map((feature) => feature.key));
  assert.deepEqual(Object.keys(DEMO_FEATURES_BY_INDUSTRY).sort(), SAMPLE_COMPANY_PROFILES.map((p) => p.industryKey).sort());
  assert.deepEqual(Object.keys(DEMO_FEATURE_EVIDENCE).sort(), [...registry].sort());
  const covered = new Set<string>();
  for (const profile of SAMPLE_COMPANY_PROFILES) {
    for (const key of DEMO_FEATURES_BY_INDUSTRY[profile.industryKey]!) assert.ok(registry.has(key), `Unknown feature ${key} in ${profile.companyName}`);
    const features = sampleCompanyFeatures(profile.industryKey);
    assert.deepEqual(Object.keys(features).sort(), [...registry].sort());
    for (const feature of FEATURES) if (features[feature.key]) {
      covered.add(feature.key);
      for (const dependency of featureRequirements(feature)) assert.equal(features[dependency], true, `${profile.companyName}: ${feature.key} requires ${dependency}`);
    }
    assert.deepEqual(Object.keys(demoFeatureEvidence(profile.industryKey)).sort(), Object.keys(features).filter((key) => features[key]).sort());
  }
  assert.deepEqual([...covered].sort(), [...registry].sort());
  assert.throws(() => sampleCompanyFeatures("unknown"), /Unknown sample-company industry/);
});

test("scenario identities are unique, tenant isolated, and resource weeks use Sundays", () => {
  for (const profile of SAMPLE_COMPANY_PROFILES) {
    const context = demoContext(profile.industryKey);
    const records = demoRecords(context);
    const keys = records.map((r) => `${r.table}:${r.values[r.primaryKey ?? "id"]}`);
    assert.equal(new Set(keys).size, keys.length, profile.companyName);
    assert.deepEqual(demoRecords(context), records);
    for (const record of records) {
      assert.equal(record.values.org_id, context.orgId);
      assert.ok(Object.values(record.values).every((value) => value !== undefined), `${profile.companyName}: ${record.table}`);
      if (record.table === "res_requests" || record.table === "res_demand_lines") {
        for (const key of ["first_week", "last_week"]) assert.equal(new Date(`${record.values[key]}T00:00:00Z`).getUTCDay(), 0);
      }
    }
    const foreign = demoRecords({ ...context, orgId: "00000000-0000-4000-8000-000000000002" });
    assert.ok(foreign.every((record) => !keys.includes(`${record.table}:${record.values[record.primaryKey ?? "id"]}`)));
  }
});

test("demo coverage declares integration limits and unsupported execution honestly", () => {
  assert.equal(DEMO_FEATURE_EVIDENCE.automationFieldTriggers?.mode, "unsupported");
  assert.equal(DEMO_FEATURE_EVIDENCE.automationWebhooks?.mode, "unsupported");
  for (const key of ["onlinePayments", "bankFeeds", "automationWebhooks", "payroll"]) assert.ok(DEMO_FEATURE_EVIDENCE[key]?.limitation);
});

import { createHash } from "node:crypto";
import { operatingDocuments } from "./industry-operations.ts";
import { sampleOperatingPolicy } from "./policy.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { FEATURES, featureRequirements } from "../organization/feature-registry.ts";
import { SAMPLE_COMPANY_PROFILES } from "./catalog.ts";
import { DEMO_FEATURES_BY_INDUSTRY, sampleCompanyFeatures, sampleRefreshFeatures, UPCOMING_DEMO_FEATURES } from "./features.ts";
import { DEMO_FEATURE_EVIDENCE, demoFeatureEvidence } from "./coverage.ts";
import { demoRecords, demoRecordId, scenarioRecordId, type DemoContext } from "./scenarios.ts";

export function demoContext(industryKey: string): DemoContext {
  const uuid = (key: string) => demoRecordId("00000000-0000-4000-8000-000000000001", "fixture", key);
  return { orgId: uuid("org"), industryKey, companyName: "Example Company", actorId: uuid("actor"), subsidiaryId: uuid("subsidiary"), bookId: uuid("book"), periodId: uuid("period"), customerId: uuid("customer"), vendorId: uuid("vendor"), employeeId: uuid("employee"), opportunityStatusId: uuid("opportunity-status"), currency: "USD", date: "2026-09-30", year: 2026,
    accounts: { bank: uuid("bank"), receivable: uuid("receivable"), revenue: uuid("revenue"), expense: uuid("expense"), inventory: uuid("inventory"), payable: uuid("payable"), equipment: uuid("equipment"), accumulatedDepreciation: uuid("accumulated"), deferredRevenue: uuid("deferred") } };
}

test("industry demos collectively cover every authoritative feature and its dependencies", () => {
  const registry = new Set(FEATURES.map((feature) => feature.key));
  assert.deepEqual(Object.keys(DEMO_FEATURES_BY_INDUSTRY).sort(), SAMPLE_COMPANY_PROFILES.map((p) => p.industryKey).sort());
  const available = [...registry].filter(key => !(UPCOMING_DEMO_FEATURES as readonly string[]).includes(key));
  assert.deepEqual(Object.keys(DEMO_FEATURE_EVIDENCE).sort(), available.sort());
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
  assert.deepEqual([...covered].sort(), available.sort());
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


test("cloned scenarios retain the published native rebase identity", () => {
  const master = demoContext("general_business");
  const clone = { ...master, orgId: "00000000-0000-4000-8000-000000000003", identitySourceOrgId: master.orgId, identitySeed: "00000000-0000-4000-8000-000000000004" };
  const source = demoRecordId(master.orgId, "documents", "operations-vendor_bill-1");
  const hex = createHash("md5").update(`${clone.identitySeed}:${source}`).digest("hex");
  assert.equal(scenarioRecordId(clone,"documents","operations-vendor_bill-1").replaceAll("-",""), hex);
  assert.notEqual(scenarioRecordId(clone,"documents","operations-vendor_bill-1"), demoRecordId(clone.orgId,"documents","operations-vendor_bill-1"));
});

test("every industry has deterministic counterparty and transaction volume without fabricated posting states", () => {
  for (const profile of SAMPLE_COMPANY_PROFILES) {
    const context = demoContext(profile.industryKey);
    const policy = sampleOperatingPolicy(profile.industryKey);
    const documents = operatingDocuments(context);
    assert.equal(documents.filter(d => d.kind === "vendor_bill").length, policy.vendorBills);
    assert.equal(documents.filter(d => d.kind === "customer_invoice").length, policy.customerInvoices);
    assert.equal(new Set(documents.filter(d => d.kind === "vendor_bill").map(d => d.partyId)).size, policy.vendors);
    assert.equal(new Set(documents.filter(d => d.kind === "customer_invoice").map(d => d.partyId)).size, policy.customers);
    for (const kind of ["vendor_credit","customer_credit","expense_report","check","deposit","card_charge","card_refund","transfer"]) assert.equal(documents.filter(d => d.kind === kind).length, 3);
    for (const record of demoRecords(context).filter(record => record.table === "documents")) assert.ok(record.values.status === undefined || record.values.status === "draft");
  }
});


test("preserving refresh adds required demo gates and retains unrelated explicit choices", () => {
  const before = { crm: false, projects: true, payroll: false, manufacturingSubcontract: true, futureOperatorChoice: false };
  const refreshed = sampleRefreshFeatures("general_business", before);
  assert.equal(refreshed.crm, true);
  assert.equal(refreshed.projects, true);
  assert.equal(refreshed.payroll, false);
  assert.equal(refreshed.manufacturingSubcontract, true);
  assert.equal(refreshed.futureOperatorChoice, false);
  assert.equal(before.crm, false, "refresh cannot mutate the supplied settings snapshot");
});

test("posted ordinary operations span native dates, parties and editable follow-up work", () => {
  for (const profile of SAMPLE_COMPANY_PROFILES) {
    const c = { ...demoContext(profile.industryKey), operationDates: ["2026-07-31", "2026-08-31", "2026-09-30"] };
    for (const kind of ["vendor_bill", "customer_invoice"]) {
      const documents = operatingDocuments(c).filter(row => row.kind === kind);
      assert.equal(new Set(documents.filter(row => row.post).map(row => row.documentDate)).size, 3);
      assert.ok(documents.some(row => !row.post));
      assert.ok(documents.filter(row => row.post).length >= 12);
    }
    assert.equal(DEMO_FEATURE_EVIDENCE.autopay?.stage, "configured");
    assert.equal(DEMO_FEATURE_EVIDENCE.projectProgress?.stage, "executed");
    assert.equal(DEMO_FEATURE_EVIDENCE.revenueContracts?.stage, "draft");
  }
});

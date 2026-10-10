import { createHash } from "node:crypto";
import { demoRecords, demoRecordId, type DemoContext } from "./scenarios.ts";
import { operatingDocuments } from "./industry-operations.ts";
import { FEATURES, featureRequirements } from "../organization/feature-registry.ts";
import { SAMPLE_COMPANY_PROFILES } from "./catalog.ts";
import { DEMO_FEATURE_EVIDENCE } from "./coverage.ts";
import { sampleCompanyFeatures, UPCOMING_DEMO_FEATURES } from "./features.ts";
import { sampleOperatingPolicy } from "./policy.ts";

function definitionDigest(industryKey: string, companyName: string): string {
  const id = (key: string) => demoRecordId("00000000-0000-4000-8000-000000000001", "definition", key);
  const context: DemoContext = {
    orgId: id("org"), actorId: id("actor"), subsidiaryId: id("subsidiary"), bookId: id("book"), periodId: id("period"),
    customerId: id("customer"), vendorId: id("vendor"), employeeId: id("employee"), opportunityStatusId: id("opportunity"),
    industryKey, companyName, currency: "USD", date: "2026-09-30", year: 2026,
    operationDate: "2026-09-30", operationDates: ["2026-07-31", "2026-08-31", "2026-09-30"],
    accounts: { bank: id("bank"), receivable: id("receivable"), revenue: id("revenue"), expense: id("expense"), inventory: id("inventory"),
      payable: id("payable"), equipment: id("equipment"), accumulatedDepreciation: id("accumulated"), deferredRevenue: id("deferred") },
  };
  return createHash("sha256").update(JSON.stringify({ records: demoRecords(context), operations: operatingDocuments(context) })).digest("hex");
}

/** A source manifest is an expectation, never a claim that database evidence exists. */
export function sampleSourceManifest() {
  const industries = SAMPLE_COMPANY_PROFILES.map(profile => ({
    ...profile, definitionDigest: definitionDigest(profile.industryKey, profile.companyName), policy: sampleOperatingPolicy(profile.industryKey),
    enabledFeatures: Object.entries(sampleCompanyFeatures(profile.industryKey)).filter(([, enabled]) => enabled).map(([key]) => key),
  }));
  return {
    qualification: "source-expectations-only",
    nativeWorkflowContract: { version: 5, bankAccounts: 4, supplierPayments: 3, customerReceipts: 3,
      returnExamples: { industry: "wholesale_distribution", count: 3, stages: ["requested", "receiving", "rejected"] },
      fieldTicketExamples: { industry: "construction_contractor", count: 3, linkedTimeRowsPerTicket: 3 } },
    features: FEATURES.map(feature => ({
      key: feature.key, requirements: featureRequirements(feature),
      status: (UPCOMING_DEMO_FEATURES as readonly string[]).includes(feature.key) ? "upcoming" : "available",
      companies: industries.filter(profile => profile.enabledFeatures.includes(feature.key)).map(profile => profile.industryKey),
      evidence: DEMO_FEATURE_EVIDENCE[feature.key] ?? null,
    })),
    industries,
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { defaultContinuousCloseDetectors } from "./continuous-close-config.ts";
import {
  classifyCollectionSeverity,
  collectionsFindings,
  qualifiesForCreditHold,
  type BrokenPromiseRow,
  type CollectionsLoaders,
  type OverdueCustomerRow,
  type OverdueInvoiceRow,
} from "./collections.ts";
import { MODULE_BY_KEY } from "../navigation/nav-registry.ts";

function policies(agentThreshold = "1000.0000") {
  void agentThreshold;
  return defaultContinuousCloseDetectors("collections");
}

function stubLoaders(overrides: Partial<CollectionsLoaders> = {}): CollectionsLoaders & {
  seen: { cutoff: string | null };
} {
  const seen = { cutoff: null as string | null };
  return {
    seen,
    today: async () => "2026-07-16",
    overdueCustomers: async () => [],
    overdueInvoices: async () => [],
    brokenPromises: async (_orgId, cutoff) => {
      seen.cutoff = cutoff;
      return [];
    },
    ...overrides,
  };
}

const ORG = "00000000-0000-0000-0000-000000000001";

test("collection severity trips at exact age and materiality boundaries", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  assert.equal(
    classifyCollectionSeverity({
      materiality: "4999.9999",
      threshold: "1000.0000",
      oldestDate: "2026-07-15",
      now,
    }),
    "warning",
  );
  assert.equal(
    classifyCollectionSeverity({
      materiality: "5000.0000",
      threshold: "1000.0000",
      oldestDate: "2026-07-15",
      now,
    }),
    "critical",
  );
  assert.equal(
    classifyCollectionSeverity({ materiality: "1.0000", threshold: "1000.0000", oldestDate: "2026-06-16", now }),
    "critical",
  );
});

test("credit hold needs age, materiality multiple, and invoice count together", () => {
  const base = {
    overdueBalance: "6000.0000",
    threshold: "1000.0000",
    oldestDue: "2026-04-01",
    overdueCount: 3,
    now: new Date("2026-07-16T12:00:00Z"),
    holdOverdueDays: 60,
    holdMaterialityMultiple: 3,
    minOverdueInvoices: 2,
  };
  assert.equal(qualifiesForCreditHold(base), true);
  assert.equal(qualifiesForCreditHold({ ...base, oldestDue: "2026-06-01" }), false);
  assert.equal(qualifiesForCreditHold({ ...base, overdueBalance: "2999.9999" }), false);
  assert.equal(qualifiesForCreditHold({ ...base, overdueCount: 1 }), false);
});

test("overdue findings rank the call list and keep exact money", async () => {
  const customers: OverdueCustomerRow[] = [
    {
      partyId: "p-small",
      partyName: "Small Debtor",
      email: null,
      openBalance: "600.0000",
      overdueBalance: "500.0000",
      overdueCount: 1,
      openCount: 1,
      oldestDue: "2026-07-01",
      latePayments: 0,
      worstLateDays: 0,
    },
    {
      partyId: "p-big",
      partyName: "Big Debtor",
      email: "ap@example.invalid",
      openBalance: "5234.5678",
      overdueBalance: "5234.5678",
      overdueCount: 2,
      openCount: 2,
      oldestDue: "2026-05-01",
      latePayments: 4,
      worstLateDays: 21,
      // ^ paid late before: the behaviour signal rides along
    },
  ];
  const invoices: OverdueInvoiceRow[] = [
    { partyId: "p-big", docId: "d1", docNumber: "INV-1", dueDate: "2026-05-01", openBalance: "5000.0000" },
    { partyId: "p-big", docId: "d2", docNumber: "INV-2", dueDate: "2026-06-01", openBalance: "234.5678" },
  ];
  const loaders = stubLoaders({
    overdueCustomers: async () => customers,
    overdueInvoices: async () => invoices,
  });
  const findings = await collectionsFindings(ORG, "1000.0000", policies(), loaders);
  const overdue = findings.filter((finding) => finding.findingType === "overdue_customer_balance");
  // The $500 balance is below the $1000 floor and stays out of the call list.
  assert.equal(overdue.length, 1);
  const only = overdue[0]!;
  assert.equal(only.fingerprint, "collections-overdue:p-big");
  assert.equal(only.materiality, "5234.5678");
  assert.equal(only.severity, "critical");
  assert.equal(only.summary.callPriority, 1);
  assert.equal(only.summary.callListSize, 1, "below-floor balances never join the call list");
  assert.match(String(only.summary.reminderDraft), /Big Debtor/);
  assert.match(String(only.summary.reminderDraft), /5234\.5678/);
  // F-t11-012: the evidence source link resolves through the nav registry —
  // never a hand-built path ("/ar/cockpit" 404s; the cockpit is the `ar` entry).
  assert.equal(only.summary.href, MODULE_BY_KEY.get("ar")?.href);
  assert.equal(only.summary.href, "/ar");
  assert.equal(only.evidence.length, 3, "two invoices plus the payment-behaviour datum");
  assert.equal(only.proposal ?? null, null, "no record-send tool exists: drafts are listed, not dispatched");
});

test("a disabled overdue control stays silent while promises still fire", async () => {
  const loaders = stubLoaders({
    overdueCustomers: async () => [
      {
        partyId: "p1",
        partyName: "P",
        email: null,
        openBalance: "2000.0000",
        overdueBalance: "2000.0000",
        overdueCount: 1,
        openCount: 1,
        oldestDue: "2026-06-01",
        latePayments: 0,
        worstLateDays: 0,
      },
    ],
    brokenPromises: async () => [
      {
        partyId: "p1",
        partyName: "P",
        docId: "d9",
        docNumber: "INV-9",
        expectedPayDate: "2026-06-01",
        dueDate: "2026-05-20",
        openBalance: "2000.0000",
      } satisfies BrokenPromiseRow,
    ],
  });
  const detectors = policies().map((detector) =>
    detector.detectorKey === "overdue_customer_balance" ? { ...detector, enabled: false } : detector,
  );
  const findings = await collectionsFindings(ORG, "1000.0000", detectors, loaders);
  assert.deepEqual(
    findings.map((finding) => finding.findingType).sort(),
    ["broken_payment_promise"],
  );
});

test("broken promises group by customer and respect the breach tolerance", async () => {
  const loaders = stubLoaders();
  const seed: BrokenPromiseRow[] = [
    { partyId: "p1", partyName: "P One", docId: "a", docNumber: "A", expectedPayDate: "2026-06-01", dueDate: null, openBalance: "800.0000" },
    { partyId: "p1", partyName: "P One", docId: "b", docNumber: "B", expectedPayDate: "2026-06-05", dueDate: null, openBalance: "700.0000" },
    { partyId: "p2", partyName: "P Two", docId: "c", docNumber: "C", expectedPayDate: "2026-06-02", dueDate: null, openBalance: "100.0000" },
  ];
  loaders.brokenPromises = async (_orgId, cutoff) => {
    loaders.seen.cutoff = cutoff;
    return seed;
  };
  // Run through businessToday-independent assembly by calling with only the
  // promise detector enabled; the cutoff assertion below pins tolerance math.
  const detectors = policies().map((detector) => ({
    ...detector,
    enabled: detector.detectorKey === "broken_payment_promise",
  }));
  const findings = await collectionsFindings(ORG, "1000.0000", detectors, loaders);
  assert.equal(findings.length, 1, "p2 is below the floor; p1 groups into one finding");
  assert.equal(findings[0]!.fingerprint, "collections-promise:p1");
  assert.equal(findings[0]!.materiality, "1500.0000");
  assert.equal(findings[0]!.summary.brokenCount, 2);
  assert.equal(loaders.seen.cutoff, "2026-07-13", "today minus the 3-day breach tolerance");
});

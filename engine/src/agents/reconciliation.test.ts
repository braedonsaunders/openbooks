import test from "node:test";
import assert from "node:assert/strict";
import { defaultContinuousCloseDetectors } from "./continuous-close-config.ts";
import {
  pairMatchCandidates,
  reconciliationFindings,
  type NeverReconciledRow,
  type ReconAccountCandidates,
  type ReconciliationLoaders,
  type StaleReconRow,
} from "./reconciliation.ts";

function policies() {
  return defaultContinuousCloseDetectors("reconciliation");
}

function stubLoaders(overrides: Partial<ReconciliationLoaders> = {}): ReconciliationLoaders {
  return {
    today: async () => "2026-09-16",
    candidateAccounts: async () => [],
    staleSessions: async () => [],
    neverReconciled: async () => [],
    ...overrides,
  };
}

const ORG = "00000000-0000-0000-0000-000000000003";

test("pairing mirrors autoMatch: signed amounts, closest date, greedy consumption", () => {
  const pairs = pairMatchCandidates(
    [
      { lineId: "l1", postedOn: "2026-09-10", amount: "500.0000" },
      { lineId: "l2", postedOn: "2026-09-12", amount: "500.0000" },
      { lineId: "l3", postedOn: "2026-09-10", amount: "-500.0000" },
      { lineId: "l4", postedOn: "2026-08-01", amount: "200.0000" },
    ],
    [
      { journalLineId: "j1", postingDate: "2026-09-11", amount: "500.0000" },
      { journalLineId: "j2", postingDate: "2026-08-20", amount: "200.0000" },
    ],
  );
  // l1 takes j1 (1 day, 0.90); l2 finds j1 consumed and stays unmatched; l3
  // never matches a +500 journal despite the equal absolute value; l4 is
  // past the 14-day window.
  assert.deepEqual(pairs, [
    { lineId: "l1", journalLineId: "j1", daysBetween: 1, confidence: "0.90" },
  ]);
});

test("the 0.70 band covers 4-14 days at the exact boundary", () => {
  const pairs = pairMatchCandidates(
    [
      { lineId: "edge", postedOn: "2026-09-01", amount: "100.0000" },
      { lineId: "past", postedOn: "2026-09-01", amount: "300.0000" },
    ],
    [
      { journalLineId: "j-edge", postingDate: "2026-09-15", amount: "100.0000" },
      { journalLineId: "j-past", postingDate: "2026-09-16", amount: "300.0000" },
    ],
    14,
  );
  assert.deepEqual(pairs, [
    { lineId: "edge", journalLineId: "j-edge", daysBetween: 14, confidence: "0.70" },
  ]);
  const widened = pairMatchCandidates(
    [{ lineId: "past", postedOn: "2026-09-01", amount: "300.0000" }],
    [{ journalLineId: "j-past", postingDate: "2026-09-16", amount: "300.0000" }],
    15,
  );
  assert.equal(widened.length, 1, "matchWindowDays widens the autoMatch default");
});

function account(overrides: Partial<ReconAccountCandidates> = {}): ReconAccountCandidates {
  return {
    accountId: "a1",
    accountNumber: "1010",
    accountName: "Operating",
    reconciliationId: "r1",
    throughDate: "2026-09-16",
    totalUnmatched: 5,
    candidates: [
      {
        lineId: "l1",
        postedOn: "2026-09-14",
        amount: "500.0000",
        description: "Counterparty transfer",
        counterpartyRef: "REF-1",
        journalLineId: "j1",
        journalDate: "2026-09-15",
        daysBetween: 1,
        confidence: "0.90",
        confidencePercent: 90,
      },
    ],
    ...overrides,
  };
}

test("candidate findings propose the top match inside the open session", async () => {
  let seenWindow = 0;
  const loaders = stubLoaders({
    candidateAccounts: async (_orgId, _today, windowDays) => {
      seenWindow = windowDays;
      return [account()];
    },
  });
  const findings = await reconciliationFindings(ORG, "1000.0000", policies(), loaders);
  assert.equal(seenWindow, 14, "the detector window reaches the loader");
  const candidates = findings.filter((finding) => finding.findingType === "bank_line_match_candidate");
  // $500 is below the $1000 floor — no finding.
  assert.equal(candidates.length, 0, "sub-floor candidates stay silent");
});

test("floor and confidence gates compose: big confident pairs propose", async () => {
  const big = account({
    candidates: [
      {
        lineId: "l9",
        postedOn: "2026-09-14",
        amount: "2500.0000",
        description: null,
        counterpartyRef: null,
        journalLineId: "j9",
        journalDate: "2026-09-15",
        daysBetween: 1,
        confidence: "0.90",
        confidencePercent: 90,
      },
      {
        lineId: "l8",
        postedOn: "2026-09-01",
        amount: "4000.0000",
        description: null,
        counterpartyRef: null,
        journalLineId: "j8",
        journalDate: "2026-09-10",
        daysBetween: 9,
        confidence: "0.70",
        confidencePercent: 70,
      },
    ],
  });
  const loaders = stubLoaders({ candidateAccounts: async () => [big] });
  const findings = await reconciliationFindings(ORG, "1000.0000", policies(), loaders);
  const candidates = findings.filter((finding) => finding.findingType === "bank_line_match_candidate");
  assert.equal(candidates.length, 1);
  // Default minimum confidence 80 admits only the 0.90 pair; materiality $2500.
  assert.equal(candidates[0]!.materiality, "2500.0000");
  assert.deepEqual(candidates[0]!.proposal, {
    tool: "match_bank_line",
    input: { reconciliationId: "r1", statementLineId: "l9", journalLineIds: ["j9"] },
    label: "Match 2500.0000 (2026-09-14) in Operating",
  });
});

test("accounts without a session list candidates but propose nothing", async () => {
  const noSession = account({
    reconciliationId: null,
    throughDate: null,
    candidates: [
      {
        lineId: "l9",
        postedOn: "2026-09-14",
        amount: "2500.0000",
        description: null,
        counterpartyRef: null,
        journalLineId: "j9",
        journalDate: "2026-09-15",
        daysBetween: 1,
        confidence: "0.90",
        confidencePercent: 90,
      },
    ],
  });
  const loaders = stubLoaders({ candidateAccounts: async () => [noSession] });
  const findings = await reconciliationFindings(ORG, "1000.0000", policies(), loaders);
  const candidates = findings.filter((finding) => finding.findingType === "bank_line_match_candidate");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.proposal ?? null, null, "no session exists to name in the command");
});

test("balanced stale sessions propose sign-off, imbalanced ones do not", async () => {
  const stale = (difference: string): StaleReconRow => ({
    reconciliationId: `r-${difference}`,
    accountId: "a1",
    accountNumber: "1010",
    accountName: "Operating",
    throughDate: "2026-08-31",
    statementBalance: "1000.0000",
    updatedAt: "2026-09-01T00:00:00Z",
    difference,
  });
  let seenCutoff = "";
  const loaders = stubLoaders({
    staleSessions: async (_orgId, cutoff) => {
      seenCutoff = cutoff;
      return [stale("0.0000"), stale("25.0000")];
    },
  });
  const findings = await reconciliationFindings(ORG, "1000.0000", policies(), loaders);
  assert.ok(seenCutoff.startsWith("2026-09-09"), `stale cutoff, got ${seenCutoff}`);
  const sessions = findings.filter((finding) => finding.findingType === "stale_reconciliation");
  assert.equal(sessions.length, 2, "stale sessions surface at any balance");
  assert.deepEqual(sessions[0]!.proposal, {
    tool: "sign_off_reconciliation",
    input: { reconciliationId: "r-0.0000" },
    label: "Sign off Operating through 2026-08-31",
  });
  assert.equal(sessions[1]!.proposal ?? null, null, "a live difference is never auto-closed");
});

test("never-reconciled accounts honour the floor", async () => {
  const rows: NeverReconciledRow[] = [
    { accountId: "a9", accountNumber: "1020", accountName: "Reserve", activityCount: 12, activityTotal: "800.0000", oldestActivity: "2026-08-01" },
    { accountId: "a8", accountNumber: "1030", accountName: "Payroll", activityCount: 30, activityTotal: "45000.0000", oldestActivity: "2026-07-01" },
  ];
  const loaders = stubLoaders({ neverReconciled: async () => rows });
  const findings = await reconciliationFindings(ORG, "1000.0000", policies(), loaders);
  const never = findings.filter((finding) => finding.findingType === "never_reconciled_account");
  assert.equal(never.length, 1);
  assert.equal(never[0]!.fingerprint, "recon-never:a8");
  assert.equal(never[0]!.proposal ?? null, null, "the statement balance comes from the bank, not the agent");
});

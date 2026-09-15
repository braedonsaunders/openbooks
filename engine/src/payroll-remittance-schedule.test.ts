import assert from "node:assert/strict";
import test from "node:test";
import { RQ_REMITTANCE_SCHEDULE } from "./payroll/canada/quebec/remittance.ts";
import {
  groupRemittanceRows,
  scheduledRemittanceDueDateExplained,
  scheduledRemittanceFrequency,
  scheduleForRemittanceGroup,
  type RemittanceRow,
} from "./payroll-remittance.ts";
import type { PayrollFilingAccount } from "./payroll-filing.ts";

/**
 * Due dates from a pack-declared destination schedule — Revenu Québec's.
 *
 * Each case is hand-worked from Revenu Québec Guide TP-1015.G-V ("Guide for
 * Employers: Source Deductions and Contributions", remittance frequency and
 * deadlines) and form TPZ-1015.R-V, on the Québec due-date calendar
 * (Saint-Jean-Baptiste Day observed, the federal Civic Holiday not):
 *
 * - quarterly (average monthly remittance under $3,000): the 15th of the
 *   month following the end of the quarter;
 * - monthly ($3,000 to under $25,000): the 15th of the month following the
 *   month of the pay date;
 * - twice-monthly ($25,000 or more): remuneration paid the 1st to the 15th
 *   due the 25th of the same month, the 16th to month end due the 10th of
 *   the following month;
 * - a deadline on a Saturday, Sunday or statutory holiday moves to the next
 *   business day.
 *
 * 2026 weekday anchors (shared with the CRA due-date tests): New Year Thu
 * Jan 1, Good Friday Apr 3, Easter Monday Apr 6, Victoria Day Mon May 18,
 * Saint-Jean Wed Jun 24, Canada Day Wed Jul 1, Civic Holiday Mon Aug 3 (not
 * observed in Québec), Labour Day Mon Sep 7, Thanksgiving Mon Oct 12,
 * Remembrance Wed Nov 11, Christmas Fri Dec 25, Boxing Day Sat Dec 26.
 *
 * The load-bearing property: these dates come from the DESTINATION's
 * declaration, never from the filing account's CRA remitter type. A Québec
 * payroll on an accelerated-threshold-2 CRA account still remits to Revenu
 * Québec monthly — the CRA's working-day-counted threshold 2 has no RQ
 * counterpart, and stamping it dates an RQ bill from a schedule Revenu
 * Québec never set.
 */

const RQ = RQ_REMITTANCE_SCHEDULE;
const RQ_VENDOR = "11111111-1111-4111-8111-111111111111";
const CRA_VENDOR = "22222222-2222-4222-8222-222222222222";

const due = (frequency: string, periodTo: string): string =>
  scheduledRemittanceDueDateExplained(RQ, frequency, periodTo).dueDate;

test("RQ monthly: the 15th of the following month", () => {
  // August 15 2026 is a Saturday, so the deadline is the Monday.
  assert.equal(due("monthly", "2026-07-31"), "2026-08-17");
  // September 15 2026 is a Tuesday and does not move.
  assert.equal(due("monthly", "2026-08-31"), "2026-09-15");
  // Across the year boundary.
  assert.equal(due("monthly", "2026-12-31"), "2027-01-15");
});

test("RQ quarterly: the 15th after the quarter, not after the period", () => {
  assert.equal(due("quarterly", "2026-03-31"), "2026-04-15");
  assert.equal(due("quarterly", "2026-01-31"), "2026-04-15");
  assert.equal(due("quarterly", "2026-02-28"), "2026-04-15");
  assert.equal(due("quarterly", "2026-06-30"), "2026-07-15");
  assert.equal(due("quarterly", "2026-09-30"), "2026-10-15");
  assert.equal(due("quarterly", "2026-12-31"), "2027-01-15");
  // October 15 2028 is a Sunday, so the deadline is Monday the 16th.
  assert.equal(due("quarterly", "2028-09-30"), "2028-10-16");
});

test("RQ twice-monthly: the 25th, then the 10th", () => {
  // January 25 2026 is a Sunday, so it moves to Monday the 26th.
  assert.equal(due("twice_monthly", "2026-01-15"), "2026-01-26");
  // May 25 2026 is a Monday — Victoria Day that year is the 18th.
  assert.equal(due("twice_monthly", "2026-05-15"), "2026-05-25");
  assert.equal(due("twice_monthly", "2026-01-31"), "2026-02-10");
  // December's second half is due January 10 2027, a Sunday, so the 11th.
  assert.equal(due("twice_monthly", "2026-12-31"), "2027-01-11");
});

test("RQ deadlines move off statutory holidays to the next business day", () => {
  // Christmas Day 2026 is a Friday: the first-half December deadline moves to
  // Monday December 28 (the 26th is a Saturday, the 27th a Sunday).
  assert.equal(due("twice_monthly", "2026-12-15"), "2026-12-28");
});

test("the rule that produced the date travels with it", () => {
  assert.match(
    scheduledRemittanceDueDateExplained(RQ, "monthly", "2026-08-31").rule,
    /Revenu Québec monthly remitter.*15th of the month following the month/,
  );
  assert.match(
    scheduledRemittanceDueDateExplained(RQ, "quarterly", "2026-06-30").rule,
    /Revenu Québec quarterly remitter.*15th of the month following the end of the quarter/,
  );
  assert.match(
    scheduledRemittanceDueDateExplained(RQ, "twice_monthly", "2026-01-15").rule,
    /twice-monthly.*1st to the 15th, due the 25th of the same month/,
  );
  assert.match(
    scheduledRemittanceDueDateExplained(RQ, "twice_monthly", "2026-01-31").rule,
    /twice-monthly.*16th to month end, due the 10th of the following month/,
  );
});

test("an unknown frequency falls back to the schedule default rather than throwing", () => {
  // Configuration drift must never stop a bill from dating itself; readiness
  // — not the bill path — nags the org to fix the value.
  assert.equal(due("weekly", "2026-08-31"), "2026-09-15");
  assert.equal(
    scheduledRemittanceDueDateExplained(RQ, "weekly", "2026-08-31").rule,
    scheduledRemittanceDueDateExplained(RQ, "monthly", "2026-08-31").rule,
  );
});

test("frequency resolution prefers configuration, then the schedule default", () => {
  assert.deepEqual(
    scheduledRemittanceFrequency(RQ, { rqRemittanceFrequency: "twice_monthly" }),
    { frequency: "twice_monthly", source: "configured" },
  );
  // Unknown, missing, or mistyped values all fall back to monthly — Revenu
  // Québec's new-employer frequency — and say so.
  for (const settings of [{}, { rqRemittanceFrequency: "weekly" }, { rqRemittanceFrequency: 3 }]) {
    assert.deepEqual(scheduledRemittanceFrequency(RQ, settings), {
      frequency: "monthly", source: "default",
    });
  }
});

test("schedule resolution prefers provenance, then the configured party", () => {
  const settings = { rqRemittancePartyId: RQ_VENDOR };
  // Rows that arrived through the RQ vendor key are RQ-governed even when the
  // party is unassigned (the org has not configured its RQ vendor yet).
  const unassigned = scheduleForRemittanceGroup({
    vendorKeys: ["rqRemittancePartyId"], partyId: null, periodTo: "2026-07-31",
    payrollSettings: {}, schedules: [RQ],
  });
  assert.equal(unassigned?.authority, "Revenu Québec");
  assert.equal(unassigned?.frequency, "monthly");
  assert.equal(unassigned?.frequencySource, "default");
  assert.equal(unassigned?.dueDate, "2026-08-17");
  // An `external` component pointed at the RQ vendor resolves through the party.
  const byParty = scheduleForRemittanceGroup({
    vendorKeys: [], partyId: RQ_VENDOR, periodTo: "2026-07-31",
    payrollSettings: { ...settings, rqRemittanceFrequency: "quarterly" }, schedules: [RQ],
  });
  assert.equal(byParty?.vendorSettingsKey, "rqRemittancePartyId");
  assert.equal(byParty?.frequency, "quarterly");
  assert.equal(byParty?.frequencySource, "configured");
  assert.equal(byParty?.dueDate, "2026-10-15");
  // A CRA-vendor group has no declared schedule: the legacy path governs.
  assert.equal(scheduleForRemittanceGroup({
    vendorKeys: ["craRemittancePartyId"], partyId: CRA_VENDOR, periodTo: "2026-07-31",
    payrollSettings: { ...settings, craRemittancePartyId: CRA_VENDOR }, schedules: [RQ],
  }), null);
  // Unassigned rows with no provenance stay on the legacy path too.
  assert.equal(scheduleForRemittanceGroup({
    vendorKeys: [], partyId: null, periodTo: "2026-07-31",
    payrollSettings: settings, schedules: [RQ],
  }), null);
});

test("a declared schedule beats the legacy path when one party serves two keys", () => {
  // A misconfigured org pointing both vendors at one party still gets the
  // declared date — provenance with a schedule wins over provenance without.
  const resolved = scheduleForRemittanceGroup({
    vendorKeys: ["craRemittancePartyId", "rqRemittancePartyId"],
    partyId: RQ_VENDOR, periodTo: "2026-07-31",
    payrollSettings: { rqRemittancePartyId: RQ_VENDOR, craRemittancePartyId: RQ_VENDOR },
    schedules: [RQ],
  });
  assert.equal(resolved?.authority, "Revenu Québec");
  assert.equal(resolved?.dueDate, "2026-08-17");
});

test("no schedule governs before its effective date", () => {
  assert.equal(scheduleForRemittanceGroup({
    vendorKeys: ["rqRemittancePartyId"], partyId: RQ_VENDOR, periodTo: "2023-12-31",
    payrollSettings: { rqRemittancePartyId: RQ_VENDOR }, schedules: [RQ],
  }), null);
});

const ACCOUNT: PayrollFilingAccount = {
  id: "acct-1", country: "CA", programType: "ca_rp", accountNumber: "123456789RP0001",
  name: "Head office", remitterType: "accelerated_2", subsidiaryId: null, stateCode: null,
  isDefault: true, isActive: true,
};

const ROW: RemittanceRow = {
  component_id: "qpip", code: "QPIP", name: "QPIP", kind: "deduction",
  system_key: "qpip", remittance_party_id: null, liability_account_id: "liab-1",
  filing_account_id: ACCOUNT.id, province: "QC", amount: "100.00",
};

test("grouping carries each group's schedule provenance", () => {
  const groups = groupRemittanceRows({
    rows: [ROW],
    contextByAccount: new Map(),
    filingAccounts: new Map([[ACCOUNT.id, ACCOUNT]]),
    resolveParty: () => RQ_VENDOR,
    resolveAccount: (row) => row.liability_account_id,
    resolveVendorKey: () => "rqRemittancePartyId",
  });
  assert.equal(groups.size, 1);
  const group = [...groups.values()][0]!;
  assert.deepEqual(group.vendorKeys, ["rqRemittancePartyId"]);
  assert.equal(group.schedule, null);
  // Existing callers pass no provenance callback: no provenance, no behaviour change.
  const legacy = groupRemittanceRows({
    rows: [ROW],
    contextByAccount: new Map(),
    filingAccounts: new Map([[ACCOUNT.id, ACCOUNT]]),
    resolveParty: () => RQ_VENDOR,
    resolveAccount: (row) => row.liability_account_id,
  });
  assert.deepEqual([...legacy.values()][0]!.vendorKeys, []);
});

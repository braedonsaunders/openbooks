import assert from "node:assert/strict";
import test from "node:test";
import { contractorWithholdingScheme, CONTRACTOR_REVERSE_CHARGE_RULES } from "../country-tax-packs/index.ts";
import { resolveSchemeRemittanceDue, type SchemeRemittanceDueInput } from "./remittance.ts";

const us = contractorWithholdingScheme("US_BACKUP_WITHHOLDING")!;
const it = contractorWithholdingScheme("IT_RITENUTA_APPALTI")!;
const input = (over: Partial<SchemeRemittanceDueInput> = {}): SchemeRemittanceDueInput => ({
  scheme: us, enrollmentSchedule: "US_LOOKBACK", paidOn: "2026-05-22", accumulatedLiability: "1200",
  lookback: { taxYear: 2024, totalTax: "50000" },
  calendar: { from: "2023-01-01", to: "2028-12-31", closedDates: ["2023-04-17", "2024-04-16", "2025-04-16", "2026-04-16", "2027-04-16", "2028-04-17", "2026-05-25", "2027-01-01"], sourceReference: "IRS published legal holidays" },
  ...over,
});

test("backup withholding uses the native vendor flag and Italian withholding requires a condominium payer", () => {
  assert.equal(us.standingSource, "vendor_backup_withholding");
  assert.equal(us.returnFrequency, "annual");
  assert.equal(us.returnKind, "annual_945");
  assert.equal(us.paymentDue, null);
  assert.equal(it.payerScope, "condominium");
  assert.equal(it.threshold, undefined, "€500 defers remittance and never exempts a deduction");
  assert.equal(it.returnDue, null, "a workpaper has no invented statutory filing date");
});

test("Form 945 lookback at $50,000 remains monthly and above it becomes semiweekly", () => {
  assert.equal(resolveSchemeRemittanceDue(input()).dueDate, "2026-06-15");
  const semiweekly = resolveSchemeRemittanceDue(input({ lookback: { taxYear: 2024, totalTax: "50000.0001" } }));
  assert.equal(semiweekly.reason, "semiweekly");
  assert.equal(semiweekly.dueDate, "2026-05-28", "three business days follow Friday, excluding the confirmed Monday holiday");
});

test("Saturday to Tuesday payments share the Friday semiweekly deadline", () => {
  for (const paidOn of ["2026-05-16", "2026-05-17", "2026-05-18", "2026-05-19"]) {
    assert.equal(resolveSchemeRemittanceDue(input({ paidOn, lookback: { taxYear: 2024, totalTax: "50001" } })).dueDate, "2026-05-22");
  }
});

test("$100,000 next-day deposit rolls through legal holidays and changes subsequent schedules", () => {
  const decision = resolveSchemeRemittanceDue(input({ paidOn: "2026-12-31", accumulatedLiability: "100000" }));
  assert.equal(decision.dueDate, "2027-01-04");
  assert.equal(decision.nextScheduleCode, "US_SEMIWEEKLY");
  assert.equal(decision.nextScheduleEffectiveFrom, "2027-01-01");
  const after = resolveSchemeRemittanceDue(input({ paidOn: "2027-01-04", nextDayEventOn: "2026-12-31", lookback: { taxYear: 2025, totalTax: "0" } }));
  assert.equal(after.reason, "semiweekly");
  const expires = resolveSchemeRemittanceDue(input({ paidOn: "2028-01-04", nextDayEventOn: "2026-12-31", lookback: { taxYear: 2026, totalTax: "0" } }));
  assert.equal(expires.reason, "monthly");
});

test("Form 945 refuses missing, wrong-year or contradictory schedule evidence", () => {
  assert.throws(() => resolveSchemeRemittanceDue(input({ lookback: undefined })), /second preceding/);
  assert.throws(() => resolveSchemeRemittanceDue(input({ lookback: { taxYear: 2025, totalTax: "0" } })), /second preceding/);
  assert.throws(() => resolveSchemeRemittanceDue(input({ enrollmentSchedule: "US_MONTHLY", lookback: { taxYear: 2024, totalTax: "50001" } })), /disagrees/);
  assert.throws(() => resolveSchemeRemittanceDue(input({ accumulatedLiability: "1,000" })), /exact nonnegative/);
  assert.throws(() => resolveSchemeRemittanceDue(input({ calendar: { from: "2026-01-01", to: "2026-05-31", closedDates: ["2026-04-16"], sourceReference: "IRS published legal holidays" } })), /does not cover/);
});

test("annual Form 945 payment requires complete liability strictly below $2,500", () => {
  assert.throws(() => resolveSchemeRemittanceDue(input({ enrollmentSchedule: "US_ANNUAL_SMALL" })), /finalized/);
  assert.throws(() => resolveSchemeRemittanceDue(input({ enrollmentSchedule: "US_ANNUAL_SMALL", finalAnnualLiability: { taxYear: 2026, totalTax: "2500" } })), /below/);
  const decision = resolveSchemeRemittanceDue(input({ enrollmentSchedule: "US_ANNUAL_SMALL", finalAnnualLiability: { taxYear: 2026, totalTax: "2499.99" } }));
  assert.equal(decision.dueDate, "2027-02-01");
});

test("Italian accumulation threshold governs remittance and cutoffs change prospectively", () => {
  const italian = (paidOn: string, liability: string) => resolveSchemeRemittanceDue(input({ scheme: it, enrollmentSchedule: "IT_ACCUMULATED", paidOn, accumulatedLiability: liability }));
  assert.equal(italian("2023-05-01", "499.99").dueDate, "2023-06-30");
  assert.equal(italian("2026-05-01", "499.99").dueDate, "2026-06-16");
  assert.equal(italian("2026-01-01", "500").dueDate, "2026-02-16");
  assert.equal(italian("2026-06-01", "499.99").dueDate, "2026-12-16");
  assert.equal(italian("2026-12-01", "499.99").dueDate, "2027-06-16");
  assert.equal(italian("2026-07-01", "500").dueDate, "2026-08-20");
});

test("construction reverse-charge templates use existing tax-code calculation and invoice metadata", () => {
  assert.deepEqual(CONTRACTOR_REVERSE_CHARGE_RULES.map((rule) => rule.country).sort(), ["DE", "ES", "FR", "GB", "HU", "IE"]);
  for (const rule of CONTRACTOR_REVERSE_CHARGE_RULES) {
    assert.equal(rule.calculationType, "reverse_charge");
    assert.equal(rule.einvoiceCategory, "AE");
    assert.ok(rule.invoiceWording.trim());
    assert.ok(rule.applicability.trim());
    assert.ok(rule.sources.length > 0);
  }
});


test("IRS calendars require their authority reference and observed DC Emancipation Day", () => {
  assert.throws(() => resolveSchemeRemittanceDue(input({ calendar: { ...input().calendar, sourceReference: "" } })), /source reference/);
  assert.throws(() => resolveSchemeRemittanceDue(input({ calendar: { ...input().calendar, closedDates: [] } })), /Emancipation/);
  assert.equal(resolveSchemeRemittanceDue(input({ paidOn: "2026-04-15", accumulatedLiability: "100000" })).dueDate, "2026-04-17");
});

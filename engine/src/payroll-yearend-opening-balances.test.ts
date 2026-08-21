import assert from "node:assert/strict";
import test from "node:test";
import { carryOpeningTaxYtd, openingYtdIntoT4Slip, openingYtdIntoW2Slip } from "./payroll-yearend.ts";
import type { T4Slip, W2Slip } from "./payroll-yearend.ts";

/**
 * The opening-balance carry-in on year-end slips.
 *
 * `payroll_opening_balances.taxable_ytd` / `tax_ytd` promise T4 box 14 /
 * box 22 and W-2 box 1 / box 2 (the field help says so), and a mid-year
 * adopter's slips understate every one of those boxes without them. What is
 * under test here is the folding rule itself: the carry-in is a PER-EMPLOYEE
 * fact landing on exactly ONE slip of a multi-slip employee, it is ADDITIVE
 * with the committed stubs (the `employeeYtd` pattern), and it never touches
 * the capped boxes, which measure the CPP/EI/FICA bases the stubs were
 * assessed against.
 */

const t4 = (employeePartyId: string, overrides: Partial<T4Slip> = {}): T4Slip => ({
  employeePartyId, employeeName: `Emp ${employeePartyId}`, province: "ON", isQuebec: false,
  filingAccountId: null,
  box14EmploymentIncome: "50000.0000", box16Cpp: "3000.0000", box16aCpp2: "0",
  box18Ei: "800.0000", box22IncomeTax: "9000.0000",
  box24EiInsurable: "50000.0000", box26CppPensionable: "50000.0000",
  box44UnionDues: "0", box55Qpip: "0", box56QpipInsurable: "0", stubCount: 12,
  ...overrides,
});

const w2 = (employeePartyId: string, overrides: Partial<W2Slip> = {}): W2Slip => ({
  employeePartyId, employeeName: `Emp ${employeePartyId}`, states: ["CA"], state: "CA",
  filingAccountId: null,
  box1Wages: "48000.0000", box2FederalIncomeTax: "6000.0000",
  box3SsWages: "48000.0000", box4SsTax: "2976.0000",
  box5MedicareWages: "48000.0000", box6MedicareTax: "696.0000",
  ...overrides,
});

test("the carry-in is additive with committed stubs, not either/or", () => {
  const [slip] = carryOpeningTaxYtd(
    [t4("e1")],
    new Map([["e1", { taxableYtd: "21000.50", taxYtd: "3150.75" }]]),
    openingYtdIntoT4Slip,
  );
  assert.equal(slip!.box14EmploymentIncome, "71000.5000");
  assert.equal(slip!.box22IncomeTax, "12150.7500");
});

test("a multi-slip employee's carry-in lands on exactly one slip", () => {
  // One employee, two provinces of employment: the per-employee opening must
  // not be multiplied by the slip count. It rides the FIRST slip in the
  // caller's chronological order — the same first-slip-fill convention
  // capAnnualEarnings uses for per-employee annual amounts.
  const slips = [
    t4("e1", { province: "BC", box14EmploymentIncome: "20000" }),
    t4("e1", { province: "ON", box14EmploymentIncome: "30000" }),
  ];
  const carried = carryOpeningTaxYtd(
    slips,
    new Map([["e1", { taxableYtd: "21000.50", taxYtd: "3150.75" }]]),
    openingYtdIntoT4Slip,
  );
  assert.equal(carried[0]!.box14EmploymentIncome, "41000.5000");
  assert.equal(carried[0]!.box22IncomeTax, "12150.7500");
  assert.equal(carried[1]!.box14EmploymentIncome, "30000", "second slip untouched");
  assert.equal(carried[1]!.box22IncomeTax, "9000.0000");
});

test("employees without a carry-in are untouched", () => {
  const slips = [t4("e1"), t4("e2")];
  const carried = carryOpeningTaxYtd(
    slips,
    new Map([["e2", { taxableYtd: "1.00", taxYtd: "0.10" }]]),
    openingYtdIntoT4Slip,
  );
  assert.deepEqual(carried[0], slips[0]);
  assert.notEqual(carried[1], slips[1]);
});

test("the T4 carry-in reaches only boxes 14 and 22 — capped boxes stay put", () => {
  // Boxes 24/26/56 are the CPP/EI/QPIP bases the year's stubs were assessed
  // against; the taxable/tax columns say nothing about them.
  const before = t4("e1");
  const after = openingYtdIntoT4Slip(before, { taxableYtd: "100.00", taxYtd: "20.00" });
  assert.equal(after.box14EmploymentIncome, "50100.0000");
  assert.equal(after.box22IncomeTax, "9020.0000");
  assert.equal(after.box24EiInsurable, before.box24EiInsurable);
  assert.equal(after.box26CppPensionable, before.box26CppPensionable);
  assert.equal(after.box55Qpip, before.box55Qpip);
  assert.equal(after.box56QpipInsurable, before.box56QpipInsurable);
});

test("the W-2 carry-in reaches only boxes 1 and 2 — FICA wage bases stay put", () => {
  const before = w2("e1");
  const after = openingYtdIntoW2Slip(before, { taxableYtd: "12000.25", taxYtd: "1500.50" });
  assert.equal(after.box1Wages, "60000.2500");
  assert.equal(after.box2FederalIncomeTax, "7500.5000");
  assert.equal(after.box3SsWages, before.box3SsWages);
  assert.equal(after.box4SsTax, before.box4SsTax);
  assert.equal(after.box5MedicareWages, before.box5MedicareWages);
  assert.equal(after.box6MedicareTax, before.box6MedicareTax);
});

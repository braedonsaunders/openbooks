import assert from "node:assert/strict";
import test from "node:test";
import { db } from "./db.ts";
import {
  capAnnualEarnings,
  carryOpeningYearEndYtd,
  openingYtdIntoT4Slip,
  openingYtdIntoW2Slip,
  seedOpeningOnlySlips,
  t4Slips,
  w2Slips,
} from "./payroll-yearend.ts";
import type { OpeningYearEndYtd, T4Slip, W2Slip } from "./payroll-yearend.ts";

/**
 * The opening-balance carry-in on year-end slips.
 *
 * Every statutory column on `payroll_opening_balances` is a year-end input:
 * taxable/tax feed T4 14/22 and W-2 1/2, CPP/CPP2/EI/QPIP feed T4
 * 16/16A/18/55, and pensionable feeds T4 26 and W-2 3/5 while insurable
 * feeds T4 24. A mid-year adopter's slips understate those boxes if the
 * carry-in is reduced to taxable/tax only. The folding rule is still a
 * PER-EMPLOYEE fact landing on exactly ONE slip, ADDITIVE with committed
 * stubs, with T4 bases capped only after opening and committed amounts are
 * combined.
 */

const opening = (overrides: Partial<OpeningYearEndYtd> = {}): OpeningYearEndYtd => ({
  pensionableYtd: "0", insurableYtd: "0", cppYtd: "0", cpp2Ytd: "0",
  eiYtd: "0", qpipYtd: "0", taxableYtd: "0", taxYtd: "0", ...overrides,
});

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

test("every statutory opening amount is additive with committed stubs", () => {
  const [slip] = carryOpeningYearEndYtd(
    [t4("e1")],
    new Map([[
      "e1",
      opening({
        pensionableYtd: "12000.50", insurableYtd: "11000.25", cppYtd: "700.00",
        cpp2Ytd: "120.00", eiYtd: "210.75", qpipYtd: "33.25",
        taxableYtd: "21000.50", taxYtd: "3150.75",
      }),
    ]]),
    openingYtdIntoT4Slip,
  );
  assert.equal(slip!.box14EmploymentIncome, "71000.5000");
  assert.equal(slip!.box16Cpp, "3700.0000");
  assert.equal(slip!.box16aCpp2, "120.0000");
  assert.equal(slip!.box18Ei, "1010.7500");
  assert.equal(slip!.box22IncomeTax, "12150.7500");
  assert.equal(slip!.box24EiInsurable, "61000.2500");
  assert.equal(slip!.box26CppPensionable, "62000.5000");
  assert.equal(slip!.box55Qpip, "33.2500");
  assert.equal(slip!.box56QpipInsurable, "0", "no QPIP-insurable opening source exists");
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
  const carried = carryOpeningYearEndYtd(
    slips,
    new Map([[
      "e1", opening({ pensionableYtd: "21000.50", insurableYtd: "19000.25", cppYtd: "1200", eiYtd: "400",
        taxableYtd: "21000.50", taxYtd: "3150.75" }),
    ]]),
    openingYtdIntoT4Slip,
  );
  assert.equal(carried[0]!.box14EmploymentIncome, "41000.5000");
  assert.equal(carried[0]!.box22IncomeTax, "12150.7500");
  assert.equal(carried[0]!.box24EiInsurable, "69000.2500");
  assert.equal(carried[0]!.box26CppPensionable, "71000.5000");
  assert.equal(carried[0]!.box16Cpp, "4200.0000");
  assert.equal(carried[0]!.box18Ei, "1200.0000");
  assert.equal(carried[1]!.box14EmploymentIncome, "30000", "second slip untouched");
  assert.equal(carried[1]!.box22IncomeTax, "9000.0000");
  assert.equal(carried[1]!.box24EiInsurable, "50000.0000");
  assert.equal(carried[1]!.box26CppPensionable, "50000.0000");
});

test("employees without a carry-in are untouched", () => {
  const slips = [t4("e1"), t4("e2")];
  const carried = carryOpeningYearEndYtd(
    slips,
    new Map([["e2", opening({ taxableYtd: "1.00", taxYtd: "0.10" })]]),
    openingYtdIntoT4Slip,
  );
  assert.deepEqual(carried[0], slips[0]);
  assert.notEqual(carried[1], slips[1]);
});

test("T4 carry-in leaves box 56 alone because QPIP-insurable YTD is not collected", () => {
  const before = t4("e1");
  const after = openingYtdIntoT4Slip(before, opening({
    taxableYtd: "100.00", taxYtd: "20.00", pensionableYtd: "100.00", insurableYtd: "80.00",
    cppYtd: "5.00", cpp2Ytd: "2.00", eiYtd: "3.00", qpipYtd: "1.00",
  }));
  assert.equal(after.box14EmploymentIncome, "50100.0000");
  assert.equal(after.box16Cpp, "3005.0000");
  assert.equal(after.box16aCpp2, "2.0000");
  assert.equal(after.box18Ei, "803.0000");
  assert.equal(after.box22IncomeTax, "9020.0000");
  assert.equal(after.box24EiInsurable, "50080.0000");
  assert.equal(after.box26CppPensionable, "50100.0000");
  assert.equal(after.box55Qpip, "1.0000");
  assert.equal(after.box56QpipInsurable, before.box56QpipInsurable);
});

test("an opening with no committed stub still produces a slip", () => {
  const openings = new Map([["e-midyear", opening({ taxableYtd: "21000.50", taxYtd: "3150.75", pensionableYtd: "50000", insurableYtd: "40000" })]]);
  const seeded = seedOpeningOnlySlips([], openings.keys(), (id) => t4(id, {
    box14EmploymentIncome: "0", box22IncomeTax: "0", box24EiInsurable: "0", box26CppPensionable: "0", stubCount: 0,
  }));
  assert.equal(seeded.length, 1);
  const [slip] = carryOpeningYearEndYtd(seeded, openings, openingYtdIntoT4Slip);
  assert.equal(slip!.box14EmploymentIncome, "21000.5000");
  assert.equal(slip!.box22IncomeTax, "3150.7500");
  assert.equal(slip!.box24EiInsurable, "40000.0000");
  assert.equal(slip!.box26CppPensionable, "50000.0000");
});

test("the W-2 carry-in reaches taxable, tax and both FICA wage bases", () => {
  const before = w2("e1");
  const after = openingYtdIntoW2Slip(before, opening({
    taxableYtd: "12000.25", taxYtd: "1500.50", pensionableYtd: "14000.75",
  }));
  assert.equal(after.box1Wages, "60000.2500");
  assert.equal(after.box2FederalIncomeTax, "7500.5000");
  assert.equal(after.box3SsWages, "62000.7500");
  assert.equal(after.box4SsTax, before.box4SsTax);
  assert.equal(after.box5MedicareWages, "62000.7500");
  assert.equal(after.box6MedicareTax, before.box6MedicareTax);
});

test("opening bases are capped together with committed T4 bases", () => {
  // 40,000 EI-insurable / 70,000 CPP-pensionable was already paid by the
  // prior provider. Only the remaining 28,900 / 15,000 can appear on this
  // first OpenBooks slip; adding the opening after capping would overstate
  // both statutory boxes.
  const slips = [
    t4("adopter", { box24EiInsurable: "30000", box26CppPensionable: "20000" }),
    t4("adopter", { box24EiInsurable: "50000", box26CppPensionable: "30000" }),
  ];
  const openings = new Map([["adopter", opening({ insurableYtd: "40000", pensionableYtd: "70000" })]]);
  const carried = carryOpeningYearEndYtd(slips, openings, openingYtdIntoT4Slip);
  const capped = capAnnualEarnings(
    carried.map((slip) => ({
      employeePartyId: slip.employeePartyId,
      insurable: slip.box24EiInsurable,
      pensionable: slip.box26CppPensionable,
    })),
    { mie: "68900", yampe: "85000" },
  );
  assert.equal(capped[0]!.box24EiInsurable, "68900");
  assert.equal(capped[0]!.box26CppPensionable, "85000");
  assert.equal(capped[1]!.box24EiInsurable, "0");
  assert.equal(capped[1]!.box26CppPensionable, "0");
});

test("an opening with no country profile is Canadian, while an explicit US opening is W-2-only", async (t) => {
  const nullProfileEmployee = "00000000-0000-4000-8000-000000000001";
  const usEmployee = "00000000-0000-4000-8000-000000000002";
  const orgId = "00000000-0000-4000-8000-000000000099";
  const population = [
    { employeePartyId: nullProfileEmployee, profileCountry: null, taxableYtd: "12000" },
    { employeePartyId: usEmployee, profileCountry: "US", taxableYtd: "34000" },
  ] as const;
  const countryRows = (country: string) => population.filter((row) =>
    (row.profileCountry ?? "CA") === country);
  const queries: { sql: string; params: unknown[] }[] = [];
  const dialect = (db as unknown as {
    dialect: { sqlToQuery(query: Parameters<typeof db.execute>[0]): { sql: string; params: unknown[] } };
  }).dialect;

  t.mock.method(db, "execute", async (query: Parameters<typeof db.execute>[0]) => {
    const built = dialect.sqlToQuery(query);
    queries.push({ sql: built.sql, params: built.params });
    if (built.sql.includes("from payroll_opening_balances")) {
      const country = String(built.params[0]);
      return {
        rows: countryRows(country).map((row) => ({
          employee_party_id: row.employeePartyId,
          pensionable_ytd: "0", insurable_ytd: "0", cpp_ytd: "0", cpp2_ytd: "0",
          ei_ytd: "0", qpip_ytd: "0", taxable_ytd: row.taxableYtd, tax_ytd: "0",
        })),
      };
    }
    if (built.sql.includes("left join employee_payroll_profiles")) {
      const country = String(built.params[0]);
      return {
        rows: countryRows(country).map((row) => ({
          employee_party_id: row.employeePartyId,
          display_name: row.employeePartyId === nullProfileEmployee ? "Null Profile" : "US Employee",
          province: row.profileCountry === "US" ? "CA" : "ON",
          filing_account_id: null,
        })),
      };
    }
    // No committed stubs: both populations are opening-only and are seeded by
    // their country-filtered opening rows above.
    return { rows: [] };
  });

  const ca = await t4Slips(orgId, 2026);
  const us = await w2Slips(orgId, 2026);

  assert.deepEqual(ca.map((slip) => slip.employeePartyId), [nullProfileEmployee]);
  assert.equal(ca[0]!.box14EmploymentIncome, "12000.0000");
  assert.deepEqual(us.map((slip) => slip.employeePartyId), [usEmployee]);
  assert.equal(us[0]!.box1Wages, "34000.0000");

  const countryQueries = queries.filter((query) =>
    query.sql.includes("coalesce(prof.country")
    && (query.sql.includes("from payroll_opening_balances")
      || query.sql.includes("from parties p")));
  assert.equal(countryQueries.length, 4);
  assert.deepEqual(countryQueries.map((query) => query.params[0]), ["CA", "CA", "US", "US"]);
  for (const query of countryQueries) {
    assert.match(query.sql, /coalesce\(prof\.country, 'CA'\) = \$1/);
    assert.doesNotMatch(query.sql, /coalesce\(prof\.country, \$1\)/);
  }
});

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { db } from "../platform/db.ts";
import {
  capAnnualEarnings,
  carryOpeningYearEndYtd,
  openingYtdIntoT4Slip,
  openingYtdIntoW2Slip,
  seedOpeningOnlySlips,
  t4Slips,
  w2Slips,
} from "./yearend.ts";
import type { OpeningYearEndYtd, T4Slip, W2Slip } from "./yearend.ts";

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
  eiYtd: "0", qpipYtd: "0", taxableYtd: "0", taxYtd: "0", ficaWithheldYtd: "0", ...overrides,
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
  stateLines: [],
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
      qpipInsurable: slip.box56QpipInsurable,
    })),
    { mie: "68900", yampe: "85000", qpipMie: "103000" },
  );
  assert.equal(capped[0]!.box24EiInsurable, "68900");
  assert.equal(capped[0]!.box26CppPensionable, "85000");
  assert.equal(capped[1]!.box24EiInsurable, "0");
  assert.equal(capped[1]!.box26CppPensionable, "0");
});

test("box 56 consumes its OWN room at the QPIP maximum (C-12)", () => {
  // A Québec two-slip employee: 70,000 + 50,000 of QPIP-insurable earnings
  // against a 103,000 QPIP maximum. The first slip fills first and the
  // second gets only the 33,000 of QPIP room that is left — while the EI
  // room (68,900) is consumed by the EI base alone, untouched by the QPIP
  // figures on either slip.
  const capped = capAnnualEarnings(
    [
      { employeePartyId: "qc", insurable: "50000", pensionable: "60000", qpipInsurable: "70000" },
      { employeePartyId: "qc", insurable: "40000", pensionable: "50000", qpipInsurable: "50000" },
    ],
    { mie: "68900", yampe: "85000", qpipMie: "103000" },
  );
  assert.equal(capped[0]!.box56QpipInsurable, "70000");
  assert.equal(capped[1]!.box56QpipInsurable, "33000.0000"); // 103,000 − 70,000
  assert.equal(capped[1]!.box24EiInsurable, "18900.0000"); // 68,900 − 50,000
});

/**
 * An opening whose employee has no payroll profile row is refused — by name,
 * on BOTH year-end populations — never slipped as Canadian.
 *
 * The old reads folded the missing row into Canada (`coalesce(prof.country,
 * 'CA')`), so a profile-less carry-in became a Canadian T4; the inner-join
 * half of the same shape silently dropped it instead. Both are silent. The
 * mock below emulates the profile join per country the way the database
 * would, so the refusal (and the absence of any slip) is behavioral, through
 * the real `t4Slips`/`w2Slips` entry points.
 */
interface MockPopulationRow {
  employeePartyId: string;
  employeeName: string;
  profileCountry: string | null;
  province: string;
  taxableYtd: string;
}

function mockOpeningPopulations(t: TestContext, population: readonly MockPopulationRow[]): void {
  const dialect = (db as unknown as {
    dialect: { sqlToQuery(query: Parameters<typeof db.execute>[0]): { sql: string; params: unknown[] } };
  }).dialect;
  const requestedCountry = (params: unknown[]): string | null => {
    for (const param of params) {
      if (param === "CA" || param === "US") return param;
    }
    return null;
  };
  const zeroYtd = {
    pensionable_ytd: "0", insurable_ytd: "0", cpp_ytd: "0", cpp2_ytd: "0",
    ei_ytd: "0", qpip_ytd: "0", taxable_ytd: "0", tax_ytd: "0", fica_withheld_ytd: "0",
  };
  t.mock.method(db, "execute", async (query: Parameters<typeof db.execute>[0]) => {
    const built = dialect.sqlToQuery(query);
    // The unknown-country guard's opening check: carry-ins with NO profile row.
    if (built.sql.includes("from payroll_opening_balances")
      && built.sql.includes("prof.employee_party_id is null")) {
      return {
        rows: population
          .filter((row) => row.profileCountry == null)
          .map((row) => ({ employee_party_id: row.employeePartyId, display_name: row.employeeName })),
      };
    }
    // The readers' opening check: carry-ins joined to a profile of the
    // requested country (a missing row joins to nothing, like the database).
    if (built.sql.includes("from payroll_opening_balances")) {
      const country = requestedCountry(built.params);
      return {
        rows: population
          .filter((row) => row.profileCountry === country)
          .map((row) => ({
            employee_party_id: row.employeePartyId,
            ...zeroYtd,
            taxable_ytd: row.taxableYtd,
          })),
      };
    }
    if (built.sql.includes("from parties p")) {
      const country = requestedCountry(built.params);
      return {
        rows: population
          .filter((row) => row.profileCountry === country)
          .map((row) => ({
            employee_party_id: row.employeePartyId,
            display_name: row.employeeName,
            province: row.province,
            filing_account_id: null,
          })),
      };
    }
    // No committed stubs: both populations are opening-only and are seeded by
    // their country-routed opening rows above.
    return { rows: [] };
  });
}

test("an opening with no profile refuses year-end by name and is never slipped as CA", async (t) => {
  const orgId = "00000000-0000-4000-8000-000000000099";
  mockOpeningPopulations(t, [
    {
      employeePartyId: "00000000-0000-4000-8000-000000000001",
      employeeName: "No Profile", profileCountry: null, province: "", taxableYtd: "12000",
    },
    {
      employeePartyId: "00000000-0000-4000-8000-000000000002",
      employeeName: "US Employee", profileCountry: "US", province: "CA", taxableYtd: "34000",
    },
  ]);

  await assert.rejects(
    t4Slips(orgId, 2026),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /No Profile/);
      assert.match(error.message, /unknown historical country/);
      return true;
    },
  );
  await assert.rejects(
    w2Slips(orgId, 2026),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /No Profile/);
      return true;
    },
  );
});

test("explicitly routed openings still seed exactly their own country's slips", async (t) => {
  const caEmployee = "00000000-0000-4000-8000-000000000001";
  const usEmployee = "00000000-0000-4000-8000-000000000002";
  const orgId = "00000000-0000-4000-8000-000000000099";
  mockOpeningPopulations(t, [
    {
      employeePartyId: caEmployee,
      employeeName: "CA Employee", profileCountry: "CA", province: "ON", taxableYtd: "12000",
    },
    {
      employeePartyId: usEmployee,
      employeeName: "US Employee", profileCountry: "US", province: "CA", taxableYtd: "34000",
    },
  ]);

  const ca = await t4Slips(orgId, 2026);
  const us = await w2Slips(orgId, 2026);

  assert.deepEqual(ca.map((slip) => slip.employeePartyId), [caEmployee]);
  assert.equal(ca[0]!.box14EmploymentIncome, "12000.0000");
  assert.deepEqual(us.map((slip) => slip.employeePartyId), [usEmployee]);
  assert.equal(us[0]!.box1Wages, "34000.0000");
});

test("a FICA tax withheld carry-in splits into W-2 boxes 4 and 6", () => {
  // F-t08-010: the combined FICA carry-in reached no box, so an adopted
  // workforce filed $0 SS/Medicare tax. The split is wage-implied — Social
  // Security is 6.2% of FICA wages up to the wage base, Medicare is the
  // withheld remainder (Box 6 includes Additional Medicare) — so the two
  // boxes always account for every withheld dollar exactly.
  const before = w2("e1", { box4SsTax: "0", box6MedicareTax: "0" });
  const after = openingYtdIntoW2Slip(
    before,
    opening({ pensionableYtd: "45000.00", ficaWithheldYtd: "3442.50" }),
    { ssRate: "0.062", ssWageBase: "184500" },
  );
  assert.equal(after.box4SsTax, "2790.0000");
  assert.equal(after.box6MedicareTax, "652.5000");
});

test("the FICA split caps Social Security at the wage base", () => {
  const before = w2("e1", { box4SsTax: "0", box6MedicareTax: "0" });
  const after = openingYtdIntoW2Slip(
    before,
    opening({ pensionableYtd: "250000.00", ficaWithheldYtd: "15000.00" }),
    { ssRate: "0.062", ssWageBase: "184500" },
  );
  // 6.2% of the 184,500 base, not of 250,000 in wages.
  assert.equal(after.box4SsTax, "11439.0000");
  assert.equal(after.box6MedicareTax, "3561.0000");
});

test("the FICA split never attributes more than was withheld", () => {
  const before = w2("e1", { box4SsTax: "0", box6MedicareTax: "0" });
  const after = openingYtdIntoW2Slip(
    before,
    opening({ pensionableYtd: "45000.00", ficaWithheldYtd: "100.00" }),
    { ssRate: "0.062", ssWageBase: "184500" },
  );
  assert.equal(after.box4SsTax, "100.0000");
  assert.equal(after.box6MedicareTax, "0.0000");
});

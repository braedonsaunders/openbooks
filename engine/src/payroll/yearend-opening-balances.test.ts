import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, orgContext } from "../platform/db.ts";
import { OPENING_BALANCE_FIELDS } from "./opening-balances.ts";
import { rl1Slips } from "./canada/quebec/rl1.ts";
import type { CanadianOpeningReportingAllocation } from "./canada/opening-reporting-source.ts";
import type { OriginalOpeningSourceChildren } from "./opening-levy-source-reader.ts";
import {
  capAnnualEarnings,
  carryOpeningYearEndYtd,
  openingYtdIntoT4Slip,
  openingYtdIntoW2Slip,
  openingAccountYtdIntoW2Slip,
  seedOpeningOnlySlips,
  t4Slips,
  w2Slips,
} from "./yearend.ts";
import type { OpeningYearEndYtd, T4Slip, W2Slip } from "./yearend.ts";

/** Pure arithmetic helpers and native source-qualified year-end attribution contracts. */

const opening = (overrides: Partial<OpeningYearEndYtd> = {}): OpeningYearEndYtd => ({
  pensionableYtd: "0",
  insurableYtd: "0",
  cppYtd: "0",
  cpp2Ytd: "0",
  eiYtd: "0",
  qpipYtd: "0",
  taxableYtd: "0",
  taxYtd: "0",
  ficaWithheldYtd: "0",
  programBasesYtd: {},
  ...overrides,
});

const t4 = (employeePartyId: string, overrides: Partial<T4Slip> = {}): T4Slip => ({
  employeePartyId,
  employeeName: `Emp ${employeePartyId}`,
  province: "ON",
  isQuebec: false,
  filingAccountId: null,
  box14EmploymentIncome: "50000.0000",
  box16Cpp: "3000.0000",
  box16aCpp2: "0",
  box18Ei: "800.0000",
  box22IncomeTax: "9000.0000",
  box24EiInsurable: "50000.0000",
  box26CppPensionable: "50000.0000",
  box44UnionDues: "0",
  box55Qpip: "0",
  box56QpipInsurable: "0",
  stubCount: 12,
  employerCpp: "0",
  employerCpp2: "0",
  employerEi: "0",
  ...overrides,
});

const w2 = (employeePartyId: string, overrides: Partial<W2Slip> = {}): W2Slip => ({
  employeePartyId,
  employeeName: `Emp ${employeePartyId}`,
  states: ["CA"],
  state: "CA",
  filingAccountId: null,
  box1Wages: "48000.0000",
  box2FederalIncomeTax: "6000.0000",
  box3SsWages: "48000.0000",
  box4SsTax: "2976.0000",
  box5MedicareWages: "48000.0000",
  box6MedicareTax: "696.0000",
  stateLines: [],
  ...overrides,
});

test("every statutory opening amount is additive with committed stubs", () => {
  const [slip] = carryOpeningYearEndYtd(
    [t4("e1")],
    new Map([
      [
        "e1",
        opening({
          pensionableYtd: "12000.50",
          insurableYtd: "11000.25",
          cppYtd: "700.00",
          cpp2Ytd: "120.00",
          eiYtd: "210.75",
          qpipYtd: "33.25",
          taxableYtd: "21000.50",
          taxYtd: "3150.75",
          unionDuesYtd: "250.00",
        }),
      ],
    ]),
    openingYtdIntoT4Slip,
  );
  assert.equal(slip!.box14EmploymentIncome, "71000.5000");
  assert.equal(slip!.box16Cpp, "3700.0000");
  assert.equal(slip!.box16aCpp2, "120.0000");
  assert.equal(slip!.box18Ei, "1010.7500");
  assert.equal(slip!.box22IncomeTax, "12150.7500");
  assert.equal(slip!.box24EiInsurable, "61000.2500");
  assert.equal(slip!.box26CppPensionable, "62000.5000");
  assert.equal(slip!.box44UnionDues, "250.0000");
  assert.equal(slip!.box55Qpip, "33.2500");
  assert.equal(
    slip!.box56QpipInsurable,
    "0.0000",
    "no program base carried: box 56 keeps the stubs alone",
  );
});

test("employer levy carry-in is additive with the committed employer share", () => {
  const carried = openingYtdIntoT4Slip(
    t4("e1", { employerCpp: "3000.0000", employerCpp2: "40.0000", employerEi: "1120.0000" }),
    opening({ employerCppYtd: "700.00", employerCpp2Ytd: "120.00", employerEiYtd: "294.00" }),
  );
  assert.equal(carried.employerCpp, "3700.0000");
  assert.equal(carried.employerCpp2, "160.0000");
  assert.equal(carried.employerEi, "1414.0000");
  assert.equal(
    carried.box24EiInsurable,
    "50000.0000",
    "employer premiums never enter the insurable base",
  );
});

test("the generic employee carry helper adds an aggregate once", () => {
  // This helper guarantees arithmetic deduplication only. Native Canadian
  // readers use source-qualified RP/province slices, tested below.
  const slips = [
    t4("e1", { province: "BC", box14EmploymentIncome: "20000" }),
    t4("e1", { province: "ON", box14EmploymentIncome: "30000" }),
  ];
  const carried = carryOpeningYearEndYtd(
    slips,
    new Map([
      [
        "e1",
        opening({
          pensionableYtd: "21000.50",
          insurableYtd: "19000.25",
          cppYtd: "1200",
          eiYtd: "400",
          taxableYtd: "21000.50",
          taxYtd: "3150.75",
        }),
      ],
    ]),
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

test("T4 carry-in folds the program's own base into box 56, never the EI base", () => {
  // No program base carried: box 56 is untouched, not backfilled from the EI
  // carry-in folded into box 24 above.
  const untouched = openingYtdIntoT4Slip(
    t4("e1"),
    opening({
      taxableYtd: "100.00",
      taxYtd: "20.00",
      pensionableYtd: "100.00",
      insurableYtd: "80.00",
      cppYtd: "5.00",
      cpp2Ytd: "2.00",
      eiYtd: "3.00",
      qpipYtd: "1.00",
    }),
  );
  assert.equal(untouched.box14EmploymentIncome, "50100.0000");
  assert.equal(untouched.box24EiInsurable, "50080.0000");
  assert.equal(untouched.box55Qpip, "1.0000");
  assert.equal(untouched.box56QpipInsurable, "0.0000");
  // A pre-adoption QPIP base lands in box 56 ADDITIVELY with the stubs, while
  // box 24 keeps the EI carry-in alone: the two bases differ by construction
  // (CRA T4 guide: box 56 is QPIP-insurable earnings, box 24 EI-insurable).
  const carried = openingYtdIntoT4Slip(
    t4("e1", { box56QpipInsurable: "20000.0000" }),
    opening({ insurableYtd: "80.00", programBasesYtd: { qpip: "12000.00" } }),
  );
  assert.equal(carried.box56QpipInsurable, "32000.0000");
  assert.equal(carried.box24EiInsurable, "50080.0000");
});

test("a mid-year adopter's box 56 is capped at the QPIP maximum with the stubs", () => {
  // Stubs hold 90,000 of QPIP base; the carry-in adds 20,000 more. The QPIP
  // maximum (103,000) binds the program base while the EI maximum (68,900)
  // binds the EI base alone — neither program consumes the other's room.
  const carried = openingYtdIntoT4Slip(
    t4("qc", { box24EiInsurable: "60000.0000", box56QpipInsurable: "90000.0000" }),
    opening({ insurableYtd: "20000.00", programBasesYtd: { qpip: "20000.00" } }),
  );
  const [capped] = capAnnualEarnings(
    [
      {
        employeePartyId: "qc",
        insurable: carried.box24EiInsurable,
        pensionable: carried.box26CppPensionable,
        qpipInsurable: carried.box56QpipInsurable,
      },
    ],
    { mie: "68900", yampe: "85000", qpipMie: "103000" },
  );
  assert.equal(capped!.box56QpipInsurable, "103000");
  assert.equal(capped!.box24EiInsurable, "68900");
});

test("the generic seed helper creates an opening-only arithmetic row", () => {
  const openings = new Map([
    [
      "e-midyear",
      opening({
        taxableYtd: "21000.50",
        taxYtd: "3150.75",
        pensionableYtd: "50000",
        insurableYtd: "40000",
      }),
    ],
  ]);
  const seeded = seedOpeningOnlySlips([], openings.keys(), (id) =>
    t4(id, {
      box14EmploymentIncome: "0",
      box22IncomeTax: "0",
      box24EiInsurable: "0",
      box26CppPensionable: "0",
      stubCount: 0,
    }),
  );
  assert.equal(seeded.length, 1);
  const [slip] = carryOpeningYearEndYtd(seeded, openings, openingYtdIntoT4Slip);
  assert.equal(slip!.box14EmploymentIncome, "21000.5000");
  assert.equal(slip!.box22IncomeTax, "3150.7500");
  assert.equal(slip!.box24EiInsurable, "40000.0000");
  assert.equal(slip!.box26CppPensionable, "50000.0000");
});

test("the W-2 carry-in is restricted to its federal account", () => {
  const otherEin = w2("e1", { filingAccountId: "ein-b" });
  const after = openingAccountYtdIntoW2Slip(
    otherEin,
    opening({
      accountBasesYtd: {
        us_w2_taxable: [{ filingAccountId: "ein-a", insurableYtd: "12000.25" }],
      },
    }),
  );
  assert.equal(after.box1Wages, "48000.0000");
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
  const openings = new Map([
    ["adopter", opening({ insurableYtd: "40000", pensionableYtd: "70000" })],
  ]);
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

test("box 56 consumes its OWN room at the QPIP maximum", () => {
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

/** Database-boundary facts preserve original source identity independently of live profiles. */
interface MockPopulationRow {
  employeePartyId: string;
  employeeName: string;
  profileCountry: string | null;
  originalCountry: "CA" | "US" | null;
  province: string;
  taxableYtd: string;
  taxYtd?: string;
  employerCppYtd?: string;
  sourceMatches?: boolean;
  annualAmounts?: Record<string, string>;
  children?: OriginalOpeningSourceChildren;
  reportingAllocations?: CanadianOpeningReportingAllocation[];
}

const reportingOrg = "00000000-0000-4000-8000-000000000099";
const originalRp = "00000000-0000-4000-8000-000000000006";
const secondRp = "00000000-0000-4000-8000-000000000007";
const zeroAnnual = Object.fromEntries(OPENING_BALANCE_FIELDS.map((field) => [field.column, "0"]));
const emptyChildren = (): OriginalOpeningSourceChildren => ({
  components: [],
  programBases: [],
  accountBases: [],
  suiStates: [],
});
const reportingAllocation = (
  overrides: Partial<CanadianOpeningReportingAllocation> = {},
): CanadianOpeningReportingAllocation => ({
  sourceOrdinal: 1,
  firstCoveredPayDate: "2026-01-15",
  filingAccountId: originalRp,
  province: "ON",
  annualAmounts: { ...zeroAnnual },
  reportableBases: { ei: "0", cpp: "0", qpip: "0" },
  children: emptyChildren(),
  ...overrides,
});
const originalEmployer = "00000000-0000-4000-8000-000000000004";
const originalEin = "00000000-0000-4000-8000-000000000003";
function mockOpeningPopulations(t: TestContext, population: readonly MockPopulationRow[]) {
  const runner = drizzle.mock();
  const dialect = (
    runner as unknown as {
      dialect: {
        sqlToQuery(query: Parameters<typeof db.execute>[0]): { sql: string; params: unknown[] };
      };
    }
  ).dialect;
  const requestedCountry = (params: unknown[]): string | null =>
    (params.find((param) => param === "CA" || param === "US") as string | undefined) ?? null;
  const material = (row: MockPopulationRow) =>
    [row.taxableYtd, row.taxYtd ?? "0", row.employerCppYtd ?? "0"].some((value) => value !== "0");
  const amounts = (row: MockPopulationRow) => ({
    ...zeroAnnual,
    taxable_ytd: row.taxableYtd,
    tax_ytd: row.taxYtd ?? "0",
    employer_cpp_ytd: row.employerCppYtd ?? "0",
    ...row.annualAmounts,
  });
  t.mock.method(
    runner,
    "execute",
    async (query: Parameters<typeof db.execute>[0], mode?: string) => {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      const built = dialect.sqlToQuery(query);
      if (built.sql === "show transaction_isolation")
        return inMode({ rows: [{ transaction_isolation: "read committed" }] });
      if (built.sql.includes('as "openingSnapshot"')) {
        const row = population.find((row) => built.params.includes(row.employeePartyId));
        if (!row) return inMode({ rows: [] });
        return inMode({
          rows: [
            {
              id: row.employeePartyId,
              openingSnapshot: amounts(row),
              openingChildren: row.children ?? emptyChildren(),
              employerAuthorityId: row.employeePartyId,
              subsidiaryId: originalEmployer,
              sourceAuthorityId: row.originalCountry ? row.employeePartyId : null,
              sealed: row.originalCountry !== null,
              sourceMatches: row.sourceMatches ?? true,
              originalCountry: row.originalCountry,
              originalCurrency: row.originalCountry === "US" ? "USD" : "CAD",
              coverageStart: "2026-01-01",
              coverageEnd: "2026-06-30",
              coverageComplete: true,
              sourceFileId: "00000000-0000-4000-8000-000000000010",
              sourceVersionId: "00000000-0000-4000-8000-000000000011",
              sourceSha256: "a".repeat(64),
              sourceReference: "Complete original employer YTD report",
              openingSha256: "b".repeat(64),
              hasMaterialHistory: material(row),
              hasWageHistory: row.taxableYtd !== "0",
              hasFutaWageHistory: false,
              hasSuiWageHistory: false,
            },
          ],
        });
      }
      if (built.sql.includes("from payroll_opening_levy_source_allocations")) {
        const source = population.find((row) => built.params.includes(row.employeePartyId));
        if (source?.originalCountry === "CA")
          return inMode({
            rows: [
              ...["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"].map(
                (region) => ({
                  programKey: "ca_wcb",
                  region,
                  subRegion: "",
                  filingAccountId: null,
                  federalAccountId: null,
                  amount: "0",
                }),
              ),
              ...["BC", "MB", "NL", "ON"].map((region) => ({
                programKey: "ca_eht",
                region,
                subRegion: "",
                filingAccountId: null,
                federalAccountId: null,
                amount: "0",
              })),
              {
                programKey: "ca_cnt",
                region: "QC",
                subRegion: "",
                filingAccountId: null,
                federalAccountId: null,
                amount: "0",
              },
            ],
          });
        return inMode({
          rows: [
            {
              programKey: "us_futa",
              region: "US",
              subRegion: "",
              filingAccountId: originalEin,
              federalAccountId: originalEin,
              amount: "0",
            },
          ],
        });
      }
      if (built.sql.includes("select distinct b.employee_party_id")) {
        return inMode({
          rows: population.filter(material).map((row) => ({
            employee_party_id: row.employeePartyId,
            display_name: row.employeeName,
          })),
        });
      }
      if (built.sql.includes("from payroll_ca_opening_reporting_authorities r")) {
        const row = population.find((row) => built.params.includes(row.employeePartyId));
        if (!row?.reportingAllocations) return inMode({ rows: [] });
        return inMode({
          rows: [
            {
              id: row.employeePartyId,
              openingBalanceId: row.employeePartyId,
              levyAuthorityId: row.employeePartyId,
              levyAllocationSha256: "c".repeat(64),
              employerAuthorityId: row.employeePartyId,
              employeePartyId: row.employeePartyId,
              taxYear: 2026,
              subsidiaryId: originalEmployer,
              originalCountry: "CA",
              originalCurrency: "CAD",
              coverageStart: "2026-01-01",
              coverageEnd: "2026-06-30",
              openingSha256: "b".repeat(64),
              openingChildrenSha256: "d".repeat(64),
              allocationSha256: "e".repeat(64),
              sourceFileId: "00000000-0000-4000-8000-000000000010",
              sourceVersionId: "00000000-0000-4000-8000-000000000011",
              sourceSha256: "a".repeat(64),
              sourceReference: "Original RP/province year-to-date report",
              matches: true,
              annualAmounts: amounts(row),
              children: row.children ?? emptyChildren(),
              allocationSnapshot: row.reportingAllocations,
            },
          ],
        });
      }
      if (built.sql.includes("select b.employee_party_id as id")) {
        return inMode({
          rows: population.map((row) => ({ id: row.employeePartyId, name: row.employeeName })),
        });
      }
      if (built.sql.includes("from payroll_opening_balances b")) {
        const country = requestedCountry(built.params);
        return inMode({
          rows: population
            .filter((row) => material(row) && row.originalCountry === country)
            .map((row) => ({
              employee_party_id: row.employeePartyId,
              ...amounts(row),
            })),
        });
      }
      if (built.sql.includes('program_type as "programType"')) {
        return inMode({
          rows: [originalRp, secondRp].map((id) => ({
            id,
            orgId: reportingOrg,
            subsidiaryId: originalEmployer,
            country: "CA",
            programType: "ca_rp",
          })),
        });
      }
      if (built.sql.includes("from parties p")) {
        const country = requestedCountry(built.params);
        return inMode({
          rows: population
            .filter((row) => built.params.includes(row.employeePartyId))
            .map((row) => ({
              employee_party_id: row.employeePartyId,
              display_name: row.employeeName,
              province: row.profileCountry === country ? row.province : "",
              filing_account_id: null,
              subsidiary_id: "00000000-0000-4000-8000-000000000005",
            })),
        });
      }
      if (built.sql.includes("from payroll_filing_accounts") && built.sql.includes("for share")) {
        return inMode({
          rows: [
            {
              id: originalEin,
              name: "Original federal EIN",
              program_type: "us_ein",
              subsidiary_id: originalEmployer,
              state_code: null,
              is_active: false,
              account_number: "12-3456789",
            },
          ],
        });
      }
      return inMode({ rows: [] });
    },
  );
  return <Reader extends (orgId: string, taxYear: number) => Promise<unknown>>(
    read: Reader,
    orgId = reportingOrg,
  ): ReturnType<Reader> =>
    orgContext.run({ orgId, bypass: false, txDb: runner }, () =>
      read(orgId, 2026),
    ) as ReturnType<Reader>;
}

for (const amounts of [
  { taxableYtd: "12000" },
  { taxableYtd: "0", taxYtd: "125" },
  { taxableYtd: "0", employerCppYtd: "75" },
]) {
  test(
    "material openings require the original source even when a current country is known " +
      JSON.stringify(amounts),
    async (t) => {
      const readInContext = mockOpeningPopulations(t, [
        {
          employeePartyId: "00000000-0000-4000-8000-000000000001",
          employeeName: "Unqualified Original",
          profileCountry: "CA",
          originalCountry: null,
          province: "ON",
          ...amounts,
        },
      ]);
      for (const read of [t4Slips, w2Slips]) {
        await assert.rejects(
          readInContext(read),
          /original opening source|statutory levy source allocation/,
        );
      }
    },
  );
}

test("original country routes openings despite a different or missing current profile", async (t) => {
  const caEmployee = "00000000-0000-4000-8000-000000000001";
  const usEmployee = "00000000-0000-4000-8000-000000000002";
  const orgId = "00000000-0000-4000-8000-000000000099";
  const readInContext = mockOpeningPopulations(t, [
    {
      employeePartyId: caEmployee,
      employeeName: "CA Original",
      profileCountry: "US",
      originalCountry: "CA",
      province: "TX",
      taxableYtd: "12000",
      taxYtd: "125",
      reportingAllocations: [
        reportingAllocation({
          annualAmounts: { ...zeroAnnual, taxable_ytd: "12000", tax_ytd: "125" },
        }),
      ],
    },
    {
      employeePartyId: usEmployee,
      employeeName: "US Original",
      profileCountry: null,
      originalCountry: "US",
      province: "",
      taxableYtd: "34000",
    },
  ]);
  const ca = await readInContext(t4Slips, orgId),
    us = await readInContext(w2Slips, orgId);
  assert.deepEqual(
    ca.map((slip) => slip.employeePartyId),
    [caEmployee],
  );
  assert.equal(ca[0]!.box14EmploymentIncome, "12000.0000");
  assert.equal(ca[0]!.box22IncomeTax, "125.0000");
  assert.equal(ca[0]!.province, "ON");
  assert.equal(ca[0]!.filingAccountId, originalRp);
  assert.deepEqual(
    await readInContext(rl1Slips, orgId),
    [],
    "neither original ON nor US wages become Québec wages from a current profile",
  );
  assert.deepEqual(
    us.map((slip) => slip.employeePartyId),
    [usEmployee],
  );
  assert.equal(us[0]!.box1Wages, "34000.0000");
  assert.equal(us[0]!.filingAccountId, originalEin);
});

test("a mismatched original source refuses both year-end populations", async (t) => {
  const readInContext = mockOpeningPopulations(t, [
    {
      employeePartyId: "00000000-0000-4000-8000-000000000001",
      employeeName: "Changed Source",
      profileCountry: "US",
      originalCountry: "CA",
      province: "TX",
      taxableYtd: "12000",
      sourceMatches: false,
    },
  ]);
  for (const read of [t4Slips, w2Slips]) {
    await assert.rejects(readInContext(read), /no longer matches/);
  }
});

for (const missing of [
  "certificate",
  "filingAccountId",
  "province",
  "ei",
  "cpp",
  "qpip",
] as const) {
  test(`Canadian material history refuses a missing original reporting ${missing}`, async (t) => {
    const allocation = reportingAllocation({
      annualAmounts: { ...zeroAnnual, taxable_ytd: "12000" },
    });
    if (missing === "filingAccountId") allocation.filingAccountId = "";
    if (missing === "province") allocation.province = "";
    if (missing === "ei" || missing === "cpp" || missing === "qpip")
      Reflect.deleteProperty(allocation.reportableBases, missing);
    const readInContext = mockOpeningPopulations(t, [
      {
        employeePartyId: "00000000-0000-4000-8000-000000000001",
        employeeName: "Canadian Original",
        originalCountry: "CA",
        profileCountry: "CA",
        province: "QC",
        taxableYtd: "12000",
        ...(missing === "certificate" ? {} : { reportingAllocations: [allocation] }),
      },
    ]);
    for (const read of [t4Slips, rl1Slips]) {
      await assert.rejects(
        readInContext(read),
        /original reporting source|original native RP account and province|Original reportable bases must contain every original field/,
      );
    }
  });
}

test("source-declared RP/province slices retain exact amounts and capped bases after a current profile move", async (t) => {
  const annual = {
    ...zeroAnnual,
    taxable_ytd: "120000.0001",
    tax_ytd: "12000",
    pensionable_ytd: "120000",
    insurable_ytd: "120000",
    cpp_ytd: "4000",
    cpp2_ytd: "396",
    ei_ytd: "1000",
    qpip_ytd: "200",
  };
  const children = {
    ...emptyChildren(),
    programBases: [{ program_key: "qpip", insurable_ytd: "40000" }],
  };
  const allocations = [
    reportingAllocation({
      sourceOrdinal: 2,
      firstCoveredPayDate: "2026-03-15",
      filingAccountId: secondRp,
      province: "ON",
      annualAmounts: {
        ...zeroAnnual,
        taxable_ytd: "80000.0001",
        tax_ytd: "8000",
        pensionable_ytd: "80000",
        insurable_ytd: "80000",
        cpp_ytd: "2500",
        cpp2_ytd: "296",
        ei_ytd: "650",
      },
      reportableBases: { ei: "43900", cpp: "60000", qpip: "0" },
      children: { ...emptyChildren(), programBases: [{ program_key: "qpip", insurable_ytd: "0" }] },
    }),
    reportingAllocation({
      province: "QC",
      annualAmounts: {
        ...zeroAnnual,
        taxable_ytd: "40000",
        tax_ytd: "4000",
        pensionable_ytd: "40000",
        insurable_ytd: "40000",
        cpp_ytd: "1500",
        cpp2_ytd: "100",
        ei_ytd: "350",
        qpip_ytd: "200",
      },
      reportableBases: { ei: "25000", cpp: "25000", qpip: "40000" },
      children,
    }),
  ];
  const row: MockPopulationRow = {
    employeePartyId: "00000000-0000-4000-8000-000000000001",
    employeeName: "Original Canadian",
    originalCountry: "CA",
    profileCountry: "CA",
    province: "BC",
    taxableYtd: annual.taxable_ytd,
    taxYtd: annual.tax_ytd,
    annualAmounts: annual,
    children,
    reportingAllocations: allocations,
  };
  const readInContext = mockOpeningPopulations(t, [row]);
  const before = await readInContext(t4Slips);
  assert.deepEqual(
    before.map((slip) => [
      slip.filingAccountId,
      slip.province,
      slip.box14EmploymentIncome,
      slip.box22IncomeTax,
      slip.box24EiInsurable,
      slip.box26CppPensionable,
      slip.box56QpipInsurable,
    ]),
    [
      [originalRp, "QC", "40000.0000", "4000.0000", "25000.0000", "25000.0000", "40000.0000"],
      [secondRp, "ON", "80000.0001", "8000.0000", "43900.0000", "60000.0000", "0.0000"],
    ],
  );
  row.profileCountry = "US";
  row.province = "TX";
  assert.deepEqual(await readInContext(t4Slips), before);
  const quebec = await readInContext(rl1Slips);
  assert.equal(quebec.length, 1);
  assert.equal(quebec[0]!.boxA, "40000.0000");
  assert.equal(quebec[0]!.boxG, "25000.0000");
  assert.equal(quebec[0]!.boxI, "40000.0000");
});

test("a FICA tax withheld carry-in splits into W-2 boxes 4 and 6", () => {
  // The combined FICA carry-in reached no box, so an adopted
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

test("box 3 caps the FICA wage carry-in at the Social Security wage base", () => {
  // A $200,000 prior-provider FICA wage carry-in alone is past the 2025
  // $176,100 base: box 3 files the base (the SSA rejects more), box 5 the
  // full Medicare wages. Committed stubs and the carry-in cap together.
  const rates = { ssRate: "0.062", ssWageBase: "176100" };
  const fresh = w2("e1", { box3SsWages: "0", box5MedicareWages: "0" });
  const legacy = openingYtdIntoW2Slip(fresh, opening({ pensionableYtd: "200000" }), rates);
  assert.equal(legacy.box3SsWages, "176100.0000");
  assert.equal(legacy.box5MedicareWages, "200000.0000");
  const perEin = openingAccountYtdIntoW2Slip(
    { ...fresh, filingAccountId: "ein-a" },
    opening({
      accountBasesYtd: {
        us_w2_fica_wages: [{ filingAccountId: "ein-a", insurableYtd: "150000" }],
      },
    }),
    rates,
  );
  assert.equal(perEin.box3SsWages, "150000.0000");
  const withStubs = openingAccountYtdIntoW2Slip(
    { ...fresh, filingAccountId: "ein-a", box3SsWages: "26100.0000" },
    opening({
      accountBasesYtd: { us_w2_fica_wages: [{ filingAccountId: "ein-a", insurableYtd: "160000" }] },
    }),
    rates,
  );
  assert.equal(withStubs.box3SsWages, "176100.0000");
});

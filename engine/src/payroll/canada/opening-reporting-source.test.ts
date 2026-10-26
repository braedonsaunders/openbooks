import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalCanadianOpeningReportingAllocations,
  openingReportingAllocationChildren,
  type CanadianOpeningReportingAllocation,
  type CanadianOpeningReportingCatalogue,
  type CanadianOpeningReportingOriginal,
} from "./opening-reporting-source.ts";

const orgId = "10000000-0000-4000-8000-000000000001";
const subsidiaryId = "10000000-0000-4000-8000-000000000002";
const rp1 = "10000000-0000-4000-8000-000000000003";
const rp2 = "10000000-0000-4000-8000-000000000004";
const componentId = "10000000-0000-4000-8000-000000000005";
const catalogue: CanadianOpeningReportingCatalogue = {
  annualFields: [
    { column: "pensionable_ytd", packs: ["CA", "US"] },
    { column: "insurable_ytd", packs: ["CA"] },
    { column: "taxable_ytd", packs: ["CA", "US"] },
    { column: "cpp_ytd", packs: ["CA"] },
    { column: "qc_tax_ytd", packs: ["CA"] },
    { column: "qpip_ytd", packs: ["CA"] },
    { column: "employer_cpp_ytd", packs: ["CA"] },
    { column: "fica_withheld_ytd", packs: ["US"] },
  ],
  components: [{ id: componentId, country: null }],
  programs: [
    { programKey: "ei", country: "CA" },
    { programKey: "qpip", country: "CA", provinces: ["QC"] },
  ],
  filingAccounts: [rp1, rp2].map((id) => ({
    id,
    orgId,
    subsidiaryId,
    country: "CA",
    programType: "ca_rp",
  })),
};

function fixture(): {
  original: CanadianOpeningReportingOriginal;
  allocations: CanadianOpeningReportingAllocation[];
} {
  return {
    original: {
      orgId,
      subsidiaryId,
      originalCountry: "CA",
      originalCurrency: "CAD",
      coverageStart: "2026-01-01",
      coverageEnd: "2026-06-30",
      annualAmounts: {
        pensionable_ytd: "0",
        insurable_ytd: "0",
        taxable_ytd: "10000.0001",
        cpp_ytd: "700",
        qc_tax_ytd: "500",
        qpip_ytd: "40",
        employer_cpp_ytd: "700",
        fica_withheld_ytd: "0",
      },
      children: {
        components: [{ component_id: componentId, ytd_amount: "1000.0001" }],
        programBases: [{ program_key: "qpip", insurable_ytd: "6000" }],
        accountBases: [
          { program_key: "ei", filing_account_id: rp1, region: null, insurable_ytd: "4000.0001" },
        ],
        suiStates: [],
      },
    },
    allocations: [
      {
        filingAccountId: rp1,
        province: "ON",
        sourceOrdinal: 1,
        firstCoveredPayDate: "2026-01-15",
        reportableBases: { ei: "0", cpp: "0", qpip: "0" },
        annualAmounts: {
          pensionable_ytd: "0",
          insurable_ytd: "0",
          taxable_ytd: "4000.0001",
          cpp_ytd: "280",
          qc_tax_ytd: "0",
          qpip_ytd: "0",
          employer_cpp_ytd: "280",
          fica_withheld_ytd: "0",
        },
        children: {
          components: [{ component_id: componentId, ytd_amount: "400.0001" }],
          programBases: [{ program_key: "qpip", insurable_ytd: "0" }],
          accountBases: [
            { program_key: "ei", filing_account_id: rp1, region: null, insurable_ytd: "4000.0001" },
          ],
          suiStates: [],
        },
      },
      {
        filingAccountId: rp2,
        province: "QC",
        sourceOrdinal: 2,
        firstCoveredPayDate: "2026-03-15",
        reportableBases: { ei: "0", cpp: "0", qpip: "6000" },
        annualAmounts: {
          pensionable_ytd: "0",
          insurable_ytd: "0",
          taxable_ytd: "6000",
          cpp_ytd: "420",
          qc_tax_ytd: "500",
          qpip_ytd: "40",
          employer_cpp_ytd: "420",
          fica_withheld_ytd: "0",
        },
        children: {
          components: [{ component_id: componentId, ytd_amount: "600" }],
          programBases: [{ program_key: "qpip", insurable_ytd: "6000" }],
          accountBases: [
            { program_key: "ei", filing_account_id: rp1, region: null, insurable_ytd: "0" },
          ],
          suiStates: [],
        },
      },
    ],
  };
}

test("complete original RP/province allocations preserve all annual and child amounts deterministically", () => {
  const { original, allocations } = fixture();
  const snapshot = structuredClone({ original, allocations });
  const canonical = canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue);
  assert.equal(canonical[0]!.annualAmounts.taxable_ytd, "4000.0001");
  assert.equal(canonical[1]!.annualAmounts.qc_tax_ytd, "500.0000");
  assert.equal(canonical[0]!.children.components[0]!.ytd_amount, "400.0001");
  assert.deepEqual(
    canonicalCanadianOpeningReportingAllocations(original, [...allocations].reverse(), catalogue),
    canonical,
  );
  assert.deepEqual({ original, allocations }, snapshot);
});

test("allocation input from retained source rows preserves money and identity without admitting storage metadata", () => {
  const { original, allocations } = fixture();
  const first = allocations[0]!;
  const retained = {
    components: first.children.components.map((row) => ({
      ...row,
      id: orgId,
      org_id: orgId,
      opening_balance_id: subsidiaryId,
    })),
    programBases: first.children.programBases.map((row) => ({
      ...row,
      org_id: orgId,
      employee_party_id: componentId,
      tax_year: 2026,
    })),
    accountBases: first.children.accountBases.map((row) => ({
      ...row,
      org_id: orgId,
      employee_party_id: componentId,
      tax_year: 2026,
    })),
    suiStates: first.children.suiStates,
  };
  const before = structuredClone(retained);
  assert.throws(
    () =>
      canonicalCanadianOpeningReportingAllocations(
        original,
        [{ ...first, children: retained }, allocations[1]!],
        catalogue,
      ),
    /every original field/,
  );
  assert.deepEqual(
    canonicalCanadianOpeningReportingAllocations(
      original,
      [{ ...first, children: openingReportingAllocationChildren(retained) }, allocations[1]!],
      catalogue,
    ),
    canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
  );
  assert.deepEqual(retained, before);
});

test("allocation arithmetic retains precision beyond binary floating-point money", () => {
  const { original, allocations } = fixture();
  original.annualAmounts = { ...original.annualAmounts, taxable_ytd: "9007199254740993.0001" };
  allocations[0]!.annualAmounts.taxable_ytd = "9007199254740992.0001";
  allocations[1]!.annualAmounts.taxable_ytd = "1";
  assert.equal(
    canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue)[0]!.annualAmounts
      .taxable_ytd,
    "9007199254740992.0001",
  );
  allocations[1]!.annualAmounts.taxable_ytd = "1.0001";
  assert.throws(
    () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
    /exact original taxable_ytd/,
  );
});

test("missing or additional annual facts refuse even when the omitted original amount is zero", () => {
  for (const modify of [
    (row: CanadianOpeningReportingAllocation) => {
      delete row.annualAmounts.fica_withheld_ytd;
    },
    (row: CanadianOpeningReportingAllocation) => {
      row.annualAmounts.unknown_ytd = "0";
    },
  ]) {
    const { original, allocations } = fixture();
    modify(allocations[0]!);
    assert.throws(
      () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
      /every original field/,
    );
  }
});

test("component, program and account identities cannot disappear, multiply or introduce amounts", () => {
  for (const modify of [
    (row: CanadianOpeningReportingAllocation) => {
      row.children.components = [];
    },
    (row: CanadianOpeningReportingAllocation) => {
      row.children.programBases.push({ ...row.children.programBases[0]! });
    },
    (row: CanadianOpeningReportingAllocation) => {
      row.children.accountBases[0]!.insurable_ytd = "4000";
    },
  ]) {
    const { original, allocations } = fixture();
    modify(allocations[0]!);
    assert.throws(
      () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
      /original identity|original amount/,
    );
  }
});

test("an account-specific opening base cannot move between RP accounts", () => {
  const { original, allocations } = fixture();
  allocations[0]!.children.accountBases[0]!.insurable_ytd = "0";
  allocations[1]!.children.accountBases[0]!.insurable_ytd = "4000.0001";
  assert.throws(
    () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
    /cannot be reassigned/,
  );
});

test("the original RP must resolve to the exact organization and legal employer without a default", () => {
  for (const patch of [
    { orgId: rp1 },
    { subsidiaryId: null },
    { subsidiaryId: rp2 },
    { country: "US" },
    { programType: "us_ein" },
  ]) {
    const { original, allocations } = fixture();
    const native = structuredClone(catalogue);
    native.filingAccounts = native.filingAccounts.map((account) =>
      account.id === rp1 ? { ...account, ...patch } : account,
    );
    assert.throws(
      () => canonicalCanadianOpeningReportingAllocations(original, allocations, native),
      /source-qualified legal employer/,
    );
  }
});

test("Québec-only premiums, withholding and program bases cannot land on non-Québec employment", () => {
  for (const modify of [
    (row: CanadianOpeningReportingAllocation) => {
      row.annualAmounts.qc_tax_ytd = "1";
    },
    (row: CanadianOpeningReportingAllocation) => {
      row.annualAmounts.qpip_ytd = "1";
    },
    (row: CanadianOpeningReportingAllocation) => {
      row.children.programBases[0]!.insurable_ytd = "1";
    },
  ]) {
    const { original, allocations } = fixture();
    modify(allocations[0]!);
    assert.throws(
      () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
      /original Québec employment|original program jurisdiction/,
    );
  }
});

test("mixed foreign history, unknown programs and absent exact source attribution refuse", () => {
  const { original, allocations } = fixture();
  assert.throws(
    () =>
      canonicalCanadianOpeningReportingAllocations(
        { ...original, originalCountry: "US" },
        allocations,
        catalogue,
      ),
    /original Canadian/,
  );
  assert.throws(
    () => canonicalCanadianOpeningReportingAllocations(original, [], catalogue),
    /every original Canadian/,
  );
  assert.throws(
    () =>
      canonicalCanadianOpeningReportingAllocations(
        original,
        [...allocations, { ...allocations[0]!, sourceOrdinal: 3 }],
        catalogue,
      ),
    /one reporting allocation/,
  );
  original.annualAmounts = { ...original.annualAmounts, fica_withheld_ytd: "1" };
  assert.throws(
    () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
    /another statutory country/,
  );
  original.annualAmounts = { ...original.annualAmounts, fica_withheld_ytd: "0" };
  allocations[0]!.children.programBases[0]!.program_key = "unknown";
  assert.throws(
    () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
    /unknown or foreign/,
  );
});

test("numeric coercion, grouping, scientific notation and negative allocations refuse", () => {
  for (const value of [4000, "4,000", "4e3", "-1", "0.00001", undefined]) {
    const { original, allocations } = fixture();
    allocations[0]!.annualAmounts.taxable_ytd = value as string;
    assert.throws(
      () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
      /explicit non-negative exact decimal/,
    );
  }
});

test("source ordinals determine cap order even when account lexical order differs", () => {
  const { original, allocations } = fixture();
  allocations[0]!.sourceOrdinal = 4;
  allocations[0]!.firstCoveredPayDate = "2026-04-15";
  allocations[1]!.sourceOrdinal = 2;
  allocations[1]!.firstCoveredPayDate = "2026-02-15";
  const ordered = canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue);
  assert.deepEqual(
    ordered.map((row) => row.filingAccountId),
    [rp2, rp1],
  );
  assert.deepEqual(
    ordered.map((row) => row.sourceOrdinal),
    [2, 4],
  );
});

test("same-date cap priority is source-attested by a unique ordinal", () => {
  const { original, allocations } = fixture();
  allocations[0]!.firstCoveredPayDate = allocations[1]!.firstCoveredPayDate = "2026-03-15";
  allocations[0]!.sourceOrdinal = 7;
  allocations[1]!.sourceOrdinal = 3;
  assert.deepEqual(
    canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue).map(
      (row) => row.filingAccountId,
    ),
    [rp2, rp1],
  );
});

test("missing, repeated, coerced, fractional and unbounded ordinals refuse", () => {
  for (const value of [undefined, 0, -1, 1.5, "2", 2147483648]) {
    const { original, allocations } = fixture();
    allocations[0]!.sourceOrdinal = value as number;
    assert.throws(
      () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
      /unique positive source ordinal/,
    );
  }
  const { original, allocations } = fixture();
  allocations[1]!.sourceOrdinal = allocations[0]!.sourceOrdinal;
  assert.throws(
    () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
    /unique positive source ordinal/,
  );
});

test("original first pay dates require exact valid dates inside certified coverage", () => {
  for (const value of [
    "2025-12-31",
    "2026-07-01",
    "2026-02-30",
    "2026-1-15",
    undefined,
    20260115,
  ]) {
    const { original, allocations } = fixture();
    allocations[0]!.firstCoveredPayDate = value as string;
    assert.throws(
      () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
      /first covered pay date/,
    );
  }
  const { original, allocations } = fixture();
  allocations[0]!.firstCoveredPayDate = original.coverageStart;
  allocations[1]!.firstCoveredPayDate = original.coverageEnd;
  assert.equal(
    canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue).length,
    2,
  );
});

test("contradictory source chronology and invalid original coverage refuse", () => {
  const { original, allocations } = fixture();
  allocations[0]!.sourceOrdinal = 3;
  assert.throws(
    () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
    /preserve first covered pay date chronology/,
  );
  assert.throws(
    () =>
      canonicalCanadianOpeningReportingAllocations(
        { ...original, coverageStart: "2026-07-01" },
        allocations,
        catalogue,
      ),
    /coverage is reversed/,
  );
  assert.throws(
    () =>
      canonicalCanadianOpeningReportingAllocations(
        { ...original, coverageEnd: "2026-06-31" },
        allocations,
        catalogue,
      ),
    /valid calendar dates/,
  );
});

test("source-attested capped bases preserve allocation when original RP periods interleave", () => {
  const { original, allocations } = fixture();
  original.annualAmounts = {
    ...original.annualAmounts,
    pensionable_ytd: "100000",
    insurable_ytd: "80000",
  };
  allocations[0]!.annualAmounts = {
    ...allocations[0]!.annualAmounts,
    pensionable_ytd: "40000",
    insurable_ytd: "40000",
  };
  allocations[1]!.annualAmounts = {
    ...allocations[1]!.annualAmounts,
    pensionable_ytd: "60000",
    insurable_ytd: "40000",
  };
  allocations[0]!.reportableBases = { ei: "30000", cpp: "30000", qpip: "0" };
  allocations[1]!.reportableBases = { ei: "38900", cpp: "55000", qpip: "6000" };
  const source = canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue);
  assert.deepEqual(
    source.map((row) => row.reportableBases.cpp),
    ["30000.0000", "55000.0000"],
  );
  allocations[1]!.reportableBases.ei = "38900.0001";
  assert.throws(
    () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
    /annual maximum/,
  );
  allocations[1]!.reportableBases.ei = "38900";
  allocations[0]!.reportableBases.cpp = "40000.0001";
  assert.throws(
    () => canonicalCanadianOpeningReportingAllocations(original, allocations, catalogue),
    /exceeds/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { filingAccountRef, type PayrollFilingAccount } from "./filing.ts";
import { cmp } from "../money/money.ts";
import {
  duplicateRemittanceMessage,
  groupRemittanceRows,
  pickRemittanceSequence,
  pickRemittanceSlice,
  remittanceBillLockKey,
  remittanceGroupRegionalCalendar,
  remittancePeriodProblem,
  remittanceRegionalCalendarsFor,
  type RemittanceRow,
} from "./remittance.ts";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";
import { renderT4Xml, type T4ReturnWithSins } from "./canada/t4xml.ts";
import type { T4Slip, T4SummaryTotals } from "./yearend.ts";

/**
 * Multi-account filing: an employer that remits and files under several
 * payroll program accounts must never mix them. These cover the two places
 * that would leak — the PD7A remittance grouping and the T4 transmittal.
 */

const RP1: PayrollFilingAccount = {
  id: "acct-1", country: "CA", programType: "ca_rp", accountNumber: "123456789RP0001",
  name: "Head office", remitterType: "regular", subsidiaryId: null, stateCode: null,
  isDefault: true, isActive: true,
};
const RP2: PayrollFilingAccount = {
  ...RP1, id: "acct-2", accountNumber: "123456789RP0002", name: "Field division",
  remitterType: "accelerated_1", isDefault: false,
};
const ACCOUNTS = new Map([[RP1.id, RP1], [RP2.id, RP2]]);

function row(overrides: Partial<RemittanceRow>): RemittanceRow {
  const base: Omit<RemittanceRow, "sliceAmount"> = {
    component_id: "c1", code: "TAX", name: "Income tax", kind: "deduction",
    system_key: "income_tax", country: "CA", remittance_party_id: "cra", liability_account_id: "gl-tax",
    filing_account_id: RP1.id, filingUnknown: false, province: "ON", amount: "100.00",
    subsidiary_id: "sub-a" as string | null, currency: "CAD",
    ...overrides,
  };
  return { ...base, sliceAmount: overrides.sliceAmount ?? base.amount };
}

const CONTEXT = new Map([
  [RP1.id, { gross: "10000.00", employees: 4 }],
  [RP2.id, { gross: "5000.00", employees: 2 }],
  ["", { gross: "250.00", employees: 1 }],
]);

const group = (rows: RemittanceRow[]) =>
  groupRemittanceRows({
    rows,
    contextByAccount: CONTEXT,
    filingAccounts: ACCOUNTS,
    resolveParty: (r) => r.remittance_party_id,
    resolveAccount: (r) => r.liability_account_id,
  });

test("remittance groups split one destination across its filing accounts", () => {
  const groups = group([
    row({ amount: "100.00", filing_account_id: RP1.id }),
    row({ component_id: "c2", code: "CPP", name: "CPP", system_key: "cpp", amount: "40.00", filing_account_id: RP1.id }),
    row({ amount: "60.00", filing_account_id: RP2.id }),
  ]);

  assert.equal(groups.size, 2, "same CRA vendor, two program accounts, two PD7As");
  const byAccount = new Map([...groups.values()].map((g) => [g.filingAccount.accountNumber, g]));
  assert.equal(byAccount.get("123456789RP0001")!.total, "140.0000");
  assert.equal(byAccount.get("123456789RP0002")!.total, "60.0000");
  // PD7A context is the account's own payroll, never the org's.
  assert.equal(byAccount.get("123456789RP0001")!.employeeCount, 4);
  assert.equal(byAccount.get("123456789RP0002")!.employeeCount, 2);
  // The remitter type rides along so the due-date calendar can use it.
  assert.equal(byAccount.get("123456789RP0002")!.filingAccount.remitterType, "accelerated_1");
});

test("employees on no filing account stay in one unassigned group", () => {
  const groups = group([
    row({ amount: "100.00", filing_account_id: null }),
    row({ component_id: "c2", code: "EI", name: "EI", system_key: "ei", amount: "25.00", filing_account_id: null }),
  ]);
  assert.equal(groups.size, 1);
  const [only] = [...groups.values()];
  assert.equal(only!.filingAccount.id, null);
  assert.equal(only!.filingAccount.accountNumber, null);
  assert.equal(only!.total, "125.0000");
  assert.equal(only!.employeeCount, 1);
});

test("different destinations under one account remain separate groups", () => {
  const groups = group([
    row({ remittance_party_id: "cra", amount: "100.00" }),
    row({ component_id: "c9", code: "DUES", name: "Union dues", system_key: null, remittance_party_id: "local-1", amount: "30.00" }),
  ]);
  assert.equal(groups.size, 2);
});

test("remittance groups carry their stub provinces for the due-date calendar", () => {
  const groups = group([
    row({ amount: "100.00", filing_account_id: RP1.id, province: "QC" }),
    row({ component_id: "c2", code: "CPP", name: "CPP", system_key: "cpp", amount: "40.00", filing_account_id: RP1.id, province: "QC" }),
    row({ amount: "60.00", filing_account_id: RP2.id, province: "ON" }),
  ]);
  const byAccount = new Map([...groups.values()].map((g) => [g.filingAccount.accountNumber, g]));
  assert.deepEqual(byAccount.get("123456789RP0001")!.provinces, ["QC"]);
  assert.deepEqual(byAccount.get("123456789RP0002")!.provinces, ["ON"]);
});

test("one group carries one native-currency slice per legal entity", () => {
  const SUBS = new Map([
    ["sub-a", { name: "Alpha Co", currency: "CAD" }],
    ["sub-b", { name: "Beta Co", currency: "CAD" }],
  ]);
  const groups = groupRemittanceRows({
    rows: [
      row({ amount: "100.00", subsidiary_id: "sub-a" }),
      row({ component_id: "c2", code: "CPP", name: "CPP", system_key: "cpp", amount: "40.00", subsidiary_id: "sub-b" }),
    ],
    contextByAccount: CONTEXT,
    filingAccounts: ACCOUNTS,
    resolveParty: (r) => r.remittance_party_id,
    resolveAccount: (r) => r.liability_account_id,
    subsidiaries: SUBS,
  });
  assert.equal(groups.size, 1, "one destination and account stays one group");
  const [only] = [...groups.values()];
  // The READ path is unchanged: consolidated total plus the account's own
  // worksheet context, exactly as a de-consolidated GROUP BY would break.
  assert.equal(only!.total, "140.0000");
  assert.equal(only!.grossPayroll, "10000.00");
  assert.equal(only!.employeeCount, 4);
  assert.equal(only!.hasEntitylessAccruals, false);
  // The WRITE path splits: one slice per entity, native units, labelled.
  assert.equal(only!.slices.length, 2);
  const bySub = new Map(only!.slices.map((s) => [s.subsidiaryId, s]));
  assert.equal(bySub.get("sub-a")!.total, "100.0000");
  assert.equal(bySub.get("sub-a")!.currency, "CAD");
  assert.equal(bySub.get("sub-a")!.subsidiaryName, "Alpha Co");
  assert.equal(bySub.get("sub-b")!.total, "40.0000");
  assert.equal(bySub.get("sub-b")!.subsidiaryName, "Beta Co");
  assert.equal(
    cmp(bySub.get("sub-a")!.total, "0") !== 0 && cmp(bySub.get("sub-b")!.total, "0") !== 0,
    true,
  );
});

test("one component across two historical liability accounts keeps two lines", () => {
  // A setup change between runs must not merge the old account's accrual
  // into the new account's line: the bill would debit one account for both.
  const groups = group([
    row({ amount: "100.00", liability_account_id: "gl-tax-old" }),
    row({ amount: "50.00", liability_account_id: "gl-tax-new" }),
  ]);
  const [only] = [...groups.values()];
  assert.equal(cmp(only!.total, "150"), 0);
  assert.equal(only!.components.length, 2);
  const byAccount = new Map(only!.components.map((c) => [c.liabilityAccountId, c]));
  assert.equal(cmp(byAccount.get("gl-tax-old")!.amount, "100"), 0);
  assert.equal(cmp(byAccount.get("gl-tax-new")!.amount, "50"), 0);
  // Same component, same account still folds: provinces re-merge, accounts do not.
  const merged = group([
    row({ amount: "100.00", province: "ON" }),
    row({ amount: "50.00", province: "QC" }),
  ]);
  assert.equal([...merged.values()][0]!.components.length, 1);
  // The entity slice splits identically: one bill line per credited account.
  const [slice] = only!.slices;
  assert.equal(slice!.components.length, 2);
});

test("entityless accruals stay consolidated and flag the group", () => {
  const groups = group([
    row({ amount: "100.00", subsidiary_id: "sub-a" }),
    row({ component_id: "c2", code: "CPP", name: "CPP", system_key: "cpp", amount: "40.00", subsidiary_id: null }),
  ]);
  const [only] = [...groups.values()];
  assert.equal(only!.total, "140.0000", "the money stays visible in the consolidated group");
  assert.equal(only!.hasEntitylessAccruals, true);
  assert.equal(only!.slices.length, 1, "only the attributed entity slices");
  assert.equal(only!.slices[0]!.subsidiaryId, "sub-a");
});

test("pickRemittanceSlice passes one slice through and refuses ambiguity", () => {
  const groups = group([
    row({ amount: "100.00", subsidiary_id: "sub-a" }),
  ]);
  const [sole] = [...groups.values()];
  assert.equal(pickRemittanceSlice(sole!, null).subsidiaryId, "sub-a");
  assert.equal(pickRemittanceSlice(sole!, "sub-a").subsidiaryId, "sub-a");
  assert.throws(
    () => pickRemittanceSlice(sole!, "sub-b"),
    /nothing to remit/,
    "naming an entity with no accruals bills nothing",
  );

  const multi = group([
    row({ amount: "100.00", subsidiary_id: "sub-a" }),
    row({ component_id: "c2", code: "CPP", name: "CPP", system_key: "cpp", amount: "40.00", subsidiary_id: "sub-b" }),
  ]);
  const [both] = [...multi.values()];
  assert.equal(pickRemittanceSlice(both!, "sub-b").total, "40.0000");
  assert.throws(
    () => pickRemittanceSlice(both!, null),
    /spans 2 legal entities.*raise one bill per entity/,
    "an unnamed multi-entity group splits rather than billing as one",
  );

  const empty = group([row({ amount: "100.00", subsidiary_id: null })]);
  const [flagged] = [...empty.values()];
  assert.throws(
    () => pickRemittanceSlice(flagged!, null),
    /no legal entity/,
    "entityless money never becomes a bill",
  );
});

test("a pack's regional calendar governs exactly the single-region payrolls", () => {
  // Saint-Jean-Baptiste Day moves a Quebec deadline and the Civic Holiday
  // moves everyone else's; the bill must ask which calendar its payroll is
  // on. A mixed payroll keeps the national calendar (the employer's province
  // of record decides, which the product does not model) — never a guess.
  const CA = PAYROLL_COUNTRY_PACKS.CA!.remittanceRegionalCalendars;
  assert.equal(remittanceGroupRegionalCalendar(["QC"], CA), "CA-CRA-QC");
  assert.equal(remittanceGroupRegionalCalendar(["QC", "QC"], CA), "CA-CRA-QC");
  assert.equal(remittanceGroupRegionalCalendar(["ON"], CA), null);
  assert.equal(remittanceGroupRegionalCalendar(["QC", "ON"], CA), null);
  assert.equal(remittanceGroupRegionalCalendar([], CA), null);
  // The rule is the DECLARATION's, not Canada's: a pack that declares no
  // regional calendar gets the national one for every region, including one
  // another pack happens to call the same thing.
  assert.equal(remittanceGroupRegionalCalendar(["QC"], {}), null);
  // And an unplaceable group never borrows a pack it does not belong to.
  assert.equal(remittanceGroupRegionalCalendar(["QC"], remittanceRegionalCalendarsFor(null)), null);
});

test("filingAccountRef labels a known account and degrades honestly", () => {
  assert.deepEqual(filingAccountRef(RP2.id, ACCOUNTS), {
    id: "acct-2", accountNumber: "123456789RP0002", name: "Field division",
    remitterType: "accelerated_1",
  });
  assert.deepEqual(filingAccountRef(null, ACCOUNTS), {
    id: null, accountNumber: null, name: null, remitterType: null,
  });
  // An archived account still names its id rather than pretending it is the
  // unassigned bucket, which would silently merge two returns.
  assert.equal(filingAccountRef("gone", ACCOUNTS).id, "gone");
});

// -- T4 transmittal ---------------------------------------------------------

const TRANSMITTER = {
  bn: "999999999RP0001", transmitterNumber: "MM555555", name: "Acme Ltd",
  contactName: "Pat Payroll", contactEmail: "pat@acme.test", contactPhone: "5555550100",
};

function slip(name: string, sin: string, filingAccountId: string | null): T4Slip & { sin: string } {
  return {
    employeePartyId: name, employeeName: name, province: "ON", isQuebec: false,
    filingAccountId, sin,
    box14EmploymentIncome: "50000", box16Cpp: "3000", box16aCpp2: "0", box18Ei: "800",
    box22IncomeTax: "9000", box24EiInsurable: "50000", box26CppPensionable: "50000",
    box44UnionDues: "0", box55Qpip: "0", box56QpipInsurable: "0", stubCount: 26,
  };
}

const summary = (income: string): T4SummaryTotals => ({
  slips: 1, employmentIncome: income, employeeCpp: "3000", employeeCpp2: "0",
  employerCpp: "3000", employeeEi: "800", employerEi: "1120", incomeTax: "9000",
  remitted: "0",
});

test("T4 XML files one return per payroll program account", () => {
  const returns: T4ReturnWithSins[] = [
    {
      filingAccount: filingAccountRef(RP1.id, ACCOUNTS),
      slips: [slip("Ada Byron", "046454286", RP1.id)],
      summary: summary("50000"),
    },
    {
      filingAccount: filingAccountRef(RP2.id, ACCOUNTS),
      slips: [slip("Grace Hopper", "046454286", RP2.id)],
      summary: summary("70000"),
    },
  ];
  const xml = renderT4Xml({ orgId: "org", taxYear: 2026, transmitter: TRANSMITTER, returns });

  assert.equal(xml.match(/<T4>/g)?.length, 2);
  assert.equal(xml.match(/<T4Summary>/g)?.length, 2);
  assert.match(xml, /<summ_cnt>2<\/summ_cnt>/, "the transmittal counts every summary");
  // Each slip and summary carries its OWN account's business number.
  assert.match(xml, /<BN>123456789RP0001<\/BN>/);
  assert.match(xml, /<BN>123456789RP0002<\/BN>/);
  assert.match(xml, /<bn>123456789RP0001<\/bn>/);
  assert.match(xml, /<bn>123456789RP0002<\/bn>/);
  assert.ok(!xml.includes("999999999RP0001"), "the transmitter BN never stands in for an account");
  assert.match(xml, /<TOT_EMPT_INC_AMT>70000\.00<\/TOT_EMPT_INC_AMT>/);
});

test("T4 XML falls back to the transmitter BN for unassigned employees", () => {
  const xml = renderT4Xml({
    orgId: "org", taxYear: 2026, transmitter: TRANSMITTER,
    returns: [{
      filingAccount: filingAccountRef(null, ACCOUNTS),
      slips: [slip("Ada Byron", "046454286", null)],
      summary: summary("50000"),
    }],
  });
  assert.equal(xml.match(/<T4>/g)?.length, 1);
  assert.match(xml, /<BN>999999999RP0001<\/BN>/);
  assert.match(xml, /<summ_cnt>1<\/summ_cnt>/);
});

test("T4 XML formats amounts by exact decimal arithmetic, never a float round-trip", () => {
  // The ROE builder's documented case: 86.615 has no exact binary double, so
  // Number(v).toFixed(2) printed "86.61" where the statutory figure — half-up
  // from the 4-decimal money string — is "86.62".
  const xml = renderT4Xml({
    orgId: "org", taxYear: 2026, transmitter: TRANSMITTER,
    returns: [{
      filingAccount: filingAccountRef(RP1.id, ACCOUNTS),
      slips: [{ ...slip("Ada Byron", "046454286", RP1.id), box14EmploymentIncome: "86.6150" }],
      summary: summary("86.6150"),
    }],
  });
  assert.match(xml, /<EMPT_INC_AMT>86\.62<\/EMPT_INC_AMT>/);
  assert.match(xml, /<TOT_EMPT_INC_AMT>86\.62<\/TOT_EMPT_INC_AMT>/);
});

test("T4 XML keeps large magnitudes exact beyond double precision", () => {
  // At ~2^46 the double spacing (2^-7) is coarser than the cent being
  // rounded: Number("70368744177663.985") lands on …984.375 and toFixed(2)
  // prints ".98". The bigint path rounds the exact decimal half-up to ".99".
  const xml = renderT4Xml({
    orgId: "org", taxYear: 2026, transmitter: TRANSMITTER,
    returns: [{
      filingAccount: filingAccountRef(RP1.id, ACCOUNTS),
      slips: [{
        ...slip("Ada Byron", "046454286", RP1.id),
        box14EmploymentIncome: "70368744177663.9850",
      }],
      summary: summary("70368744177663.9850"),
    }],
  });
  assert.match(xml, /<EMPT_INC_AMT>70368744177663\.99<\/EMPT_INC_AMT>/);
  assert.match(xml, /<TOT_EMPT_INC_AMT>70368744177663\.99<\/TOT_EMPT_INC_AMT>/);
});

test("a region-scoped remittance vendor splits the group; same-vendor provinces fold into one line", () => {
  // The CA pack declares QPP/QPIP remitted to Revenu Québec for QC stubs
  // (regionalRemittanceVendorSettingsKeys) while every other province's CPP
  // goes to the CRA vendor. The summary therefore resolves the destination
  // per (component, province): QC rows land in their own group, and the
  // provinces that share a destination fold BACK into one component line so
  // a remittance bill never carries two lines for one component.
  const groups = groupRemittanceRows({
    rows: [
      row({ component_id: "cpp", code: "CPP", name: "CPP", system_key: "cpp", province: "ON", amount: "40.00" }),
      row({ component_id: "cpp", code: "CPP", name: "CPP", system_key: "cpp", province: "AB", amount: "10.00" }),
      row({ component_id: "cpp", code: "CPP", name: "CPP", system_key: "cpp", province: "QC", amount: "25.00" }),
    ],
    contextByAccount: CONTEXT,
    filingAccounts: ACCOUNTS,
    resolveParty: (r) => (r.province === "QC" ? "rq-vendor" : "cra"),
    resolveAccount: (r) => r.liability_account_id,
  });

  assert.equal(groups.size, 2, "one CRA group, one Revenu Québec group");
  const byParty = new Map([...groups.values()].map((g) => [g.partyId, g]));
  const cra = byParty.get("cra")!;
  const rq = byParty.get("rq-vendor")!;
  assert.equal(cra.components.length, 1, "ON and AB fold into one CPP line");
  assert.equal(cra.components[0]!.amount, "50.0000");
  assert.equal(cra.total, "50.0000");
  assert.equal(rq.components.length, 1);
  assert.equal(rq.components[0]!.amount, "25.00");
  assert.equal(rq.total, "25.0000");
});

// -- Remittance period validity ----------------------------------------------

test("shape-valid but impossible dates are refused before any row is read", () => {
  // February 30th and month 13 pass a YYYY-MM-DD shape check but name no
  // day: each refuses naming its bound, instead of reaching PostgreSQL as a
  // driver error.
  assert.match(remittancePeriodProblem("2026-02-30", "2026-03-31")!, /invalid from/);
  assert.match(remittancePeriodProblem("2026-02-30", "2026-03-31")!, /calendar date required/);
  assert.match(remittancePeriodProblem("2026-01-01", "2026-13-01")!, /invalid to/);
  assert.match(remittancePeriodProblem("2026-10-01", "2026-09-01")!, /is after to/);
  // Real dates pass, including a leap day and a one-day period.
  assert.equal(remittancePeriodProblem("2024-02-29", "2024-02-29"), null);
  assert.equal(remittancePeriodProblem("2026-09-01", "2026-09-30"), null);
});

// -- Remittance bill idempotency ---------------------------------------------

test("a second remittance bill for the same key is refused, naming the first", () => {
  const refusal = duplicateRemittanceMessage({ documentNumber: "BILL-00004" });
  assert.match(refusal!, /already exists \(BILL-00004\)/);
  assert.match(refusal!, /one bill per remittance/);
  // No prior bill (or only a voided one, which never reaches this check) is
  // a clear coast.
  assert.equal(duplicateRemittanceMessage(undefined), null);
});

test("the bill lock key scopes one destination, window, filing account and entity", () => {
  assert.equal(
    remittanceBillLockKey("org-1", {
      partyId: "cra", from: "2026-07-01", to: "2026-07-31", filingAccountId: null,
    }),
    "payroll-remittance-bill:org-1:cra:2026-07-01:2026-07-31::",
  );
  assert.notEqual(
    remittanceBillLockKey("org-1", {
      partyId: "cra", from: "2026-07-01", to: "2026-07-31", filingAccountId: "acct-2",
    }),
    remittanceBillLockKey("org-1", {
      partyId: "cra", from: "2026-07-01", to: "2026-07-31", filingAccountId: null,
    }),
    "two program accounts remit independently",
  );
  // Two slices of one multi-entity group fence independently: concurrent
  // creators for different entities proceed, while the same slice serializes.
  assert.notEqual(
    remittanceBillLockKey("org-1", {
      partyId: "cra", from: "2026-07-01", to: "2026-07-31", filingAccountId: null,
      subsidiaryId: "sub-a",
    }),
    remittanceBillLockKey("org-1", {
      partyId: "cra", from: "2026-07-01", to: "2026-07-31", filingAccountId: null,
      subsidiaryId: "sub-b",
    }),
    "two entities remit independently",
  );
  assert.equal(
    remittanceBillLockKey("org-1", {
      partyId: "cra", from: "2026-07-01", to: "2026-07-31", filingAccountId: null,
      subsidiaryId: "sub-a",
    }),
    "payroll-remittance-bill:org-1:cra:2026-07-01:2026-07-31::sub-a",
  );
});

test("remittance bills number off the org's existing vendor_bill series", () => {
  const root = "sub-root";
  // The org's current usage wins: a subsidiary-scoped series outranks the
  // org-wide row, exactly like the AP path's own numbering.
  assert.deepEqual(
    pickRemittanceSequence([
      { prefix: "AP-", subsidiaryId: null },
      { prefix: "PB-", subsidiaryId: root },
    ], root),
    { prefix: "PB-", subsidiaryId: root },
  );
  assert.deepEqual(
    pickRemittanceSequence([{ prefix: "AP-", subsidiaryId: null }], root),
    { prefix: "AP-", subsidiaryId: null },
  );
  // Another subsidiary's series never leaks, and no series at all leaves the
  // caller seeding 'BILL-' as before.
  assert.equal(pickRemittanceSequence([{ prefix: "XX-", subsidiaryId: "other" }], root), null);
  assert.equal(pickRemittanceSequence([], root), null);
});

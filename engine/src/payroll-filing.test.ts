import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filingAccountRef, type PayrollFilingAccount } from "./payroll-filing.ts";
import {
  duplicateRemittanceMessage,
  groupRemittanceRows,
  pickRemittanceSequence,
  remittanceBillLockKey,
  type RemittanceRow,
} from "./payroll-remittance.ts";
import { renderT4Xml, type T4ReturnWithSins } from "./payroll-t4xml.ts";
import type { T4Slip, T4SummaryTotals } from "./payroll-yearend.ts";

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
  return {
    component_id: "c1", code: "TAX", name: "Income tax", kind: "deduction",
    system_key: "income_tax", remittance_party_id: "cra", liability_account_id: "gl-tax",
    filing_account_id: RP1.id, province: "ON", amount: "100.00",
    ...overrides,
  };
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

// -- Remittance bill idempotency ---------------------------------------------

test("a second remittance bill for the same key is refused, naming the first", () => {
  const refusal = duplicateRemittanceMessage({ documentNumber: "BILL-00004" });
  assert.match(refusal!, /already exists \(BILL-00004\)/);
  assert.match(refusal!, /one bill per remittance/);
  // No prior bill (or only a voided one, which never reaches this check) is
  // a clear coast.
  assert.equal(duplicateRemittanceMessage(undefined), null);
});

test("the bill lock key scopes one destination, window and filing account", () => {
  assert.equal(
    remittanceBillLockKey("org-1", {
      partyId: "cra", from: "2026-07-01", to: "2026-07-31", filingAccountId: null,
    }),
    "payroll-remittance-bill:org-1:cra:2026-07-01:2026-07-31:",
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
});

test("bill creation takes the advisory lock before any bill write", () => {
  // The duplicate check is only a control if two transactions cannot pass it
  // simultaneously — pinned structurally, like bootstrap-safety does.
  const source = readFileSync(new URL("./payroll-remittance.ts", import.meta.url), "utf8");
  const fn = source.indexOf("export async function createRemittanceBill");
  const tx = source.indexOf("db.transaction", fn);
  const lock = source.indexOf("pg_advisory_xact_lock", tx);
  const insert = source.indexOf("insert into documents", tx);
  assert.ok(tx > fn && lock > tx && insert > lock, "lock precedes the bill insert inside the transaction");
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

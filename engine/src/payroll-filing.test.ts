import assert from "node:assert/strict";
import test from "node:test";
import { filingAccountRef, type PayrollFilingAccount } from "./payroll-filing.ts";
import { groupRemittanceRows, type RemittanceRow } from "./payroll-remittance.ts";
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
    filing_account_id: RP1.id, amount: "100.00",
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
    box44UnionDues: "0", box55Qpip: "0", stubCount: 26,
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

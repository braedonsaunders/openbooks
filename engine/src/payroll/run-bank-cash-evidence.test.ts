import assert from "node:assert/strict";
import test from "node:test";
import {
  bankCashFundingSplit,
  bankCashInputEvidence,
  bankCashSplitMatchesValuation,
  canonicalBankCashInputValues,
  isBankCashInputEvidenceCandidate,
  parseBankCashInputEvidence,
  type BankCashPayDateValuation,
} from "./run-bank-cash-evidence.ts";

test("bank cash input evidence retains the keyed rate and source identity", () => {
  const encoded = bankCashInputEvidence(
    "Issued bank withdrawal at the cheque's keyed rate",
    "Payroll source document 7",
    "30000000-0000-4000-8000-000000000001",
    "143.83",
  );
  assert.deepEqual(parseBankCashInputEvidence(encoded), {
    kind: "bank_cash_input",
    reason: "Issued bank withdrawal at the cheque's keyed rate",
    sourceReference: "Payroll source document 7",
    requestId: "30000000-0000-4000-8000-000000000001",
    rate: "143.83",
  });
  assert.equal(isBankCashInputEvidenceCandidate(encoded), true);
});

test("bank cash input evidence refuses malformed requests and rates", () => {
  assert.equal(
    parseBankCashInputEvidence(
      '{"kind":"bank_cash_input","reason":"x","sourceReference":"card","requestId":"bad","rate":null}',
    ),
    null,
  );
  assert.equal(isBankCashInputEvidenceCandidate('{"kind" : "bank_cash_input"'), true);
  assert.equal(
    parseBankCashInputEvidence(
      bankCashInputEvidence(
        "Issued bank withdrawal",
        "Payroll source document 7",
        "30000000-0000-4000-8000-000000000001",
        "0.001",
      ),
    ),
    null,
  );
  assert.equal(isBankCashInputEvidenceCandidate('{"kind" : "bank_cash_input"}'), true);
});

test("bank cash input retains a valid outside-bank portion and refuses invalid splits", () => {
  const encoded = bankCashInputEvidence(
    "Issued bank payout with independently paid cash",
    "Payroll source document 7",
    "30000000-0000-4000-8000-000000000002",
    "143.83",
    "782.64",
  );
  assert.equal(parseBankCashInputEvidence(encoded)?.outsideBankAmount, "782.64");
  assert.deepEqual(bankCashFundingSplit("1150.6400", "782.64"), {
    totalAmount: "1150.6400",
    bankFundedAmount: "368.0000",
    outsideBankAmount: "782.64",
  });
  for (const [total, outside] of [
    ["1150.64", "1150.64"],
    ["1150.64", "1150.65"],
    ["1150.64", "0"],
    ["1150.64", "-1.00"],
    ["1150.641", "782.64"],
    ["-1150.64", "782.64"],
    ["0", "0.01"],
    ["1150.64", "782.641"],
  ] as const)
    assert.equal(bankCashFundingSplit(total, outside), null, `${total}/${outside}`);
  assert.equal(
    parseBankCashInputEvidence(
      bankCashInputEvidence(
        "Issued bank payout",
        "Payroll source document 7",
        "30000000-0000-4000-8000-000000000002",
        "143.83",
        "782.641",
      ),
    ),
    null,
  );
});

test("a funding split matches only its exact hours at the retained pay-date wage", () => {
  const valuation: BankCashPayDateValuation = {
    rateId: "30000000-0000-4000-8000-000000000001",
    scope: "employee",
    hourlyWage: "46.0000",
    currency: "CAD",
    basis: "hour",
    rate: "46.0000",
    effectiveFrom: "2026-06-01",
    effectiveTo: null,
    annualHoursUsed: null,
    annualHoursSource: null,
    updatedAt: "2026-06-01T00:00:00.000000Z",
  };
  const split = bankCashFundingSplit("1150.64", "782.64")!;
  assert.equal(bankCashSplitMatchesValuation(split, "8.00", valuation), true);
  assert.equal(
    bankCashSplitMatchesValuation(split, "8.00", { ...valuation, hourlyWage: "46.0100" }),
    false,
  );
  assert.equal(bankCashSplitMatchesValuation(split, "7.00", valuation), false);
  assert.equal(bankCashSplitMatchesValuation(split, "-8.00", valuation), false);
  assert.equal(
    bankCashSplitMatchesValuation({ ...split, bankFundedAmount: "368.01" }, "8.00", valuation),
    false,
  );
});

test("issued cash inputs preserve signed hours and exact cents without binary arithmetic", () => {
  assert.deepEqual(
    canonicalBankCashInputValues({ hours: "8", rate: "143.83", amount: "1150.64" }),
    { hours: "8", amount: "1150.6400", rate: "143.83" },
  );
  assert.deepEqual(canonicalBankCashInputValues({ hours: "-58", amount: "-1624" }), {
    hours: "-58",
    amount: "-1624.0000",
    rate: null,
  });
  assert.deepEqual(canonicalBankCashInputValues({ hours: "1", amount: "999999999999999.99" }), {
    hours: "1",
    amount: "999999999999999.9900",
    rate: null,
  });
});

test("bank inputs refuse missing financial proof, mismatched signs and precision loss", () => {
  for (const input of [
    { hours: "8" },
    { hours: "0", amount: "1" },
    { hours: "1", amount: "0" },
    { hours: "8", rate: "143.83", amount: "1150.65" },
    { hours: "-58", amount: "1624" },
    { hours: "58", amount: "-1624" },
    { hours: "1.001", amount: "1" },
    { hours: "1", rate: "0.001" },
    { hours: "1", amount: "1.001" },
    { hours: "1", amount: "1e3" },
    { hours: "10000000000", amount: "1" },
    { hours: "1", amount: "1000000000000000" },
    { hours: "0.01", rate: "1000000000000000" },
  ])
    assert.throws(() => canonicalBankCashInputValues(input));
  assert.throws(() => canonicalBankCashInputValues({ hours: "1", amount: 1 as unknown as string }));
});

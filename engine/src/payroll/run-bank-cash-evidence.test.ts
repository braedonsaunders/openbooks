import assert from "node:assert/strict";
import test from "node:test";
import {
  bankCashInputEvidence,
  canonicalBankCashInputValues,
  isBankCashInputEvidenceCandidate,
  parseBankCashInputEvidence,
} from "./run-bank-cash-evidence.ts";

test("bank cash input evidence retains the keyed rate and source identity", () => {
  const encoded = bankCashInputEvidence(
    "Issued bank withdrawal at the cheque's keyed rate",
    "card 44707",
    "44707000-0000-4000-8000-000000000001",
    "143.83",
  );
  assert.deepEqual(parseBankCashInputEvidence(encoded), {
    kind: "bank_cash_input",
    reason: "Issued bank withdrawal at the cheque's keyed rate",
    sourceReference: "card 44707",
    requestId: "44707000-0000-4000-8000-000000000001",
    rate: "143.83",
  });
  assert.equal(isBankCashInputEvidenceCandidate(encoded), true);
});

test("bank cash input evidence refuses malformed requests and rates", () => {
  assert.equal(parseBankCashInputEvidence('{"kind":"bank_cash_input","reason":"x","sourceReference":"card","requestId":"bad","rate":null}'), null);
  assert.equal(isBankCashInputEvidenceCandidate('{"kind" : "bank_cash_input"'), true);
  assert.equal(parseBankCashInputEvidence(bankCashInputEvidence(
    "Issued bank withdrawal", "card 44707", "44707000-0000-4000-8000-000000000001", "0.001",
  )), null);
  assert.equal(isBankCashInputEvidenceCandidate('{"kind" : "bank_cash_input"}'), true);
});

test("issued cash inputs preserve signed hours and exact cents without binary arithmetic", () => {
  assert.deepEqual(canonicalBankCashInputValues({ hours: "8", rate: "143.83", amount: "1150.64" }),
    { hours: "8", amount: "1150.6400", rate: "143.83" });
  assert.deepEqual(canonicalBankCashInputValues({ hours: "-58", amount: "-1624" }),
    { hours: "-58", amount: "-1624.0000", rate: null });
  assert.deepEqual(canonicalBankCashInputValues({ hours: "1", amount: "999999999999999.99" }),
    { hours: "1", amount: "999999999999999.9900", rate: null });
});

test("bank inputs refuse missing financial proof, mismatched signs and precision loss", () => {
  for (const input of [
    { hours: "8" }, { hours: "0", amount: "1" }, { hours: "1", amount: "0" },
    { hours: "8", rate: "143.83", amount: "1150.65" },
    { hours: "-58", amount: "1624" }, { hours: "58", amount: "-1624" },
    { hours: "1.001", amount: "1" }, { hours: "1", rate: "0.001" },
    { hours: "1", amount: "1.001" }, { hours: "1", amount: "1e3" },
    { hours: "10000000000", amount: "1" },
    { hours: "1", amount: "1000000000000000" },
    { hours: "0.01", rate: "1000000000000000" },
  ]) assert.throws(() => canonicalBankCashInputValues(input));
  assert.throws(() => canonicalBankCashInputValues({ hours: "1", amount: 1 as unknown as string }));
});

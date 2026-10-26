import assert from "node:assert/strict";
import test from "node:test";
import { documentCreateContentRefusal } from "./document-kinds.ts";

const TRANSFER_REFUSAL = "A transfer needs an amount and both accounts before it can be saved.";
const LINE_REFUSAL = "A new document needs at least one line before it can be saved.";

test("a transfer create needs its amount and both accounts", () => {
  const complete = [
    { accountId: "bank-b", amount: "100.00" },
    { accountId: "card-a", amount: "0" },
  ];
  assert.equal(documentCreateContentRefusal("transfer", complete), null);
  assert.equal(documentCreateContentRefusal("transfer", undefined), TRANSFER_REFUSAL);
  assert.equal(documentCreateContentRefusal("transfer", []), TRANSFER_REFUSAL);
  assert.equal(
    documentCreateContentRefusal("transfer", [{ accountId: "bank-b", amount: "100" }]),
    TRANSFER_REFUSAL,
    "one leg is not a transfer",
  );
  assert.equal(
    documentCreateContentRefusal("transfer", [
      { accountId: "bank-b", amount: "0.0000" },
      { accountId: "card-a", amount: "0" },
    ]),
    TRANSFER_REFUSAL,
    "a zero amount moves nothing",
  );
  assert.equal(
    documentCreateContentRefusal("transfer", [
      { accountId: "", amount: "100" },
      { accountId: "card-a", amount: "0" },
    ]),
    TRANSFER_REFUSAL,
    "the destination account is required",
  );
  assert.equal(
    documentCreateContentRefusal("transfer", [
      { accountId: "bank-b", amount: "-100" },
      { accountId: "card-a", amount: "0" },
    ]),
    TRANSFER_REFUSAL,
    "a negative amount is refused at create",
  );
  assert.equal(
    documentCreateContentRefusal("transfer", [
      { accountId: "bank-b", amount: ".5" },
      { accountId: "card-a", amount: "0" },
    ]),
    null,
    "a leading-dot amount is a positive amount",
  );
});

test("every other kind needs at least one line", () => {
  assert.equal(
    documentCreateContentRefusal("expense_report", [{ accountId: "exp-1", amount: "25" }]),
    null,
  );
  assert.equal(documentCreateContentRefusal("vendor_bill", []), LINE_REFUSAL);
  assert.equal(documentCreateContentRefusal("expense_report", null), LINE_REFUSAL);
  assert.equal(documentCreateContentRefusal("deposit", undefined), LINE_REFUSAL);
});

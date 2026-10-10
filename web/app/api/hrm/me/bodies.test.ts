import assert from "node:assert/strict";
import test from "node:test";
import { fileBankChangeBody } from "./bodies";

const employmentId = "11111111-1111-4111-8111-111111111111";

test("bank changes accept the masked filing shape", () => {
  assert.deepEqual(
    fileBankChangeBody.parse({
      employmentId,
      bank: { bankName: "First Bank", accountNumber: "12345678", country: "US", currency: "USD" },
      reason: "switched to direct deposit",
    }).bank.bankName,
    "First Bank",
  );
});

test("bank changes refuse short numbers, short reasons, and bad ids at the boundary", () => {
  assert.equal(
    fileBankChangeBody.safeParse({
      employmentId,
      bank: { bankName: "First Bank", accountNumber: "12" },
      reason: "switched to direct deposit",
    }).success,
    false,
  );
  assert.equal(
    fileBankChangeBody.safeParse({
      employmentId,
      bank: { bankName: "First Bank", accountNumber: "12345678" },
      reason: "move",
    }).success,
    false,
  );
  assert.equal(
    fileBankChangeBody.safeParse({
      employmentId: "not-a-uuid",
      bank: { bankName: "First Bank", accountNumber: "12345678" },
      reason: "switched to direct deposit",
    }).success,
    false,
  );
});

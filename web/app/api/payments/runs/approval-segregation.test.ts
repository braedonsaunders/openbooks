import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertIndependentPaymentApprover,
} from "../../../../../engine/src/payment-operations.ts";
import { PaymentError } from "../../../../../engine/src/payments.ts";

const paymentOperationsSource = readFileSync(
  new URL("../../../../../engine/src/payment-operations.ts", import.meta.url),
  "utf8",
);

function sourceBetween(start: string, end: string): string {
  const startAt = paymentOperationsSource.indexOf(start);
  const endAt = paymentOperationsSource.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `${start} must exist`);
  assert.notEqual(endAt, -1, `${end} must follow ${start}`);
  return paymentOperationsSource.slice(startAt, endAt);
}

test("payment-run submitters cannot approve their own run", () => {
  assert.throws(
    () => assertIndependentPaymentApprover("run", "user-1", "user-1"),
    (error: Error) =>
      error instanceof PaymentError
      && error.message === "the payment run submitter cannot approve the same run",
  );
});

test("payment-file generators cannot approve their own file", () => {
  assert.throws(
    () => assertIndependentPaymentApprover("file", "user-1", "user-1"),
    (error: Error) =>
      error instanceof PaymentError
      && error.message === "the payment file generator cannot approve the same file",
  );
});

test("payment approval fails closed when the maker is not identified", () => {
  for (const [kind, role] of [["run", "submitter"], ["file", "generator"]] as const) {
    assert.throws(
      () => assertIndependentPaymentApprover(kind, null, "user-2"),
      (error: Error) =>
        error instanceof PaymentError
        && error.message.includes(`requires an identified ${role}`),
    );
  }
});

test("a different user remains eligible to approve", () => {
  assert.doesNotThrow(() => assertIndependentPaymentApprover("run", "user-1", "user-2"));
  assert.doesNotThrow(() => assertIndependentPaymentApprover("file", "user-1", "user-2"));
});

test("run approval enforces maker-checker identity in the atomic status update", () => {
  const source = sourceBetween("export async function decidePaymentRun", "interface FormatContext");
  assert.match(
    source,
    /status = 'pending_approval'[\s\S]*?\$\{decision\} = 'reject'[\s\S]*?submitted_by is not null and submitted_by <> \$\{userId\}/,
  );
});

test("file approval enforces maker-checker identity in the atomic status update", () => {
  const source = sourceBetween("export async function decidePaymentFile", "export async function recordPaymentFileDownload");
  assert.match(
    source,
    /status = 'pending_approval'[\s\S]*?\$\{decision\} = 'reject'[\s\S]*?generated_by is not null and generated_by <> \$\{userId\}/,
  );
});

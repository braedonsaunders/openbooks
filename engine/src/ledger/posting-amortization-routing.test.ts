import assert from "node:assert/strict";
import test from "node:test";
import type { PostingDocument, PostingDocumentLine } from "../journal/posting-contracts.ts";
import { assertFinalKernelBalance } from "../journal/posting-invariants.ts";
import { RULES } from "./posting-rules.ts";

const control = { ap: "ap", ar: "ar", bank: "bank" };

function line(
  id: string,
  accountId: string,
  amount: string,
  extra: Record<string, unknown> = {},
): PostingDocumentLine {
  return {
    id,
    lineNumber: Number(id.replace(/\D/g, "")) || 1,
    accountId,
    amount,
    taxAmount: "0.0000",
    partyId: null,
    departmentId: "line-department",
    projectId: "line-project",
    ...extra,
  } as unknown as PostingDocumentLine;
}

function doc(kind: string): PostingDocument {
  return {
    id: "doc",
    kind,
    partyId: "vendor",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: {},
  } as unknown as PostingDocument;
}

test("a deferred bill line debits the deferral account and names its source line; other lines expense as before", () => {
  const lines = [
    line("l1", "insurance-expense", "300.0000"),
    line("l2", "office-expense", "50.0000"),
  ];
  const projected = RULES.vendor_bill!(doc("vendor_bill"), lines, {
    control,
    amortizationByLine: new Map([["l1", { deferralAccountId: "prepaid" }]]),
  });
  assert.deepEqual(
    projected.map((row) => [row.accountId, row.amount, row.amortizationSourceLineId ?? null]),
    [
      ["prepaid", "300.0000", "l1"],
      ["office-expense", "50.0000", null],
      ["ap", "-350.0000", null],
    ],
  );
  // The deferred leg keeps the line's dimensions so its schedule inherits them.
  assert.equal(projected[0]!.projectId, "line-project");
  assert.equal(projected[0]!.departmentId, "line-department");
  assert.equal(
    Object.hasOwn(projected[1]!, "amortizationSourceLineId"),
    false,
    "an ordinary leg carries no marker",
  );
  assert.doesNotThrow(() =>
    assertFinalKernelBalance(projected.map((row) => ({ ...row, subsidiaryId: "sub" }))),
  );
});

test("without routing the bill projection is unchanged", () => {
  const lines = [line("l1", "insurance-expense", "300.0000")];
  const routed = RULES.vendor_bill!(doc("vendor_bill"), lines, { control });
  assert.deepEqual(
    routed.map((row) => [row.accountId, row.amount]),
    [
      ["insurance-expense", "300.0000"],
      ["ap", "-300.0000"],
    ],
  );
  assert.ok(routed.every((row) => !Object.hasOwn(row, "amortizationSourceLineId")));
});

test("journal and expense report lines defer the same way", () => {
  const journal = RULES.journal!(
    doc("journal"),
    [line("l1", "software-expense", "1200.0000"), line("l2", "bank", "-1200.0000")],
    {
      control,
      openItemAccountIds: new Set(),
      amortizationByLine: new Map([["l1", { deferralAccountId: "prepaid" }]]),
    },
  );
  assert.deepEqual(
    journal.map((row) => [row.accountId, row.amount, row.amortizationSourceLineId ?? null]),
    [
      ["prepaid", "1200.0000", "l1"],
      ["bank", "-1200.0000", null],
    ],
  );

  const report = RULES.expense_report!(
    { ...doc("expense_report"), partyId: "employee" } as PostingDocument,
    [line("l1", "travel-expense", "90.0000", { settlementType: "out_of_pocket" })],
    {
      control: { ...control, employeePayable: "employee-payable" },
      openItemAccountIds: new Set(["employee-payable"]),
      amortizationByLine: new Map([["l1", { deferralAccountId: "prepaid" }]]),
    },
  );
  assert.deepEqual(
    report.map((row) => [row.accountId, row.amount, row.amortizationSourceLineId ?? null]),
    [
      ["prepaid", "90.0000", "l1"],
      ["employee-payable", "-90.0000", null],
    ],
  );
});

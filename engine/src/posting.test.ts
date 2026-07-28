import assert from "node:assert/strict";
import test from "node:test";
import { assertFinalKernelBalance, controlLineIsOpenItem, PostingError, RULES } from "./posting.ts";

const controlAccounts = new Set(["ar", "ap"]);

test("entity-bearing AR/AP journal lines participate in the subledger", () => {
  assert.equal(controlLineIsOpenItem("ar", "customer", controlAccounts), true);
  assert.equal(controlLineIsOpenItem("ap", "vendor", controlAccounts), true);
});

test("party-less control-account journals remain direct GL activity", () => {
  assert.equal(controlLineIsOpenItem("ar", null, controlAccounts), false);
  assert.equal(controlLineIsOpenItem("expense", "vendor", controlAccounts), false);
});

test("final posting proof rejects whole-entry and per-subsidiary imbalance", () => {
  assert.doesNotThrow(() =>
    assertFinalKernelBalance([
      { subsidiaryId: "A", amount: "10.0000" },
      { subsidiaryId: "A", amount: "-10.0000" },
    ]),
  );
  assert.throws(
    () => assertFinalKernelBalance([
      { subsidiaryId: "A", amount: "10.0000" },
      { subsidiaryId: "B", amount: "-10.0000" },
    ]),
    (error: Error) => error instanceof PostingError && /subsidiary A/.test(error.message),
  );
  assert.throws(
    () => assertFinalKernelBalance([
      { subsidiaryId: "A", amount: "10.0000" },
      { subsidiaryId: "A", amount: "-9.9999" },
    ]),
    /does not balance/,
  );
});

test("purchase tax projection separates recoverable, nonrecoverable, withholding, and reverse charge", () => {
  const doc = {
    id: "doc",
    kind: "vendor_bill",
    partyId: "vendor",
    projectId: "header-project",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: {},
  } as any;
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "expense",
    amount: "100.0000",
    taxAmount: "7.0000",
    partyId: null,
    projectId: "line-project",
    taxGroupId: "group",
  } as any;
  const projected = RULES.vendor_bill!(doc, [line], {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    taxComponentsByLine: new Map([["line", [
      { taxCodeId: "standard", sequence: 1, taxAmount: "10.0000", recoverableAmount: "5.0000", nonrecoverableAmount: "5.0000", calculationType: "standard", collectedAccountId: "output", paidAccountId: "input", withholdingAccountId: null },
      { taxCodeId: "withholding", sequence: 2, taxAmount: "3.0000", recoverableAmount: "3.0000", nonrecoverableAmount: "0.0000", calculationType: "withholding", collectedAccountId: null, paidAccountId: null, withholdingAccountId: "withholding" },
      { taxCodeId: "reverse", sequence: 3, taxAmount: "5.0000", recoverableAmount: "4.0000", nonrecoverableAmount: "1.0000", calculationType: "reverse_charge", collectedAccountId: "output", paidAccountId: "input", withholdingAccountId: null },
    ]]]),
  });
  assert.deepEqual(projected.map((row) => [row.accountId, row.amount]), [
    ["expense", "106.0000"],
    ["input", "5.0000"],
    ["withholding", "-3.0000"],
    ["input", "4.0000"],
    ["output", "-5.0000"],
    ["ap", "-107.0000"],
  ]);
  assert.equal(projected[0]!.projectId, "line-project");
  assert.deepEqual(
    projected
      .filter((row) =>
        ["input", "withholding", "output"].includes(row.accountId)
      )
      .map((row) => row.projectId),
    [null, null, null, null],
  );
  assert.doesNotThrow(() => assertFinalKernelBalance(projected.map((row) => ({ ...row, subsidiaryId: "sub" }))));
});

test("sales tax control lines never become project revenue or cost", () => {
  const doc = {
    id: "invoice",
    kind: "customer_invoice",
    partyId: "customer",
    projectId: "header-project",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: {},
  } as any;
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "income",
    amount: "100.0000",
    taxAmount: "13.0000",
    projectId: "line-project",
    taxCodeId: "tax",
  } as any;
  const projected = RULES.customer_invoice!(doc, [line], {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    taxComponentsByLine: new Map([["line", [{
      taxCodeId: "tax",
      sequence: 1,
      taxAmount: "13.0000",
      recoverableAmount: "0",
      nonrecoverableAmount: "0",
      calculationType: "standard",
      collectedAccountId: "output",
      paidAccountId: "input",
      withholdingAccountId: null,
    }]]]),
  });
  assert.equal(
    projected.find((row) => row.accountId === "income")!.projectId,
    "line-project",
  );
  assert.equal(
    projected.find((row) => row.accountId === "output")!.projectId,
    null,
  );
  assert.doesNotThrow(() =>
    assertFinalKernelBalance(
      projected.map((row) => ({ ...row, subsidiaryId: "sub" })),
    )
  );
});

test("tax profiles cannot post without cross-footing component evidence", () => {
  const doc = { id: "doc", kind: "customer_invoice", partyId: "customer", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom: {} } as any;
  const line = { id: "line", lineNumber: 1, accountId: "income", amount: "100.0000", taxAmount: "13.0000", taxCodeId: "tax" } as any;
  assert.throws(
    () => RULES.customer_invoice!(doc, [line], { control: { ap: "ap", ar: "ar", bank: "bank" } }),
    /no calculation evidence/,
  );
  assert.throws(
    () => RULES.customer_invoice!(doc, [line], {
      control: { ap: "ap", ar: "ar", bank: "bank" },
      taxComponentsByLine: new Map([["line", [{
        taxCodeId: "tax", sequence: 1, taxAmount: "12.9999", recoverableAmount: "12.9999",
        nonrecoverableAmount: "0", calculationType: "standard", collectedAccountId: "output",
        paidAccountId: "input", withholdingAccountId: null,
      }]]]),
    }),
    /do not match stored tax total/,
  );
});

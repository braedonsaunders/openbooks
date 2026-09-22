import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { assertFinalKernelBalance } from "./posting-invariants.ts";
import { controlLineIsOpenItem, RULES } from "./posting-rules.ts";
import { glProjectionKey } from "./posting-projection.ts";
import { postDocument } from "./posting-document.ts";
import { PostingError, type PostingDocument, type PostingDocumentLine } from "./posting-contracts.ts";

const controlAccounts = new Set(["ar", "ap"]);
const DB = !!process.env.OPENBOOKS_DB_URL;

test("entity-bearing AR/AP journal lines participate in the subledger", () => {
  assert.equal(controlLineIsOpenItem("ar", "customer", controlAccounts), true);
  assert.equal(controlLineIsOpenItem("ap", "vendor", controlAccounts), true);
});

test("party-less control-account journals remain direct GL activity", () => {
  assert.equal(controlLineIsOpenItem("ar", null, controlAccounts), false);
  assert.equal(controlLineIsOpenItem("expense", "vendor", controlAccounts), false);
});

test("expense reports age only genuine AP control balances", () => {
  const doc = {
    id: "expense-report",
    kind: "expense_report",
    partyId: "employee",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: { controlAccountId: "card-liability" },
  } as unknown as PostingDocument;
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "travel",
    amount: "120.0000",
    taxAmount: "0",
  } as unknown as PostingDocumentLine;
  const cardProjection = RULES.expense_report!(doc, [line], {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    openItemAccountIds: new Set(["ar", "ap"]),
  });
  assert.equal(cardProjection.at(-1)!.accountId, "card-liability");
  assert.equal(cardProjection.at(-1)!.isOpenItem, false);

  const apProjection = RULES.expense_report!(
    { ...doc, custom: { controlAccountId: "ap" } },
    [line],
    {
      control: { ap: "ap", ar: "ar", bank: "bank" },
      openItemAccountIds: new Set(["ar", "ap"]),
    },
  );
  assert.equal(apProjection.at(-1)!.isOpenItem, true);
});

test("expense settlement splits a report across three counterparties", () => {
  const doc = {
    id: "expense-report",
    kind: "expense_report",
    partyId: "employee",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    paymentCardId: "card",
    custom: {},
  } as unknown as PostingDocument;
  const line = (n: number, settlementType: string, amount: string) =>
    ({
      id: `line-${n}`,
      lineNumber: n,
      accountId: "travel",
      amount,
      taxAmount: "0",
      settlementType,
    }) as unknown as PostingDocumentLine;
  const deps = {
    control: { ap: "ap", ar: "ar", bank: "bank", employeePayable: "emp-pay", employeeReceivable: "emp-recv" },
    cardLiabilityAccountId: "card-clearing",
    openItemAccountIds: new Set(["ar", "ap", "emp-pay", "emp-recv"]),
  };
  const legs = RULES.expense_report!(
    doc,
    [line(1, "out_of_pocket", "100.0000"), line(2, "company_paid", "200.0000"), line(3, "personal", "50.0000")],
    deps,
  );
  const at = (accountId: string) => legs.filter((l) => l.accountId === accountId);
  assert.deepEqual(at("travel").map((l) => l.amount).sort(), ["100.0000", "200.0000"]);
  assert.deepEqual(at("emp-recv").map((l) => [l.amount, l.partyId, l.isOpenItem]), [["50.0000", "employee", true]]);
  assert.deepEqual(at("emp-pay").map((l) => [l.amount, l.partyId, l.isOpenItem]), [["-100.0000", "employee", true]]);
  // The card-clearing leg never carries the employee party and is never an
  // open item: that one invariant keeps company-paid and personal amounts out
  // of every is_open_item reader (tile, aging, run selection) at once.
  assert.deepEqual(
    at("card-clearing").map((l) => [l.amount, l.partyId, l.paymentCardId, l.isOpenItem]),
    [["-250.0000", undefined, "card", false]],
  );
});

test("expense settlement fails closed on unknown kinds, missing card, and nonstandard personal tax", () => {
  const doc = {
    id: "expense-report",
    kind: "expense_report",
    partyId: "employee",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    paymentCardId: "card",
    custom: {},
  } as unknown as PostingDocument;
  const deps = {
    control: { ap: "ap", ar: "ar", bank: "bank", employeePayable: "emp-pay", employeeReceivable: "emp-recv" },
    cardLiabilityAccountId: "card-clearing",
    openItemAccountIds: new Set(["ar", "ap", "emp-pay", "emp-recv"]),
  };
  const line = (settlementType: unknown) =>
    ({ id: "line", lineNumber: 1, accountId: "travel", amount: "10.0000", taxAmount: "0", settlementType }) as unknown as PostingDocumentLine;
  // A future settlement kind must be taught to the kernel deliberately, never
  // defaulted into the wrong counterparty.
  assert.throws(() => RULES.expense_report!(doc, [line("cryptocurrency")], deps), /unknown settlement type/);
  // Card-funded lines with no resolvable card liability have no lawful credit.
  assert.throws(
    () => RULES.expense_report!(doc, [line("company_paid")], { control: deps.control, openItemAccountIds: deps.openItemAccountIds }),
    /require a payment card/,
  );
  // Personal lines with no configured receivable have no lawful debit.
  assert.throws(
    () => RULES.expense_report!(doc, [line("personal")], {
      control: { ap: "ap", ar: "ar", bank: "bank" },
      cardLiabilityAccountId: "card-clearing",
      openItemAccountIds: deps.openItemAccountIds,
    }),
    /employee-receivable/,
  );
  // A personal line posts gross to the receivable with no recoverable-tax leg:
  // net 10.00 plus the full 10.00 input component (6.00 recoverable) debits
  // 20.00, and no tax-control leg is emitted — a non-business charge
  // generates no input tax credit.
  const gross = {
    id: "line",
    lineNumber: 1,
    accountId: "travel",
    amount: "10.0000",
    taxAmount: "10.0000",
    settlementType: "personal",
  } as unknown as PostingDocumentLine;
  const grossLegs = RULES.expense_report!(doc, [gross], {
    ...deps,
    taxComponentsByLine: new Map([
      ["line", [{ taxCodeId: "std", sequence: 1, taxAmount: "10.0000", recoverableAmount: "6.0000", nonrecoverableAmount: "4.0000", calculationType: "standard", collectedAccountId: null, paidAccountId: "tax-in", withholdingAccountId: null }]],
    ]),
  });
  assert.deepEqual(
    grossLegs.map((l) => [l.accountId, l.amount]),
    [["emp-recv", "20.0000"], ["card-clearing", "-20.0000"]],
  );
  // Withholding on a personal line fails closed rather than posting a tax leg
  // the receivable must never carry. (Standard 10.00 minus withholding 2.00
  // settles the component evidence to the stored 8.00, so the refusal comes
  // from the personal-line gate, not the evidence check.)
  const withheld = {
    id: "line",
    lineNumber: 1,
    accountId: "travel",
    amount: "10.0000",
    taxAmount: "8.0000",
    settlementType: "personal",
  } as unknown as PostingDocumentLine;
  assert.throws(
    () =>
      RULES.expense_report!(doc, [withheld], {
        ...deps,
        taxComponentsByLine: new Map([
          [
            "line",
            [
              { taxCodeId: "std", sequence: 1, taxAmount: "10.0000", recoverableAmount: "6.0000", nonrecoverableAmount: "4.0000", calculationType: "standard", collectedAccountId: null, paidAccountId: null, withholdingAccountId: null },
              { taxCodeId: "wht", sequence: 2, taxAmount: "2.0000", recoverableAmount: "0", nonrecoverableAmount: "0", calculationType: "withholding", collectedAccountId: null, paidAccountId: null, withholdingAccountId: "wht-pay" },
            ],
          ],
        ]),
      }),
    /cannot carry withholding tax/,
  );
});

test("checks written against a party-bearing AP control leg settle open items", () => {
  // Paying vendor bills by check debits the AP control account. That leg must
  // be an open item so it can serve as an application source (from_line) —
  // otherwise the ledger moves but the bill stays open and the subledger
  // disagrees with the GL for that vendor.
  const doc = {
    id: "check",
    kind: "check",
    partyId: "vendor",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: {},
  } as unknown as PostingDocument;
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "ap",
    amount: "100.0000",
    taxAmount: "0",
  } as unknown as PostingDocumentLine;
  const deps = {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    openItemAccountIds: new Set(["ar", "ap"]),
  };
  const projected = RULES.check!(doc, [line], deps);
  assert.deepEqual(projected.map((row) => [row.accountId, row.amount]), [
    ["ap", "100.0000"],
    ["bank", "-100.0000"],
  ]);
  assert.equal(projected[0]!.isOpenItem, true);
  assert.doesNotThrow(() =>
    assertFinalKernelBalance(
      projected.map((row) => ({ ...row, subsidiaryId: "sub" })),
    ),
  );

  // A party-less control-account check is a direct GL posting and must not
  // become an anonymous aging item.
  const anonymous = RULES.check!(
    { ...doc, partyId: null },
    [line],
    deps,
  );
  assert.notEqual(anonymous[0]!.isOpenItem, true);
});

test("ordinary expense checks stay direct bank disbursements", () => {
  const doc = {
    id: "check",
    kind: "check",
    partyId: "vendor",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: {},
  } as unknown as PostingDocument;
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "office-supplies",
    amount: "100.0000",
    taxAmount: "0",
  } as unknown as PostingDocumentLine;
  const projected = RULES.check!(doc, [line], {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    openItemAccountIds: new Set(["ar", "ap"]),
  });
  assert.deepEqual(projected.map((row) => [row.accountId, row.amount]), [
    ["office-supplies", "100.0000"],
    ["bank", "-100.0000"],
  ]);
  assert.equal(
    projected.some((row) => row.isOpenItem),
    false,
  );
});

test("checks credit the chosen funding bank instead of the org default", () => {
  // The check form's funding-bank picker stores the account on
  // doc.custom.controlAccountId (the same bag contract deposits use). The
  // credit leg must follow it; without an override the org default bank
  // still wins.
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "office-supplies",
    amount: "100.0000",
    taxAmount: "0",
  } as unknown as PostingDocumentLine;
  const deps = {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    openItemAccountIds: new Set(["ar", "ap"]),
  };
  const base = {
    id: "check",
    kind: "check",
    partyId: "vendor",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
  } as unknown as PostingDocument;
  const overridden = RULES.check!(
    { ...base, custom: { controlAccountId: "payroll-account" } },
    [line],
    deps,
  );
  assert.deepEqual(overridden.map((row) => [row.accountId, row.amount]), [
    ["office-supplies", "100.0000"],
    ["payroll-account", "-100.0000"],
  ]);
  assert.doesNotThrow(() =>
    assertFinalKernelBalance(
      overridden.map((row) => ({ ...row, subsidiaryId: "sub" })),
    ),
  );
  const fallback = RULES.check!({ ...base, custom: {} }, [line], deps);
  assert.equal(fallback.at(-1)!.accountId, "bank");
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
  } as unknown as PostingDocument;
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "expense",
    amount: "100.0000",
    taxAmount: "7.0000",
    partyId: null,
    projectId: "line-project",
    taxGroupId: "group",
  } as unknown as PostingDocumentLine;
  const projected = RULES.vendor_bill!(doc, [line], {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    taxComponentsByLine: new Map([["line", [
      { taxCodeId: "standard", sequence: 1, taxAmount: "10.0000", recoverableAmount: "5.0000", nonrecoverableAmount: "5.0000", calculationType: "standard" as const, collectedAccountId: "output", paidAccountId: "input", withholdingAccountId: null },
      { taxCodeId: "withholding", sequence: 2, taxAmount: "3.0000", recoverableAmount: "3.0000", nonrecoverableAmount: "0.0000", calculationType: "withholding" as const, collectedAccountId: null, paidAccountId: null, withholdingAccountId: "withholding" },
      { taxCodeId: "reverse", sequence: 3, taxAmount: "5.0000", recoverableAmount: "4.0000", nonrecoverableAmount: "1.0000", calculationType: "reverse_charge" as const, collectedAccountId: "output", paidAccountId: "input", withholdingAccountId: null },
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
  } as unknown as PostingDocument;
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "income",
    amount: "100.0000",
    taxAmount: "13.0000",
    projectId: "line-project",
    taxCodeId: "tax",
  } as unknown as PostingDocumentLine;
  const projected = RULES.customer_invoice!(doc, [line], {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    taxComponentsByLine: new Map([["line", [{
      taxCodeId: "tax",
      sequence: 1,
      taxAmount: "13.0000",
      recoverableAmount: "0",
      nonrecoverableAmount: "0",
      calculationType: "standard" as const,
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
  const doc = { id: "doc", kind: "customer_invoice", partyId: "customer", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom: {} } as unknown as PostingDocument;
  const line = { id: "line", lineNumber: 1, accountId: "income", amount: "100.0000", taxAmount: "13.0000", taxCodeId: "tax" } as unknown as PostingDocumentLine;
  assert.throws(
    () => RULES.customer_invoice!(doc, [line], { control: { ap: "ap", ar: "ar", bank: "bank" } }),
    /no calculation evidence/,
  );
  assert.throws(
    () => RULES.customer_invoice!(doc, [line], {
      control: { ap: "ap", ar: "ar", bank: "bank" },
      taxComponentsByLine: new Map([["line", [{
        taxCodeId: "tax", sequence: 1, taxAmount: "12.9999", recoverableAmount: "12.9999",
        nonrecoverableAmount: "0", calculationType: "standard" as const, collectedAccountId: "output",
        paidAccountId: "input", withholdingAccountId: null,
      }]]]),
    }),
    /do not match stored tax total/,
  );
});

test("tax amounts without calculation evidence fail closed instead of posting short", () => {
  // A line carrying tax but no profile and no components posted its net
  // amount only: $13 of tax vanished from the projection while the document
  // still claimed it. Like a profile without evidence, tax without evidence
  // must fail closed before any journal is written.
  const doc = { id: "doc", kind: "customer_invoice", partyId: "customer", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom: {} } as unknown as PostingDocument;
  const control = { control: { ap: "ap", ar: "ar", bank: "bank" } };
  const taxedLine = { id: "line", lineNumber: 1, accountId: "income", amount: "100.0000", taxAmount: "13.0000" } as unknown as PostingDocumentLine;
  assert.throws(
    () => RULES.customer_invoice!(doc, [taxedLine], control),
    (error: Error) => error instanceof PostingError && /line 1 has a tax amount but no calculation evidence/.test(error.message),
  );
  const bill = { id: "doc", kind: "vendor_bill", partyId: "vendor", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom: {} } as unknown as PostingDocument;
  const billLine = { id: "line", lineNumber: 1, accountId: "expense", amount: "100.0000", taxAmount: "7.0000" } as unknown as PostingDocumentLine;
  assert.throws(
    () => RULES.vendor_bill!(bill, [billLine], control),
    (error: Error) => error instanceof PostingError && /line 1 has a tax amount but no calculation evidence/.test(error.message),
  );
  // Zero-tax lines without a profile still post untouched.
  const untaxed = { id: "line", lineNumber: 1, accountId: "income", amount: "100.0000", taxAmount: "0" } as unknown as PostingDocumentLine;
  const projected = RULES.customer_invoice!(doc, [untaxed], control);
  assert.deepEqual(projected.map((row) => [row.accountId, row.amount]), [
    ["ar", "100.0000"],
    ["income", "-100.0000"],
  ]);
});

test("credit memos mirror their invoice and bill projections with reversed direction", () => {
  // The -1 direction is a mutation target: flipped to +1, a credit memo
  // posts its tax legs with invoice/bill signs while still balancing, so
  // only exact mirrored amounts catch it.
  const deps = {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    taxComponentsByLine: new Map([["line", [
      { taxCodeId: "standard", sequence: 1, taxAmount: "10.0000", recoverableAmount: "5.0000", nonrecoverableAmount: "5.0000", calculationType: "standard" as const, collectedAccountId: "output", paidAccountId: "input", withholdingAccountId: null },
      { taxCodeId: "withholding", sequence: 2, taxAmount: "3.0000", recoverableAmount: "3.0000", nonrecoverableAmount: "0.0000", calculationType: "withholding" as const, collectedAccountId: null, paidAccountId: null, withholdingAccountId: "withholding" },
      { taxCodeId: "reverse", sequence: 3, taxAmount: "5.0000", recoverableAmount: "4.0000", nonrecoverableAmount: "1.0000", calculationType: "reverse_charge" as const, collectedAccountId: "output", paidAccountId: "input", withholdingAccountId: null },
    ]]]),
  };
  const bill = { id: "doc", kind: "vendor_credit", partyId: "vendor", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom: {} } as unknown as PostingDocument;
  const billLine = { id: "line", lineNumber: 1, accountId: "expense", amount: "100.0000", taxAmount: "7.0000", taxGroupId: "group" } as unknown as PostingDocumentLine;
  const creditProjected = RULES.vendor_credit!(bill, [billLine], deps);
  assert.deepEqual(creditProjected.map((row) => [row.accountId, row.amount]), [
    ["ap", "107.0000"],
    ["expense", "-106.0000"],
    ["input", "-5.0000"],
    ["withholding", "3.0000"],
    ["input", "-4.0000"],
    ["output", "5.0000"],
  ]);
  assert.doesNotThrow(() => assertFinalKernelBalance(creditProjected.map((row) => ({ ...row, subsidiaryId: "sub" }))));

  const invoice = { id: "invoice", kind: "customer_credit", partyId: "customer", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom: {} } as unknown as PostingDocument;
  const invoiceLine = { id: "line", lineNumber: 1, accountId: "income", amount: "100.0000", taxAmount: "13.0000", taxCodeId: "tax" } as unknown as PostingDocumentLine;
  const invoiceProjected = RULES.customer_credit!(invoice, [invoiceLine], {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    taxComponentsByLine: new Map([["line", [{
      taxCodeId: "tax",
      sequence: 1,
      taxAmount: "13.0000",
      recoverableAmount: "0",
      nonrecoverableAmount: "0",
      calculationType: "standard" as const,
      collectedAccountId: "output",
      paidAccountId: "input",
      withholdingAccountId: null,
    }]]]),
  });
  assert.deepEqual(invoiceProjected.map((row) => [row.accountId, row.amount]), [
    ["ar", "-113.0000"],
    ["income", "100.0000"],
    ["output", "13.0000"],
  ]);
  assert.doesNotThrow(() => assertFinalKernelBalance(invoiceProjected.map((row) => ({ ...row, subsidiaryId: "sub" }))));
});

test("taxable sales and purchases fail closed when no tax control account exists", () => {
  const baseDoc = {
    id: "doc",
    partyId: "party",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: {},
  } as unknown as PostingDocument;
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "detail",
    amount: "100.0000",
    taxAmount: "13.0000",
    taxCodeId: "tax",
  } as unknown as PostingDocumentLine;
  const deps = {
    control: { ar: "ar", ap: "ap", bank: "bank" },
    taxComponentsByLine: new Map([["line", [{
      taxCodeId: "tax",
      sequence: 1,
      taxAmount: "13.0000",
      recoverableAmount: "13.0000",
      nonrecoverableAmount: "0",
      calculationType: "standard" as const,
      collectedAccountId: null,
      paidAccountId: null,
      withholdingAccountId: null,
    }]]]),
  };
  assert.throws(
    () => RULES.customer_invoice!({ ...baseDoc, kind: "customer_invoice" }, [line], deps),
    (error: Error) => error instanceof PostingError && /collected tax .*no configured/.test(error.message),
  );
  assert.throws(
    () => RULES.vendor_bill!({ ...baseDoc, kind: "vendor_bill" }, [line], deps),
    (error: Error) => error instanceof PostingError && /paid tax .*no configured/.test(error.message),
  );
});

test("taxable lines use explicitly configured tax fallback accounts", () => {
  const doc = {
    id: "doc",
    kind: "customer_invoice",
    partyId: "party",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: {},
  } as unknown as PostingDocument;
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "income",
    amount: "100.0000",
    taxAmount: "13.0000",
    taxCodeId: "tax",
  } as unknown as PostingDocumentLine;
  const projected = RULES.customer_invoice!(doc, [line], {
    control: { ar: "ar", ap: "ap", bank: "bank", taxCollected: "tax-output" },
    taxComponentsByLine: new Map([["line", [{
      taxCodeId: "tax", sequence: 1, taxAmount: "13.0000", recoverableAmount: "0",
      nonrecoverableAmount: "0", calculationType: "standard" as const,
      collectedAccountId: null, paidAccountId: null, withholdingAccountId: null,
    }]]]),
  });
  assert.equal(projected.at(-1)!.accountId, "tax-output");
});

const transferDoc = {
  id: "trf",
  kind: "transfer",
  subsidiaryId: "sub",
  currency: "CAD",
  fxRate: "1",
  extraDims: null,
} as unknown as PostingDocument;

const transferLine = (
  lineNumber: number,
  accountId: string,
  amount: string,
) =>
  ({ id: `l${lineNumber}`, lineNumber, accountId, amount }) as unknown as PostingDocumentLine;

test("transfer moves exactly the entered amount between the two named accounts", () => {
  // Canonical contract — the shape every native importer emits: the
  // destination line carries the amount, the source line carries zero.
  const projected = RULES.transfer!(
    transferDoc,
    [transferLine(1, "bank-b", "100.0000"), transferLine(2, "bank-a", "0")],
    { control: { ap: "ap", ar: "ar", bank: "bank" } },
  );
  assert.deepEqual(projected.map((row) => [row.accountId, row.amount]), [
    ["bank-b", "100.0000"],
    ["bank-a", "-100.0000"],
  ]);
  assert.doesNotThrow(() =>
    assertFinalKernelBalance(projected.map((row) => ({ ...row, subsidiaryId: "sub" }))),
  );
});

test("payment discount/fee validation is PostingError, not a raw 500-class error", () => {
  // API routes map PostingError to 422 and plain Error to 500. These guards
  // reject caller-supplied custom amounts, so they must be PostingError like
  // every other rule validation in this file.
  const paymentLine = (lineNumber: number) =>
    ({ id: `p${lineNumber}`, lineNumber, accountId: "bank", amount: "100.0000" }) as unknown as PostingDocumentLine;
  const paymentDeps = { control: { ap: "ap", ar: "ar", bank: "bank" } };
  const vendorBill = (custom: Record<string, unknown>) =>
    ({ id: "vp", kind: "vendor_payment", partyId: "vendor", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom }) as unknown as PostingDocument;
  const customerReceipt = (custom: Record<string, unknown>) =>
    ({ id: "cp", kind: "customer_payment", partyId: "customer", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom }) as unknown as PostingDocument;
  const cases: Array<[string, () => unknown, RegExp]> = [
    ["negative discount", () => RULES.vendor_payment!(vendorBill({ discountAmount: "-5.0000", discountAccountId: "disc" }), [paymentLine(1)], paymentDeps), /discount cannot be negative/],
    ["missing discount account", () => RULES.vendor_payment!(vendorBill({ discountAmount: "5.0000" }), [paymentLine(1)], paymentDeps), /discount account is required/],
    ["negative fee", () => RULES.customer_payment!(customerReceipt({ feeAmount: "-5.0000", feeIncomeAccountId: "fee" }), [paymentLine(1)], paymentDeps), /fee cannot be negative/],
    ["fee exceeding receipt", () => RULES.customer_payment!(customerReceipt({ feeAmount: "500.0000", feeIncomeAccountId: "fee" }), [paymentLine(1)], paymentDeps), /fee exceeds the receipt/],
    ["missing fee account", () => RULES.customer_payment!(customerReceipt({ feeAmount: "5.0000" }), [paymentLine(1)], paymentDeps), /fee income account is required/],
    ["dust-negative discount", () => RULES.vendor_payment!(vendorBill({ discountAmount: "-0.0001", discountAccountId: "disc" }), [paymentLine(1)], paymentDeps), /discount cannot be negative/],
    ["dust-negative fee", () => RULES.customer_payment!(customerReceipt({ feeAmount: "-0.0001", feeIncomeAccountId: "fee" }), [paymentLine(1)], paymentDeps), /fee cannot be negative/],
  ];
  for (const [name, run, message] of cases) {
    assert.throws(run, (error: Error) => error instanceof PostingError && message.test(error.message), name);
  }
});

test("zero discount, zero fee, and a fee equal to the receipt post without extra legs", () => {
  // The zero boundaries are mutation targets: a shifted bound rejects the
  // legal zero (or accepts dust-negative amounts), and a widened fee cap
  // refuses a receipt consumed entirely by its surcharge.
  const paymentLine = (lineNumber: number) =>
    ({ id: `p${lineNumber}`, lineNumber, accountId: "bank", amount: "100.0000" }) as unknown as PostingDocumentLine;
  const paymentDeps = { control: { ap: "ap", ar: "ar", bank: "bank" } };
  const vendorBill = (custom: Record<string, unknown>) =>
    ({ id: "vp", kind: "vendor_payment", partyId: "vendor", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom }) as unknown as PostingDocument;
  const customerReceipt = (custom: Record<string, unknown>) =>
    ({ id: "cp", kind: "customer_payment", partyId: "customer", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom }) as unknown as PostingDocument;
  assert.deepEqual(
    RULES.vendor_payment!(vendorBill({ discountAmount: "0" }), [paymentLine(1)], paymentDeps).map((row) => [row.accountId, row.amount]),
    [["ap", "100.0000"], ["bank", "-100.0000"]],
  );
  assert.deepEqual(
    RULES.customer_payment!(customerReceipt({ feeAmount: "0" }), [paymentLine(1)], paymentDeps).map((row) => [row.accountId, row.amount]),
    [["bank", "100.0000"], ["ar", "-100.0000"]],
  );
  assert.deepEqual(
    RULES.customer_payment!(
      customerReceipt({ feeAmount: "100.0000", feeIncomeAccountId: "fee" }), [paymentLine(1)], paymentDeps,
    ).map((row) => [row.accountId, row.amount]),
    [["bank", "100.0000"], ["ar", "0.0000"], ["fee", "-100.0000"]],
  );
});

test("payment refunds post the opposite direction on the same side", () => {
  // Connector refund imports (e.g. a Xero payment against an ACCRECCREDIT
  // credit note) arrive as a negative bank line: a customer refund of 50
  // posts CR bank 50 / DR AR 50, and a supplier refund of 50 posts DR bank
  // 50 / CR AP 50 — the mirror image of the normal flow on the same side.
  const refundLine = (lineNumber: number) =>
    ({ id: `r${lineNumber}`, lineNumber, accountId: "bank", amount: "-50.0000" }) as unknown as PostingDocumentLine;
  const paymentDeps = { control: { ap: "ap", ar: "ar", bank: "bank" } };
  const customerRefund = (custom: Record<string, unknown>) =>
    ({ id: "cp", kind: "customer_payment", partyId: "customer", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom }) as unknown as PostingDocument;
  const vendorRefund = (custom: Record<string, unknown>) =>
    ({ id: "vp", kind: "vendor_payment", partyId: "vendor", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom }) as unknown as PostingDocument;
  assert.deepEqual(
    RULES.customer_payment!(customerRefund({ feeAmount: "0" }), [refundLine(1)], paymentDeps).map((row) => [row.accountId, row.amount]),
    [["bank", "-50.0000"], ["ar", "50.0000"]],
  );
  assert.deepEqual(
    RULES.vendor_payment!(vendorRefund({ discountAmount: "0" }), [refundLine(1)], paymentDeps).map((row) => [row.accountId, row.amount]),
    [["ap", "-50.0000"], ["bank", "50.0000"]],
  );
  // No acceptance surcharge exists on money returned to the customer: a fee
  // riding a refund is refused by name instead of miscompared against a
  // negative receipt.
  assert.throws(
    () => RULES.customer_payment!(customerRefund({ feeAmount: "5.0000", feeIncomeAccountId: "fee" }), [refundLine(1)], paymentDeps),
    (error: Error) => error instanceof PostingError && /cannot carry a payment-acceptance fee/.test(error.message),
  );
});

test("transfer posts dust amounts but refuses unresolvable line accounts", () => {
  // A shifted positivity bound rejects the smallest legal transfer; an
  // inverted account check lets an empty account reach the ledger.
  const control = { control: { ap: "ap", ar: "ar", bank: "bank" } };
  assert.deepEqual(
    RULES.transfer!(
      transferDoc,
      [transferLine(1, "bank-b", "0.0001"), transferLine(2, "bank-a", "0")],
      control,
    ).map((row) => [row.accountId, row.amount]),
    [["bank-b", "0.0001"], ["bank-a", "-0.0001"]],
  );
  assert.throws(
    () => RULES.vendor_bill!(
      { id: "doc", kind: "vendor_bill", partyId: "vendor", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom: {} } as unknown as PostingDocument,
      [{ id: "l1", lineNumber: 1, accountId: "", amount: "100.0000" } as unknown as PostingDocumentLine],
      control,
    ),
    (error: Error) => error instanceof PostingError && /no resolvable account/.test(error.message),
  );
});

test("card charges fail closed without a payment card", () => {
  // A negated card guard posts the liability leg against an undefined
  // account instead of refusing the document.
  const doc = { id: "doc", kind: "card_charge", partyId: "vendor", subsidiaryId: "sub", currency: "CAD", fxRate: "1", custom: {} } as unknown as PostingDocument;
  const line = { id: "line", lineNumber: 1, accountId: "expense", amount: "100.0000" } as unknown as PostingDocumentLine;
  assert.throws(
    () => RULES.card_charge!(doc, [line], { control: { ap: "ap", ar: "ar", bank: "bank" } }),
    (error: Error) => error instanceof PostingError && /requires a payment card/.test(error.message),
  );
});

test("transfer rejects a full-amount source leg instead of summing both legs", () => {
  // The old drawer emitted the amount on BOTH lines; summing them posted a
  // $100 transfer as DR 200 / CR 200 while still balancing.
  assert.throws(
    () =>
      RULES.transfer!(
        transferDoc,
        [
          transferLine(1, "bank-b", "100.0000"),
          transferLine(2, "bank-a", "100.0000"),
        ],
        { control: { ap: "ap", ar: "ar", bank: "bank" } },
      ),
    (error: Error) =>
      error instanceof PostingError && /exactly one line/.test(error.message),
  );
});

test("transfer rejects differing legs rather than averaging or summing them", () => {
  assert.throws(
    () =>
      RULES.transfer!(
        transferDoc,
        [
          transferLine(1, "bank-b", "100.0000"),
          transferLine(2, "bank-a", "80.0000"),
        ],
        { control: { ap: "ap", ar: "ar", bank: "bank" } },
      ),
    (error: Error) =>
      error instanceof PostingError && /exactly one line/.test(error.message),
  );
});

test("transfer requires exactly two lines naming distinct accounts and a positive amount", () => {
  const control = { control: { ap: "ap", ar: "ar", bank: "bank" } };
  assert.throws(
    () => RULES.transfer!(transferDoc, [transferLine(1, "bank-b", "100.0000")], control),
    /exactly two lines/,
  );
  assert.throws(
    () =>
      RULES.transfer!(
        transferDoc,
        [
          transferLine(1, "bank-b", "100.0000"),
          transferLine(2, "bank-a", "0"),
          transferLine(3, "bank-c", "0"),
        ],
        control,
      ),
    /exactly two lines/,
  );
  assert.throws(
    () =>
      RULES.transfer!(
        transferDoc,
        [transferLine(1, "bank-b", "100.0000"), transferLine(2, "", "0")],
        control,
      ),
    /name both/,
  );
  assert.throws(
    () =>
      RULES.transfer!(
        transferDoc,
        [
          transferLine(1, "bank-b", "100.0000"),
          transferLine(2, "bank-b", "0"),
        ],
        control,
      ),
    /different accounts/,
  );
  assert.throws(
    () =>
      RULES.transfer!(
        transferDoc,
        [transferLine(1, "bank-b", "0"), transferLine(2, "bank-a", "0")],
        control,
      ),
    /must be positive/,
  );
});

async function seedApprovedDocument(
  org: ScratchOrg,
  kind: "customer_invoice" | "vendor_bill",
  documentNumber: string,
  options: { amount?: string; currency?: string; fxRate?: string } = {},
): Promise<string> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  const amount = options.amount ?? "80.0000";
  const currency = options.currency ?? "CAD";
  const fxRate = options.fxRate ?? "1";
  const partyId = kind === "customer_invoice" ? org.customerId : org.vendorId;
  const accountId = kind === "customer_invoice" ? org.accounts.revenue : org.accounts.cogs;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
    values (${documentId}, ${org.orgId}, ${kind}, 'draft', ${documentNumber},
            ${partyId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
            ${currency}, ${fxRate}, ${amount}, '0', ${amount})`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, account_id, amount,
       tax_input_amount, tax_amount, quantity, unit_price)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${accountId}, ${amount},
            ${amount}, '0', '1', ${amount})`);
  await db.execute(sql`
    update documents
       set status = 'approved'
     where id = ${documentId} and org_id = ${org.orgId}`);
  return documentId;
}

test("GL projection keys treat line order as presentation-only", () => {
  const lines = [
    {
      accountId: "ar",
      amount: "100.0000",
      subsidiaryId: "sub",
      partyId: "customer",
      currency: "CAD",
      txnAmount: "100.0000",
      fxRate: "1.0000000000",
    },
    {
      accountId: "income",
      amount: "-100.0000",
      subsidiaryId: "sub",
      currency: "CAD",
      txnAmount: "-100.0000",
      fxRate: "1.0000000000",
    },
  ];
  assert.equal(
    glProjectionKey(lines),
    glProjectionKey([...lines].reverse()),
    "reordering identical GL lines must not look like an accounting change",
  );
});

test("numeric default FX header rates resolve a stored spot instead of a 1:1 peg", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      insert into fx_rates (id, org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${randomUUID()}, ${org.orgId}, 'USD', 'CAD', ${org.date}, 'spot', '1.2500000000', 'posting-test')`);
    const documentId = await seedApprovedDocument(org, "customer_invoice", "FX-SENTINEL-1", {
      currency: "USD",
      fxRate: "1.0000000000",
    });
    const entryId = await postDocument(documentId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }, { deferEffects: true, suppressAutomation: true });
    const revenue = (await db.execute<{ amount: string; txn_amount: string; fx_rate: string }>(sql`
      select amount::text, txn_amount::text, fx_rate::text
        from journal_lines
       where entry_id = ${entryId} and account_id = ${org.accounts.revenue}`)).rows[0]!;
    assert.deepEqual(revenue, {
      amount: "-100.0000",
      txn_amount: "-80.0000",
      fx_rate: "1.2500000000",
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("different document kinds sharing a number post to distinct journal identities", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const deps = { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
  try {
    const invoiceId = await seedApprovedDocument(org, "customer_invoice", "DUP-POSTING-1");
    await postDocument(invoiceId, deps, { deferEffects: true, suppressAutomation: true });
    const billId = await seedApprovedDocument(org, "vendor_bill", "DUP-POSTING-1");
    await postDocument(billId, deps, { deferEffects: true, suppressAutomation: true });
    const entries = (await db.execute<{ entry_number: string; source_document_id: string }>(sql`
      select entry_number, source_document_id from journal_entries
       where org_id = ${org.orgId} and source_document_id in (${invoiceId}, ${billId})
    `)).rows;
    assert.equal(entries.length, 2);
    assert.equal(new Set(entries.map((entry) => entry.entry_number)).size, 2);
    assert.deepEqual(new Set(entries.map((entry) => entry.source_document_id)), new Set([invoiceId, billId]));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("final posting proof catches dust imbalance and cross-subsidiary masking", () => {
  // A single 0.0001 unit is real money: the kernel trigger would refuse it,
  // so the application proof must refuse it first with a readable error.
  assert.throws(
    () => assertFinalKernelBalance([
      { subsidiaryId: "A", amount: "10.0000" },
      { subsidiaryId: "A", amount: "-9.9999" },
    ]),
    /does not balance/,
  );
  // Whole-entry balance must not mask a per-subsidiary break: +10 on A and
  // -10 on B sum to zero yet each entity's books are wrong.
  assert.throws(
    () => assertFinalKernelBalance([
      { subsidiaryId: "A", amount: "10.0000" },
      { subsidiaryId: "B", amount: "-10.0000" },
    ]),
    /subsidiary A/,
  );
  assert.throws(
    () => assertFinalKernelBalance([
      { subsidiaryId: "A", amount: "10.0000" },
      { subsidiaryId: "A", amount: "-5.0000" },
      { subsidiaryId: "B", amount: "-5.0000" },
    ]),
    /subsidiary A/,
  );
  // A guard that only summed the whole entry would pass all three rows above.
  // Multi-subsidiary balance with every entity at zero still passes.
  assert.doesNotThrow(() =>
    assertFinalKernelBalance([
      { subsidiaryId: "A", amount: "10.0000" },
      { subsidiaryId: "A", amount: "-10.0000" },
      { subsidiaryId: "B", amount: "3.0000" },
      { subsidiaryId: "B", amount: "-3.0000" },
    ]),
  );
  // Degenerate projections never reach the ledger.
  assert.throws(() => assertFinalKernelBalance([]), /fewer than 2 lines/);
  assert.throws(
    () => assertFinalKernelBalance([{ subsidiaryId: "A", amount: "10.0000" }]),
    /fewer than 2 lines/,
  );
});

test("kernel projections are deterministic: the same input posts the same lines twice", () => {
  // Regeneration compares against the original projection; a rule that reads
  // a clock, a random id, or iteration order would drift and every repost
  // would look like an accounting change.
  const doc = {
    id: "doc",
    kind: "vendor_bill",
    partyId: "vendor",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: {},
  } as unknown as PostingDocument;
  const line = {
    id: "line",
    lineNumber: 1,
    accountId: "expense",
    amount: "100.0000",
    taxAmount: "5.0000",
    taxCodeId: "tax",
  } as unknown as PostingDocumentLine;
  const deps = {
    control: { ap: "ap", ar: "ar", bank: "bank" },
    taxComponentsByLine: new Map([["line", [{
      taxCodeId: "tax",
      sequence: 1,
      taxAmount: "5.0000",
      recoverableAmount: "5.0000",
      nonrecoverableAmount: "0",
      calculationType: "standard" as const,
      collectedAccountId: "output",
      paidAccountId: "input",
      withholdingAccountId: null,
    }]]]),
  };
  const first = RULES.vendor_bill!(doc, [line], deps);
  const second = RULES.vendor_bill!(doc, [line], deps);
  assert.deepEqual(second, first);
  assert.doesNotThrow(() =>
    assertFinalKernelBalance(first.map((row) => ({ ...row, subsidiaryId: "sub" }))),
  );
  const transferFirst = RULES.transfer!(
    transferDoc,
    [transferLine(1, "bank-b", "100.0000"), transferLine(2, "bank-a", "0")],
    { control: { ap: "ap", ar: "ar", bank: "bank" } },
  );
  assert.deepEqual(
    RULES.transfer!(
      transferDoc,
      [transferLine(1, "bank-b", "100.0000"), transferLine(2, "bank-a", "0")],
      { control: { ap: "ap", ar: "ar", bank: "bank" } },
    ),
    transferFirst,
  );
});

test("open-item gating is a pure function of party presence and control designation", () => {
  // Truth table: only party-bearing legs on designated control accounts join
  // the subledger. A dropped party check would age anonymous GL activity; a
  // dropped designation check would age every expense line.
  const designated = new Set(["ar", "ap"]);
  const cases: Array<[string, string | null | undefined, ReadonlySet<string> | undefined, boolean]> = [
    ["ar", "customer", designated, true],
    ["ap", "vendor", designated, true],
    ["ar", null, designated, false],
    ["ar", undefined, designated, false],
    ["ar", "customer", undefined, false],
    ["ar", "customer", new Set(), false],
    ["expense", "vendor", designated, false],
    ["bank", "customer", designated, false],
    ["ap", "", designated, true],
  ];
  for (const [accountId, partyId, accounts, expected] of cases) {
    assert.equal(
      controlLineIsOpenItem(accountId, partyId, accounts),
      expected,
      `controlLineIsOpenItem(${accountId}, ${String(partyId)})`,
    );
  }
});

test("replaying a posted document refuses without duplicating entries or lines", { skip: !DB }, async () => {
  // Postings must be idempotent at the boundary: a retried or double-fired
  // postDocument for the same document throws instead of inserting a second
  // entry, so the ledger can never hold two entries (or two line sets) for
  // one document.
  const org = await createScratchOrg();
  const deps = { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
  try {
    const documentId = await seedApprovedDocument(org, "customer_invoice", "REPLAY-IDEMPOTENT-1");
    await postDocument(documentId, deps, { deferEffects: true, suppressAutomation: true });
    const counts = async () => (await db.execute<{ entries: string; lines: string }>(sql`
      select (select count(*)::text from journal_entries
               where org_id = ${org.orgId} and source_document_id = ${documentId}) as entries,
             (select count(*)::text from journal_lines jl
                join journal_entries je on je.id = jl.entry_id
               where je.org_id = ${org.orgId} and je.source_document_id = ${documentId}) as lines`)).rows[0]!;
    const before = await counts();
    assert.equal(before.entries, "1");
    await assert.rejects(
      postDocument(documentId, deps, { deferEffects: true, suppressAutomation: true }),
      (error: Error) => error instanceof PostingError && /already posted/.test(error.message),
    );
    assert.deepEqual(await counts(), before);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

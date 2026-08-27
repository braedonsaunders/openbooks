import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";
import {
  assertFinalKernelBalance,
  controlLineIsOpenItem,
  glProjectionKey,
  postDocument,
  PostingError,
  RULES,
  type PostingDocument,
  type PostingDocumentLine,
} from "./posting.ts";

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
        nonrecoverableAmount: "0", calculationType: "standard", collectedAccountId: "output",
        paidAccountId: "input", withholdingAccountId: null,
      }]]]),
    }),
    /do not match stored tax total/,
  );
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

test("cross-document journal-number collisions identify the claimant document", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const deps = { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
  try {
    const invoiceId = await seedApprovedDocument(org, "customer_invoice", "DUP-POSTING-1");
    await postDocument(invoiceId, deps, { deferEffects: true, suppressAutomation: true });
    const billId = await seedApprovedDocument(org, "vendor_bill", "DUP-POSTING-1");
    await assert.rejects(
      postDocument(billId, deps, { deferEffects: true, suppressAutomation: true }),
      (error: unknown) =>
        error instanceof Error &&
        /journal entry number "DUP-POSTING-1" is already used by customer_invoice/.test(error.message) &&
        !/already posted or voided/.test(error.message),
    );
    const status = (await db.execute<{ status: string }>(sql`
      select status from documents where id = ${billId} and org_id = ${org.orgId}`)).rows[0]?.status;
    assert.equal(status, "approved");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

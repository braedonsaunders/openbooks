import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext, withOrg } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { postDocument } from "./posting-document.ts";
import { createProgram, issueStoredValue } from "../stored-value/accounts.ts";
import {
  completeRequestedDocumentVoid,
  requestDocumentVoid,
} from "./document-void.ts";
import { receiveInventory } from "../inventory/movements.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { computeTaxReturn } from "../tax-returns/return.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const control = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function seedStandardCode(org: ScratchOrg): Promise<string> {
  const codeId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into tax_codes
      (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
    values (${codeId}, ${org.orgId}, 'CASH-STD', 'Cash sale standard', 'both', 'standard',
            ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`));
  return codeId;
}

interface CashLine {
  amount: string;
  taxAmount?: string;
  taxCodeId?: string;
  itemId?: string;
  quantity?: string;
  unitPrice?: string;
  inventoryReturnSourceIssueId?: string;
}

interface CashTenderInput {
  kind?: string;
  methodLabel?: string;
  accountId?: string | null;
  storedValueAccountId?: string | null;
  amount: string;
  reference?: string;
}

/** Draft an approved cash document with exact matching header totals. */
async function draftCashDocument(
  org: ScratchOrg,
  kind: "cash_sale" | "cash_refund",
  number: string,
  lines: CashLine[],
  tenders: CashTenderInput[] | null,
  partyId: string | null = org.customerId,
): Promise<{ id: string; lineIds: string[] }> {
  const id = randomUUID();
  const lineIds = lines.map(() => randomUUID());
  const subtotal = lines.reduce((n, l) => n + Number(l.amount), 0).toFixed(4);
  const taxTotal = lines.reduce((n, l) => n + Number(l.taxAmount ?? "0"), 0).toFixed(4);
  const total = (Number(subtotal) + Number(taxTotal)).toFixed(4);
  await withBypassContext(() =>
    db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom)
      values (${id}, ${org.orgId}, ${kind}, 'draft', ${number}, ${org.subsidiaryId},
              ${partyId}, ${org.date}, ${org.date}, 'CAD', '1',
              ${subtotal}, ${taxTotal}, ${total}, '{}'::jsonb)`),
  );
  // Tenders live in document_tenders (never in custom): the lifecycle guard
  // permits writes while this draft parent is still unapproved.
  for (let i = 0; i < (tenders ?? []).length; i++) {
    const tender = tenders![i]!;
    const kind = tender.kind ?? "cash";
    await withBypassContext(() =>
      db.execute(sql`
        insert into document_tenders
          (org_id, document_id, position, kind, method_label, account_id,
           stored_value_account_id, amount_minor, currency, reference)
        values (${org.orgId}, ${id}, ${i + 1}, ${kind}, ${tender.methodLabel ?? kind},
                ${tender.accountId ?? null}, ${tender.storedValueAccountId ?? null},
                ${toUnits(tender.amount).toString()}, 'CAD',
                ${tender.reference ?? null})`),
    );
  }
  let lineNumber = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    lineNumber += 1;
    const lineCustom = line.inventoryReturnSourceIssueId
      ? JSON.stringify({ inventoryReturn: { sourceIssueMovementId: line.inventoryReturnSourceIssueId } })
      : "{}";
    await withBypassContext(() =>
      db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
           tax_amount, tax_code_id, quantity, unit_price, item_id, stock_location_id, custom)
        values (${lineIds[i]}, ${org.orgId}, ${id}, ${lineNumber}, ${org.accounts.revenue},
                ${line.amount}, ${line.amount}, ${line.taxAmount ?? "0"},
                ${line.taxCodeId ?? null}, ${line.quantity ?? "1"}, ${line.unitPrice ?? line.amount},
                ${line.itemId ?? null}, ${line.itemId ? org.stockLocationId : null},
                ${lineCustom}::jsonb)`),
    );
    if (line.taxCodeId) {
      await withBypassContext(() =>
        db.execute(sql`
          insert into document_line_tax_components
            (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
             tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
             price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
             paid_account_id, withholding_account_id, overridden)
          values (${org.orgId}, ${lineIds[i]}, ${line.taxCodeId}, 1, '10', ${line.amount},
                  ${line.taxAmount ?? "0"}, '0.0000', ${line.taxAmount ?? "0"}, 'standard',
                  false, false, 2, ${org.accounts.taxOutput}, null, null, false)`),
      );
    }
  }
  await withBypassContext(() =>
    db.execute(sql`update documents set status = 'approved' where id = ${id} and org_id = ${org.orgId}`),
  );
  return { id, lineIds };
}

async function entryLines(documentId: string, orgId: string): Promise<{ number: string | null; amount: string }[]> {
  const rows = (await db.execute<{ number: string | null; amount: string }>(sql`
    select a.number, l.amount::text as amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where e.org_id = ${orgId} and e.source_document_id = ${documentId}
     order by l.line_number`)).rows;
  return rows;
}

async function entryCount(documentId: string, orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where source_document_id = ${documentId} and org_id = ${orgId}`)).rows;
  return rows[0]?.n ?? 0;
}

test("a cash sale posts a balanced entry with tax and two tenders, and no receivable", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const codeId = await seedStandardCode(org);
    const till = await withBypassContext(() =>
      seedPostingAccount(org.orgId, "1010", "Till Clearing", "asset_current_other", org.subsidiaryId),
    );
    const { id } = await draftCashDocument(org, "cash_sale", "CS-1", [
      { amount: "100.0000", taxAmount: "10.0000", taxCodeId: codeId },
    ], [
      { kind: "cash", accountId: org.accounts.bank, amount: "60.0000" },
      { kind: "card", accountId: till, amount: "50.0000", reference: "auth-1" },
    ]);
    await withOrg(org.orgId, () => postDocument(id, control(org)));
    const legs = await entryLines(id, org.orgId);
    assert.deepEqual(
      legs.map((l) => [l.number, l.amount]),
      [
        ["1000", "60.0000"],
        ["1010", "50.0000"],
        ["4000", "-100.0000"],
        ["2250", "-10.0000"],
      ],
    );
    // No receivable leg and no open-item leg: a paid sale must never surface
    // in aging, dunning, or statements of balance.
    const openItems = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.org_id = ${org.orgId} and e.source_document_id = ${id}
         and (l.is_open_item or l.account_id = ${org.accounts.ar})`)).rows[0]?.n ?? 1;
    assert.equal(openItems, 0);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("tenders that do not sum to the total are refused by name", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const codeId = await seedStandardCode(org);
    const { id } = await draftCashDocument(org, "cash_sale", "CS-SHORT", [
      { amount: "100.0000", taxAmount: "10.0000", taxCodeId: codeId },
    ], [{ kind: "cash", accountId: org.accounts.bank, amount: "100.0000" }]);
    await assert.rejects(
      withOrg(org.orgId, () => postDocument(id, control(org))),
      (error: unknown) =>
        error instanceof PostingError &&
        /tenders 100\.0000 but lines and tax total 110\.0000/.test(error.message),
    );
    assert.equal(await entryCount(id, org.orgId), 0);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a cash sale with no tenders is refused before any journal", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { id } = await draftCashDocument(org, "cash_sale", "CS-NOTENDER", [
      { amount: "50.0000" },
    ], null);
    await assert.rejects(
      withOrg(org.orgId, () => postDocument(id, control(org))),
      (error: unknown) =>
        error instanceof PostingError && /has no tenders/.test(error.message),
    );
    assert.equal(await entryCount(id, org.orgId), 0);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a stocked cash sale issues inventory and a refund restocks at original cost", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Cash Stock Keeper", "admin"),
    );
    await withOrg(org.orgId, () =>
      receiveInventory(org.orgId, actorId, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "4",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
    );
    const sale = await draftCashDocument(org, "cash_sale", "CS-STOCK", [
      { amount: "20.0000", itemId: org.items.fifo, quantity: "2", unitPrice: "10" },
    ], [{ kind: "cash", accountId: org.accounts.bank, amount: "20.0000" }]);
    await withOrg(org.orgId, () => postDocument(sale.id, control(org)));
    const issue = (await db.execute<{ id: string; quantity: string; value: string }>(sql`
      select id, quantity::text as quantity, total_value::text as value
        from inventory_movements
       where org_id = ${org.orgId} and document_line_id = ${sale.lineIds[0]} and kind = 'issue'`)).rows[0];
    assert.ok(issue, "the sale issues stock");
    // The refund restores the first unit at the cost it left at.
    const refund = await draftCashDocument(org, "cash_refund", "CR-STOCK", [
      {
        amount: "10.0000",
        itemId: org.items.fifo,
        quantity: "1",
        unitPrice: "10",
        inventoryReturnSourceIssueId: issue!.id,
      },
    ], [{ kind: "cash", accountId: org.accounts.bank, amount: "10.0000" }]);
    await withOrg(org.orgId, () => postDocument(refund.id, control(org)));
    const receipt = (await db.execute<{ quantity: string; value: string }>(sql`
      select quantity::text as quantity, total_value::text as value
        from inventory_movements
       where org_id = ${org.orgId} and document_line_id = ${refund.lineIds[0]} and kind = 'receipt'`)).rows[0];
    assert.deepEqual([receipt?.quantity, receipt?.value], ["1.0000", "4.0000"]);
    const refundLegs = await entryLines(refund.id, org.orgId);
    assert.deepEqual(
      refundLegs.map((l) => [l.number, l.amount]),
      [
        ["1000", "-10.0000"],
        ["4000", "10.0000"],
      ],
    );
    // Returning more than the unreturned remainder is refused by name.
    const over = await draftCashDocument(org, "cash_refund", "CR-OVER", [
      {
        amount: "20.0000",
        itemId: org.items.fifo,
        quantity: "2",
        unitPrice: "10",
        inventoryReturnSourceIssueId: issue!.id,
      },
    ], [{ kind: "cash", accountId: org.accounts.bank, amount: "20.0000" }]);
    await assert.rejects(
      withOrg(org.orgId, () => postDocument(over.id, control(org))),
      (error: unknown) => error instanceof Error && /exceeds the unreturned quantity/.test(error.message),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("voiding a cash sale reverses its entry", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Cash Void Clerk", "admin"));
    const { id } = await draftCashDocument(org, "cash_sale", "CS-VOID", [
      { amount: "40.0000" },
    ], [{ kind: "cash", accountId: org.accounts.bank, amount: "40.0000" }]);
    await withOrg(org.orgId, () => postDocument(id, control(org)));
    const requested = await withOrg(org.orgId, () =>
      requestDocumentVoid({ documentId: id, orgId: org.orgId, actorId, reason: "till error", reversalDate: org.date, source: "api" }),
    );
    assert.equal(requested.status, "voided");
    await withOrg(org.orgId, () => completeRequestedDocumentVoid(id, org.orgId, null));
    const legs = (await db.execute<{ amount: string }>(sql`
      select l.amount::text as amount
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.org_id = ${org.orgId}
         and (e.source_document_id = ${id} or e.id in (
           select reversal_entry_id from documents where id = ${id} and org_id = ${org.orgId}
         ))`)).rows;
    const net = legs.reduce((n, l) => n + Number(l.amount), 0);
    assert.equal(net, 0);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

interface StoredValueSetup {
  liability: string;
  giftProgramId: string;
  creditProgramId: string;
}

/** Stored-value feature, liability control, and both programs. */
async function seedStoredValue(org: ScratchOrg, actorId: string): Promise<StoredValueSetup> {
  const liability = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "2600", "Stored value liability", "liability_current_other"),
  );
  await withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = settings
        || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"storedValue": true}'::jsonb)
       where id = ${org.orgId}`);
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,storedValueLiability}', to_jsonb(${liability}::text), true)
       where id = ${org.orgId}`);
  });
  const gift = await withBypass(() =>
    createProgram({
      orgId: org.orgId, name: "Till gift cards", kind: "gift_card",
      liabilityAccountId: liability, actorId,
    }),
  );
  const credit = await withBypass(() =>
    createProgram({
      orgId: org.orgId, name: "Till store credit", kind: "store_credit",
      liabilityAccountId: liability, actorId,
    }),
  );
  return { liability, giftProgramId: gift.id, creditProgramId: credit.id };
}

async function storedValueBalance(orgId: string, accountId: string): Promise<string> {
  const row = (await db.execute<{ balance: string }>(sql`
    select balance_minor::text as balance from stored_value_accounts
     where org_id = ${orgId} and id = ${accountId}`)).rows[0];
  assert.ok(row);
  return row.balance;
}

test("a stored-value tender posts debit liability and reduces the balance", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Till Clerk", "admin"));
    const sv = await seedStoredValue(org, actorId);
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId, allowedSubsidiaryIds: null, programId: sv.giftProgramId, amountMinor: toUnits("100"),
        currency: "CAD", debitAccountId: org.accounts.bank, postingDate: org.date,
        idempotencyKey: `till-gift-${randomUUID()}`, actorId,
      }),
    );
    const { id } = await draftCashDocument(org, "cash_sale", "CS-SV", [
      { amount: "60.0000" },
    ], [
      { kind: "stored_value", methodLabel: "Gift card", storedValueAccountId: issued.accountId, amount: "60.0000" },
    ]);
    await withOrg(org.orgId, () => postDocument(id, control(org)));
    const legs = await entryLines(id, org.orgId);
    assert.deepEqual(
      legs.map((l) => [l.number, l.amount]),
      [
        ["2600", "60.0000"],
        ["4000", "-60.0000"],
      ],
    );
    assert.equal(await storedValueBalance(org.orgId, issued.accountId), toUnits("40").toString());
    // The subledger entry points at the sale's journal, and the payment
    // evidence lives in the table — a masked clone nulls custom, never this.
    const link = (await db.execute<{ journal: string | null; document: string | null }>(sql`
      select journal_entry_id as journal, document_id as document from stored_value_entries
       where org_id = ${org.orgId} and account_id = ${issued.accountId} and kind = 'redeem'`)).rows[0];
    assert.ok(link?.journal);
    assert.equal(link?.document, id);
    const custom = (await db.execute<{ custom: unknown }>(sql`
      select custom from documents where org_id = ${org.orgId} and id = ${id}`)).rows[0]?.custom as Record<string, unknown>;
    assert.ok(custom && !("tenders" in custom));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an overdrawn stored-value tender refuses naming the balance and posts nothing", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Till Clerk", "admin"));
    const sv = await seedStoredValue(org, actorId);
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId, allowedSubsidiaryIds: null, programId: sv.giftProgramId, amountMinor: toUnits("50"),
        currency: "CAD", debitAccountId: org.accounts.bank, postingDate: org.date,
        idempotencyKey: `till-gift-${randomUUID()}`, actorId,
      }),
    );
    const { id } = await draftCashDocument(org, "cash_sale", "CS-SVSHORT", [
      { amount: "60.0000" },
    ], [
      { kind: "stored_value", methodLabel: "Gift card", storedValueAccountId: issued.accountId, amount: "60.0000" },
    ]);
    await assert.rejects(
      withOrg(org.orgId, () => postDocument(id, control(org))),
      (error: unknown) =>
        error instanceof PostingError &&
        /holds 50\.0000.*less than.*60\.0000/.test(error.message),
    );
    assert.equal(await entryCount(id, org.orgId), 0);
    assert.equal(await storedValueBalance(org.orgId, issued.accountId), toUnits("50").toString());
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a cash refund to store credit loads the named account", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Refund Clerk", "admin"));
    const sv = await seedStoredValue(org, actorId);
    const issued = await withBypass(() =>
      issueStoredValue({
        orgId: org.orgId, allowedSubsidiaryIds: null, programId: sv.creditProgramId, amountMinor: toUnits("20"),
        currency: "CAD", customerPartyId: org.customerId, debitAccountId: org.accounts.bank,
        postingDate: org.date, idempotencyKey: `till-credit-${randomUUID()}`, actorId,
      }),
    );
    const { id } = await draftCashDocument(org, "cash_refund", "CR-SV", [
      { amount: "10.0000" },
    ], [
      { kind: "stored_value", methodLabel: "Store credit", storedValueAccountId: issued.accountId, amount: "10.0000" },
    ]);
    await withOrg(org.orgId, () => postDocument(id, control(org)));
    const legs = await entryLines(id, org.orgId);
    assert.deepEqual(
      legs.map((l) => [l.number, l.amount]),
      [
        ["2600", "-10.0000"],
        ["4000", "10.0000"],
      ],
    );
    assert.equal(await storedValueBalance(org.orgId, issued.accountId), toUnits("30").toString());
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a cash refund to store credit mints from the memo program and fills the tender", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Refund Clerk", "admin"));
    const sv = await seedStoredValue(org, actorId);
    const { id } = await draftCashDocument(org, "cash_refund", "CR-SVMINT", [
      { amount: "25.0000" },
    ], [
      { kind: "stored_value", methodLabel: "Store credit", amount: "25.0000" },
    ]);
    await withBypassContext(() => db.execute(sql`
      update documents set custom = jsonb_build_object('storeCreditProgramId', ${sv.creditProgramId}::uuid)
       where org_id = ${org.orgId} and id = ${id}`));
    await withOrg(org.orgId, () => postDocument(id, control(org)));
    // The post-commit effect minted the account and filled the tender row —
    // the only post-commit tender write the lifecycle guard permits.
    const tender = (await db.execute<{ account: string | null }>(sql`
      select stored_value_account_id as account from document_tenders
       where org_id = ${org.orgId} and document_id = ${id}`)).rows[0];
    assert.ok(tender?.account);
    assert.equal(await storedValueBalance(org.orgId, tender.account!), toUnits("25").toString());
    const legs = await entryLines(id, org.orgId);
    assert.deepEqual(
      legs.map((l) => [l.number, l.amount]),
      [
        ["2600", "-25.0000"],
        ["4000", "25.0000"],
      ],
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("posted tender rows reject direct edits", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { id } = await draftCashDocument(org, "cash_sale", "CS-LOCKED", [
      { amount: "40.0000" },
    ], [{ kind: "cash", accountId: org.accounts.bank, amount: "40.0000" }]);
    await withOrg(org.orgId, () => postDocument(id, control(org)));
    await assert.rejects(
      withBypassContext(() => db.execute(sql`
        update document_tenders set amount_minor = 1
         where org_id = ${org.orgId} and document_id = ${id}`)),
      (error: unknown) =>
        error instanceof Error &&
        /immutable outside draft status/.test(
          `${error.message} ${(error as { cause?: unknown }).cause ?? ""}`,
        ),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("the sales tax return includes cash sale tax and nets cash refunds", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const codeId = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
      values (${codeId}, ${org.orgId}, 'CASH-VAT', 'Cash VAT', 'both', 'standard',
              ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`));
    const sale = await draftCashDocument(org, "cash_sale", "CS-TAX", [
      { amount: "200.0000", taxAmount: "20.0000", taxCodeId: codeId },
    ], [{ kind: "cash", accountId: org.accounts.bank, amount: "220.0000" }]);
    await withOrg(org.orgId, () => postDocument(sale.id, control(org)));
    const refund = await draftCashDocument(org, "cash_refund", "CR-TAX", [
      { amount: "50.0000", taxAmount: "5.0000", taxCodeId: codeId },
    ], [{ kind: "cash", accountId: org.accounts.bank, amount: "55.0000" }]);
    await withOrg(org.orgId, () => postDocument(refund.id, control(org)));
    const formCode = "CASH_SALES_BASE";
    await withBypassContext(() => db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, 'Cash sales base probe', 'efile_api', true)`));
    await withBypassContext(() => db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values
        (${randomUUID()}, ${org.orgId}, ${formCode}, '6', 'Total value of sales excluding tax', ${codeId}, 'taxable_base', 1, 60),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '1', 'Tax due on sales', ${codeId}, 'tax_collected', -1, 10)`));
    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    const values = new Map(result.boxes.map((box) => [box.lineCode, box.value]));
    // Sales base: 200 sale − 50 refund. Tax: 20 − 5.
    assert.equal(values.get("6"), "150.0000");
    assert.equal(values.get("1"), "15.0000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

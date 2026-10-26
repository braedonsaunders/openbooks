import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { postDocument } from "./posting-document.ts";
import { readTipsPayableExposure } from "../sales/cash-closeout.ts";
import { requestDocumentVoid } from "./document-void.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const control = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

interface CashLine {
  amount: string;
  taxAmount?: string;
  taxCodeId?: string;
}

interface CashTenderInput {
  kind?: string;
  accountId?: string | null;
  amount: string;
}

/** Draft an approved cash sale with an optional canonical close-out bag. */
async function draftCloseoutSale(
  org: ScratchOrg,
  number: string,
  lines: CashLine[],
  tenders: CashTenderInput[],
  closeout: Record<string, unknown> | null,
): Promise<string> {
  const id = randomUUID();
  const subtotal = lines.reduce((n, l) => n + Number(l.amount), 0).toFixed(4);
  const taxTotal = lines.reduce((n, l) => n + Number(l.taxAmount ?? "0"), 0).toFixed(4);
  const total = (Number(subtotal) + Number(taxTotal)).toFixed(4);
  await withBypassContext(() =>
    db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom)
      values (${id}, ${org.orgId}, 'cash_sale', 'draft', ${number}, ${org.subsidiaryId},
              ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '1',
              ${subtotal}, ${taxTotal}, ${total},
              ${JSON.stringify(closeout ? { closeout } : {})}::jsonb)`),
  );
  for (let i = 0; i < tenders.length; i++) {
    const tender = tenders[i]!;
    await withBypassContext(() =>
      db.execute(sql`
        insert into document_tenders
          (org_id, document_id, position, kind, method_label, account_id,
           stored_value_account_id, amount_minor, currency, reference)
        values (${org.orgId}, ${id}, ${i + 1}, ${tender.kind ?? "cash"}, ${tender.kind ?? "cash"},
                ${tender.accountId ?? null}, null,
                ${toUnits(tender.amount).toString()}, 'CAD', null)`),
    );
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    await withBypassContext(() =>
      db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
           tax_amount, tax_code_id, quantity, unit_price, custom)
        values (${randomUUID()}, ${org.orgId}, ${id}, ${i + 1}, ${org.accounts.revenue},
                ${line.amount}, ${line.amount}, ${line.taxAmount ?? "0"},
                ${line.taxCodeId ?? null}, '1', ${line.amount}, '{}'::jsonb)`),
    );
  }
  await withBypassContext(() =>
    db.execute(
      sql`update documents set status = 'approved' where id = ${id} and org_id = ${org.orgId}`,
    ),
  );
  return id;
}

async function closeoutAccounts(
  org: ScratchOrg,
): Promise<{ tips: string; fees: string; overShort: string }> {
  const tips = await withBypassContext(() =>
    seedPostingAccount(
      org.orgId,
      "2160",
      "Tips Payable",
      "liability_current_other",
      org.subsidiaryId,
    ),
  );
  const fees = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "6160", "Processor Fees", "expense", org.subsidiaryId),
  );
  const overShort = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "6190", "Cash Over/Short", "expense_other", org.subsidiaryId),
  );
  await withBypassContext(() =>
    db.execute(sql`
    update orgs set settings = settings ||
      jsonb_build_object('controlAccounts',
        coalesce(settings->'controlAccounts', '{}'::jsonb) ||
        jsonb_build_object('tipsPayable', ${tips}::text, 'processorFees', ${fees}::text, 'cashOverShort', ${overShort}::text))
     where id = ${org.orgId}`),
  );
  return { tips, fees, overShort };
}

async function entryLegs(documentId: string, orgId: string): Promise<[string | null, string][]> {
  const rows = await db.execute<{ number: string | null; amount: string }>(
    sql`
    select a.number, l.amount::text as amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where e.org_id = ${orgId} and e.source_document_id = ${documentId}
     order by l.line_number`,
    "objects",
  );
  return rows.map((row) => [row.number, row.amount]);
}

test("tips and fees post to liability and expense, never revenue", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await closeoutAccounts(org);
    const card = await withBypassContext(() =>
      seedPostingAccount(
        org.orgId,
        "1011",
        "Card Clearing",
        "asset_current_other",
        org.subsidiaryId,
      ),
    );
    // Total 100 + 5.00 tip − 0.35 fee: the card tender collects 104.65.
    const id = await draftCloseoutSale(
      org,
      "CS-CLOSE-1",
      [{ amount: "100.0000" }],
      [{ kind: "card", accountId: card, amount: "104.6500" }],
      {
        tipsTotal: "5.0000",
        feeTotal: "0.3500",
        overShort: "0",
        serverPartyId: null,
        parts: [{ position: 1, tip: "5.0000", fee: "0.3500" }],
      },
    );
    await withOrg(org.orgId, () => postDocument(id, control(org)));
    assert.deepEqual(await entryLegs(id, org.orgId), [
      ["1011", "104.6500"],
      ["2160", "-5.0000"],
      ["6160", "0.3500"],
      ["4000", "-100.0000"],
    ]);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a cash over credits and a short debits the over/short account", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await closeoutAccounts(org);
    const over = await draftCloseoutSale(
      org,
      "CS-OVER",
      [{ amount: "100.0000" }],
      [{ kind: "cash", accountId: org.accounts.bank, amount: "100.5000" }],
      { tipsTotal: "0", feeTotal: "0", overShort: "0.5000", serverPartyId: null, parts: [] },
    );
    await withOrg(org.orgId, () => postDocument(over, control(org)));
    assert.deepEqual(await entryLegs(over, org.orgId), [
      ["1000", "100.5000"],
      ["6190", "-0.5000"],
      ["4000", "-100.0000"],
    ]);
    const short = await draftCloseoutSale(
      org,
      "CS-SHORT",
      [{ amount: "100.0000" }],
      [{ kind: "cash", accountId: org.accounts.bank, amount: "99.7000" }],
      { tipsTotal: "0", feeTotal: "0", overShort: "-0.3000", serverPartyId: null, parts: [] },
    );
    await withOrg(org.orgId, () => postDocument(short, control(org)));
    assert.deepEqual(await entryLegs(short, org.orgId), [
      ["1000", "99.7000"],
      ["6190", "0.3000"],
      ["4000", "-100.0000"],
    ]);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("server-tagged tips carry the party for payroll pay-out", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await closeoutAccounts(org);
    const card = await withBypassContext(() =>
      seedPostingAccount(
        org.orgId,
        "1012",
        "Card Clearing",
        "asset_current_other",
        org.subsidiaryId,
      ),
    );
    const id = await draftCloseoutSale(
      org,
      "CS-SERVER",
      [{ amount: "50.0000" }],
      [{ kind: "card", accountId: card, amount: "53.0000" }],
      {
        tipsTotal: "3.0000",
        feeTotal: "0",
        overShort: "0",
        serverPartyId: org.customerId,
        parts: [{ position: 1, tip: "3.0000", fee: "0" }],
      },
    );
    await withOrg(org.orgId, () => postDocument(id, control(org)));
    const tipParty = (
      await db.execute<{ party: string | null }>(
        sql`
      select l.party_id as party
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
       where e.org_id = ${org.orgId} and e.source_document_id = ${id} and a.number = '2160'`,
        "objects",
      )
    )[0]?.party;
    assert.equal(tipParty, org.customerId);
    const exposure = await withBypassContext(() =>
      readTipsPayableExposure(db, org.orgId, { allowedSubsidiaryIds: null }),
    );
    assert.equal(exposure.length, 1);
    assert.equal(exposure[0]!.partyId, org.customerId);
    assert.equal(exposure[0]!.amountMinor, "-30000");
    assert.equal(exposure[0]!.day, org.date);

    const outOfScope = await withBypassContext(() =>
      readTipsPayableExposure(db, org.orgId, {
        allowedSubsidiaryIds: new Set([randomUUID()]),
      }),
    );
    assert.deepEqual(outOfScope, []);

    const actorId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Cash Sale Reviewer", "admin"),
    );
    const voidResult = await withOrg(org.orgId, () =>
      requestDocumentVoid({
        documentId: id,
        orgId: org.orgId,
        actorId,
        reason: "Duplicate cash sale",
        reversalDate: org.date,
        source: "api",
        allowedSubsidiaryIds: null,
      }),
    );
    assert.equal(voidResult.status, "voided");
    const afterVoid = await withBypassContext(() =>
      readTipsPayableExposure(db, org.orgId, {
        allowedSubsidiaryIds: null,
      }),
    );
    assert.deepEqual(afterVoid, []);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test(
  "tips without a configured liability refuse with the Setup remedy",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const card = await withBypassContext(() =>
        seedPostingAccount(
          org.orgId,
          "1013",
          "Card Clearing",
          "asset_current_other",
          org.subsidiaryId,
        ),
      );
      const id = await draftCloseoutSale(
        org,
        "CS-NOACCT",
        [{ amount: "100.0000" }],
        [{ kind: "card", accountId: card, amount: "105.0000" }],
        {
          tipsTotal: "5.0000",
          feeTotal: "0",
          overShort: "0",
          serverPartyId: null,
          parts: [{ position: 1, tip: "5.0000", fee: "0" }],
        },
      );
      await assert.rejects(
        withOrg(org.orgId, () => postDocument(id, control(org))),
        (error: unknown) =>
          error instanceof PostingError &&
          /no tips-payable liability account is configured/.test(error.message) &&
          /Setup → Company & Accounting → Control accounts/.test(error.message),
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test("a mis-tendered close-out names the explicit formula", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await closeoutAccounts(org);
    const card = await withBypassContext(() =>
      seedPostingAccount(
        org.orgId,
        "1014",
        "Card Clearing",
        "asset_current_other",
        org.subsidiaryId,
      ),
    );
    const id = await draftCloseoutSale(
      org,
      "CS-MIS",
      [{ amount: "100.0000" }],
      [{ kind: "card", accountId: card, amount: "114.0000" }],
      {
        tipsTotal: "5.0000",
        feeTotal: "0.3500",
        overShort: "0",
        serverPartyId: null,
        parts: [{ position: 1, tip: "5.0000", fee: "0.3500" }],
      },
    );
    await assert.rejects(
      withOrg(org.orgId, () => postDocument(id, control(org))),
      (error: unknown) =>
        error instanceof PostingError &&
        /tenders 114\.0000 but document total 100\.0000 \+ tips 5\.0000 \+ fees −0\.3500 = 104\.6500/.test(
          error.message,
        ) &&
        /document total \+ tips − fees ± over\/short/.test(error.message),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a close-out on a refund refuses at posting", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const id = randomUUID();
    await withBypassContext(() =>
      db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom)
        values (${id}, ${org.orgId}, 'cash_refund', 'draft', 'CR-CLOSE', ${org.subsidiaryId},
                ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '1',
                '10.0000', '0', '10.0000',
                '{"closeout": {"tipsTotal": "1.0000", "feeTotal": "0", "overShort": "0", "serverPartyId": null, "parts": []}}'::jsonb)`),
    );
    await withBypassContext(() =>
      db.execute(sql`
        insert into document_tenders
          (org_id, document_id, position, kind, method_label, account_id,
           stored_value_account_id, amount_minor, currency, reference)
        values (${org.orgId}, ${id}, 1, 'cash', 'cash', ${org.accounts.bank}, null, '100000', 'CAD', null)`),
    );
    await withBypassContext(() =>
      db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
           tax_amount, quantity, unit_price, custom)
        values (${randomUUID()}, ${org.orgId}, ${id}, 1, ${org.accounts.revenue},
                '10.0000', '10.0000', '0', '1', '10.0000', '{}'::jsonb)`),
    );
    await withBypassContext(() =>
      db.execute(
        sql`update documents set status = 'approved' where id = ${id} and org_id = ${org.orgId}`,
      ),
    );
    await assert.rejects(
      withOrg(org.orgId, () => postDocument(id, control(org))),
      (error: unknown) =>
        error instanceof PostingError &&
        /carries a close-out — record tips, fees and over\/short on the cash sale/.test(
          error.message,
        ),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

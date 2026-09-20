import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument, regenerateGlImpactTx, type PostingDeps } from "./posting.ts";
import {
  createPaymentRun,
  openItemsForParty,
} from "../payments/payments.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface SettlementOrg {
  orgId: string;
  date: string;
  subsidiaryId: string;
  employeeId: string;
  cardId: string;
  cardLiability: string;
  employeePayable: string;
  employeeReceivable: string;
  cogs: string;
  deps: PostingDeps;
}

async function seedSettlementOrg(): Promise<SettlementOrg> {
  const org = await createScratchOrg();
  const employeePayable = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${employeePayable}, ${org.orgId}, '2110', 'Employee Reimbursements Payable', 'liability_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  const employeeReceivable = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${employeeReceivable}, ${org.orgId}, '1400', 'Employee Advances', 'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  const cardLiability = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${cardLiability}, ${org.orgId}, '2050', 'Corporate Card Clearing', 'liability_card', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts,employeePayable}', to_jsonb(${employeePayable}::text), true),
         '{controlAccounts,employeeReceivable}', to_jsonb(${employeeReceivable}::text), true)
     where id = ${org.orgId}`);

  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'employee', 'Riley Fieldworker', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employeeId})`);

  const cardId = randomUUID();
  await db.execute(sql`
    insert into payment_cards (id, org_id, holder_party_id, liability_account_id, label, is_active)
    values (${cardId}, ${org.orgId}, ${employeeId}, ${cardLiability}, 'Field card', true)`);

  return {
    orgId: org.orgId,
    date: org.date,
    subsidiaryId: org.subsidiaryId,
    employeeId,
    cardId,
    cardLiability,
    employeePayable,
    employeeReceivable,
    cogs: org.accounts.cogs,
    deps: {
      control: {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
        employeePayable,
        employeeReceivable,
      },
    },
  };
}

async function postReport(
  s: SettlementOrg,
  n: string,
  lines: { desc: string; amount: string; settlement?: string | null }[],
  cardId: string | null,
): Promise<string> {
  const id = randomUUID();
  const total = lines.reduce((a, l) => a + Number(l.amount), 0).toFixed(2);
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, payment_card_id, custom)
    values (${id}, ${s.orgId}, 'expense_report', 'draft', ${n}, ${s.date}, ${s.employeeId}, ${s.subsidiaryId}, 'CAD',
            ${total}, '0', ${total}, ${cardId}, '{}'::jsonb)`);
  let i = 1;
  for (const l of lines) {
    if (l.settlement === undefined) {
      // Legacy shape: the column untouched (NULL = settlement not recorded).
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount)
        values (${randomUUID()}, ${s.orgId}, ${id}, ${i}, ${s.cogs}, ${l.desc}, '1', ${l.amount}, ${l.amount}, '0')`);
    } else {
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount, settlement_type)
        values (${randomUUID()}, ${s.orgId}, ${id}, ${i}, ${s.cogs}, ${l.desc}, '1', ${l.amount}, ${l.amount}, '0', ${l.settlement})`);
    }
    i++;
  }
  await db.execute(sql`update documents set status = 'approved' where id = ${id} and org_id = ${s.orgId}`);
  await postDocument(id, s.deps);
  return id;
}

type PostedLeg = {
  account_id: string;
  amount: string;
  party_id: string | null;
  payment_card_id: string | null;
  is_open_item: boolean;
};

async function postedLegs(docId: string, orgId: string): Promise<PostedLeg[]> {
  const r = await db.execute<PostedLeg>(sql`
    select jl.account_id, jl.amount::text as amount, jl.party_id, jl.payment_card_id, jl.is_open_item
      from documents d
      join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.org_id = d.org_id
     where d.id = ${docId} and d.org_id = ${orgId}
     order by jl.amount::numeric desc, jl.account_id`);
  return r.rows;
}

async function dropOrg(s: SettlementOrg): Promise<void> {
  // The reporting reset removes ledger rows before the card instruments that
  // journal_lines reference; deleting cards first would trip the card FK.
  await dropScratchOrgReporting(s.orgId);
}

/**
 * The three settlements post to three counterparties: the employee payable
 * carries exactly the out-of-pocket amount, the card liability exactly the
 * card-funded amounts, and the personal line debits the receivable instead
 * of any expense account.
 */
test("a three-settlement report posts each type to its own counterparty", { skip: !DB }, async () => {
  const s = await seedSettlementOrg();
  try {
    const docId = await postReport(
      s,
      "EXP-3WAY-1",
      [
        { desc: "Mileage", amount: "100.00", settlement: "out_of_pocket" },
        { desc: "Hotel", amount: "200.00", settlement: "company_paid" },
        { desc: "Minibar", amount: "50.00", settlement: "personal" },
      ],
      s.cardId,
    );
    const legs = await postedLegs(docId, s.orgId);
    const by = (accountId: string) => legs.filter((l) => l.account_id === accountId);
    // Debits: two expense legs plus the personal receivable (never an expense).
    assert.deepEqual(
      by(s.cogs).map((l) => l.amount).sort(),
      ["100.0000", "200.0000"],
    );
    assert.deepEqual(by(s.employeeReceivable).map((l) => ({ amount: l.amount, party: l.party_id, open: l.is_open_item })), [
      { amount: "50.0000", party: s.employeeId, open: true },
    ]);
    // Credits: the employee is owed exactly the out-of-pocket amount; the
    // card issuer (via the clearing liability) exactly the rest.
    assert.deepEqual(
      by(s.employeePayable).map((l) => ({ amount: l.amount, party: l.party_id, open: l.is_open_item })),
      [{ amount: "-100.0000", party: s.employeeId, open: true }],
    );
    assert.deepEqual(
      by(s.cardLiability).map((l) => ({ amount: l.amount, party: l.party_id, card: l.payment_card_id, open: l.is_open_item })),
      [{ amount: "-250.0000", party: null, card: s.cardId, open: false }],
    );
    // The entry balances.
    const sum = legs.reduce((a, l) => a + Number(l.amount), 0);
    assert.ok(Math.abs(sum) < 0.00005, `entry must balance, net ${sum}`);
  } finally {
    await dropOrg(s);
  }
});

/**
 * Reimbursement batching (the trap practitioners report): only the
 * out-of-pocket portion may ever reach a reimbursement payment run. The
 * card-clearing legs are never open items and never carry the employee
 * party, so neither the open-item selection nor the run builder can see them.
 */
test("a reimbursement run over a three-settlement report selects only the out-of-pocket amount", { skip: !DB }, async () => {
  const s = await seedSettlementOrg();
  try {
    const actor = await createScratchUser(s.orgId, "Payables clerk", "admin");
    const docId = await postReport(
      s,
      "EXP-3WAY-2",
      [
        { desc: "Mileage", amount: "500.00", settlement: "out_of_pocket" },
        { desc: "Hotel", amount: "700.00", settlement: "company_paid" },
        { desc: "Minibar", amount: "300.00", settlement: "personal" },
      ],
      s.cardId,
    );
    const apOpen = await openItemsForParty(s.employeeId, "ap", s.orgId);
    assert.deepEqual(apOpen.map((l) => l.open), ["500.0000"]);
    // The receivable stays collectible through the application engine.
    const arOpen = await openItemsForParty(s.employeeId, "ar", s.orgId);
    assert.deepEqual(arOpen.map((l) => l.open), ["300.0000"]);

    const formatId = randomUUID();
    const profileId = randomUUID();
    await db.execute(sql`
      insert into payment_formats
        (id, org_id, code, name, rail, direction, file_extension, content_type, created_by, updated_by)
      values (${formatId}, ${s.orgId}, ${`WIRE-3W-${formatId.slice(0, 8)}`},
              'Settlement wire', 'wire', 'credit', 'csv', 'text/csv', ${actor}, ${actor})`);
    await db.execute(sql`
      insert into payment_bank_profiles
        (id, org_id, name, bank_account_id, payment_format_id, currency,
         require_run_approval, require_file_approval, created_by, updated_by)
      values (${profileId}, ${s.orgId}, 'Settlement profile', ${s.deps.control.bank},
              ${formatId}, 'CAD', false, false, ${actor}, ${actor})`);
    const run = await createPaymentRun({
      orgId: s.orgId,
      createdBy: actor,
      paymentBankProfileId: profileId,
      billDocumentIds: [docId],
    });
    const items = (await db.execute<{ kind: string; payment_amount: string }>(sql`
      select kind, payment_amount::text as payment_amount
        from payment_run_items where payment_run_id = ${run.id} and org_id = ${s.orgId}`)).rows;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, "expense");
    assert.equal(items[0]!.payment_amount, "500.0000");
  } finally {
    await dropOrg(s);
  }
});

/**
 * NULL settlement (all pre-0171 history) posts legacy math, and a controlled
 * replay regenerates byte-identical legs — the backfill-behavior contract the
 * live tenant's 9,068 reports depend on.
 */
test("unclassified lines post legacy math and replay byte-identical", { skip: !DB }, async () => {
  const s = await seedSettlementOrg();
  try {
    const actor = await createScratchUser(s.orgId, "Replayer", "admin");
    const docId = await postReport(s, "EXP-NULL-1", [{ desc: "Travel" , amount: "123.45" }], null);
    const before = await postedLegs(docId, s.orgId);
    assert.deepEqual(
      before.filter((l) => l.account_id === s.employeePayable).map((l) => l.amount),
      ["-123.4500"],
    );
    await db.transaction(async (tx) => {
      const replay = await regenerateGlImpactTx(tx, docId, { ...s.deps, migration: true }, actor);
      assert.equal(replay.changed, false);
    });
    const after = await postedLegs(docId, s.orgId);
    assert.deepEqual(after, before);
  } finally {
    await dropOrg(s);
  }
});

/**
 * The database CHECK is the last line of defense on settlement values: a
 * writer that bypasses every API still cannot store a fourth kind.
 */
test("settlement values outside the three kinds are rejected at the database", { skip: !DB }, async () => {
  const s = await seedSettlementOrg();
  try {
    const docId = randomUUID();
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
      values (${docId}, ${s.orgId}, 'expense_report', 'draft', 'EXP-BOGUS-1', ${s.date}, ${s.employeeId}, ${s.subsidiaryId}, 'CAD', '10.00', '0', '10.00', '{}'::jsonb)`);
    // The constraint name rides on the driver's cause, not the query text.
    await assert.rejects(
      db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount, settlement_type)
        values (${randomUUID()}, ${s.orgId}, ${docId}, 1, ${s.cogs}, 'Bogus', '1', '10.00', '10.00', '0', 'cryptocurrency')`),
      (err: unknown) =>
        (err as { cause?: { code?: string; constraint?: string } }).cause?.code === "23514" &&
        (err as { cause?: { code?: string; constraint?: string } }).cause?.constraint ===
          "document_lines_settlement_type",
    );
  } finally {
    await dropOrg(s);
  }
});

/**
 * Fail-closed boundaries: card-funded lines without a card, and personal
 * lines without a configured receivable, refuse to post instead of booking
 * to the wrong counterparty.
 */
test("card-funded lines without a card and personal lines without a receivable refuse to post", { skip: !DB }, async () => {
  const s = await seedSettlementOrg();
  try {
    const noCard = randomUUID();
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
      values (${noCard}, ${s.orgId}, 'expense_report', 'draft', 'EXP-NOCARD-1', ${s.date}, ${s.employeeId}, ${s.subsidiaryId}, 'CAD', '200.00', '0', '200.00', '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount, settlement_type)
      values (${randomUUID()}, ${s.orgId}, ${noCard}, 1, ${s.cogs}, 'Hotel', '1', '200.00', '200.00', '0', 'company_paid')`);
    await db.execute(sql`update documents set status = 'approved' where id = ${noCard} and org_id = ${s.orgId}`);
    // The submission boundary fires first (corporate card on the report); the
    // kernel rule carries the same refusal deeper (payment card resolution).
    await assert.rejects(postDocument(noCard, s.deps), /corporate card/);

    const noRecv = randomUUID();
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, payment_card_id, custom)
      values (${noRecv}, ${s.orgId}, 'expense_report', 'draft', 'EXP-NORECV-1', ${s.date}, ${s.employeeId}, ${s.subsidiaryId}, 'CAD', '50.00', '0', '50.00', ${s.cardId}, '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount, settlement_type)
      values (${randomUUID()}, ${s.orgId}, ${noRecv}, 1, ${s.cogs}, 'Minibar', '1', '50.00', '50.00', '0', 'personal')`);
    await db.execute(sql`update documents set status = 'approved' where id = ${noRecv} and org_id = ${s.orgId}`);
    // Unconfigure the receivable: neither explicit deps nor org settings may
    // supply it, so the personal line has no lawful debit counterparty.
    await db.execute(sql`
      update orgs set settings = settings #- '{controlAccounts,employeeReceivable}' where id = ${s.orgId}`);
    await assert.rejects(
      postDocument(noRecv, {
        control: { ar: s.deps.control.ar, ap: s.deps.control.ap, bank: s.deps.control.bank },
      }),
      /employee-receivable/,
    );
  } finally {
    await dropOrg(s);
  }
});

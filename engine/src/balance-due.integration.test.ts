import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { documentBalanceDueLateral } from "./balance-due.ts";
import { db } from "./db.ts";
import { runDunningForOrg } from "./dunning.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * The shared balance-due reader (./balance-due.ts) pins the two rules every
 * document-balance surface depends on:
 *
 * 1. Denomination: the applied sum reads the TRANSACTION legs
 *    (target/source_transaction_amount), never the base carrying legs —
 *    documents.total is denominated in the document currency.
 * 2. Legs: BOTH application legs net with role-appropriate columns, so a
 *    credit memo consumed as a settlement source (from_line_id) reads as
 *    consumed here, exactly as the aging and the maintained open_balance
 *    cache report it.
 *
 * Hand-computed expectations below come from the seed values, not from the
 * reader under test; the independent oracle is the trigger-maintained
 * documents.open_balance cache (PL/pgSQL, a separate code path).
 */

async function postDoc(
  org: ScratchOrg,
  actor: string,
  opts: { kind: string; currency: string; fxRate: string; total: string; dueDate: string },
): Promise<{ id: string; line: string }> {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date,
     currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, ${opts.kind}, 'draft', ${id}, ${org.subsidiaryId},
      ${org.customerId}, '2026-07-01', ${opts.dueDate}, ${opts.currency}, ${opts.fxRate},
      ${opts.total}, 0, ${opts.total}, ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, 1, ${opts.total}, ${opts.total}, 0, ${opts.total})`);
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`);
  const entry = await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  const line = (await db.execute<{ id: string }>(sql`select id from journal_lines
    where entry_id = ${entry} and is_open_item`)).rows[0]!.id;
  return { id, line };
}

async function readApplied(docId: string): Promise<{ applied: number; appliedBase: number }> {
  const r = (await db.execute<{ applied: string; applied_base: string }>(sql`
    select ap.applied::text as applied, ap.applied_base::text as applied_base
      from documents d
      ${documentBalanceDueLateral("d", { base: true })}
     where d.id = ${docId}
  `));
  return { applied: Number(r.rows[0]!.applied), appliedBase: Number(r.rows[0]!.applied_base) };
}

async function cachedBalance(docId: string): Promise<string | null> {
  return (await db.execute<{ open_balance: string | null }>(sql`select open_balance::text as open_balance
    from documents where id = ${docId}`)).rows[0]!.open_balance;
}

test("FX settlement applies the transaction leg, not the base carrying amount", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Balance Reader", "admin");
    // EUR 100 invoice settled USD 40 -> EUR 50 @ 1.25. The target BASE
    // carrying amount (60) differs from the target TRANSACTION amount (50):
    // a reader subtracting the base leg reports a balance in neither
    // currency. Seeds mirror the trigger caps: 50 <= |100| txn target,
    // 40 <= |80| txn source, 60 <= |120| base target, 50 <= |100| base source.
    const inv = await postDoc(org, actor, { kind: "customer_invoice", currency: "EUR", fxRate: "1.2", total: "100", dueDate: "2026-07-10" });
    const pay = randomUUID();
    await db.execute(sql`insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${pay}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'BAL-PAY', '2026-07-12', ${org.periodId}, 'pay', 'draft', 'manual')`);
    await db.execute(sql`insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item)
      values (${org.orgId}, ${pay}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${org.customerId}, '100', 'USD', '80', '1.25', false),
             (${org.orgId}, ${pay}, 2, ${org.accounts.ar}, ${org.subsidiaryId}, ${org.customerId}, '-100', 'USD', '-80', '1.25', true)`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${pay}`);
    const payLine = (await db.execute<{ id: string }>(sql`select id from journal_lines
      where entry_id = ${pay} and is_open_item`)).rows[0]!.id;
    await db.execute(sql`insert into applications
      (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
       source_transaction_currency, target_transaction_amount, target_transaction_currency,
       settlement_rate, settlement_rate_source, settlement_rate_reference, created_by, updated_by)
      values (${org.orgId}, ${payLine}, ${inv.line}, '60', '2026-07-12', '50', '40', 'USD', '50', 'EUR',
        '1.25', 'manual', 'BALANCE-READER-TEST', ${actor}, ${actor})`);

    const reader = await readApplied(inv.id);
    assert.equal(reader.applied, 50);
    assert.equal(reader.appliedBase, 60);
    assert.equal(await cachedBalance(inv.id), "50.0000");

    // Dunning acts on the same figure: the mailed balance is the transaction
    // balance (EUR 50), and the threshold compare sees the base remainder
    // (120 - 60 = 60): a policy at min 0 sends, a policy at min 60 skips on
    // the exact boundary.
    await db.execute(sql`update parties set email = 'billing@acme.test'
      where id = ${org.customerId} and org_id = ${org.orgId}`);
    for (const [policyId, minBalance] of [[randomUUID(), "0"], [randomUUID(), "60"]] as const) {
      await db.execute(sql`insert into dunning_policies (id, org_id, name, applies_to_kind, grace_period_days, min_balance)
        values (${policyId}, ${org.orgId}, 'Collections', 'customer_invoice', 0, ${minBalance})`);
      await db.execute(sql`insert into dunning_stages
        (id, org_id, policy_id, sequence, name, offset_days, subject_template, body_template)
        values (${randomUUID()}, ${org.orgId}, ${policyId}, 1, 'First reminder', 0,
          'Reminder: {{invoice}}', 'Hi {{party}}, {{amount}} on {{invoice}} was due {{dueDate}}. — {{orgName}}')`);
    }
    const result = await runDunningForOrg(org.orgId, "2026-07-20");
    assert.equal(result.sent, 1);
    const outbox = (await db.execute<{ payload: Record<string, unknown> }>(sql`
      select payload from scheduler_outbox
       where kind = 'flow_email' and occurrence_key like ${`dunning:${inv.id}:%`}
    `)).rows;
    assert.equal(outbox.length, 1);
    assert.match(String((outbox[0]!.payload as { text: string }).text), /EUR 50\.0000/);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a credit consumed as a settlement source reads as consumed, not open", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Balance Reader", "admin");
    const inv = await postDoc(org, actor, { kind: "customer_invoice", currency: "CAD", fxRate: "1", total: "100", dueDate: "2026-07-10" });
    const credit = await postDoc(org, actor, { kind: "customer_credit", currency: "CAD", fxRate: "1", total: "60", dueDate: "2026-07-10" });
    // The credit settles the invoice: from_line = credit AR line, to_line =
    // invoice AR line. A to-leg-only reader sees applied = 0 on the credit
    // and reports the full 60 as still due — while the aging nets the
    // consumption. The shared reader must agree with the aging.
    await db.execute(sql`insert into applications
      (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
       source_transaction_currency, target_transaction_amount, target_transaction_currency,
       settlement_rate, settlement_rate_source, settlement_rate_reference, created_by, updated_by)
      values (${org.orgId}, ${credit.line}, ${inv.line}, '25', '2026-07-12', '25', '25', 'CAD', '25', 'CAD',
        '1', 'same_currency', 'CREDIT-CONSUME-TEST', ${actor}, ${actor})`);

    const creditReader = await readApplied(credit.id);
    assert.equal(creditReader.applied, 25);
    assert.equal(creditReader.appliedBase, 25);
    assert.equal(await cachedBalance(credit.id), "35.0000");

    const invReader = await readApplied(inv.id);
    assert.equal(invReader.applied, 25);
    assert.equal(await cachedBalance(inv.id), "75.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

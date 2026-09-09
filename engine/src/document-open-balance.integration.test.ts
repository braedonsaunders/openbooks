import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { createPaymentDocument, updateDraftPayment, postPaymentWithApplications, reversePaymentForReturn } from "./payments.ts";
import { postDocument } from "./posting.ts";
import { recomputeOpenBalances } from "./sync/applications.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const migration = readFileSync(new URL("../../schema/migrations/generated/0100_document_open_balance_currency.sql", import.meta.url), "utf8");
const baseline = readFileSync(new URL("../../schema/migrations/generated/0001_baseline.sql", import.meta.url), "utf8");
const legacyCalculation = baseline.slice(baseline.indexOf("CREATE FUNCTION public.recompute_document_open_balance("), baseline.indexOf("-- Name: row_extra_dims_guard"))
  .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");

async function invoice(org: ScratchOrg, actor: string, currency = "EUR") {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
     currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${id}, ${org.subsidiaryId},
      ${org.customerId}, ${org.date}, ${currency}, ${currency === "CAD" ? "1" : "1.2"}, 100, 0, 100, ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, 1, 100, 100, 0, 100)`);
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`);
  const entry = await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  const line = (await db.execute<{ id: string }>(sql`select id from journal_lines
    where entry_id = ${entry} and is_open_item`)).rows[0]!.id;
  return { id, entry, line };
}

async function payment(org: ScratchOrg, actor: string, line: string, partial = false, currency = "USD") {
  const result = await createPaymentDocument({ orgId: org.orgId, kind: "customer_payment", createdBy: actor,
    partyId: org.customerId, bankAccountId: org.accounts.bank, subsidiaryId: org.subsidiaryId,
    documentDate: org.date, currency, fxRate: currency === "CAD" ? "1" : "1.625" });
  await updateDraftPayment(result.id, { bankAccountId: org.accounts.bank, allocations: [{ openLineId: line,
    sourceTransactionAmount: currency === "CAD" ? "100" : partial ? "40" : "80",
    targetTransactionAmount: partial ? "50" : "100", settlementRate: currency === "CAD" ? "1" : "1.25",
    settlementRateSource: currency === "CAD" ? "same_currency" : "manual", settlementRateReference: "BALANCE-REGRESSION" }] }, actor, org.orgId);
  await db.execute(sql`update documents set status = 'approved', submitted_by = ${actor}, submitted_at = now() where id = ${result.id}`);
  await postPaymentWithApplications(result.id, undefined, actor);
  return result.id;
}

async function balance(id: string) {
  return (await db.execute<{ open_balance: string | null }>(sql`select open_balance from documents where id = ${id}`)).rows[0]!.open_balance;
}

async function fixture(work: (org: ScratchOrg, actor: string) => Promise<void>) {
  const org = await createScratchOrg();
  try { await work(org, await createScratchUser(org.orgId, "Balance Controller", "admin")); }
  finally { await dropScratchOrg(org.orgId); }
}

test("open balance is transaction currency before any settlement", { skip: !DB }, async () => fixture(async (org, actor) => {
  const inv = await invoice(org, actor);
  assert.equal(await balance(inv.id), "100.0000");
}));

for (const partial of [false, true]) {
  test(`FX ${partial ? "partial" : "full"} settlement uses each endpoint's transaction amount`, { skip: !DB }, async () => fixture(async (org, actor) => {
    const inv = await invoice(org, actor);
    const pay = await payment(org, actor, inv.line, partial);
    assert.deepEqual([await balance(inv.id), await balance(pay)], [partial ? "50.0000" : "0.0000", "0.0000"]);
    assert.equal(await recomputeOpenBalances(org.orgId), 0, "bulk and triggers agree without repair");
  }));
}

test("unapply restores both endpoint currencies and payment reversal clears the voided cache", { skip: !DB }, async () => fixture(async (org, actor) => {
  const inv = await invoice(org, actor);
  const pay = await payment(org, actor, inv.line);
  await db.execute(sql`update applications set unapplied_at = now() where org_id = ${org.orgId} and to_line_id = ${inv.line}`);
  assert.deepEqual([await balance(inv.id), await balance(pay)], ["100.0000", "80.0000"]);
  await reversePaymentForReturn(pay, org.orgId, "Returned payment", actor, org.date);
  assert.equal(await balance(pay), null);
  assert.equal(await recomputeOpenBalances(org.orgId), 0);
}));

test("same-currency settlement retains zero open balances", { skip: !DB }, async () => fixture(async (org, actor) => {
  const inv = await invoice(org, actor, "CAD");
  const pay = await payment(org, actor, inv.line, false, "CAD");
  assert.deepEqual([await balance(inv.id), await balance(pay)], ["0.0000", "0.0000"]);
}));

test("bulk recompute heals drift only in its tenant and clears non-open-item and draft caches", { skip: !DB }, async () => fixture(async (org, actor) => {
  const other = await createScratchOrg();
  try {
    const inv = await invoice(org, actor);
    const foreign = await invoice(other, await createScratchUser(other.orgId, "Other Controller", "admin"));
    const journal = randomUUID();
    await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, document_date, currency, subtotal, tax_total, total, created_by)
      values (${journal}, ${org.orgId}, 'journal', 'draft', ${journal}, ${org.subsidiaryId}, ${org.date}, 'CAD', 10, 0, 10, ${actor})`);
    await db.execute(sql`insert into document_lines
      (org_id, document_id, line_number, account_id, subsidiary_id, amount, quantity, unit_price, tax_amount, tax_input_amount)
      values (${org.orgId}, ${journal}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, 10, 1, 10, 0, 10),
             (${org.orgId}, ${journal}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, -10, 1, -10, 0, -10)`);
    await db.execute(sql`update documents set open_balance = 999 where id in (${inv.id}, ${foreign.id}, ${journal})`);
    assert.equal(await recomputeOpenBalances(org.orgId), 2);
    assert.deepEqual([await balance(inv.id), await balance(foreign.id), await balance(journal)], ["100.0000", "999.0000", null]);
    await db.execute(sql`update documents set status = 'approved' where id = ${journal}`);
    await postDocument(journal, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    assert.equal(await balance(journal), null);
    await db.execute(sql`update documents set open_balance = 999 where id = ${journal}`);
    assert.equal(await recomputeOpenBalances(org.orgId), 1);
    assert.equal(await balance(journal), null);
  } finally { await dropScratchOrg(other.orgId); }
}));

test("0100 upgrades legacy projections atomically and idempotently without changing financial evidence", { skip: !DB }, async () => fixture(async (org, actor) => {
  const inv = await invoice(org, actor);
  const pay = await payment(org, actor, inv.line);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(legacyCalculation);
    await client.query("select public.recompute_document_open_balance(id) from documents where id = any($1::uuid[])", [[inv.id, pay]]);
    const before = await client.query("select id, open_balance from documents where id = any($1::uuid[]) order by id", [[inv.id, pay]]);
    assert.equal(before.rows.find((row) => row.id === pay).open_balance, "10.0000", "reproduces legacy source carrying-amount residual");
    const evidenceSql = `select (select jsonb_agg(to_jsonb(j) order by id) from journal_lines j where org_id = $1) as journal,
      (select jsonb_agg(to_jsonb(a) order by id) from applications a where org_id = $1) as applications`;
    const evidence = (await client.query(evidenceSql, [org.orgId])).rows;
    await client.query(migration);
    assert.deepEqual((await client.query("select open_balance from documents where id = any($1::uuid[])", [[inv.id, pay]])).rows,
      [{ open_balance: "0.0000" }, { open_balance: "0.0000" }]);
    await client.query(migration);
    assert.deepEqual((await client.query(evidenceSql, [org.orgId])).rows, evidence);
  } finally { await client.query("rollback"); client.release(); }
}));

async function openJournal(org: ScratchOrg, actor: string, amounts: readonly string[]) {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'journal', 'draft', ${id}, ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', 100, 0, 100, ${actor})`);
  for (let index = 0; index < amounts.length; index += 1) {
    await db.execute(sql`insert into document_lines
      (org_id, document_id, line_number, account_id, subsidiary_id, amount, quantity, unit_price, tax_amount, tax_input_amount)
      values (${org.orgId}, ${id}, ${index + 1}, ${index === amounts.length - 1 ? org.accounts.bank : org.accounts.ar},
        ${org.subsidiaryId}, ${amounts[index]!}, 1, ${amounts[index]!}, 0, ${amounts[index]!})`);
  }
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`);
  const entry = await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  const lines = (await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${entry} and is_open_item order by line_number`)).rows.map((line) => line.id);
  return { id, entry, lines };
}

test("concurrent applications to distinct lines serialize the shared document cache", { skip: !DB }, async () => fixture(async (org, actor) => {
  const target = await openJournal(org, actor, ["50", "50", "-100"]);
  const sources = [await openJournal(org, actor, ["-25", "25"]), await openJournal(org, actor, ["-25", "25"])];
  const blocker = await pool.connect();
  const writers = await Promise.all([pool.connect(), pool.connect()]);
  let writes: Promise<unknown>[] = [];
  try {
    await blocker.query("begin");
    await blocker.query("select id from documents where id = $1 for update", [target.id]);
    const writerPids = await Promise.all(writers.map(async (writer) => (await writer.query("select pg_backend_pid() as pid")).rows[0].pid as number));
    writes = writers.map((writer, index) => writer.query(`insert into applications
      (org_id, from_line_id, to_line_id, amount, source_amount, applied_on,
       source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency,
       settlement_rate, settlement_rate_source, settlement_rate_reference)
      values ($1, $2, $3, 25, 25, $4, 25, 'CAD', 25, 'CAD', 1, 'same_currency', 'CACHE-CONCURRENCY')`,
    [org.orgId, sources[index]!.lines[0], target.lines[index], org.date]));
    // Attach failure handlers immediately while deliberately waiting on row locks.
    const results = Promise.allSettled(writes);
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const state = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
        where pid in (${writerPids[0]!}, ${writerPids[1]!}) and wait_event_type = 'Lock'`);
      if (state.rows[0]!.count >= 2) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "both application writes reached the shared document lock");
    await blocker.query("commit");
    for (const result of await results) assert.equal(result.status, "fulfilled", JSON.stringify(result));
    assert.equal(await balance(target.id), "50.0000");
    assert.equal(await recomputeOpenBalances(org.orgId), 0);
  } finally {
    await blocker.query("rollback");
    await Promise.allSettled(writes);
    for (const writer of writers) writer.release();
    blocker.release();
  }
}));

test("bulk repair waits for an application commit before taking its calculation snapshot", { skip: !DB }, async () => fixture(async (org, actor) => {
  const target = await openJournal(org, actor, ["100", "-100"]);
  const source = await openJournal(org, actor, ["-25", "25"]);
  const application = await pool.connect();
  const repair = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await application.query("begin");
    await application.query(`insert into applications
      (org_id, from_line_id, to_line_id, amount, source_amount, applied_on,
       source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency,
       settlement_rate, settlement_rate_source, settlement_rate_reference)
      values ($1, $2, $3, 25, 25, $4, 25, 'CAD', 25, 'CAD', 1, 'same_currency', 'CACHE-BULK-RACE')`,
    [org.orgId, source.lines[0], target.lines[0], org.date]);
    const repairPid = (await repair.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    pending = repair.query("select public.recompute_document_open_balances($1) as healed", [org.orgId]);
    const settled = Promise.allSettled([pending]);
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const state = await db.execute<{ blocked: boolean }>(sql`select wait_event_type = 'Lock' as blocked
        from pg_stat_activity where pid = ${repairPid}`);
      if (state.rows[0]?.blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "bulk repair is fenced behind the uncommitted application");
    await application.query("commit");
    const [result] = await settled;
    assert.equal(result!.status, "fulfilled", JSON.stringify(result));
    assert.equal(await balance(target.id), "75.0000");
    assert.equal(await balance(source.id), "0.0000");
    assert.equal(await recomputeOpenBalances(org.orgId), 0);
  } finally {
    await application.query("rollback");
    if (pending) await Promise.allSettled([pending]);
    application.release(); repair.release();
  }
}));

test("a parallel accounting-book representation does not contribute to the document cache", { skip: !DB }, async () => fixture(async (org, actor) => {
  const inv = await invoice(org, actor);
  const book = randomUUID();
  const entry = randomUUID();
  await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
    values (${book}, ${org.orgId}, 'TAX-BALANCE', 'Tax representation', false, true, true)`);
  await db.execute(sql`insert into journal_entries
    (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, source_document_id, memo, status, origin)
    values (${entry}, ${org.orgId}, ${book}, ${org.subsidiaryId}, ${entry}, ${org.date}, ${org.periodId}, ${inv.id}, 'Parallel book', 'draft', 'manual')`);
  await db.execute(sql`insert into journal_lines
    (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item)
    values (${org.orgId}, ${entry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, 120, 'EUR', 100, 1.2, ${org.customerId}, true),
           (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, -120, 'EUR', -100, 1.2, null, false)`);
  await db.execute(sql`update journal_entries set status = 'posted', posted_by = ${actor} where id = ${entry}`);
  await db.execute(sql`select public.recompute_document_open_balance(${inv.id})`);
  assert.equal(await balance(inv.id), "100.0000");
  assert.equal(await recomputeOpenBalances(org.orgId), 0);
}));

test("ambiguous currency projection fails with actionable organization and entry evidence", { skip: !DB }, async () => fixture(async (org, actor) => {
  const inv = await invoice(org, actor);
  await assert.rejects(db.execute(sql`select public.document_open_balance_amount(
    ${org.orgId}::uuid, ${inv.entry}::uuid, 'USD', 'posted')`), (error: unknown) => {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    assert.equal(cause?.code, "23514");
    assert.match(cause?.message ?? "", new RegExp(`${org.orgId}.*${inv.entry}.*USD`));
    return true;
  });
  assert.equal(await balance(inv.id), "100.0000");
}));

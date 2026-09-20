import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { seedAdoption } from "./filing-test-fixtures.ts";
import { calculatePayRun, commitPayRun, createPayRun } from "./run.ts";
import { payRunStaleness } from "./readiness.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function makeAccount(orgId: string, number: string, name: string, type: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false,
            '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
}

async function makeItem(
  orgId: string,
  actorId: string,
  name: string,
  payrollAccountId: string | null,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into items (id, org_id, kind, name, payroll_expense_account_id, is_active, custom,
                       created_by, updated_by)
    values (${id}, ${orgId}, 'service', ${name}, ${payrollAccountId}, true, '{}'::jsonb,
            ${actorId}, ${actorId})`);
  return id;
}

async function addEntry(
  orgId: string,
  employeeId: string,
  actorId: string,
  workedOn: string,
  hours: string,
  itemId: string | null,
): Promise<void> {
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status, item_id,
      is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${orgId}, ${employeeId}, ${workedOn}, ${hours}, 'approved', ${itemId}, false,
      'unbilled', 'actual', ${actorId}, ${actorId})`);
}

async function earningLines(orgId: string, documentId: string) {
  return (await db.execute<{
    id: string; hours: string; rate: string; amount: string; item_id: string | null;
    expense_account_id: string | null; expense_account_source: string;
    expense_account_evidence: { reason: string; reference: string } | null;
  }>(sql`
    select l.id, l.hours, l.rate, l.amount, l.item_id,
           l.expense_account_id, l.expense_account_source, l.expense_account_evidence
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
     where l.org_id = ${orgId} and s.pay_run_document_id = ${documentId} and l.kind = 'earning'
     order by l.sequence`)).rows;
}

async function journalDebits(orgId: string, documentId: string) {
  return (await db.execute<{ number: string | null; name: string; amount: string }>(sql`
    select a.number, a.name, d.amount from document_lines d
      join accounts a on a.id = d.account_id and a.org_id = d.org_id
     where d.org_id = ${orgId} and d.document_id = ${documentId} and d.amount > 0
     order by a.number, d.amount`)).rows;
}

async function moneySnapshot(orgId: string, documentId: string) {
  const stubs = (await db.execute<{ gross: string; net_pay: string; employer_cost: string }>(sql`
    select gross, net_pay, employer_cost from pay_stubs
     where org_id = ${orgId} and pay_run_document_id = ${documentId} order by employee_party_id`)).rows;
  const lines = (await db.execute<{ kind: string; description: string; amount: string }>(sql`
    select l.kind, l.description, l.amount from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
     where l.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
     order by l.kind, l.description, l.amount`)).rows;
  return { stubs, lines };
}

test("same time type across two items splits into two lines with an identical total", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    // The actual use case end to end at calculate level: production work
    // costed to a COGS account, support work to an expense account.
    const cogs = await makeAccount(fx.orgId, "5300", "Production Labour", "cogs");
    const support = await makeAccount(fx.orgId, "6020", "Support Labour", "expense");
    const production = await makeItem(fx.orgId, fx.actorId, "Production work", cogs);
    const supportItem = await makeItem(fx.orgId, fx.actorId, "Support work", support);
    await addEntry(fx.orgId, fx.employeeId, fx.actorId, "2026-07-14", "8", production);
    await addEntry(fx.orgId, fx.employeeId, fx.actorId, "2026-07-15", "8", supportItem);
    const run = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-07-05", periodEnd: "2026-07-18",
    });
    const input = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
    assert.deepEqual((await calculatePayRun(input)).errors, []);

    const lines = await earningLines(fx.orgId, run.documentId);
    assert.equal(lines.length, 2);
    const byItem = new Map(lines.map((l) => [l.item_id, l]));
    assert.equal(byItem.get(production)?.expense_account_id, cogs);
    assert.equal(byItem.get(production)?.expense_account_source, "item");
    assert.equal(byItem.get(supportItem)?.expense_account_id, support);
    assert.equal(byItem.get(supportItem)?.expense_account_source, "item");
    for (const line of lines) {
      assert.ok(line.expense_account_evidence?.reason.trim(), "evidence must explain the rung");
      assert.ok(line.expense_account_evidence?.reference.trim(), "evidence must name the record");
    }
    // $30/hr × 8h on each item: the split moves no money (numeric(19,4)
    // scale, exactly as the unchanged calculation stores it).
    assert.deepEqual(lines.map((l) => l.amount).sort(), ["240.0000", "240.0000"]);
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test("mapping items changes no money: gross, statutory lines and net are byte-identical", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    // Entries carry items from the start, but neither item names an account:
    // the first calculation stamps component/org_default.
    const itemA = await makeItem(fx.orgId, fx.actorId, "Trade Alpha", null);
    const itemB = await makeItem(fx.orgId, fx.actorId, "Trade Beta", null);
    await addEntry(fx.orgId, fx.employeeId, fx.actorId, "2026-07-14", "8", itemA);
    await addEntry(fx.orgId, fx.employeeId, fx.actorId, "2026-07-15", "8", itemB);
    const run = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-07-05", periodEnd: "2026-07-18",
    });
    const input = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    const before = await moneySnapshot(fx.orgId, run.documentId);

    // Now give both items opinions and recalculate: structure gains stamps,
    // money must not move a cent.
    const cogs = await makeAccount(fx.orgId, "5300", "Production Labour", "cogs");
    const support = await makeAccount(fx.orgId, "6020", "Support Labour", "expense");
    await db.execute(sql`update items set payroll_expense_account_id = ${cogs}
      where id = ${itemA} and org_id = ${fx.orgId}`);
    await db.execute(sql`update items set payroll_expense_account_id = ${support}
      where id = ${itemB} and org_id = ${fx.orgId}`);
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    const after = await moneySnapshot(fx.orgId, run.documentId);

    assert.deepEqual(after, before);
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test("unmapped items and item-less hours fall through to the component account", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    const componentAccount = await makeAccount(fx.orgId, "6030", "Component Wages", "expense");
    await db.execute(sql`update pay_components set expense_account_id = ${componentAccount}
      where org_id = ${fx.orgId} and system_key = 'base_pay'`);
    const unmapped = await makeItem(fx.orgId, fx.actorId, "Unmapped trade", null);
    await addEntry(fx.orgId, fx.employeeId, fx.actorId, "2026-07-14", "8", unmapped);
    await addEntry(fx.orgId, fx.employeeId, fx.actorId, "2026-07-15", "8", null);
    const run = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-07-05", periodEnd: "2026-07-18",
    });
    const input = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
    assert.deepEqual((await calculatePayRun(input)).errors, []);

    const lines = await earningLines(fx.orgId, run.documentId);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.expense_account_id, componentAccount);
      assert.equal(line.expense_account_source, "component");
    }
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test("one employee on two items posts two journal debits with the right amounts", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    const cogs = await makeAccount(fx.orgId, "5300", "Production Labour", "cogs");
    const support = await makeAccount(fx.orgId, "6020", "Support Labour", "expense");
    const production = await makeItem(fx.orgId, fx.actorId, "Production work", cogs);
    const supportItem = await makeItem(fx.orgId, fx.actorId, "Support work", support);
    await addEntry(fx.orgId, fx.employeeId, fx.actorId, "2026-07-14", "8", production);
    await addEntry(fx.orgId, fx.employeeId, fx.actorId, "2026-07-15", "8", supportItem);
    const run = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-07-05", periodEnd: "2026-07-18",
    });
    const input = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
    const calculated = await calculatePayRun(input);
    assert.deepEqual(calculated.errors, []);

    // No edit between calculate and commit: the journal must match the
    // calculate screen exactly — the freeze half of the protection.
    assert.ok((await commitPayRun(input)).lines > 0);
    const debits = await journalDebits(fx.orgId, run.documentId);
    const wages = (number: string) => debits
      .filter((d) => d.number === number)
      .reduce((sum, d) => sum + Number(d.amount), 0);
    assert.equal(wages("5300"), 240);
    assert.equal(wages("6020"), 240);
    // The journal balances: every debit has its credit (exact numerics —
    // binary floats must never judge money).
    const balance = (await db.execute<{ total: string }>(sql`
      select coalesce(sum(d.amount), 0)::text as total from document_lines d
       where d.org_id = ${fx.orgId} and d.document_id = ${run.documentId}`)).rows[0]!;
    assert.equal(balance.total, "0.0000");
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test("editing an item account after calculate refuses the commit as stale, then posts the new account", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    const first = await makeAccount(fx.orgId, "5300", "Production Labour", "cogs");
    const second = await makeAccount(fx.orgId, "6020", "Support Labour", "expense");
    const item = await makeItem(fx.orgId, fx.actorId, "Production work", first);
    await addEntry(fx.orgId, fx.employeeId, fx.actorId, "2026-07-14", "8", item);
    const run = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-07-05", periodEnd: "2026-07-18",
    });
    const input = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
    assert.deepEqual((await calculatePayRun(input)).errors, []);

    // The admin fixes the mapping after reviewing the register: the draft
    // must not silently post the old account — the digest half refuses,
    // naming items, in both the wizard overlay and the commit boundary.
    await db.execute(sql`update items set payroll_expense_account_id = ${second}
      where id = ${item} and org_id = ${fx.orgId}`);
    assert.ok((await payRunStaleness(fx.orgId, run.documentId)).reasons.includes("items"));
    await assert.rejects(
      commitPayRun(input),
      (err: unknown) => {
        assert.match(String((err as Error)?.message ?? err), /inputs changed after it was last calculated/);
        assert.match(String((err as Error)?.message ?? err), /items/);
        return true;
      },
    );

    // Recalculate and the new account is what posts — no silent stale debit.
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    assert.ok((await commitPayRun(input)).lines > 0);
    const debits = await journalDebits(fx.orgId, run.documentId);
    assert.ok(debits.some((d) => d.number === "6020" && Number(d.amount) === 240));
    assert.ok(!debits.some((d) => d.number === "5300" && Number(d.amount) === 240));
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

test("recalculate re-stamps a draft; a committed stamp is immutable", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    const first = await makeAccount(fx.orgId, "5300", "Production Labour", "cogs");
    const second = await makeAccount(fx.orgId, "6020", "Support Labour", "expense");
    const item = await makeItem(fx.orgId, fx.actorId, "Production work", first);
    await addEntry(fx.orgId, fx.employeeId, fx.actorId, "2026-07-14", "8", item);
    const run = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-07-05", periodEnd: "2026-07-18",
    });
    const input = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    assert.equal((await earningLines(fx.orgId, run.documentId))[0]?.expense_account_id, first);

    // The GB persona recalculates drafts repeatedly: a remap re-stamps.
    await db.execute(sql`update items set payroll_expense_account_id = ${second}
      where id = ${item} and org_id = ${fx.orgId}`);
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    const restamped = await earningLines(fx.orgId, run.documentId);
    assert.equal(restamped[0]?.expense_account_id, second);
    assert.equal(restamped[0]?.expense_account_source, "item");

    // Once committed, the stamp is history: the guard refuses a rewrite.
    assert.ok((await commitPayRun(input)).lines > 0);
    const lineId = restamped[0]!.id;
    await assert.rejects(
      db.execute(sql`update pay_stub_lines set expense_account_id = ${first}
        where id = ${lineId} and org_id = ${fx.orgId}`),
      (err: unknown) => {
        const outer = err instanceof Error ? err.message : String(err);
        const cause = (err as { cause?: { message?: string; constraint?: string } })?.cause;
        assert.match(
          `${outer}\n${cause?.message ?? ""}\n${cause?.constraint ?? ""}`,
          /pay_stub_line_expense_immutable/,
        );
        return true;
      },
    );
  } finally { await dropScratchOrgReporting(fx.orgId); }
});

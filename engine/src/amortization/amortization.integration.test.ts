import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { errorChainMatches } from "../testing/error-chain.ts";
import { db } from "../platform/db.ts";
import { daysInCivilMonth } from "../platform/civil-date.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  seedFlowActors,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { AmortizationError } from "./errors.ts";
import { reconcileDeferralAccounts, dueUnpostedAmortization } from "./reconciliation.ts";
import { runExpenseAmortization } from "./run.ts";
import {
  activateSchedule,
  cancelSchedule,
  changeScheduleTerm,
  createManualSchedule,
  holdSchedule,
  reduceSchedule,
  resumeSchedule,
} from "./schedules.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface World {
  org: ScratchOrg;
  actorId: string;
  readerId: string;
  prepaidId: string;
  expenseId: string;
  templateId: string;
  periods: Map<string, string>;
}

async function setFeature(orgId: string, key: string, on: boolean): Promise<void> {
  const updated = await db.execute(
    sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${key}}`}::text[], ${on ? "true" : "false"}::jsonb, true)
     where id = ${orgId} returning id`,
    "objects",
  );
  assert.equal(updated.length, 1, `feature ${key} written`);
}

async function grant(orgId: string, roleKey: string, permissions: string[]): Promise<void> {
  const updated = await db.execute(
    sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${roleKey} returning id`,
    "objects",
  );
  assert.equal(updated.length, 1, `role ${roleKey} granted`);
}

/** Seed open monthly periods after the scratch tenant's July period. */
async function seedPeriods(orgId: string, monthStarts: string[]): Promise<Map<string, string>> {
  const cal = (
    await db.execute<{ id: string }>(
      sql`
    select id from fiscal_calendars where org_id = ${orgId} and is_default`,
      "objects",
    )
  )[0];
  assert.ok(cal, "scratch org ships a default fiscal calendar");
  const ids = new Map<string, string>();
  for (const month of monthStarts) {
    const year = Number(month.slice(0, 4));
    const mon = Number(month.slice(5, 7));
    const name = month.slice(0, 7);
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${orgId}, ${year}, ${mon}, ${name},
        ${`${name}-01`}, ${`${name}-${String(daysInCivilMonth(year, mon)).padStart(2, "0")}`}, false, ${cal.id})
      on conflict do nothing`);
    const row = (
      await db.execute<{ id: string }>(
        sql`
      select id from accounting_periods where org_id = ${orgId} and name = ${name}`,
        "objects",
      )
    )[0];
    assert.ok(row, `period ${name} exists`);
    ids.set(name, row.id);
  }
  return ids;
}

async function seedTemplate(
  orgId: string,
  actorId: string,
  deferralAccountId: string,
  overrides: {
    code?: string;
    method?: string;
    termSource?: string;
    periodCount?: number | null;
    percentages?: unknown;
    effectiveFrom?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into expense_amortization_templates
      (id, org_id, code, name, effective_from, method, term_source, period_count, percentages,
       deferral_account_id, destination_account_id, period_offset, created_by, updated_by)
    values (${id}, ${orgId}, ${overrides.code ?? "INS3"}, 'Prepaid insurance', ${overrides.effectiveFrom ?? "2026-01-01"},
      ${overrides.method ?? "straight_line"}, ${overrides.termSource ?? "template"},
      ${overrides.periodCount === undefined ? 3 : overrides.periodCount},
      ${overrides.percentages === undefined ? null : JSON.stringify(overrides.percentages)}::jsonb,
      ${deferralAccountId}, null, 0, ${actorId}, ${actorId})`);
  return id;
}

async function setupWorld(): Promise<World> {
  const org = await createScratchOrg();
  assert.ok(org.date.startsWith("2026-07"), "the scratch tenant's open period is July 2026");
  const actorId = await createScratchUser(org.orgId, "Amortization Controller", "amort_controller");
  await grant(org.orgId, "amort_controller", ["amortization.read", "amortization.manage"]);
  const readerId = await createScratchUser(org.orgId, "Amortization Reader", "amort_reader");
  await grant(org.orgId, "amort_reader", ["amortization.read"]);
  await setFeature(org.orgId, "expenseAmortization", true);
  const prepaidId = await seedPostingAccount(
    org.orgId,
    "1350",
    "Prepaid Insurance",
    "asset_current_other",
  );
  const expenseId = await seedPostingAccount(org.orgId, "6250", "Insurance Expense", "expense");
  const periods = await seedPeriods(org.orgId, [
    "2026-08-01",
    "2026-09-01",
    "2026-10-01",
    "2026-11-01",
    "2026-12-01",
  ]);
  periods.set("2026-07", org.periodId);
  const templateId = await seedTemplate(org.orgId, actorId, prepaidId);
  return { org, actorId, readerId, prepaidId, expenseId, templateId, periods };
}

const control = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

/** Post a vendor bill (or credit) with one line through the native posting path. */
async function postSourceDocument(
  w: World,
  opts: {
    kind?: "vendor_bill" | "vendor_credit";
    number: string;
    amount: string;
    subsidiaryId?: string;
    accountId?: string;
    templateId?: string | null;
    start?: string | null;
    end?: string | null;
    departmentId?: string | null;
  },
): Promise<{ documentId: string; lineId: string; entryId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
       currency, fx_rate, status, subtotal, tax_total, total, created_by)
    values (${documentId}, ${w.org.orgId}, ${opts.kind ?? "vendor_bill"}, ${opts.number}, ${w.org.vendorId},
      ${opts.subsidiaryId ?? w.org.subsidiaryId}, ${w.org.date}, ${w.org.date}, 'CAD', '1', 'draft',
      ${opts.amount}, '0', ${opts.amount}, ${w.actorId})`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount,
       department_id, amortization_template_id, amortization_start_on, amortization_end_on, created_by)
    values (${lineId}, ${w.org.orgId}, ${documentId}, 1, ${opts.accountId ?? w.expenseId}, '1', ${opts.amount},
      ${opts.amount}, '0', ${opts.departmentId ?? null}, ${opts.templateId === undefined ? w.templateId : opts.templateId},
      ${opts.start ?? null}, ${opts.end ?? null}, ${w.actorId})`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now() where id = ${documentId} and org_id = ${w.org.orgId}`);
  const entryId = await postDocument(documentId, control(w.org), {
    audit: { actorId: w.actorId, source: "test" },
  });
  return { documentId, lineId, entryId };
}

async function accountBalance(orgId: string, accountId: string): Promise<string> {
  const row = (
    await db.execute<{ balance: string }>(
      sql`
    select coalesce(sum(jl.amount), 0)::numeric(19,4)::text as balance
      from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
     where jl.org_id = ${orgId} and jl.account_id = ${accountId} and je.status in ('posted', 'reversed')`,
      "objects",
    )
  )[0];
  return row?.balance ?? "0.0000";
}

async function scheduleFor(orgId: string, lineId: string) {
  const row = (
    await db.execute<{ id: string; status: string; total_amount: string; revision: number }>(
      sql`
    select id, status, total_amount::text as total_amount, revision from expense_amortization_schedules
     where org_id = ${orgId} and source_line_id = ${lineId}`,
      "objects",
    )
  )[0];
  assert.ok(row, "the posted line has a schedule");
  return row;
}

async function plan(
  orgId: string,
  scheduleId: string,
): Promise<{ period: string; amount: string; status: string }[]> {
  return await db.execute<{ period: string; amount: string; status: string }>(
    sql`
    select to_char(period_start, 'YYYY-MM') as period, planned_amount::text as amount, status
      from expense_amortization_schedule_lines
     where org_id = ${orgId} and schedule_id = ${scheduleId} and status in ('planned', 'posted')
     order by period_start`,
    "objects",
  );
}

async function assertReconciled(w: World, asOf: string): Promise<void> {
  const rows = await reconcileDeferralAccounts(db, w.org.orgId, { asOf });
  for (const row of rows) {
    assert.equal(
      row.difference,
      "0.0000",
      `deferral account ${row.accountId} ties on ${asOf} (ledger ${row.ledger}, schedules ${row.subledger})`,
    );
  }
}

function refusal(code: string) {
  return (error: unknown) => error instanceof AmortizationError && error.code === code;
}

test(
  "a templated bill line posts to the prepaid account and its schedule is created in the same posting",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const department = (
        await db.execute<{ id: string }>(
          sql`
      insert into departments (id, org_id, name) values (${randomUUID()}, ${w.org.orgId}, 'Operations') returning id`,
          "objects",
        )
      )[0]!;
      const bill = await postSourceDocument(w, {
        number: "B-AM-1",
        amount: "300.00",
        departmentId: department.id,
      });
      assert.equal(
        await accountBalance(w.org.orgId, w.prepaidId),
        "300.0000",
        "the deferral account carries the bill line",
      );
      assert.equal(
        await accountBalance(w.org.orgId, w.expenseId),
        "0.0000",
        "nothing reaches expense at posting",
      );
      const schedule = await scheduleFor(w.org.orgId, bill.lineId);
      assert.equal(schedule.status, "active");
      assert.equal(schedule.total_amount, "300.0000");
      assert.deepEqual(await plan(w.org.orgId, schedule.id), [
        { period: "2026-07", amount: "100.0000", status: "planned" },
        { period: "2026-08", amount: "100.0000", status: "planned" },
        { period: "2026-09", amount: "100.0000", status: "planned" },
      ]);
      const dims = (
        await db.execute<{ department_id: string | null; source_entry_id: string }>(
          sql`
      select department_id, source_entry_id from expense_amortization_schedules where id = ${schedule.id}`,
          "objects",
        )
      )[0]!;
      assert.equal(dims.department_id, department.id, "the schedule keeps the line's department");
      assert.equal(dims.source_entry_id, bill.entryId);
      await assertReconciled(w, w.org.date);
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "each due period posts exactly once, in its own period, and the schedule completes",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const bill = await postSourceDocument(w, { number: "B-AM-2", amount: "1000.00" });
      const schedule = await scheduleFor(w.org.orgId, bill.lineId);
      assert.deepEqual(
        (await plan(w.org.orgId, schedule.id)).map((line) => line.amount),
        ["333.3300", "333.3300", "333.3400"],
      );

      const july = await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-07")!,
      });
      assert.equal(july.posted, 1);
      assert.deepEqual(july.problems, []);
      const entry = (
        await db.execute<{
          origin: string;
          period_id: string;
          posting_date: string;
          balanced: boolean;
        }>(
          sql`
      select je.origin, je.period_id, je.posting_date::text as posting_date,
             (select sum(amount) = 0 from journal_lines where entry_id = je.id) as balanced
        from journal_entries je where je.id = ${july.entries[0]!.entryId}`,
          "objects",
        )
      )[0]!;
      assert.equal(entry.origin, "expense_amortization");
      assert.equal(entry.period_id, w.periods.get("2026-07"));
      assert.equal(entry.posting_date, "2026-07-31");
      assert.equal(entry.balanced, true);
      assert.equal(await accountBalance(w.org.orgId, w.expenseId), "333.3300");

      const replay = await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-07")!,
      });
      assert.equal(replay.posted, 0, "a re-run posts nothing twice");

      const due = await dueUnpostedAmortization(db, w.org.orgId, {
        endsOn: "2026-09-30",
        bookId: w.org.bookId,
      });
      assert.equal(due.lines, 2, "two periods are due through September");
      const september = await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-09")!,
      });
      assert.equal(september.posted, 2);
      assert.deepEqual(september.completed, [schedule.id]);
      assert.equal((await scheduleFor(w.org.orgId, bill.lineId)).status, "completed");
      assert.equal(await accountBalance(w.org.orgId, w.prepaidId), "0.0000");
      assert.equal(await accountBalance(w.org.orgId, w.expenseId), "1000.0000");
      assert.equal(
        (
          await dueUnpostedAmortization(db, w.org.orgId, {
            endsOn: "2026-09-30",
            bookId: w.org.bookId,
          })
        ).lines,
        0,
      );
      for (const asOf of ["2026-07-31", "2026-08-31", "2026-09-30"])
        await assertReconciled(w, asOf);
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test("concurrent runs never post a period twice", { skip: !DB }, async () => {
  const w = await setupWorld();
  try {
    await postSourceDocument(w, { number: "B-AM-3", amount: "300.00" });
    await postSourceDocument(w, { number: "B-AM-4", amount: "600.00" });
    const periodId = w.periods.get("2026-09")!;
    const results = await Promise.allSettled([
      runExpenseAmortization({ orgId: w.org.orgId, actorId: w.actorId, periodId }),
      runExpenseAmortization({ orgId: w.org.orgId, actorId: w.actorId, periodId }),
    ]);
    const posted = results.reduce(
      (acc, result) => acc + (result.status === "fulfilled" ? result.value.posted : 0),
      0,
    );
    assert.equal(posted, 6, "six periods post once in total across both runs");
    const entries = (
      await db.execute<{ n: string }>(
        sql`
      select count(*)::text as n from journal_entries where org_id = ${w.org.orgId} and origin = 'expense_amortization'`,
        "objects",
      )
    )[0]!;
    assert.equal(entries.n, "6");
    assert.equal(await accountBalance(w.org.orgId, w.prepaidId), "0.0000");
  } finally {
    await dropScratchOrgReporting(w.org.orgId);
  }
});

test(
  "zero plan lines are retired without posting empty journal entries",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const bill = await postSourceDocument(w, { number: "B-AM-ZERO", amount: "0.01" });
      const schedule = await scheduleFor(w.org.orgId, bill.lineId);
      assert.equal((await plan(w.org.orgId, schedule.id))[0]?.amount, "0.0000");

      const run = await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.org.periodId,
      });

      assert.equal(run.posted, 0, "a zero line is not counted as a posted journal");
      assert.deepEqual(run.entries, [], "a zero line has no journal entry");
      assert.deepEqual(run.problems, []);
      const closed = await db.execute<{ status: string; closed_at: Date | null }>(
        sql`
      select status, closed_at from expense_amortization_schedule_lines
       where org_id = ${w.org.orgId} and schedule_id = ${schedule.id}
         and planned_amount = 0 and status = 'superseded'`,
        "objects",
      );
      assert.equal(closed.length, 1);
      assert.equal(closed[0]?.status, "superseded");
      assert.ok(closed[0]?.closed_at, "the zero line is retained in closed schedule history");
      const entries = (
        await db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from journal_entries where org_id = ${w.org.orgId} and origin = 'expense_amortization'`,
          "objects",
        )
      )[0]!;
      assert.equal(entries.n, "0");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a credit preserves pre-credit plan periods and must belong to the schedule's legal entity",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const templateId = await seedTemplate(w.org.orgId, w.actorId, w.prepaidId, {
        code: "AM9",
        termSource: "service_dates",
        periodCount: null,
      });
      const bill = await postSourceDocument(w, {
        number: "B-AM-CREDIT-DATE",
        amount: "900.00",
        start: "2026-06-01",
        end: "2027-02-28",
        templateId,
      });
      const schedule = await scheduleFor(w.org.orgId, bill.lineId);
      const credit = await postSourceDocument(w, {
        kind: "vendor_credit",
        number: "VC-AM-CREDIT-DATE",
        amount: "100.00",
        accountId: w.prepaidId,
        templateId: null,
      });

      await reduceSchedule({
        orgId: w.org.orgId,
        actorId: w.actorId,
        scheduleId: schedule.id,
        reason: "Credit received for future service",
        amount: "100.00",
        effectiveDate: "2026-08-10",
        relatedDocumentId: credit.documentId,
      });

      const revised = await plan(w.org.orgId, schedule.id);
      assert.equal(revised.length, 9, "the full service window remains scheduled");
      assert.deepEqual(
        revised.slice(0, 2),
        [
          { period: "2026-06", amount: "100.0000", status: "planned" },
          { period: "2026-07", amount: "100.0000", status: "planned" },
        ],
        "periods before the credit date keep their original planned amounts",
      );
      assert.equal(
        revised.reduce((sum, line) => sum + BigInt(line.amount.replace(".", "")), 0n),
        8_000_000n,
      );

      const largerCredit = await postSourceDocument(w, {
        kind: "vendor_credit",
        number: "VC-AM-CREDIT-LARGER",
        amount: "650.00",
        accountId: w.prepaidId,
        templateId: null,
      });
      await reduceSchedule({
        orgId: w.org.orgId,
        actorId: w.actorId,
        scheduleId: schedule.id,
        reason: "Credit exceeds the remaining periods after its date",
        amount: "650.00",
        effectiveDate: "2026-08-11",
        relatedDocumentId: largerCredit.documentId,
      });
      const folded = await plan(w.org.orgId, schedule.id);
      assert.equal(
        folded.length,
        9,
        "when a credit exceeds later periods, earlier unposted periods stay scheduled",
      );
      assert.equal(
        folded.reduce((sum, line) => sum + BigInt(line.amount.replace(".", "")), 0n),
        1_500_000n,
      );

      const otherSubsidiaryId = randomUUID();
      await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${otherSubsidiaryId}, ${w.org.orgId}, ${w.org.subsidiaryId}, 'Second entity', 'CAD', 'CA')`);
      await db.execute(sql`
      insert into party_subsidiaries (org_id, party_id, subsidiary_id)
      values (${w.org.orgId}, ${w.org.vendorId}, ${otherSubsidiaryId})`);
      const otherEntityCredit = await postSourceDocument(w, {
        kind: "vendor_credit",
        number: "VC-AM-OTHER-ENTITY",
        amount: "100.00",
        subsidiaryId: otherSubsidiaryId,
        accountId: w.prepaidId,
        templateId: null,
      });
      await assert.rejects(
        reduceSchedule({
          orgId: w.org.orgId,
          actorId: w.actorId,
          scheduleId: schedule.id,
          reason: "Credit belongs to another entity",
          amount: "100.00",
          effectiveDate: "2026-08-10",
          relatedDocumentId: otherEntityCredit.documentId,
        }),
        refusal("amortization_credit_document_invalid"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a closed period is skipped with its remedy and holds back the schedule's later periods",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const bill = await postSourceDocument(w, { number: "B-AM-5", amount: "300.00" });
      await setPeriodLockState({
        orgId: w.org.orgId,
        periodId: w.periods.get("2026-08")!,
        bookId: w.org.bookId,
        module: "gl",
        state: "closed",
        actorId: w.actorId,
        reason: "August is closed",
      });
      const run = await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-09")!,
      });
      assert.equal(run.posted, 1, "July posts");
      assert.equal(run.problems.length, 1);
      assert.equal(run.problems[0]!.code, "amortization_period_closed");
      assert.equal(
        run.problems[0]!.message,
        "Period P08 FY2026 is closed for this schedule's entity and book.",
      );
      assert.match(run.problems[0]!.remedy, /^Reopen P08 FY2026 through a reopen request/);
      assert.match(run.problems[0]!.remedy, /remaining term/);
      const schedule = await scheduleFor(w.org.orgId, bill.lineId);
      assert.deepEqual(
        (await plan(w.org.orgId, schedule.id)).map((line) => line.status),
        ["posted", "planned", "planned"],
      );
      // Changing the remaining term moves the closed month's amount forward.
      await changeScheduleTerm({
        orgId: w.org.orgId,
        actorId: w.actorId,
        scheduleId: schedule.id,
        reason: "August is closed; amortize from September",
        effectivePeriod: "2026-09-01",
        newLastPeriod: "2026-10-01",
      });
      assert.deepEqual(await plan(w.org.orgId, schedule.id), [
        { period: "2026-07", amount: "100.0000", status: "posted" },
        { period: "2026-09", amount: "100.0000", status: "planned" },
        { period: "2026-10", amount: "100.0000", status: "planned" },
      ]);
      const unblocked = await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-09")!,
      });
      assert.equal(unblocked.posted, 1);
      assert.deepEqual(unblocked.problems, []);
      await assertReconciled(w, "2026-09-30");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "voiding the bill cancels its schedule and returns posted amortization to the deferral account",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const bill = await postSourceDocument(w, { number: "B-AM-6", amount: "300.00" });
      await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-07")!,
      });
      assert.equal(await accountBalance(w.org.orgId, w.expenseId), "100.0000");
      const voided = await requestDocumentVoid({
        documentId: bill.documentId,
        orgId: w.org.orgId,
        actorId: w.actorId,
        reason: "Duplicate insurance invoice",
        reversalDate: w.org.date,
        source: "api",
      });
      assert.equal(voided.status, "voided");
      const schedule = await scheduleFor(w.org.orgId, bill.lineId);
      assert.equal(schedule.status, "cancelled");
      assert.equal(
        await accountBalance(w.org.orgId, w.prepaidId),
        "0.0000",
        "the deferral nets to zero",
      );
      assert.equal(
        await accountBalance(w.org.orgId, w.expenseId),
        "0.0000",
        "posted amortization is returned",
      );
      const lines = await db.execute<{ status: string }>(
        sql`
      select status from expense_amortization_schedule_lines where schedule_id = ${schedule.id} order by period_start`,
        "objects",
      );
      assert.deepEqual(
        lines.map((line) => line.status),
        ["posted", "cancelled", "cancelled"],
        "the posted July period is never rewritten",
      );
      await assertReconciled(w, w.org.date);
      const history = await db.execute<{ kind: string }>(
        sql`
      select kind from expense_amortization_schedule_events where schedule_id = ${schedule.id} order by created_at`,
        "objects",
      );
      assert.deepEqual(
        history.map((event) => event.kind),
        ["created", "source_voided"],
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "hold, resume and term changes are governed, audited and refuse stale or posted changes",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const bill = await postSourceDocument(w, { number: "B-AM-7", amount: "300.00" });
      const schedule = await scheduleFor(w.org.orgId, bill.lineId);
      await assert.rejects(
        holdSchedule({
          orgId: w.org.orgId,
          actorId: w.actorId,
          scheduleId: schedule.id,
          reason: "x",
        }),
        refusal("amortization_reason_required"),
      );
      await assert.rejects(
        holdSchedule({
          orgId: w.org.orgId,
          actorId: w.readerId,
          scheduleId: schedule.id,
          reason: "Pending renewal review",
        }),
        refusal("amortization_forbidden"),
      );
      const held = await holdSchedule({
        orgId: w.org.orgId,
        actorId: w.actorId,
        scheduleId: schedule.id,
        reason: "Pending renewal review",
        expectedRevision: schedule.revision,
      });
      assert.equal(held.status, "on_hold");
      const skipped = await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-07")!,
      });
      assert.equal(skipped.posted, 0, "a held schedule is skipped");
      await assert.rejects(
        resumeSchedule({
          orgId: w.org.orgId,
          actorId: w.actorId,
          scheduleId: schedule.id,
          reason: "Renewal confirmed",
          expectedRevision: schedule.revision,
        }),
        refusal("amortization_schedule_conflict"),
      );
      await resumeSchedule({
        orgId: w.org.orgId,
        actorId: w.actorId,
        scheduleId: schedule.id,
        reason: "Renewal confirmed",
        expectedRevision: held.revision,
      });
      await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-07")!,
      });

      await assert.rejects(
        changeScheduleTerm({
          orgId: w.org.orgId,
          actorId: w.actorId,
          scheduleId: schedule.id,
          reason: "Extend the cover",
          effectivePeriod: "2026-07-01",
          newLastPeriod: "2026-11-01",
        }),
        refusal("amortization_change_period_posted"),
      );
      await changeScheduleTerm({
        orgId: w.org.orgId,
        actorId: w.actorId,
        scheduleId: schedule.id,
        reason: "Cover extended to November",
        effectivePeriod: "2026-08-01",
        newLastPeriod: "2026-11-01",
      });
      assert.deepEqual(await plan(w.org.orgId, schedule.id), [
        { period: "2026-07", amount: "100.0000", status: "posted" },
        { period: "2026-08", amount: "50.0000", status: "planned" },
        { period: "2026-09", amount: "50.0000", status: "planned" },
        { period: "2026-10", amount: "50.0000", status: "planned" },
        { period: "2026-11", amount: "50.0000", status: "planned" },
      ]);
      const superseded = (
        await db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from expense_amortization_schedule_lines where schedule_id = ${schedule.id} and status = 'superseded'`,
          "objects",
        )
      )[0]!;
      assert.equal(superseded.n, "2", "the replaced August and September plan is kept as history");
      const kinds = await db.execute<{ kind: string; reason: string }>(
        sql`
      select kind, reason from expense_amortization_schedule_events where schedule_id = ${schedule.id} order by created_at`,
        "objects",
      );
      assert.deepEqual(
        kinds.map((event) => event.kind),
        ["created", "held", "resumed", "term_changed"],
      );
      const audited = (
        await db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from audit_log where org_id = ${w.org.orgId} and table_name = 'expense_amortization_schedules' and row_id = ${schedule.id}`,
          "objects",
        )
      )[0]!;
      assert.ok(Number(audited.n) >= 4, "every change is audited");
      await assert.rejects(
        db.execute(
          sql`update expense_amortization_schedule_lines set planned_amount = 1 where schedule_id = ${schedule.id} and status = 'posted'`,
        ),
        (error: unknown) => errorChainMatches(error, /final/),
        "a posted period is immutable",
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a credit beyond the unamortized balance returns the excess amortization and completes the schedule",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const bill = await postSourceDocument(w, { number: "B-AM-8", amount: "300.00" });
      const schedule = await scheduleFor(w.org.orgId, bill.lineId);
      await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-08")!,
      });
      const credit = await postSourceDocument(w, {
        kind: "vendor_credit",
        number: "VC-AM-8",
        amount: "250.00",
        accountId: w.prepaidId,
        templateId: null,
      });
      const reduced = await reduceSchedule({
        orgId: w.org.orgId,
        actorId: w.actorId,
        scheduleId: schedule.id,
        reason: "Policy cancelled mid-term",
        amount: "250.00",
        effectiveDate: w.org.date,
        relatedDocumentId: credit.documentId,
      });
      assert.ok(reduced.journalEntryId, "the excess amortization returns through a catch-up entry");
      assert.equal(reduced.status, "completed");
      assert.equal(await accountBalance(w.org.orgId, w.prepaidId), "0.0000");
      assert.equal(
        await accountBalance(w.org.orgId, w.expenseId),
        "50.0000",
        "only the amortization the credit leaves stays in expense",
      );
      await assertReconciled(w, "2026-08-31");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a manual opening balance amortizes its unamortized remainder after activation",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      // The carried-in balance already stands in the prepaid account.
      await postSourceDocument(w, {
        number: "OPEN-1",
        amount: "300.00",
        accountId: w.prepaidId,
        templateId: null,
      });
      const created = await createManualSchedule({
        orgId: w.org.orgId,
        actorId: w.actorId,
        templateId: w.templateId,
        subsidiaryId: w.org.subsidiaryId,
        totalAmount: "400.00",
        openingAmortizedAmount: "100.00",
        serviceStartOn: "2026-06-01",
        amortizeFromPeriod: "2026-08-01",
        destinationAccountId: w.expenseId,
        reason: "Opening prepaid insurance balance",
      });
      assert.deepEqual(await plan(w.org.orgId, created.scheduleId), [
        { period: "2026-08", amount: "300.0000", status: "planned" },
      ]);
      const draftRun = await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-08")!,
      });
      assert.equal(draftRun.posted, 0, "a draft posts nothing");
      await activateSchedule({
        orgId: w.org.orgId,
        actorId: w.actorId,
        scheduleId: created.scheduleId,
        reason: "Opening balance verified",
      });
      await assertReconciled(w, "2026-07-31");
      const run = await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-08")!,
      });
      assert.equal(run.posted, 1);
      assert.equal(await accountBalance(w.org.orgId, w.prepaidId), "0.0000");
      await assertReconciled(w, "2026-08-31");
      await assert.rejects(
        cancelSchedule({
          orgId: w.org.orgId,
          actorId: w.actorId,
          scheduleId: created.scheduleId,
          reason: "Fully amortized",
          mode: "write_off",
          effectiveDate: "2026-08-31",
        }),
        refusal("amortization_nothing_to_write_off"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a write-off cancellation expenses the unamortized balance on its date",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const bill = await postSourceDocument(w, { number: "B-AM-9", amount: "300.00" });
      const schedule = await scheduleFor(w.org.orgId, bill.lineId);
      await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.periods.get("2026-07")!,
      });
      const cancelled = await cancelSchedule({
        orgId: w.org.orgId,
        actorId: w.actorId,
        scheduleId: schedule.id,
        reason: "Coverage no longer used",
        mode: "write_off",
        effectiveDate: "2026-08-15",
      });
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.journalEntryId);
      assert.equal(await accountBalance(w.org.orgId, w.prepaidId), "0.0000");
      assert.equal(await accountBalance(w.org.orgId, w.expenseId), "300.0000");
      await assertReconciled(w, "2026-08-31");
      await assert.rejects(
        resumeSchedule({
          orgId: w.org.orgId,
          actorId: w.actorId,
          scheduleId: schedule.id,
          reason: "Reopen the schedule",
        }),
        refusal("amortization_not_on_hold"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "posting refuses a templated line while the feature is off, and a template in use keeps its policy",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      await postSourceDocument(w, { number: "B-AM-10", amount: "300.00" });
      await assert.rejects(
        db.execute(
          sql`update expense_amortization_templates set period_count = 6 where id = ${w.templateId}`,
        ),
        (error: unknown) => errorChainMatches(error, /in use and its policy is fixed/),
      );
      await db.execute(
        sql`update expense_amortization_templates set name = 'Prepaid insurance (annual)' where id = ${w.templateId}`,
      );
      await setFeature(w.org.orgId, "expenseAmortization", false);
      await assert.rejects(
        postSourceDocument(w, { number: "B-AM-11", amount: "300.00" }),
        /Expense amortization is off/,
      );
      await assert.rejects(
        runExpenseAmortization({
          orgId: w.org.orgId,
          actorId: w.actorId,
          periodId: w.periods.get("2026-07")!,
        }),
        refusal("amortization_feature_off"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a service-dates template refuses a line without its dates and plans exact days when they are given",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const exactDays = await seedTemplate(w.org.orgId, w.actorId, w.prepaidId, {
        code: "DAYS",
        method: "exact_days",
        termSource: "service_dates",
        periodCount: null,
      });
      await assert.rejects(
        postSourceDocument(w, { number: "B-AM-12", amount: "590.00", templateId: exactDays }),
        /service dates/,
      );
      const bill = await postSourceDocument(w, {
        number: "B-AM-13",
        amount: "590.00",
        templateId: exactDays,
        start: "2026-07-15",
        end: "2026-09-14",
      });
      const schedule = await scheduleFor(w.org.orgId, bill.lineId);
      // 17 + 31 + 14 service days: each month in proportion, the remainder in September.
      assert.deepEqual(
        (await plan(w.org.orgId, schedule.id)).map((line) => line.amount),
        ["161.7700", "295.0000", "133.2300"],
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test("schedules are invisible to another organization", { skip: !DB }, async () => {
  const a = await setupWorld();
  const b = await setupWorld();
  try {
    const bill = await postSourceDocument(a, { number: "B-AM-14", amount: "300.00" });
    const schedule = await scheduleFor(a.org.orgId, bill.lineId);
    await assert.rejects(
      holdSchedule({
        orgId: b.org.orgId,
        actorId: b.actorId,
        scheduleId: schedule.id,
        reason: "Cross-tenant attempt",
      }),
      refusal("amortization_schedule_unknown"),
    );
    const run = await runExpenseAmortization({
      orgId: b.org.orgId,
      actorId: b.actorId,
      periodId: b.periods.get("2026-07")!,
    });
    assert.equal(run.posted, 0, "another tenant's run never posts this schedule");
    assert.equal((await plan(a.org.orgId, schedule.id))[0]!.status, "planned");
  } finally {
    await dropScratchOrgReporting(a.org.orgId);
    await dropScratchOrgReporting(b.org.orgId);
  }
});

test(
  "the close step stays open while prepaid amortization is due and clears once it posts",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const { refreshCloseRun } = await import("../close/run-automation.ts");
      const { startCloseRun } = await import("../close/run-start.ts");
      await postSourceDocument(w, { number: "B-AM-15", amount: "300.00" });
      const closeActorId = (await seedFlowActors(w.org.orgId)).adminId;
      const runId = await startCloseRun({
        orgId: w.org.orgId,
        periodId: w.org.periodId,
        bookId: w.org.bookId,
        actorId: closeActorId,
      });
      const openCounts = async (): Promise<Record<string, number>> => {
        await refreshCloseRun(w.org.orgId, runId);
        const rows = await db.execute<{ code: string; n: number }>(
          sql`
        select code, (details->>'count')::int as n from close_exceptions
         where org_id = ${w.org.orgId} and run_id = ${runId} and status = 'open'`,
          "objects",
        );
        return Object.fromEntries(rows.map((row) => [row.code, row.n]));
      };
      const task = (
        await db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from close_run_tasks where org_id = ${w.org.orgId} and run_id = ${runId} and key = 'prepaid-amortized'`,
          "objects",
        )
      )[0]!;
      assert.equal(
        task.n,
        "1",
        "the close carries the prepaid amortization step while the feature is on",
      );
      assert.equal(
        (await openCounts())["prepaid-amortization-unposted"],
        1,
        "July's due period keeps the step open",
      );
      await runExpenseAmortization({
        orgId: w.org.orgId,
        actorId: w.actorId,
        periodId: w.org.periodId,
      });
      assert.ok(
        !("prepaid-amortization-unposted" in (await openCounts())),
        "posting the period resolves the exception",
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

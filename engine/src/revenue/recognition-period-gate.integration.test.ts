import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { setPeriodLockState } from "../close/period-locks.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  buildRecognitionSchedule,
  cancelRevenueRecognitionForInvoice,
  runRevenueRecognition,
} from "./recognition.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

/**
 * One period gate for revenue recognition (fleet 8, P7): the recognition
 * runner and the invoice-cancellation reversal route through
 * arePeriodModulesOpen / assertPeriodModulesOpen instead of raw
 * period_module_is_closed SQL. Policy is preserved — recognizing and
 * reversing revenue is new local activity, not historical replay, so a
 * source-owned imported lock refuses exactly like a user lock. Each path
 * below pins both lock flavors.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

const IMPORTED_REASON = "close.importedPeriodLockReason";

/** User-owned close, through the same lock writer the close flow uses. */
async function closeGlForUser(org: ScratchOrg, actorId: string): Promise<void> {
  await setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "gl",
    state: "closed",
    actorId,
    reason: "fleet8 f2: user-owned GL close",
  });
}

/**
 * Source-owned close, mirroring exactly what the migration mirror lands
 * (engine/src/sync/migrate.ts): every module locked with the imported reason.
 */
async function closeAllImported(org: ScratchOrg): Promise<void> {
  for (const module of ["ar", "ap", "banking", "assets", "tax", "gl"] as const) {
    await db.execute(sql`
      insert into period_locks
        (org_id, period_id, book_id, module, state, locked_at, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${module},
              'closed', now(), ${IMPORTED_REASON})
      on conflict (org_id, period_id, book_id, subsidiary_id, module)
      do update set state = excluded.state,
        locked_at = excluded.locked_at,
        reason = excluded.reason,
        reopen_expires_at = null,
        version = period_locks.version + 1,
        updated_at = now()`);
  }
}

async function journalCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}`));
  return r.rows[0]!.n;
}

async function seedDueLine(
  org: ScratchOrg,
  actorId: string,
  tag: string,
): Promise<void> {
  const ruleId = randomUUID(), contractId = randomUUID(), oblId = randomUUID();
  const accounts = (await db.execute<{ deferred: string; recognized: string }>(sql`
    select (select id from accounts where org_id = ${org.orgId} and number = '2200') as deferred,
           (select id from accounts where org_id = ${org.orgId} and number = '4010') as recognized`)).rows[0]!;
  await db.execute(sql`insert into recognition_rules
    (id,org_id,code,name,method,is_forecast,recognition_periods,start_date_source,end_date_source,period_offset,start_offset_days,initial_amount_percent,deferred_account_id,recognized_account_id,is_active)
    values (${ruleId},${org.orgId},${`F2R-${tag}`},${`F2 revenue rule ${tag}`},'straight_line_even',false,1,'contract','contract',0,0,'0',${accounts.deferred},${accounts.recognized},true)`);
  await db.execute(sql`insert into revenue_contracts
    (id,org_id,customer_id,contract_number,status,starts_on,ends_on,currency,total_transaction_price,created_by,updated_by)
    values (${contractId},${org.orgId},${org.customerId},${`F2R-C-${tag}`},'active','2026-07-01','2026-07-31','CAD','1200.0000',${actorId},${actorId})`);
  await db.execute(sql`insert into performance_obligations
    (id,org_id,contract_id,description,recognition_rule_id,booked_amount,allocated_price,recognition_starts_on,recognition_ends_on,status,created_by,updated_by)
    values (${oblId},${org.orgId},${contractId},${`F2 revenue obl ${tag}`},${ruleId},'1200.0000','1200.0000','2026-07-01','2026-07-31','open',${actorId},${actorId})`);
  const built = await buildRecognitionSchedule(oblId, org.orgId, actorId, org.bookId);
  assert.equal(built.lineCount, 1, "fixture must build one due July line");
}

/** Provision every month covered by the service item's 12-month term. */
async function seedRecognitionTermPeriods(org: ScratchOrg): Promise<void> {
  const calendar = await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id
      from accounting_periods
     where id = ${org.periodId} and org_id = ${org.orgId}`);
  const fiscalCalendarId = calendar.rows[0]?.fiscal_calendar_id;
  assert.ok(fiscalCalendarId);
  const periods = [
    [2026, 8, "2026-08-01", "2026-08-31"],
    [2026, 9, "2026-09-01", "2026-09-30"],
    [2026, 10, "2026-10-01", "2026-10-31"],
    [2026, 11, "2026-11-01", "2026-11-30"],
    [2026, 12, "2026-12-01", "2026-12-31"],
    [2027, 1, "2027-01-01", "2027-01-31"],
    [2027, 2, "2027-02-01", "2027-02-28"],
    [2027, 3, "2027-03-01", "2027-03-31"],
    [2027, 4, "2027-04-01", "2027-04-30"],
    [2027, 5, "2027-05-01", "2027-05-31"],
    [2027, 6, "2027-06-01", "2027-06-30"],
  ] as const;
  for (const [fiscalYear, periodNumber, startsOn, endsOn] of periods) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      values (${randomUUID()}, ${org.orgId}, ${fiscalCalendarId}, ${fiscalYear},
              ${periodNumber}, ${startsOn.slice(0, 7)}, ${startsOn}, ${endsOn},
              false, '{}'::jsonb)`);
  }
}

/** Posted invoice with one posted July recognition line, ready to cancel. */
async function seedPostedRecognition(
  org: ScratchOrg,
  actorId: string,
  tag: string,
): Promise<string> {
  await seedRecognitionTermPeriods(org);
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, due_date, currency, fx_rate, status,
       subtotal, tax_total, total, is_final_invoice, custom, extra_dims,
       created_by, updated_by)
    values
      (${documentId}, ${org.orgId}, 'customer_invoice', ${`F2-REV-${tag}`},
       ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
       ${org.date}, 'CAD', 1, 'draft', 1200, 0, 1200, false,
       '{}'::jsonb, '{}'::jsonb, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, custom, tax_overridden,
       extra_dims, created_by, updated_by)
    values
      (${randomUUID()}, ${org.orgId}, ${documentId}, 1,
       ${org.items.service}, ${org.accounts.revenue}, 1, 1200, 1200, 0,
       false, 0, 0, '{}'::jsonb, false, '{}'::jsonb,
       ${actorId}, ${actorId})`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${documentId} and org_id = ${org.orgId}`);
  await postDocument(
    documentId,
    { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { audit: { actorId, source: "test" } },
  );
  const recognized = await runRevenueRecognition(org.orgId, "2026-07-31", actorId);
  assert.equal(recognized.posted, 1, `fixture must post one July line, got ${JSON.stringify(recognized.problems)}`);
  return documentId;
}

test("open period: the runner still posts (setup can post, refusal is load-bearing)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedDueLine(org, actorId, "open");
    const run = await runRevenueRecognition(org.orgId, "2026-07-31", actorId);
    assert.equal(run.posted, 1, `expected one posting, got ${JSON.stringify(run.problems)}`);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("runRevenueRecognition skips a user-closed GL period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedDueLine(org, actorId, "user");
    await closeGlForUser(org, actorId);
    const before = await journalCount(org.orgId);
    const run = await runRevenueRecognition(org.orgId, "2026-07-31", actorId);
    assert.equal(run.posted, 0, "a user-closed period must post nothing");
    assert.ok(run.skipped >= 1, "the closed line must be skipped, not posted");
    assert.ok(
      run.problems.some((p) => /closed/i.test(p)),
      `problems must name the closed period, got ${JSON.stringify(run.problems)}`,
    );
    assert.equal(await journalCount(org.orgId), before, "skipped recognition left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("runRevenueRecognition skips a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedDueLine(org, actorId, "imported");
    await closeAllImported(org);
    const before = await journalCount(org.orgId);
    const run = await runRevenueRecognition(org.orgId, "2026-07-31", actorId);
    assert.equal(run.posted, 0, "an imported lock must post nothing: recognition is new activity, not replay");
    assert.ok(run.skipped >= 1, "the locked line must be skipped, not posted");
    assert.ok(
      run.problems.some((p) => /closed/i.test(p)),
      `problems must name the closed period, got ${JSON.stringify(run.problems)}`,
    );
    assert.equal(await journalCount(org.orgId), before, "skipped recognition left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("cancellation reversal refuses a user-closed period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const documentId = await seedPostedRecognition(org, actorId, "user");
    await closeGlForUser(org, actorId);
    await assert.rejects(
      cancelRevenueRecognitionForInvoice({
        documentId, orgId: org.orgId, actorId,
        reason: "Gate probe: customer contract terminated",
        reversalDate: "2026-07-31",
      }),
      /the GL period covering 2026-07-31 is closed/,
      "a reversal into a user-closed period must be refused",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("cancellation reversal refuses a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const documentId = await seedPostedRecognition(org, actorId, "imported");
    await closeAllImported(org);
    await assert.rejects(
      cancelRevenueRecognitionForInvoice({
        documentId, orgId: org.orgId, actorId,
        reason: "Gate probe: customer contract terminated",
        reversalDate: "2026-07-31",
      }),
      /the GL period covering 2026-07-31 is closed/,
      "a reversal into an imported lock must be refused: reversals are not replay",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

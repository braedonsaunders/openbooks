import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient, QueryResult } from "pg";
import { db, pool } from "../platform/db.ts";
import {
  buildAllSchedules,
  buildSchedule,
  recordDepreciationInput,
  runDepreciation,
  type BuildScheduleResult,
} from "./depreciation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { remeasureAsset } from "./asset-lifecycle.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { setPeriodLockState } from "../close/period-locks.ts";
import { requestPeriodReopen, decidePeriodReopen } from "../close/reopening.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// ---------------------------------------------------------------------------
// First-use formula immutability: a custom depreciation method's definition
// must not be able to change while the FIRST schedule build that uses it is
// between its formula read and its schedule/line inserts. buildSchedule reads
// the formula, computes the whole plan in memory, and only then writes the
// schedule — an unlocked read let a concurrent definition UPDATE commit in
// that window, leaving generated lines on the old formula while the method
// row carried the new one.
// ---------------------------------------------------------------------------

type FormulaEditResult = PromiseSettledResult<QueryResult>;

const settleFormulaEdit = (promise: Promise<QueryResult>): Promise<FormulaEditResult> =>
  promise.then(
    (value): FormulaEditResult => ({ status: "fulfilled", value }),
    (reason): FormulaEditResult => ({ status: "rejected", reason }),
  );

/** The backend pid, if any, currently parked behind `blockerPid`'s locks. */
async function parkedBehind(blockerPid: number): Promise<number | null> {
  const parked = await pool.query<{ pid: number }>(
    `select pid from pg_stat_activity
      where wait_event_type = 'Lock'
        and pid <> $1::int
        and $1::int = any(pg_blocking_pids(pid))
      limit 1`,
    [blockerPid],
  );
  return parked.rows[0] ? Number(parked.rows[0].pid) : null;
}

async function waitForParkedCount(blockerPid: number, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const parked = await pool.query<{ count: number }>(
      `select count(*)::int as count from pg_stat_activity
        where wait_event_type = 'Lock'
          and pid <> $1::int`,
      [blockerPid],
    );
    if (Number(parked.rows[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${expected} sessions behind backend ${blockerPid}`);
}

/**
 * Observe a deterministic interleaving: the racing definition edit either
 * settles (the vulnerable unlocked read) or parks behind the build's
 * method-row lock.
 */
async function observeFormulaEdit(
  buildPid: number,
  waiterPid: number,
  edit: Promise<FormulaEditResult>,
): Promise<{ blocked: boolean; result?: FormulaEditResult }> {
  let result: FormulaEditResult | undefined;
  void edit.then((settled) => {
    result = settled;
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (result) return { blocked: false, result };
    const lockState = await pool.query<{ blocked: boolean }>(
      "select $1::int = any(pg_blocking_pids($2::int)) as blocked",
      [buildPid, waiterPid],
    );
    if (lockState.rows[0]?.blocked) return { blocked: true };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out observing the racing formula edit on backend ${waiterPid}`);
}

async function seedAsset(
  method: "manual" | "units_of_production",
  unitsTotal?: string,
): Promise<{ org: Awaited<ReturnType<typeof createScratchOrg>>; assetId: string; actorId: string; approverId: string; evidenceFileId: string }> {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  const actorId = actors.adminId;
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, default_method, default_life_months, default_convention,
       tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, 'Equipment', ${org.accounts.invAsset}, ${org.accounts.clearing},
            ${org.accounts.adjustment}, ${method}, null, 'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, depreciation_units_total, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, ${`ASSET-${method}`},
            ${method}, 'in_service', ${org.date}, ${org.date}, '12000.0000', '2000.0000',
            ${method}, ${unitsTotal ?? null}, '{}'::jsonb)`);
  await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  const folderId = randomUUID();
  const evidenceFileId = await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into folders (id, org_id, name, record_table, record_id, created_by, updated_by)
      values (${folderId}, ${org.orgId}, 'Asset evidence', 'fixed_assets', ${assetId}, ${actorId}, ${actorId})`);
    const evidenceFileId = (await tx.execute<{ id: string }>(sql`
      insert into files (org_id, folder_id, name, file_type, content_type, size_bytes, created_by, updated_by)
      values (${org.orgId}, ${folderId}, 'meter-evidence.pdf', 'pdf', 'application/pdf', 1, ${actorId}, ${actorId}) returning id`)).rows[0]!.id;
    assert.equal(evidenceFileId[14], "7", "evidence uses the native file ID generator");
    await tx.execute(sql`
      insert into file_attachments (org_id, file_id, target_table, target_id, created_by)
      values (${org.orgId}, ${evidenceFileId}, 'fixed_assets', ${assetId}, ${actorId})`);
    return evidenceFileId;
  });
  return { org, assetId, actorId, approverId: actors.approver1Id, evidenceFileId };
}

test("manual evidence replacement is append-preserved and concurrent runs post once", { skip: !DB }, async () => {
  const { org, assetId, actorId, evidenceFileId } = await seedAsset("manual");
  try {
    const unattachedFileId = randomUUID();
    const schedule = (await db.execute<{ id: string }>(sql`
      select id from depreciation_schedules where org_id=${org.orgId} and asset_id=${assetId} and book_id=${org.bookId}
    `));
    await db.execute(sql`
      insert into files (id, org_id, folder_id, name, file_type, content_type, size_bytes, created_by, updated_by)
      select ${unattachedFileId}, ${org.orgId}, folder_id, 'unattached.pdf', 'pdf', 'application/pdf', 1, ${actorId}, ${actorId}
        from files where id=${evidenceFileId}
    `);
    await assert.rejects(
      db.execute(sql`
        insert into depreciation_inputs
          (org_id, schedule_id, period_id, kind, manual_amount, memo, evidence_file_id, created_by, updated_by)
        values (${org.orgId}, ${schedule.rows[0]!.id}, ${org.periodId}, 'manual', '1.0000',
                'Attempted unattached evidence', ${unattachedFileId}, ${actorId}, ${actorId})
      `),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /depreciation evidence file must be attached to the owning fixed asset/.test(
          `${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`,
        );
      },
    );

    const first = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual", value: "100.0000",
      memo: "Approved manual adjustment", evidenceFileId, actorId,
    });
    const attachment = (await db.execute<{ id: string }>(sql`
      select id from file_attachments where org_id=${org.orgId} and file_id=${evidenceFileId} and target_id=${assetId}`));
    await assert.rejects(
      db.execute(sql`delete from file_attachments where id=${attachment.rows[0]!.id}`),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /file attachment is retained by depreciation evidence/.test(
          `${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`,
        );
      },
    );
    const second = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual", value: "125.4321",
      memo: "Controller-approved correction", evidenceFileId, actorId,
    });
    assert.equal(second.replacedInputId, first.inputId);
    assert.equal(second.plannedAmount, "125.4321");

    const evidence = (await db.execute<{ total: number; voided: number }>(sql`
      select count(*)::int as total,
             count(*) filter (where voided_at is not null)::int as voided
        from depreciation_inputs where org_id = ${org.orgId}`));
    assert.deepEqual(evidence.rows[0], { total: 2, voided: 1 });

    const runs = await Promise.all([
      runDepreciation(org.orgId, "2026-07-31", actorId, assetId),
      runDepreciation(org.orgId, "2026-07-31", actorId, assetId),
    ]);
    assert.equal(runs.reduce((total, run) => total + run.posted, 0), 1);
    const ledger = (await db.execute<{ entries: number; balance: string; posted_amount: string }>(sql`
      select count(distinct je.id)::int as entries, coalesce(sum(jl.amount), 0)::text as balance,
             min(l.posted_amount)::text as posted_amount
        from depreciation_schedule_lines l
        join journal_entries je on je.id = l.journal_entry_id
        join journal_lines jl on jl.entry_id = je.id
       where l.org_id = ${org.orgId} and l.id = ${second.scheduleLineId}`));
    assert.deepEqual(ledger.rows[0], { entries: 1, balance: "0.0000", posted_amount: "125.4321" });

    await assert.rejects(
      db.execute(sql`update depreciation_inputs set memo = 'tampered' where id = ${second.inputId}`),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /posted depreciation input evidence is immutable/.test(`${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`);
      },
    );

    const correction = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual", value: "-25.4321",
      memo: "Controller-approved correction", evidenceFileId, actorId,
    });
    assert.equal(correction.replacedInputId, null, "posted evidence remains intact instead of being superseded");
    const correctionRun = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    assert.equal(correctionRun.posted, 1);
    assert.deepEqual(correctionRun.problems, []);
    const corrected = (await db.execute<{ accumulated: string; postings: number; journals: number; entry_numbers: number }>(sql`
      select coalesce(sum(posted_amount), 0)::text as accumulated,
             count(*) filter (where posted_amount is not null)::int as postings,
             count(distinct journal_entry_id)::int as journals,
             count(distinct je.entry_number)::int as entry_numbers
        from depreciation_schedule_lines l
        left join journal_entries je on je.id = l.journal_entry_id and je.org_id = l.org_id
       where l.org_id = ${org.orgId} and l.schedule_id = (
         select schedule_id from depreciation_schedule_lines where id = ${second.scheduleLineId})
    `));
    assert.deepEqual(corrected.rows[0], { accumulated: "100.0000", postings: 2, journals: 2, entry_numbers: 2 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an IFRS reversal on manual evidence replays the manual ceiling, not production", { skip: !DB }, async () => {
  // Restoration-ceiling pin: input-driven methods replay retained evidence —
  // manual evidence sums manual_amount. Reading production_units for a manual
  // asset (or vice versa) throws the wrong-evidence error and blocks every
  // impairment reversal on input-driven schedules.
  const { org, assetId, actorId, evidenceFileId } = await seedAsset("manual");
  try {
    await db.execute(sql`
      update orgs set settings = settings || '{"reportingFramework": "ifrs"}'::jsonb
       where id = ${org.orgId}`);
    // Remeasurement posts gains/losses: configure the account before anything
    // posts (posted policy is immutable).
    await db.execute(sql`
      update asset_categories set gain_loss_account_id = ${org.accounts.adjustment}
       where org_id = ${org.orgId}`);
    await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual", value: "100.0000",
      memo: "Manual charge before impairment", evidenceFileId, actorId,
    });
    // Post the planned input so the carrying value reflects it.
    await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    // NBV 12,000 − 100 = 11,900; impair to 11,000 (loss 900).
    const impairment = await remeasureAsset(org.orgId, assetId, {
      newCarryingValue: "11000", date: "2026-07-31", actorId,
    });
    assert.equal(impairment.delta, "-900.0000");
    // Fair value recovers to 11,500: reversal 500, inside the 900 cap.
    const reversal = await remeasureAsset(org.orgId, assetId, {
      newCarryingValue: "11500", date: "2026-07-31", actorId,
    });
    assert.equal(reversal.delta, "500.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a schedule split across fiscal calendars fails closed instead of picking one", { skip: !DB }, async () => {
  // Calendar-retention pin: when an asset's lines reference periods of two
  // fiscal calendars, rebuilding must refuse — silently keeping the first
  // calendar found would post every subsequent month to the wrong fiscal
  // spine. (Two calendars must throw; tolerating two picks one arbitrarily.)
  const { org, assetId, actorId } = await seedAsset("manual");
  try {
    const schedule = (await db.execute<{ id: string }>(sql`
      select id from depreciation_schedules where org_id=${org.orgId} and asset_id=${assetId} and book_id=${org.bookId}`));
    const scheduleId = schedule.rows[0]!.id;
    const calB = randomUUID();
    await db.execute(sql`
      insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                                    adjustment_period_enabled, is_default, is_active, config)
      values (${calB}, ${org.orgId}, 'Second', 'monthly', 1, 1, 'UTC', false, false, true, '{}'::jsonb)`);
    const periodB = randomUUID();
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${periodB}, ${org.orgId}, 2026, 7, '2026-07-B', '2026-07-01', '2026-07-31', false, ${calB})`);
    // Manual-method schedules carry no formula lines, so one line per calendar:
    // the schedule is genuinely split across the default calendar and calB.
    await db.execute(sql`
      insert into depreciation_schedule_lines (id, org_id, schedule_id, period_id, sequence, planned_amount, source, created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, ${scheduleId}, ${org.periodId}, 998, '0.0000', 'imported', ${actorId}, ${actorId}),
             (${randomUUID()}, ${org.orgId}, ${scheduleId}, ${periodB}, 999, '0.0000', 'imported', ${actorId}, ${actorId})`);
    await assert.rejects(
      buildSchedule(assetId, org.orgId, actorId, org.bookId),
      /spans multiple fiscal calendars/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a non-hex evidence file id is refused before any schedule work", { skip: !DB }, async () => {
  // Evidence-gate strictness pin: the file id must be a hex UUID, so a
  // mistyped id fails closed up front with the evidence error instead of
  // failing deep in the input path (or attaching to the wrong file).
  const { org, assetId, actorId, evidenceFileId } = await seedAsset("manual");
  try {
    const plusId = `${evidenceFileId.slice(0, 30)}+${evidenceFileId.slice(31)}`;
    assert.equal(plusId.length, 36);
    await assert.rejects(
      recordDepreciationInput({
        orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual", value: "100.0000",
        memo: "Mistyped evidence reference", evidenceFileId: plusId, actorId,
      }),
      /an attached evidence file is required/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("depreciation reloads accounts and dimensions after a concurrent asset edit", { skip: !DB }, async () => {
  const { org, assetId, actorId, evidenceFileId } = await seedAsset("manual");
  const fence: PoolClient = await pool.connect();
  const mutator: PoolClient = await pool.connect();
  try {
    await recordDepreciationInput({
      orgId: org.orgId,
      assetId,
      effectiveDate: org.date,
      kind: "manual",
      value: "100.0000",
      memo: "Configuration race test",
      evidenceFileId,
      actorId,
    });
    const alternateLocation = (await db.execute<{ id: string }>(sql`
      select id from locations where org_id = ${org.orgId} and name = 'DC' limit 1`)).rows[0]!.id;
    // Native asset overrides are the old posting configuration. The edit below
    // changes both accounts used by the journal and its location dimension.
    await db.execute(sql`
      update fixed_assets
         set asset_account_id = ${org.accounts.invAsset},
             accumulated_depreciation_account_id = ${org.accounts.clearing},
             depreciation_expense_account_id = ${org.accounts.adjustment},
             location_id = ${org.locationId}
       where id = ${assetId} and org_id = ${org.orgId}`);

    await fence.query("begin");
    await fence.query("select set_config('app.bypass_rls', 'on', true)");
    const fenceLock = await fence.query("select id from fixed_assets where id = $1 for update", [assetId]);
    assert.equal(fenceLock.rows.length, 1, "the fence must lock the seeded asset row");
    const fencePid = (await fence.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

    await mutator.query("begin");
    await mutator.query("select set_config('app.bypass_rls', 'on', true)");
    const edit = (async () => {
      await mutator.query(
        `update fixed_assets
            set asset_account_id = $1,
                accumulated_depreciation_account_id = $2,
                depreciation_expense_account_id = $3,
                location_id = $4,
                updated_at = now(), updated_by = $5
          where id = $6 and org_id = $7`,
        [org.accounts.ar, org.accounts.ap, org.accounts.cogs, alternateLocation, actorId, assetId, org.orgId],
      );
      await mutator.query("commit");
    })();
    // The due query can still read the old configuration while the edit waits
    // on the fence. This is the interleaving that previously allowed a stale
    // snapshot to reach the journal.
    await waitForParkedCount(fencePid, 1);
    const runPromise = runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    await waitForParkedCount(fencePid, 2);

    await fence.query("commit");
    const [run] = await Promise.all([runPromise, edit]);
    assert.equal(run.posted, 1);
    assert.equal(run.problems.length, 0);

    const lines = (await db.execute<{ account_id: string; location_id: string | null }>(sql`
      select jl.account_id, jl.location_id
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where je.id = ${run.entries[0]!.entryId}
       order by jl.line_number`));
    assert.deepEqual(lines.rows, [
      { account_id: org.accounts.cogs, location_id: alternateLocation },
      { account_id: org.accounts.ap, location_id: alternateLocation },
    ], "the journal must use the committed asset edit, not the due-query snapshot");
  } finally {
    await fence.query("rollback").catch(() => undefined);
    await mutator.query("rollback").catch(() => undefined);
    fence.release();
    mutator.release();
    await dropScratchOrg(org.orgId);
  }
});

test("custom formulas operate independently on an alternate depreciation book", { skip: !DB }, async () => {
  const { org, assetId, actorId, approverId } = await seedAsset("manual");
  try {
    const formulaId = randomUUID();
    const alternateBookId = randomUUID();
    await db.execute(sql`
      insert into depreciation_methods (id, org_id, code, name, formula, end_of_life, is_active, created_by, updated_by)
      values (${formulaId}, ${org.orgId}, 'ALT-SL', 'Alternate straight line', '(OC-RV)/AL', 'fully_depreciate', true, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, posts_gl, is_active, created_by, updated_by)
      values (${alternateBookId}, ${org.orgId}, 'ALT', 'Alternate reporting', false, false, true, ${actorId}, ${actorId})`);
    const category = (await db.execute<{ category_id: string }>(sql`select category_id from fixed_assets where id=${assetId}`));
    await db.execute(sql`update fixed_assets set useful_life_months=12 where id=${assetId}`);
    await db.execute(sql`
      insert into depreciation_book_policies
        (org_id, book_id, category_id, method, depreciation_method_id, life_months, convention, created_by, updated_by)
      values (${org.orgId}, ${alternateBookId}, ${category.rows[0]!.category_id}, 'straight_line', ${formulaId}, 12, 'full_month', ${actorId}, ${actorId})`);

    const results = await buildAllSchedules(assetId, org.orgId, actorId);
    assert.equal(results.length, 2);
    const alternate = (await db.execute<{ depreciation_method_id: string; lines: number; total: string }>(sql`
      select s.depreciation_method_id, count(l.id)::int as lines, coalesce(sum(l.planned_amount),0)::text as total
        from depreciation_schedules s left join depreciation_schedule_lines l on l.schedule_id=s.id
       where s.asset_id=${assetId} and s.book_id=${alternateBookId}
       group by s.id`));
    assert.deepEqual(alternate.rows[0], { depreciation_method_id: formulaId, lines: 1, total: "833.3333" });
    await assert.rejects(
      db.execute(sql`update depreciation_methods set formula='OC/AL' where id=${formulaId}`),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /a depreciation formula used by a schedule is immutable/.test(
          `${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`,
        );
      },
    );
    const line = (await db.execute<{ id: string }>(sql`
      select l.id from depreciation_schedule_lines l join depreciation_schedules s
        on s.org_id=l.org_id and s.id=l.schedule_id
       where s.org_id=${org.orgId} and s.asset_id=${assetId} and s.book_id=${alternateBookId}`)).rows[0]!;
    await setPeriodLockState({orgId:org.orgId,periodId:org.periodId,bookId:alternateBookId,
      module:"assets",state:"closed",actorId,reason:"Protect reporting book while close is reviewed"});
    const closed = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId, undefined, alternateBookId);
    assert.equal(closed.recorded, 0);
    assert.equal(closed.skipped, 1);
    assert.match(closed.problems.join(" "), /closed/);
    await assert.rejects(db.execute(sql`
      update depreciation_schedule_lines set posted_amount=planned_amount,non_gl_recognized_at=now(),updated_by=${actorId}
       where org_id=${org.orgId} and id=${line.id}`),
      (error: unknown) => errorChainMatches(error, /closed for depreciation/),
      "the database independently refuses no-GL recognition across a close");
    const reopen = await requestPeriodReopen({orgId:org.orgId,periodId:org.periodId,bookId:alternateBookId,
      modules:["assets"],actorId,reason:"Authorized reporting-book close correction"});
    await decidePeriodReopen({orgId:org.orgId,requestId:reopen,actorId:approverId,approve:true});
    await db.execute(sql`update accounting_books set posts_gl=true where org_id=${org.orgId} and id=${alternateBookId}`);
    await assert.rejects(db.execute(sql`
      update depreciation_schedule_lines set posted_amount=planned_amount,non_gl_recognized_at=now(),updated_by=${actorId}
       where org_id=${org.orgId} and id=${line.id}`),
      (error: unknown) => errorChainMatches(error, /active non-posting book/),
      "a posting book cannot evade journal evidence with the reporting-book marker");
    await db.execute(sql`update accounting_books set posts_gl=false where org_id=${org.orgId} and id=${alternateBookId}`);
    const outsideScope = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId, [], alternateBookId);
    assert.equal(outsideScope.recorded, 0, "recognition respects the legal-entity allowlist");
    const concurrent = await Promise.all([
      runDepreciation(org.orgId, "2026-07-31", actorId, assetId, undefined, alternateBookId),
      runDepreciation(org.orgId, "2026-07-31", actorId, assetId, undefined, alternateBookId),
    ]);
    assert.ok(concurrent.every((result) => result.problems.length === 0));
    assert.equal(concurrent.reduce((n,result) => n + result.recorded,0),1,"concurrent runs recognize the book line exactly once");
    const nonPostingRun = concurrent.find((result) => result.recorded === 1)!;
    assert.equal(nonPostingRun.posted, 0, "a reporting-only book never leaks entries into the GL");
    assert.equal(nonPostingRun.recorded, 1);
    assert.equal(nonPostingRun.recordedAmount, "833.3333");
    assert.equal(nonPostingRun.totalAmount, "0");
    assert.deepEqual(nonPostingRun.entries, []);
    const recognized = (await db.execute<{ posted:string; journal_entry_id:string|null; recorded:boolean; updated_by:string }>(sql`
      select posted_amount::text as posted,journal_entry_id,non_gl_recognized_at is not null as recorded,updated_by
        from depreciation_schedule_lines where org_id=${org.orgId} and id=${line.id}`)).rows[0]!;
    assert.deepEqual(recognized, {posted:"833.3333",journal_entry_id:null,recorded:true,updated_by:actorId});
    const journalCount = (await db.execute<{ n:number }>(sql`
      select count(*)::int as n from journal_entries where org_id=${org.orgId} and book_id=${alternateBookId}`)).rows[0]!.n;
    assert.equal(journalCount, 0);
    const carrying = (await db.execute<{ amount:string }>(sql`
      select carrying_value::text as amount from asset_book_carrying_values
       where org_id=${org.orgId} and asset_id=${assetId} and book_id=${alternateBookId}`)).rows[0]!;
    assert.equal(carrying.amount, "11166.6667", "the observable book carrying amount includes recognition");
    const audit = async () => (await db.execute<{ actor_id:string; before:string|null; after:string; reason:string }>(sql`
      select actor_id,changes->'before'->>'posted_amount' as before,changes->'after'->>'posted_amount' as after,
             changes->>'reason' as reason from audit_log
       where org_id=${org.orgId} and table_name='depreciation_schedule_lines' and row_id=${line.id}
         and changes->>'reason'='Recognize reporting-book depreciation without a GL journal'`)).rows;
    assert.deepEqual(await audit(), [{actor_id:actorId,before:null,after:"833.3333",reason:"Recognize reporting-book depreciation without a GL journal"}]);
    const repeat = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId, undefined, alternateBookId);
    assert.equal(repeat.recorded, 0);
    assert.deepEqual(repeat.problems, []);
    assert.equal((await audit()).length, 1, "retry does not duplicate recognition or its evidence");
    await assert.rejects(db.execute(sql`update depreciation_schedule_lines set posted_amount=0 where org_id=${org.orgId} and id=${line.id}`),
      (error:unknown) => errorChainMatches(error,/recognized reporting-book depreciation is immutable/));
    await assert.rejects(db.execute(sql`delete from depreciation_schedule_lines where org_id=${org.orgId} and id=${line.id}`),
      (error:unknown) => errorChainMatches(error,/recognized reporting-book depreciation is immutable/));
    await buildSchedule(assetId, org.orgId, actorId, alternateBookId);
    assert.equal((await audit()).length, 1, "rebuilding future estimates retains recognized history");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("production evidence calculates exact charges and refuses lifetime overrun", { skip: !DB }, async () => {
  const { org, assetId, actorId, evidenceFileId } = await seedAsset("units_of_production", "1000.0000");
  try {
    const result = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "production_usage", value: "333.3333",
      memo: "July meter delta", evidenceFileId, actorId,
    });
    assert.equal(result.plannedAmount, "3333.3330");
    await assert.rejects(
      recordDepreciationInput({
        orgId: org.orgId, assetId, effectiveDate: "2026-07-20", kind: "production_usage", value: "1000.0001",
        memo: "Invalid replacement", evidenceFileId, actorId,
      }),
      /recorded production must remain between zero and expected lifetime units/,
    );
    const stored = (await db.execute<{ source: string; planned_amount: string; production_units: string; evidence_file_name: string }>(sql`
      select l.source, l.planned_amount::text, i.production_units::text, f.name as evidence_file_name
        from depreciation_schedule_lines l join depreciation_inputs i on i.id = l.input_id
        join files f on f.id=i.evidence_file_id
       where l.id = ${result.scheduleLineId}`));
    assert.deepEqual(stored.rows[0], {
      source: "production_usage", planned_amount: "3333.3330",
      production_units: "333.3333", evidence_file_name: "meter-evidence.pdf",
    });

    await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    const correction = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "production_usage", value: "-33.3333",
      memo: "Corrected meter delta", evidenceFileId, actorId,
    });
    assert.equal(correction.plannedAmount, "-333.3330");
    await db.execute(sql`
      insert into period_locks
        (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by, reason, created_by, updated_by)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'assets', 'closed', now(),
              ${actorId}, 'Depreciation contract test', ${actorId}, ${actorId})
    `);
    await assert.rejects(
      recordDepreciationInput({
        orgId: org.orgId, assetId, effectiveDate: org.date, kind: "production_usage", value: "1.0000",
        memo: "Late meter reading", evidenceFileId, actorId,
      }),
      /asset or GL period is closed/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a custom formula cannot change while its first schedule build is in flight", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const formulaId = randomUUID();
    const categoryId = randomUUID();
    const assetId = randomUUID();
    await db.execute(sql`
      insert into depreciation_methods (id, org_id, code, name, formula, end_of_life, is_active, created_by, updated_by)
      values (${formulaId}, ${org.orgId}, 'FIRST-USE', 'First-use straight line', '(OC-RV)/AL', 'fully_depreciate', true, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
         depreciation_expense_account_id, default_method, default_convention, tax_attributes, is_active)
      values (${categoryId}, ${org.orgId}, 'Equipment', ${org.accounts.invAsset}, ${org.accounts.clearing},
              ${org.accounts.adjustment}, 'straight_line', 'full_month', '{}'::jsonb, true)`);
    await db.execute(sql`
      insert into fixed_assets
        (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on,
         acquisition_cost, salvage_value, depreciation_method, depreciation_method_id, useful_life_months, custom)
      values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'ASSET-FIRST-USE',
              'First-use formula race', 'in_service', ${org.date}, ${org.date}, '12000.0000', '2000.0000',
              'straight_line', ${formulaId}, 12, '{}'::jsonb)`);
    // No schedule exists yet — this build is the formula's first use.

    // Session C fences the build's writes so the build parks mid-transaction,
    // after its formula read and before any schedule state can commit.
    const fence: PoolClient = await pool.connect();
    const mutator: PoolClient = await pool.connect();
    try {
      await fence.query("begin");
      await fence.query("select set_config('app.bypass_rls', 'on', true)");
      await fence.query("lock table depreciation_schedules, depreciation_schedule_lines in exclusive mode");
      const fencePid = (await fence.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

      let buildResult: BuildScheduleResult | undefined;
      let buildError: unknown;
      const buildPromise = buildSchedule(assetId, org.orgId, actorId, org.bookId).then(
        (result) => {
          buildResult = result;
        },
        (error) => {
          buildError = error;
        },
      );

      // Wait until the build is parked behind the fence: it has read the
      // formula and holds whatever locks that read took, but nothing it
      // wrote is committed.
      let buildPid: number | null = null;
      for (let attempt = 0; attempt < 400 && buildPid === null; attempt += 1) {
        buildPid = await parkedBehind(fencePid);
        if (buildPid === null) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(buildPid, "the first schedule build must park behind the write fence mid-transaction");

      const inFlight = (await db.execute<{ schedules: number }>(sql`
        select count(*)::int as schedules from depreciation_schedules
         where org_id = ${org.orgId} and asset_id = ${assetId}`));
      assert.equal(inFlight.rows[0]!.schedules, 0, "an in-flight build must expose no partial schedule");

      // Session B: a definition edit racing the in-flight first build.
      await mutator.query("begin");
      await mutator.query("select set_config('app.bypass_rls', 'on', true)");
      const mutatorPid = (await mutator.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const racingEdit = settleFormulaEdit(
        mutator.query("update depreciation_methods set formula = 'OC/AL' where id = $1", [formulaId]),
      );
      const observation = await observeFormulaEdit(buildPid, mutatorPid, racingEdit);
      assert.equal(
        observation.blocked,
        true,
        "a formula edit racing the first schedule build must park behind the build's method-row lock, not commit against the unlocked read",
      );

      // Release the fence: the build finishes and commits schedule + lines.
      await fence.query("commit");
      await buildPromise;
      assert.ok(buildError === undefined, `the first build must succeed (${String(buildError)})`);
      assert.ok(buildResult);
      assert.equal(buildResult.lineCount, 1);
      assert.equal(buildResult.skippedMonths.length, 11);

      // The parked edit wakes on the build's committed schedule and the
      // storage guard rejects it: lines and method row stay consistent.
      const edit = observation.result ?? await racingEdit;
      assert.equal(edit.status, "rejected", "the racing formula edit must be rejected once the first schedule commits");
      if (edit.status === "rejected") {
        assert.match(String(edit.reason), /a depreciation formula used by a schedule is immutable/);
      }
      await mutator.query("rollback");

      const state = (await db.execute<{ formula: string; method_id: string | null; lines: number; total: string; source: string }>(sql`
        select m.formula, s.depreciation_method_id,
               count(l.id)::int as lines, coalesce(sum(l.planned_amount), 0)::text as total,
               min(l.source) as source
          from depreciation_methods m
          join depreciation_schedules s on s.depreciation_method_id = m.id and s.org_id = m.org_id
          left join depreciation_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
         where m.org_id = ${org.orgId} and m.id = ${formulaId} and s.asset_id = ${assetId}
         group by m.formula, s.depreciation_method_id`));
      assert.deepEqual(state.rows[0], {
        formula: "(OC-RV)/AL",
        depreciation_method_id: formulaId,
        lines: 1,
        total: "833.3333",
        source: "formula",
      }, "schedule and lines must commit atomically on the formula they were generated from");

      // Post-first-use definition changes are rejected at the storage boundary.
      for (const mutation of [
        sql`update depreciation_methods set formula = 'OC/AL' where id = ${formulaId}`,
        sql`update depreciation_methods set end_of_life = 'retain_balance' where id = ${formulaId}`,
        sql`update depreciation_methods set is_active = false where id = ${formulaId}`,
      ]) {
        await assert.rejects(
          db.execute(mutation),
          (error: unknown) => {
            const wrapped = error as { message?: string; cause?: { message?: string } };
            return /a depreciation formula used by a schedule is immutable/.test(
              `${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`,
            );
          },
        );
      }
    } finally {
      await fence.query("rollback").catch(() => undefined);
      await mutator.query("rollback").catch(() => undefined);
      fence.release();
      mutator.release();
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

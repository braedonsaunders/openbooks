import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import { seedCloseRunApprovalFixture } from "../testing/close.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { requestCloseApproval } from "./approvals.ts";
import { updateCloseTask } from "./tasks.ts";
import { seedApprovalFlow } from "../testing/fixtures.ts";
import { decideGate } from "../flows/gates.ts";
import { periodFingerprint } from "./period-fingerprint.ts";
import { refreshCloseRun } from "./run-automation.ts";
import { startCloseRun } from "./run-start.ts";
import { recordClosingFxRateEvidence } from "./fx-revaluation-evidence.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  grantScratchPermissions,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const enabled = !!process.env.OPENBOOKS_DB_URL;

async function setup() {
  const org = await createScratchOrg();
  const actor = (await seedFlowActors(org.orgId)).adminId;
  await grantScratchPermissions(org.orgId, actor, ["close.run"]);
  const other = randomUUID();
  await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'USD', 'US')`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings, '{features}',
    coalesce(settings->'features','{}') || '{"multiCurrency":true,"multiSubsidiary":true,"fixedAssets":true,"advancedClose":true,"flows":true}'::jsonb)
    where id=${org.orgId}`);
  return { org, actor, other };
}

async function journal(
  org: ScratchOrg,
  actor: string,
  subsidiaryId: string,
  amount: string,
  currency = "CAD",
  posted = true,
) {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`insert into journal_entries
      (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
      values (${id},${org.orgId},${org.bookId},${subsidiaryId},${id},${org.date},${org.periodId},'draft','manual')`);
    await tx.execute(sql`insert into journal_lines
      (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values (${org.orgId},${id},1,${org.accounts.cogs},${subsidiaryId},${amount},${currency},${amount},1),
        (${org.orgId},${id},2,${org.accounts.revenue},${subsidiaryId},-${amount}::numeric,${currency},-${amount}::numeric,1)`);
    if (posted)
      await tx.execute(
        sql`update journal_entries set status='posted',posted_at=now(),posted_by=${actor} where id=${id}`,
      );
  });
  return id;
}

async function counts(orgId: string, runId: string) {
  await refreshCloseRun(orgId, runId);
  return Object.fromEntries(
    (
      await db.execute<{ code: string; n: number }>(
        sql`
    select code,(details->>'count')::int as n from close_exceptions
    where org_id=${orgId} and run_id=${runId} and status='open'`,
        "objects",
      )
    ).map((r) => [r.code, r.n]),
  );
}

async function run(org: ScratchOrg, actor: string, subsidiaryIds?: string[]) {
  return startCloseRun({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    actorId: actor,
    subsidiaryIds,
  });
}

test(
  "scoped close ignores another entity drafts and assets but retains its own blockers",
  { skip: !enabled },
  async () => {
    const { org, actor, other } = await setup();
    try {
      const foreignDraft = await journal(org, actor, other, "10", "USD", false);
      await db.execute(
        sql`update journal_entries set subsidiary_id=${org.subsidiaryId} where id=${foreignDraft}`,
      );
      const doc = randomUUID();
      // Approved so the document belongs to the assignable population: the
      // scope claim below must not depend on the old over-broad count that
      // swept drafts into the assignment backlog.
      await db.execute(sql`insert into documents (id,org_id,subsidiary_id,kind,status,document_number,document_date,currency,subtotal,tax_total,total)
      values (${doc},${org.orgId},${other},'vendor_bill','approved',${doc},${org.date},'USD',10,0,10)`);
      const category = randomUUID(),
        asset = randomUUID(),
        schedule = randomUUID();
      await db.execute(sql`insert into asset_categories (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id)
      values (${category},${org.orgId},'Readiness asset',${org.accounts.bank},${org.accounts.clearing},${org.accounts.cogs})`);
      await db.execute(sql`insert into fixed_assets (id,org_id,subsidiary_id,category_id,asset_number,name,acquisition_cost)
      values (${asset},${org.orgId},${other},${category},${asset},'Foreign asset',100)`);
      await db.execute(sql`insert into depreciation_schedules (id,org_id,asset_id,book_id,method)
      values (${schedule},${org.orgId},${asset},${org.bookId},'straight_line')`);
      await db.execute(sql`insert into depreciation_schedule_lines (org_id,schedule_id,period_id,sequence,planned_amount)
      values (${org.orgId},${schedule},${org.periodId},1,10)`);
      const runId = await run(org, actor, [org.subsidiaryId]);
      let got = await counts(org.orgId, runId);
      assert.equal(got["drafts-open"] ?? 0, 0);
      assert.equal(got["posting-period-missing"] ?? 0, 0);
      assert.equal(got["depreciation-unposted"] ?? 0, 0);
      await db.execute(
        sql`update close_runs set scope=${JSON.stringify({ subsidiaryIds: [other] })}::jsonb where id=${runId}`,
      );
      got = await counts(org.orgId, runId);
      assert.equal(got["drafts-open"], 1);
      assert.equal(got["posting-period-missing"], 1);
      assert.equal(got["depreciation-unposted"], 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "close FX checks use book measurement currency and accept current closing evidence",
  { skip: !enabled },
  async () => {
    const { org, actor, other } = await setup();
    try {
      await journal(org, actor, other, "10", "USD");
      const foreignEntry = randomUUID();
      await db.execute(sql`insert into journal_entries
      (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
      values (${foreignEntry},${org.orgId},${org.bookId},${org.subsidiaryId},${foreignEntry},${org.date},${org.periodId},'draft','manual')`);
      await db.execute(sql`insert into journal_lines
      (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values (${org.orgId},${foreignEntry},1,${org.accounts.bank},${org.subsidiaryId},'12.5000','USD','10.0000','1.25'),
             (${org.orgId},${foreignEntry},2,${org.accounts.bank},${org.subsidiaryId},'-12.5000','USD','-10.0000','1.25')`);
      await db.execute(
        sql`update journal_entries set status='posted',posted_at=now(),posted_by=${actor} where id=${foreignEntry}`,
      );
      await db.execute(sql`insert into fx_rates (org_id,from_currency,to_currency,rate_type,as_of,rate)
      values (${org.orgId},'CAD','USD','spot',${org.date},1)`);
      const runId = await run(org, actor);
      assert.equal((await counts(org.orgId, runId))["fx-missing"] ?? 0, 0);
      await db.execute(sql`delete from fx_rates where org_id=${org.orgId}`);
      await db.execute(
        sql`update close_runs set scope=${JSON.stringify({ subsidiaryIds: [other] })}::jsonb where id=${runId}`,
      );
      assert.equal(
        (await counts(org.orgId, runId))["fx-missing"] ?? 0,
        0,
        "USD entity needs no USD/CAD quote",
      );
      await db.execute(
        sql`update close_runs set scope=${JSON.stringify({ subsidiaryIds: [org.subsidiaryId] })}::jsonb where id=${runId}`,
      );
      assert.equal(
        (await counts(org.orgId, runId))["fx-missing"],
        1,
        "the CAD entity currency pair needs a usable quote or closing evidence",
      );
      await recordClosingFxRateEvidence({
        orgId: org.orgId,
        actorId: actor,
        input: {
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          periodId: org.periodId,
          accountId: org.accounts.bank,
          transactionCurrency: "USD",
          measurementCurrency: "CAD",
          rate: "1.2500000000",
          source: "Closing rate source",
          reason: "Rate evidence for the July close",
          expectedCurrentId: null,
          requestId: randomUUID(),
        },
      });
      assert.equal(
        (await counts(org.orgId, runId))["fx-missing"] ?? 0,
        0,
        "current position evidence satisfies FX readiness without a duplicate global spot quote",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "posting-period-missing uses effective posting dates for period-less documents",
  { skip: !enabled },
  async () => {
    const { org, actor } = await setup();
    try {
      const outside = randomUUID(),
        inside = randomUUID(),
        postedInside = randomUUID();
      // The inside document is approved so the date bound is what excludes
      // the outside one: drafts never belong to the assignment row set.
      await db.execute(sql`insert into documents (id,org_id,subsidiary_id,kind,status,document_number,document_date,currency,subtotal,tax_total,total)
      values (${outside},${org.orgId},${org.subsidiaryId},'vendor_bill','approved',${outside},'2026-01-15','CAD',10,0,10),
             (${inside},${org.orgId},${org.subsidiaryId},'vendor_bill','approved',${inside},${org.date},'CAD',10,0,10),
             (${postedInside},${org.orgId},${org.subsidiaryId},'vendor_bill','approved',${postedInside},'2026-01-15','CAD',10,0,10)`);
      await db.execute(
        sql`update documents set posting_date=${org.date} where org_id=${org.orgId} and id=${postedInside}`,
      );
      const runId = await run(org, actor);
      assert.equal((await counts(org.orgId, runId))["posting-period-missing"], 2);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "open drafts without a posting period belong to their effective-date review window",
  { skip: !enabled },
  async () => {
    const { org, actor } = await setup();
    try {
      for (const status of ["draft", "pending_approval"]) {
        const outside = randomUUID(),
          inside = randomUUID(),
          postedInside = randomUUID();
        await db.execute(sql`insert into documents (id,org_id,subsidiary_id,kind,status,document_number,document_date,currency,subtotal,tax_total,total)
        values (${outside},${org.orgId},${org.subsidiaryId},'vendor_bill',${status},${outside},'2026-01-15','CAD',10,0,10),
               (${inside},${org.orgId},${org.subsidiaryId},'vendor_bill',${status},${inside},${org.date},'CAD',10,0,10),
               (${postedInside},${org.orgId},${org.subsidiaryId},'vendor_bill',${status},${postedInside},'2026-01-15','CAD',10,0,10)`);
        await db.execute(
          sql`update documents set posting_date=${org.date} where org_id=${org.orgId} and id=${postedInside}`,
        );
      }
      const got = await counts(org.orgId, await run(org, actor));
      assert.equal(
        got["drafts-open"],
        4,
        "drafts and pending approvals are reviewed by effective posting date",
      );
      assert.equal(
        got["posting-period-missing"] ?? 0,
        0,
        "unapproved documents cannot be assigned a posting period",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "posting-period-missing counts the assignment row set while drafts-open keeps unapproved work",
  { skip: !enabled },
  async () => {
    const { org, actor } = await setup();
    try {
      // Only the approved unassigned bill can ever take a period on the
      // assignment page, so only it may count as missing. The draft and the
      // pending bill stay open-draft work, and the approved bill that already
      // holds this period stays open-draft work too until it posts. (A posted
      // bill always carries its period by storage constraint, so posting
      // derives the period and assignment is moot — there is no posted row
      // left for either population.)
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await db.execute(sql`insert into documents (id,org_id,subsidiary_id,kind,status,document_number,document_date,posting_period_id,currency,subtotal,tax_total,total)
      values (${ids[0]},${org.orgId},${org.subsidiaryId},'vendor_bill','draft',${ids[0]},${org.date},null,'CAD',10,0,10),
             (${ids[1]},${org.orgId},${org.subsidiaryId},'vendor_bill','pending_approval',${ids[1]},${org.date},null,'CAD',10,0,10),
             (${ids[2]},${org.orgId},${org.subsidiaryId},'vendor_bill','approved',${ids[2]},${org.date},null,'CAD',10,0,10),
             (${ids[3]},${org.orgId},${org.subsidiaryId},'vendor_bill','approved',${ids[3]},${org.date},${org.periodId},'CAD',10,0,10)`);
      const runId = await run(org, actor);
      const got = await counts(org.orgId, runId);
      assert.equal(
        got["posting-period-missing"],
        1,
        "only the approved unassigned bill matches the assignment row set",
      );
      assert.equal(
        got["drafts-open"],
        3,
        "unapproved and assigned-but-unposted bills stay open-draft work",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the close fingerprint scopes unassigned documents by effective posting date",
  { skip: !enabled },
  async () => {
    const { org } = await setup();
    try {
      const before = await periodFingerprint(org.orgId, org.periodId, org.bookId);
      const outside = randomUUID(),
        inside = randomUUID(),
        postedInside = randomUUID();
      await db.execute(sql`insert into documents (id,org_id,subsidiary_id,kind,status,document_number,document_date,currency,subtotal,tax_total,total)
      values (${outside},${org.orgId},${org.subsidiaryId},'vendor_bill','draft',${outside},'2026-01-15','CAD',10,0,10),
             (${postedInside},${org.orgId},${org.subsidiaryId},'vendor_bill','draft',${postedInside},'2026-01-15','CAD',10,0,10)`);
      assert.equal(
        await periodFingerprint(org.orgId, org.periodId, org.bookId),
        before,
        "a draft dated outside the period is not this review evidence and must not invalidate an attestation",
      );
      await db.execute(
        sql`update documents set posting_date=${org.date} where org_id=${org.orgId} and id=${postedInside}`,
      );
      assert.notEqual(
        await periodFingerprint(org.orgId, org.periodId, org.bookId),
        before,
        "an in-period posting date is review evidence even when the document date is outside",
      );
      await db.execute(sql`insert into documents (id,org_id,subsidiary_id,kind,status,document_number,document_date,currency,subtotal,tax_total,total)
      values (${inside},${org.orgId},${org.subsidiaryId},'vendor_bill','draft',${inside},${org.date},'CAD',10,0,10)`);
      assert.notEqual(
        await periodFingerprint(org.orgId, org.periodId, org.bookId),
        before,
        "an in-period draft still moves the fingerprint",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "readiness ignores non-posting order kinds for drafts and missing posting periods",
  { skip: !enabled },
  async () => {
    const { org, actor } = await setup();
    try {
      const so = randomUUID(),
        po = randomUUID(),
        bill = randomUUID();
      await db.execute(sql`insert into documents (id,org_id,subsidiary_id,kind,status,document_number,document_date,currency,subtotal,tax_total,total)
      values (${so},${org.orgId},${org.subsidiaryId},'sales_order','approved',${so},${org.date},'CAD',10,0,10),
             (${po},${org.orgId},${org.subsidiaryId},'purchase_order','pending_approval',${po},${org.date},'CAD',10,0,10),
             (${bill},${org.orgId},${org.subsidiaryId},'vendor_bill','approved',${bill},${org.date},'CAD',10,0,10)`);
      const runId = await run(org, actor);
      const got = await counts(org.orgId, runId);
      assert.equal(
        got["posting-period-missing"],
        1,
        "only the bill lacks a posting period it could ever use",
      );
      assert.equal(got["drafts-open"] ?? 0, 0, "orders are never open drafts of the period");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a computed task stays open while any of its checks has an open exception",
  { skip: !enabled },
  async () => {
    const { org, actor } = await setup();
    try {
      // An approved bill already assigned to the period: drafts-open counts it,
      // posting-period-missing does not — both feed the drafts-cleared task.
      const bill = randomUUID();
      await db.execute(sql`insert into documents (id,org_id,subsidiary_id,kind,status,document_number,document_date,posting_period_id,currency,subtotal,tax_total,total)
      values (${bill},${org.orgId},${org.subsidiaryId},'vendor_bill','approved',${bill},${org.date},${org.periodId},'CAD',10,0,10)`);
      const runId = await run(org, actor);
      const got = await counts(org.orgId, runId);
      assert.equal(got["drafts-open"], 1);
      assert.equal(got["posting-period-missing"] ?? 0, 0);
      const task = (
        await db.execute<{
          status: string;
          result: { count: number; checks: Record<string, number> };
        }>(
          sql`
      select status, result from close_run_tasks where run_id=${runId} and key='drafts-cleared'`,
          "objects",
        )
      )[0]!;
      assert.equal(task.status, "ready", "the task must not be complete while drafts-open is red");
      assert.equal(task.result.count, 1);
      assert.equal(task.result.checks["drafts-open"], 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "material variances cannot cancel between entities with unlike functional currencies",
  { skip: !enabled },
  async () => {
    const { org, actor, other } = await setup();
    try {
      await journal(org, actor, org.subsidiaryId, "12000");
      await journal(org, actor, other, "-12000", "USD");
      const runId = await run(org, actor);
      assert.equal((await counts(org.orgId, runId))["material-variances"], 4);
      await db.execute(
        sql`update close_runs set scope=${JSON.stringify({ subsidiaryIds: [org.subsidiaryId] })}::jsonb where id=${runId}`,
      );
      assert.equal((await counts(org.orgId, runId))["material-variances"], 2);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "scoped bank readiness respects bank ownership and conservatively includes shared statements",
  { skip: !enabled },
  async () => {
    const { org, actor, other } = await setup();
    try {
      const bank = randomUUID(),
        statement = randomUUID();
      await db.execute(sql`insert into accounts (id,org_id,name,type,reconcilable,currency_restriction,subsidiary_id,subsidiary_include_children)
      values (${bank},${org.orgId},'Foreign bank','asset_bank',true,'USD',${other},false)`);
      await db.execute(sql`insert into bank_statements (id,org_id,account_id,source,statement_date,raw_file_ref)
      values (${statement},${org.orgId},${bank},'manual',${org.date},'test-evidence')`);
      await db.execute(sql`insert into bank_statement_lines (org_id,statement_id,account_id,line_number,posted_on,amount,currency)
      values (${org.orgId},${statement},${bank},1,${org.date},10,'USD')`);
      const runId = await run(org, actor, [org.subsidiaryId]);
      assert.equal((await counts(org.orgId, runId))["bank-unreconciled"] ?? 0, 0);
      await db.execute(
        sql`update close_runs set scope=${JSON.stringify({ subsidiaryIds: [other] })}::jsonb where id=${runId}`,
      );
      assert.equal((await counts(org.orgId, runId))["bank-unreconciled"], 1);
      await db.execute(sql`update accounts set subsidiary_id=null where id=${bank}`);
      await db.execute(
        sql`update close_runs set scope=${JSON.stringify({ subsidiaryIds: [org.subsidiaryId] })}::jsonb where id=${runId}`,
      );
      assert.equal(
        (await counts(org.orgId, runId))["bank-unreconciled"],
        1,
        "shared statement must not disappear through guessed ownership",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an existing group close cannot be resumed as an entity close or silently waive its tasks",
  { skip: !enabled },
  async () => {
    const { org, actor, other } = await setup();
    try {
      await db.execute(sql`update accounts set eliminate=true where id=${org.accounts.cogs}`);
      await journal(org, actor, org.subsidiaryId, "10");
      const runId = await run(org, actor);
      assert.equal((await counts(org.orgId, runId))["intercompany-residual"], 1);
      const before = await db.execute(
        sql`select * from close_run_tasks
      where org_id=${org.orgId} and run_id=${runId} and key in ('intercompany-balanced','consolidation') order by id`,
        "objects",
      );
      assert.equal(before.length, 2);
      await assert.rejects(run(org, actor, [other]), /different subsidiary scope/);
      assert.deepEqual(
        await db.execute(
          sql`select * from close_run_tasks
      where org_id=${org.orgId} and run_id=${runId} and key in ('intercompany-balanced','consolidation') order by id`,
          "objects",
        ),
        before,
      );
      assert.equal((await counts(org.orgId, runId))["intercompany-residual"], 1);
      assert.equal(
        (
          await db.execute(
            sql`select id from close_run_tasks
      where org_id=${org.orgId} and run_id=${runId} and status='waived'`,
            "objects",
          )
        ).length,
        0,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "new standard scoped run omits group tasks while custom configured group checks retain full population",
  { skip: !enabled },
  async () => {
    const { org, actor, other } = await setup();
    try {
      await db.execute(sql`update accounts set eliminate=true where id=${org.accounts.cogs}`);
      await journal(org, actor, org.subsidiaryId, "10");
      const runId = await run(org, actor, [other]);
      assert.equal(
        (
          await db.execute(
            sql`select id from close_run_tasks where run_id=${runId}
      and key in ('intercompany-balanced','consolidation')`,
            "objects",
          )
        ).length,
        0,
      );
      // A tenant-customized blueprint can deliberately retain a group assertion.
      await db.execute(
        sql`update close_blueprints set name='Explicit group contract' where id=(select blueprint_id from close_runs where id=${runId})`,
      );
      await db.execute(sql`insert into close_run_tasks
      (org_id,run_id,key,title,workstream,task_type,completion_mode,gate_type,status)
      values (${org.orgId},${runId},'intercompany-balanced','Group control','intercompany','check','computed','hard','ready')`);
      assert.equal((await counts(org.orgId, runId))["intercompany-residual"], 1);
      assert.notEqual(
        (
          await db.execute<{ status: string }>(
            sql`select status from close_run_tasks where run_id=${runId} and key='intercompany-balanced'`,
            "objects",
          )
        )[0]!.status,
        "waived",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "variance comparison uses the current period fiscal calendar",
  { skip: !enabled },
  async () => {
    const { org, actor } = await setup();
    try {
      const calendar = (
        await db.execute<{ id: string }>(
          sql`select fiscal_calendar_id as id from accounting_periods where id=${org.periodId}`,
          "objects",
        )
      )[0]!.id;
      const prior = randomUUID(),
        otherCalendar = randomUUID();
      await db.execute(sql`insert into accounting_periods (id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
      values (${prior},${org.orgId},${calendar},2026,6,'Prior fiscal period','2026-06-01','2026-06-28')`);
      await db.execute(
        sql`insert into fiscal_calendars (id,org_id,name) values (${otherCalendar},${org.orgId},'Other calendar')`,
      );
      await db.execute(sql`insert into accounting_periods (org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
      values (${org.orgId},${otherCalendar},2026,6,'Other calendar prior','2026-06-29','2026-06-30')`);
      await journal(
        { ...org, periodId: prior, date: "2026-06-15" },
        actor,
        org.subsidiaryId,
        "12000",
      );
      await journal(org, actor, org.subsidiaryId, "12000");
      const runId = await run(org, actor);
      assert.equal((await counts(org.orgId, runId))["material-variances"] ?? 0, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "scoped close evidence ignores unrelated entity posting and invalidates when its own entity changes",
  { skip: !enabled },
  async () => {
    const { org, actor, other } = await setup();
    try {
      const runId = await run(org, actor, [org.subsidiaryId]);
      const first = await refreshCloseRun(org.orgId, runId, actor);
      const taskId = randomUUID();
      await db.execute(sql`insert into close_run_tasks(id,org_id,run_id,key,title,workstream,task_type,completion_mode,gate_type,status,sort_order,evidence_required,created_by,updated_by)
      values(${taskId},${org.orgId},${runId},'scoped-ledger-review','Review scoped ledger','review','action','manual','hard','ready',1,false,${actor},${actor})`);
      await updateCloseTask({
        orgId: org.orgId,
        runId,
        taskId,
        actorId: actor,
        action: "complete",
      });
      await seedCloseRunApprovalFixture(org.orgId, runId, actor);
      await journal(org, actor, other, "15", "USD");
      const unrelated = await refreshCloseRun(org.orgId, runId, actor);
      assert.equal(unrelated.fingerprint, first.fingerprint);
      assert.equal(unrelated.invalidated, 0);
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from close_runs where id=${runId}`,
            "objects",
          )
        )[0]!.status,
        "approved",
      );
      await journal(org, actor, org.subsidiaryId, "15");
      const changed = await refreshCloseRun(org.orgId, runId, actor);
      assert.notEqual(changed.fingerprint, first.fingerprint);
      assert.ok(changed.invalidated > 0);
      assert.deepEqual(
        (
          await db.execute(
            sql`select status,approved_at,approved_by from close_runs where id=${runId}`,
            "objects",
          )
        )[0],
        { status: "in_progress", approved_at: null, approved_by: null },
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "close resumption preserves captured scope and blueprint and rejects explicit conflicting requests",
  { skip: !enabled },
  async () => {
    const { org, actor, other } = await setup();
    try {
      const runId = await run(org, actor, [org.subsidiaryId]);
      await seedCloseRunApprovalFixture(org.orgId, runId, actor);
      const before = (
        await db.execute(
          sql`select scope,blueprint_id,status,approved_at,approved_by from close_runs where id=${runId}`,
          "objects",
        )
      )[0];
      const tasks = await db.execute(
        sql`select id,owner_id,reviewer_id from close_run_tasks where run_id=${runId} order by id`,
        "objects",
      );
      assert.equal(await run(org, actor), runId, "omitted scope resumes the captured scope");
      for (const subsidiaryIds of [[other], [], null]) {
        await assert.rejects(
          startCloseRun({
            orgId: org.orgId,
            periodId: org.periodId,
            bookId: org.bookId,
            actorId: actor,
            subsidiaryIds,
          }),
          /different subsidiary scope/,
        );
      }
      const custom = randomUUID();
      await db.execute(
        sql`insert into close_blueprints (id,org_id,name,is_active) values (${custom},${org.orgId},'Different template',true)`,
      );
      await assert.rejects(
        startCloseRun({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          actorId: actor,
          blueprintId: custom,
        }),
        /different blueprint/,
      );
      assert.deepEqual(
        (
          await db.execute(
            sql`select scope,blueprint_id,status,approved_at,approved_by from close_runs where id=${runId}`,
            "objects",
          )
        )[0],
        before,
      );
      assert.deepEqual(
        await db.execute(
          sql`select id,owner_id,reviewer_id from close_run_tasks where run_id=${runId} order by id`,
          "objects",
        ),
        tasks,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

for (const changedScope of ["outside", "inside"] as const)
  test(
    `final close approval evaluates ${changedScope} entity activity against its actual Flow receipt`,
    { skip: !enabled },
    async () => {
      const { org, actor, other } = await setup();
      try {
        const blueprintId = randomUUID(),
          stepId = randomUUID();
        await db.execute(
          sql`insert into close_blueprints(id,org_id,name,is_active) values(${blueprintId},${org.orgId},'Scoped review',true)`,
        );
        await db.execute(sql`insert into close_blueprint_steps(id,org_id,blueprint_id,key,title,workstream,task_type,completion_mode,gate_type,sort_order)
    values(${stepId},${org.orgId},${blueprintId},'approve-scoped-close','Approve scoped close','review','approval','manual','hard',1)`);
        const approver = (await seedFlowActors(org.orgId)).approver1Id;
        await seedApprovalFlow(org.orgId, {
          subjectKind: "close_run",
          assignees: [{ type: "user", userId: approver }],
          mode: "all",
        });
        const runId = await startCloseRun({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          actorId: actor,
          blueprintId,
          subsidiaryIds: [org.subsidiaryId],
        });
        await requestCloseApproval(org.orgId, runId, actor);
        const gate = (
          await db.execute<{ id: string }>(
            sql`select id from flow_gates where org_id=${org.orgId} and subject_kind='close_run' and subject_id=${runId} and status='pending'`,
            "objects",
          )
        )[0]!;
        await journal(
          org,
          actor,
          changedScope === "outside" ? other : org.subsidiaryId,
          "15",
          changedScope === "outside" ? "USD" : "CAD",
        );
        if (changedScope === "outside") {
          await decideGate({ gateId: gate.id, userId: approver, decision: "approved" });
          assert.equal(
            (
              await db.execute<{ status: string }>(
                sql`select status from close_runs where org_id=${org.orgId} and id=${runId}`,
                "objects",
              )
            )[0]?.status,
            "approved",
          );
        } else {
          await assert.rejects(
            decideGate({ gateId: gate.id, userId: approver, decision: "approved" }),
            /ledger changed during approval/,
          );
          assert.equal(
            (
              await db.execute<{ status: string }>(
                sql`select status from flow_gates where org_id=${org.orgId} and id=${gate.id}`,
                "objects",
              )
            )[0]?.status,
            "pending",
          );
        }
      } finally {
        await dropScratchOrg(org.orgId);
      }
    },
  );

test(
  "a scoped approval fingerprints prior-period carrying activity without unrelated entities",
  { skip: !enabled },
  async () => {
    const { org, actor, other } = await setup();
    try {
      const calendar = (
        await db.execute<{ id: string }>(
          sql`select fiscal_calendar_id as id from accounting_periods where id=${org.periodId}`,
          "objects",
        )
      )[0]!.id;
      const prior = randomUUID();
      await db.execute(sql`insert into accounting_periods (id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
      values (${prior},${org.orgId},${calendar},2026,6,'Prior period','2026-06-01','2026-06-30')`);
      const runId = await run(org, actor, [org.subsidiaryId]);
      const first = await refreshCloseRun(org.orgId, runId, actor);
      await seedCloseRunApprovalFixture(org.orgId, runId, actor);
      await journal({ ...org, periodId: prior, date: "2026-06-15" }, actor, other, "10", "USD");
      assert.equal((await refreshCloseRun(org.orgId, runId, actor)).fingerprint, first.fingerprint);
      await journal({ ...org, periodId: prior, date: "2026-06-15" }, actor, org.subsidiaryId, "10");
      assert.notEqual(
        (await refreshCloseRun(org.orgId, runId, actor)).fingerprint,
        first.fingerprint,
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from close_runs where id=${runId}`,
            "objects",
          )
        )[0]!.status,
        "in_progress",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "fingerprint uses assigned regular and adjustment period ordering for same-end entries",
  { skip: !enabled },
  async () => {
    const { org, actor } = await setup();
    try {
      const calendar = (
        await db.execute<{ id: string }>(
          sql`select fiscal_calendar_id as id from accounting_periods where id=${org.periodId}`,
          "objects",
        )
      )[0]!.id;
      const adjustment = randomUUID(),
        later = randomUUID();
      await db.execute(sql`insert into accounting_periods (id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment)
      values (${adjustment},${org.orgId},${calendar},2026,13,'First adjustment','2026-07-31','2026-07-31',true),
        (${later},${org.orgId},${calendar},2026,14,'Later adjustment','2026-07-31','2026-07-31',true)`);
      const regularRun = await run(org, actor, [org.subsidiaryId]);
      const regularFingerprint = (await refreshCloseRun(org.orgId, regularRun, actor)).fingerprint;
      await journal(
        { ...org, periodId: adjustment, date: "2026-07-31" },
        actor,
        org.subsidiaryId,
        "10",
      );
      assert.equal(
        (await refreshCloseRun(org.orgId, regularRun, actor)).fingerprint,
        regularFingerprint,
        "regular period excludes same-end adjustment",
      );
      const adjustmentRun = await run({ ...org, periodId: adjustment }, actor, [org.subsidiaryId]);
      const before = (await refreshCloseRun(org.orgId, adjustmentRun, actor)).fingerprint;
      await journal({ ...org, periodId: later, date: "2026-07-31" }, actor, org.subsidiaryId, "10");
      assert.equal(
        (await refreshCloseRun(org.orgId, adjustmentRun, actor)).fingerprint,
        before,
        "earlier adjustment excludes later adjustment",
      );
      await journal(org, actor, org.subsidiaryId, "10");
      assert.notEqual(
        (await refreshCloseRun(org.orgId, adjustmentRun, actor)).fingerprint,
        before,
        "adjustment includes its preceding regular period",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

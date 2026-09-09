import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { revaluationReadiness, runRevaluation } from "./fx-revaluation.ts";
import { neg } from "./money.ts";
import { createPaymentDocument, postPaymentWithApplications, reversePaymentForReturn, updateDraftPayment } from "./payments.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await createScratchOrg();
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const nextPeriodId = randomUUID();
  await db.execute(sql`insert into accounting_periods
    (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    select ${nextPeriodId}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
    from accounting_periods where id=${org.periodId}`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',
    coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('fxUnrealizedGainLoss',${org.accounts.fxGainLoss}::text))
    where id=${org.orgId}`);
  await db.execute(sql`insert into fx_rates(org_id,from_currency,to_currency,as_of,rate_type,rate)
    values(${org.orgId},'USD','CAD','2026-07-31','spot',1.37)`);
  const seed = async (base: string, foreign: string, periodId = org.periodId, currency = "USD", reversesEntryId: string | null = null) => {
    const id = randomUUID();
    await db.execute(sql`insert into journal_entries
      (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,reverses_entry_id,created_by,updated_by)
      values(${id},${org.orgId},${org.bookId},${org.subsidiaryId},${`FX-CORRECTION-${id}`},'2026-07-31',
        ${periodId},'draft','manual',${reversesEntryId},${actorId},${actorId})`);
    await db.execute(sql`insert into journal_lines
      (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,is_open_item)
      values(${org.orgId},${id},1,${org.accounts.ar},${org.subsidiaryId},${base},${currency},${foreign},
        ${base}::numeric/${foreign}::numeric,false),
        (${org.orgId},${id},2,${org.accounts.clearing},${org.subsidiaryId},${neg(base)},'CAD',${neg(base)},1,false)`);
    await db.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${actorId}
      where org_id=${org.orgId} and id=${id}`);
    return id;
  };
  const adjustment = async (number = 13) => {
    const id = randomUUID();
    await db.execute(sql`insert into accounting_periods
      (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
      select ${id},${org.orgId},2026,${number},${`2026-adjustment-${number}`},'2026-07-01','2026-07-31',true,fiscal_calendar_id
      from accounting_periods where id=${org.periodId}`);
    return id;
  };
  const run = (periodId = org.periodId) => runRevaluation(org.orgId, periodId, actorId, [org.subsidiaryId]);
  const readiness = (periodId = org.periodId) => revaluationReadiness(org.orgId, org.bookId, periodId);
  const total = async (periodId = org.periodId) => (await db.execute<{ amount: string }>(sql`
    select coalesce(sum(l.amount),0)::text as amount from journal_lines l join journal_entries e on e.id=l.entry_id
    where e.org_id=${org.orgId} and e.period_id=${periodId} and e.origin='fx_revaluation'
      and e.status in ('posted','reversed') and l.account_id=${org.accounts.ar}`)).rows[0]!.amount;
  return { ...org, actorId, nextPeriodId, seed, adjustment, run, readiness, total };
}

async function nativeInvoice(f: Awaited<ReturnType<typeof fixture>>, currency: "USD" | "EUR") {
  const invoiceId = randomUUID();
  const rate = currency === "EUR" ? "1.2" : "1.36";
  await db.execute(sql`insert into documents
    (id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by)
    values(${invoiceId},${f.orgId},'customer_invoice','draft','INV-FX-CORRECT',${f.subsidiaryId},${f.customerId},
      ${f.date},${currency},${rate},100,0,100,${f.actorId})`);
  await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
    values(${f.orgId},${invoiceId},1,${f.accounts.revenue},1,100,100,0,0)`);
  await db.execute(sql`update documents set status='approved' where org_id=${f.orgId} and id=${invoiceId}`);
  const invoiceEntryId = await postDocument(invoiceId, { control: { ar: f.accounts.ar, ap: f.accounts.ap, bank: f.accounts.bank } });
  const target = (await db.execute<{ id: string }>(sql`select id from journal_lines
    where entry_id=${invoiceEntryId} and account_id=${f.accounts.ar}`)).rows[0]!;
  if (currency === "EUR") await db.execute(sql`insert into fx_rates(org_id,from_currency,to_currency,as_of,rate_type,rate)
    values(${f.orgId},'EUR','CAD','2026-07-31','spot',1.5)`);
  return async (partial = false, date = f.date, periodId = f.periodId) => {
    const payment = await createPaymentDocument({ orgId: f.orgId, kind: "customer_payment", createdBy: f.actorId,
      partyId: f.customerId, bankAccountId: f.accounts.bank, subsidiaryId: f.subsidiaryId,
      documentDate: date, currency: "USD", fxRate: currency === "EUR" ? "1.625" : "1.35" });
    await updateDraftPayment(payment.id, { allocations: [{ openLineId: target.id,
      sourceTransactionAmount: currency === "EUR" ? (partial ? "40" : "80") : (partial ? "50" : "100"),
      targetTransactionAmount: partial ? "50" : "100", settlementRate: currency === "EUR" ? "1.25" : "1",
      settlementRateSource: currency === "EUR" ? "manual" : "same_currency",
      settlementRateReference: "FX-CORRECTION-TEST" }], bankAccountId: f.accounts.bank }, f.actorId, f.orgId);
    await db.execute(sql`update documents set status='approved',submitted_by=${f.actorId},submitted_at=now(),posting_period_id=${periodId}
      where org_id=${f.orgId} and id=${payment.id}`);
    await postPaymentWithApplications(payment.id, undefined, f.actorId);
    return payment.id;
  };
}

for (const currency of ["USD", "EUR"] as const) {
  test(`FX leaves a fully settled native ${currency} invoice at zero after realized FX`, { skip: !DB }, async () => {
    const f = await fixture();
    try {
      await (await nativeInvoice(f, currency))();
      const before = (await db.execute<{ amount: string }>(sql`select sum(l.amount)::text as amount
        from journal_lines l join journal_entries e on e.id=l.entry_id
        where l.org_id=${f.orgId} and l.account_id=${f.accounts.ar} and e.status='posted'`)).rows[0]!;
      assert.equal(before.amount, "0.0000");
      const result = await f.run();
      assert.deepEqual(result.problems, []);
      assert.equal(await f.total(), "0", "revaluation must leave the settled receivable at zero");
    } finally { await dropScratchOrg(f.orgId); }
  });
}

test("FX partial cross-currency payments and native returns change only remaining foreign receivables", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const pay = await nativeInvoice(f, "EUR");
    await f.run();
    assert.equal(await f.total(), "30.0000");
    await pay(true);
    await f.run();
    assert.equal(await f.total(), "15.0000", "half the EUR receivable remains");
    const second = await pay(true);
    await f.run();
    assert.equal(await f.total(), "0.0000");
    await reversePaymentForReturn(second, f.orgId, "Returned settlement", f.actorId, f.date);
    await f.run();
    assert.equal(await f.total(), "15.0000", "a same-period return restores only its target exposure");
    assert.equal((await f.readiness()).unrevaluedPositions, 0);
  } finally { await dropScratchOrg(f.orgId); }
});

test("FX historical exposure ignores future payments and their later unapplication state", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const pay = await nativeInvoice(f, "EUR");
    await db.execute(sql`insert into accounting_periods
      (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
      select ${randomUUID()},${f.orgId},2026,9,'2026-09','2026-09-01','2026-09-30',false,fiscal_calendar_id
      from accounting_periods where id=${f.periodId}`);
    const payment = await pay(false, "2026-08-05", f.nextPeriodId);
    await f.run();
    assert.equal(await f.total(), "30.0000", "August payment cannot remove July's exposure");
    await f.run(f.nextPeriodId);
    assert.equal((await f.readiness(f.nextPeriodId)).unrevaluedPositions, 0);
    await reversePaymentForReturn(payment, f.orgId, "September return", f.actorId, "2026-09-05");
    assert.equal((await f.readiness(f.nextPeriodId)).unrevaluedPositions, 0,
      "September's return cannot reinterpret August's settled exposure");
    assert.equal((await f.readiness()).unrevaluedPositions, 0);
  } finally { await dropScratchOrg(f.orgId); }
});

test("FX ignores same-date adjustment-period payments until that assigned period closes", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const pay = await nativeInvoice(f, "EUR");
    const adjustment = await f.adjustment();
    await pay(false, "2026-07-31", adjustment);
    await f.run();
    assert.equal(await f.total(), "30.0000");
    await f.run(adjustment);
    assert.equal(await f.total(adjustment), "-30.0000", "settlement removes the earlier regular-period FX");
    assert.equal((await f.readiness(adjustment)).unrevaluedPositions, 0);
  } finally { await dropScratchOrg(f.orgId); }
});

test("FX reruns correct changed source balances and rates without rewriting prior journals", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    await f.seed("136", "100");
    const first = await f.run();
    assert.deepEqual(first.problems, []);
    assert.equal(first.posted[0]?.netDelta, "1.0000");
    await f.seed("136", "100");
    assert.equal((await f.readiness()).unrevaluedPositions, 1, "new exposure makes readiness stale");
    const second = await f.run();
    assert.equal(second.posted[0]?.netDelta, "1.0000", "post only the new exposure's difference");
    await db.execute(sql`update fx_rates set rate=1.38 where org_id=${f.orgId} and from_currency='USD'`);
    assert.equal((await f.readiness()).unrevaluedPositions, 1, "changed spot requires correction");
    assert.equal((await f.run()).posted[0]?.netDelta, "2.0000");
    assert.equal(await f.total(), "4.0000");
    assert.equal((await f.run()).posted.length, 0);
    assert.equal((await f.readiness()).unrevaluedPositions, 0);
    const originals = (await db.execute<{ amount: string }>(sql`select l.amount::text as amount from journal_lines l
      where l.entry_id=${first.posted[0]!.entryId} and l.account_id=${f.accounts.ar}`)).rows;
    assert.equal(originals[0]?.amount, "1.0000", "the first posted generation is immutable");
    assert.equal(await f.total(f.nextPeriodId), "-4.0000", "every correction has its own next-period mirror");
    const evidence = (await db.execute<{ actor_id: string; changes: { positions: unknown[]; effectiveAdjustments: unknown[]; reversalEntryId: string } }>(sql`
      select actor_id,changes from audit_log where org_id=${f.orgId} and row_id=${second.posted[0]!.entryId}
      and request_id='fx_revaluation'`)).rows[0]!;
    assert.equal(evidence.actor_id, f.actorId);
    assert.equal(evidence.changes.positions.length, 1);
    assert.equal(evidence.changes.effectiveAdjustments.length, 1);
    assert.equal(evidence.changes.reversalEntryId, second.posted[0]!.reversalEntryId);
  } finally { await dropScratchOrg(f.orgId); }
});

test("FX adjustment with no new source is already satisfied; next regular close remeasures after mirrors", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const adjustment = await f.adjustment();
    await f.seed("136", "100");
    await f.run();
    assert.equal((await f.readiness(adjustment)).unrevaluedPositions, 0);
    assert.equal((await f.run(adjustment)).posted.length, 0);
    await db.execute(sql`insert into accounting_periods
      (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
      select ${randomUUID()},${f.orgId},2026,9,'2026-09','2026-09-01','2026-09-30',false,fiscal_calendar_id
      from accounting_periods where id=${f.periodId}`);
    assert.equal((await f.run(f.nextPeriodId)).posted[0]?.netDelta, "1.0000");
    assert.equal(await f.total(f.nextPeriodId), "0.0000", "August includes July mirror plus its own remeasurement");
  } finally { await dropScratchOrg(f.orgId); }
});

for (const matchingCalendarPeriod of [true, false]) {
  test(`FX reversal uses its assigned calendar when matching next period is ${matchingCalendarPeriod ? "available" : "missing"}`, { skip: !DB }, async () => {
    const f = await fixture();
    try {
      await f.seed("136", "100");
      await db.execute(sql`delete from accounting_periods where org_id=${f.orgId} and id=${f.nextPeriodId}`);
      const otherCalendarId = randomUUID();
      await db.execute(sql`insert into fiscal_calendars(id,org_id,name)
        values(${otherCalendarId},${f.orgId},'Independent reporting calendar')`);
      await db.execute(sql`insert into accounting_periods
        (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        values(${randomUUID()},${f.orgId},2026,8,'Other August','2026-08-01','2026-08-31',false,${otherCalendarId})`);
      const next = randomUUID();
      if (matchingCalendarPeriod) await db.execute(sql`insert into accounting_periods
        (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        select ${next},${f.orgId},2026,9,'Own September','2026-09-01','2026-09-30',false,fiscal_calendar_id
        from accounting_periods where id=${f.periodId}`);
      const readiness = await f.readiness();
      assert.equal(readiness.reversalPeriodMissing, !matchingCalendarPeriod);
      const result = await f.run();
      if (matchingCalendarPeriod) {
        assert.deepEqual(result.problems, []);
        const reversal = (await db.execute<{ period_id: string }>(sql`select period_id from journal_entries
          where org_id=${f.orgId} and id=${result.posted[0]!.reversalEntryId}`)).rows[0]!;
        assert.equal(reversal.period_id, next, "an earlier period in an unrelated calendar is not a reversal destination");
      } else {
        assert.equal(result.posted.length, 0);
        assert.equal(result.problems.length, 1);
        assert.equal(await f.total(), "0");
      }
    } finally { await dropScratchOrg(f.orgId); }
  });
}

test("FX corrects reversed source history and zero-foreign residual carrying without a quote", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const source = await f.seed("136", "100");
    await f.run();
    await f.seed("-136", "-100", f.periodId, "USD", source);
    await db.execute(sql`update journal_entries set status='reversed' where org_id=${f.orgId} and id=${source}`);
    assert.equal((await f.run()).posted[0]?.netDelta, "-1.0000", "reversed original and mirror net to zero");
    await f.seed("136", "100");
    await f.seed("-135", "-100");
    await db.execute(sql`delete from fx_rates where org_id=${f.orgId}`);
    const readiness = await f.readiness();
    assert.equal(readiness.positionsMissingSpotRate, 0);
    assert.equal(readiness.unrevaluedPositions, 1, "zero foreign position cannot retain base carrying");
    const result = await runRevaluation(f.orgId, f.periodId, null, [f.subsidiaryId]);
    assert.deepEqual(result.problems, []);
    assert.equal(result.posted[0]?.netDelta, "-1.0000");
    assert.equal((await f.readiness()).unrevaluedPositions, 0);
  } finally { await dropScratchOrg(f.orgId); }
});

for (const policy of ["missing rate", "missing reversal period", "closed period", "closed reversal period"] as const) {
  test(`FX correction refuses ${policy} without leaving half a pair`, { skip: !DB }, async () => {
    const f = await fixture();
    try {
      await f.seed("136", "100");
      if (policy !== "missing reversal period") {
        assert.equal((await f.run()).posted.length, 1);
        await f.seed("136", "100");
      }
      const before = await f.total();
      if (policy === "missing rate") await db.execute(sql`delete from fx_rates where org_id=${f.orgId}`);
      if (policy === "missing reversal period") await db.execute(sql`delete from accounting_periods where org_id=${f.orgId} and id=${f.nextPeriodId}`);
      const closedPeriodId = policy === "closed reversal period" ? f.nextPeriodId : f.periodId;
      if (policy.startsWith("closed")) await db.execute(sql`insert into period_locks
        (org_id,period_id,book_id,subsidiary_id,module,state,reason,locked_at,locked_by)
        values(${f.orgId},${closedPeriodId},${f.bookId},${f.subsidiaryId},'gl','closed','FX correction test',now(),${f.actorId})`);
      const result = await f.run();
      assert.equal(result.posted.length, 0);
      assert.equal(result.problems.length, 1);
      assert.equal(await f.total(), before, "refusal preserves all previously posted generations");
      const readiness = await f.readiness();
      assert.equal(readiness.unrevaluedPositions, 1);
      assert.equal(readiness.positionsMissingSpotRate, policy === "missing rate" ? 1 : 0);
      assert.equal(readiness.reversalPeriodMissing, policy === "missing reversal period");
      if (policy.startsWith("closed")) {
        await db.execute(sql`update period_locks set state='open',reason='Authorized fixture reopen'
          where org_id=${f.orgId} and period_id=${closedPeriodId}`);
        assert.equal((await f.run()).posted[0]?.netDelta, "1.0000", "reopened period can correct prior generation");
      }
    } finally { await dropScratchOrg(f.orgId); }
  });
}

test("FX reads its basis after waiting for the ordinary posting organization lock", { skip: !DB }, async () => {
  const f = await fixture();
  let release!: () => void;
  let locked!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<void>((resolve) => { locked = resolve; });
  let writer: Promise<void> | undefined;
  try {
    await f.seed("136", "100");
    await f.run();
    writer = withOrgTransaction(f.orgId, async () => {
      await db.execute(sql`select id from orgs where id=${f.orgId} for update`);
      await f.seed("136", "100");
      locked();
      await held;
    });
    await acquired;
    const correction = f.run();
    let observedWait = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      observedWait = (await db.execute<{ waiting: boolean }>(sql`select exists (
        select 1 from pg_stat_activity where datname=current_database()
          and wait_event_type='Lock' and query like '%from orgs%for update%'
      ) as waiting`)).rows[0]!.waiting;
      if (observedWait) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await writer;
    const result = await correction;
    assert.equal(observedWait, true, "the rerun must actually wait behind the ordinary writer");
    assert.deepEqual(result.problems, []);
    assert.equal(result.posted[0]?.netDelta, "1.0000");
    assert.equal(await f.total(), "2.0000");
  } finally {
    release();
    await writer;
    await dropScratchOrg(f.orgId);
  }
});

test("FX full and partial settlement remove stale adjustments even after foreign exposure disappears", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    await f.seed("136", "100");
    await f.run();
    await f.seed("-68", "-50");
    assert.equal((await f.run()).posted[0]?.netDelta, "-0.5000");
    await f.seed("-68", "-50");
    assert.equal((await f.readiness()).unrevaluedPositions, 1);
    assert.equal((await f.run()).posted[0]?.netDelta, "-0.5000");
    assert.equal(await f.total(), "0.0000");
    assert.equal(await f.total(f.nextPeriodId), "0.0000");
    assert.equal((await f.readiness()).unrevaluedPositions, 0);
  } finally { await dropScratchOrg(f.orgId); }
});

test("FX regular and same-end adjustment closes share exact period identity and effective adjustments", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const adjustment = await f.adjustment();
    const later = await f.adjustment(14);
    await f.seed("136", "100");
    await f.seed("272", "200", adjustment);
    await f.seed("544", "400", later);
    assert.equal((await f.run()).posted[0]?.netDelta, "1.0000", "regular excludes same-date adjustment sources");
    assert.equal((await f.run(adjustment)).posted[0]?.netDelta, "2.0000", "adjustment subtracts still-effective regular FX");
    assert.equal((await f.readiness(adjustment)).unrevaluedPositions, 0);
    assert.equal((await f.run(later)).posted[0]?.netDelta, "4.0000", "later adjustment subtracts both prior generations");
    assert.equal((await f.run(adjustment)).posted.length, 0, "later same-date period stays outside earlier scope");
  } finally { await dropScratchOrg(f.orgId); }
});

test("FX offsets currencies within one monetary account and ignores zero foreign balances without needing rates", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    await db.execute(sql`insert into fx_rates(org_id,from_currency,to_currency,as_of,rate_type,rate)
      values(${f.orgId},'EUR','CAD','2026-07-31','spot',1.5)`);
    await f.seed("136", "100");
    await f.seed("151", "100", f.periodId, "EUR");
    assert.equal((await f.readiness()).unrevaluedPositions, 0, "opposite changes in the same account already net to zero");
    assert.equal((await f.run()).posted.length, 0);
    await f.seed("-151", "-100", f.periodId, "EUR");
    assert.equal((await f.run()).posted[0]?.netDelta, "1.0000");
    await f.seed("-136", "-100");
    await db.execute(sql`delete from fx_rates where org_id=${f.orgId}`);
    const cleanup = await f.run();
    assert.deepEqual(cleanup.problems, []);
    assert.equal(cleanup.posted[0]?.netDelta, "-1.0000", "expired exposure needs no rate to clear existing FX");
  } finally { await dropScratchOrg(f.orgId); }
});

test("FX concurrent changed-basis reruns post exactly one correction pair", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    await f.seed("136", "100");
    await f.run();
    await f.seed("136", "100");
    const runs = await Promise.all([f.run(), f.run()]);
    assert.deepEqual(runs.flatMap((run) => run.problems), []);
    assert.equal(runs.flatMap((run) => run.posted).length, 1);
    assert.equal(await f.total(), "2.0000");
    assert.equal(await f.total(f.nextPeriodId), "-2.0000");
  } finally { await dropScratchOrg(f.orgId); }
});

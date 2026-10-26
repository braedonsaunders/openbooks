import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { guardRefusalMessage } from "../platform/database-refusal.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  grantScratchPermissions,
  seedFlowActors,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import {
  ClosingFxEvidenceError,
  ClosingFxEvidenceFeatureDisabledError,
  recordClosingFxRateEvidence,
} from "./fx-revaluation-evidence.ts";
import {
  listRevaluationExposures,
  revaluationReadiness,
  runRevaluation,
} from "./fx-revaluation.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await createScratchOrg();
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await grantScratchPermissions(org.orgId, actorId, ["close.run"]);
  const nextPeriodId = randomUUID();
  await db.execute(sql`insert into accounting_periods
    (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    select ${nextPeriodId}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
    from accounting_periods where id=${org.periodId}`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',
    coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('fxUnrealizedGainLoss',${org.accounts.fxGainLoss}::text))
    where id=${org.orgId}`);
  const seed = async (args: {
    accountId: string;
    currency: string;
    base: string;
    foreign: string;
    bookId?: string;
    subsidiaryId?: string;
    periodId?: string;
    clearingCurrency?: string;
  }) => {
    const id = randomUUID();
    const bookId = args.bookId ?? org.bookId;
    const subsidiaryId = args.subsidiaryId ?? org.subsidiaryId;
    await db.execute(sql`insert into journal_entries
      (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,created_by,updated_by)
      values(${id},${org.orgId},${bookId},${subsidiaryId},${`FX-EVIDENCE-${id}`},'2026-07-10',
        ${args.periodId ?? org.periodId},'draft','manual',${actorId},${actorId})`);
    await db.execute(sql`insert into journal_lines
      (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,is_open_item)
      values(${org.orgId},${id},1,${args.accountId},${subsidiaryId},${args.base},${args.currency},${args.foreign},
        ${args.base}::numeric/${args.foreign}::numeric,false),
        (${org.orgId},${id},2,${org.accounts.clearing},${subsidiaryId},${args.base.startsWith("-") ? args.base.slice(1) : `-${args.base}`},${args.clearingCurrency ?? "CAD"},${args.base.startsWith("-") ? args.base.slice(1) : `-${args.base}`},1,false)`);
    await db.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${actorId}
      where org_id=${org.orgId} and id=${id}`);
    return id;
  };
  const record = (overrides: Record<string, unknown> = {}, actor = actorId) =>
    recordClosingFxRateEvidence({
      orgId: org.orgId,
      actorId: actor,
      input: {
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        periodId: org.periodId,
        accountId: org.accounts.bank,
        transactionCurrency: "EUR",
        measurementCurrency: "CAD",
        rate: "1.1200000000",
        source: "European Central Bank reference rate",
        reason: "Period-end bulletin rate for the July close",
        expectedCurrentId: null,
        requestId: randomUUID(),
        ...overrides,
      },
    });
  const run = (bookId = org.bookId, subsidiaryId = org.subsidiaryId) =>
    runRevaluation(org.orgId, org.periodId, actorId, [subsidiaryId], bookId);
  const bankTotal = async (periodId = org.periodId, bookId = org.bookId) =>
    (
      await db.execute<{ amount: string }>(
        sql`
    select coalesce(sum(l.amount),0)::text as amount from journal_lines l join journal_entries e on e.id=l.entry_id
    where e.org_id=${org.orgId} and e.period_id=${periodId} and e.book_id=${bookId} and e.origin='fx_revaluation'
      and e.status in ('posted','reversed') and l.account_id=${org.accounts.bank}`,
        "objects",
      )
    )[0]!.amount;
  return { ...org, actorId, nextPeriodId, seed, record, run, bankTotal };
}

test(
  "a recorded closing rate prices its exact position through close, mirror and successor correction",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      // EUR 1,000 of foreign cash carried at 1.10 (1,100 CAD). No organization
      // exchange rate exists: before recording, readiness can only report the
      // position as missing its period-end rate.
      await f.seed({ accountId: f.accounts.bank, currency: "EUR", base: "1100", foreign: "1000" });
      const before = await revaluationReadiness(f.orgId, f.bookId, f.periodId, [f.subsidiaryId]);
      assert.equal(before.positionsMissingSpotRate, 1);
      assert.equal(before.unrevaluedPositions, 1);

      const exposures = await listRevaluationExposures(f.orgId, f.bookId, f.periodId, [
        f.subsidiaryId,
      ]);
      assert.equal(exposures.length, 1);
      assert.equal(exposures[0]!.rateEvidence, null);
      assert.equal(exposures[0]!.rateDate, "2026-07-31");

      const recorded = await f.record();
      assert.equal(recorded.replayed, false);
      assert.equal(recorded.evidence.version, 1);
      assert.equal(recorded.evidence.rateDate, "2026-07-31");
      assert.equal(
        (await db.execute(sql`select id from fx_rates where org_id=${f.orgId}`, "objects")).length,
        0,
        "recording a scoped closing rate never inserts an organization exchange rate",
      );

      const ready = await revaluationReadiness(f.orgId, f.bookId, f.periodId, [f.subsidiaryId]);
      assert.equal(ready.positionsMissingSpotRate, 0);
      assert.equal(ready.unrevaluedPositions, 1);

      // July close at 1.12 restates the position by +20; the August mirror
      // reverses exactly that, and an unchanged rerun posts nothing.
      const first = await f.run();
      assert.deepEqual(first.problems, []);
      assert.equal(first.posted[0]?.netDelta, "20.0000");
      assert.equal(await f.bankTotal(), "20.0000");
      assert.equal(await f.bankTotal(f.nextPeriodId), "-20.0000");
      assert.deepEqual((await f.run()).posted, [], "an unchanged rerun posts nothing");

      // The posted audit snapshot retains the full selected quote.
      const audit = (
        await db.execute<{
          changes: { positions: Array<{ rateEvidence: Record<string, unknown> }> };
        }>(
          sql`
      select changes from audit_log where org_id=${f.orgId} and row_id=${first.posted[0]!.entryId}
        and request_id='fx_revaluation'`,
          "objects",
        )
      )[0]!;
      assert.equal(audit.changes.positions[0]!.rateEvidence.id, recorded.evidence.id);
      assert.equal(audit.changes.positions[0]!.rateEvidence.version, 1);
      assert.equal(audit.changes.positions[0]!.rateEvidence.rate, "1.1200000000");
      assert.equal(
        audit.changes.positions[0]!.rateEvidence.source,
        "European Central Bank reference rate",
      );
      assert.equal(
        audit.changes.positions[0]!.rateEvidence.reason,
        "Period-end bulletin rate for the July close",
      );
      assert.equal(audit.changes.positions[0]!.rateEvidence.measurementCurrency, "CAD");

      // A governed successor at 1.13 corrects the close by +10 on rerun; the
      // original quote and the original journals remain immutable.
      const successor = await f.record({
        rate: "1.1300000000",
        reason: "Corrected bulletin rate for the July close",
        expectedCurrentId: recorded.evidence.id,
      });
      assert.equal(successor.evidence.version, 2);
      assert.equal(successor.evidence.supersedesId, recorded.evidence.id);
      const correction = await f.run();
      assert.equal(correction.posted[0]?.netDelta, "10.0000");
      assert.equal(await f.bankTotal(), "30.0000");
      const original = (
        await db.execute<{ rate: string; version: number }>(
          sql`
      select rate::text as rate, version from fx_revaluation_rate_evidence
       where org_id=${f.orgId} and id=${recorded.evidence.id}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(
        original,
        { rate: "1.1200000000", version: 1 },
        "the original quote is never rewritten",
      );
      const evidenceAudit = (
        await db.execute<{ beforeRate: string; afterRate: string }>(
          sql`
      select changes#>>'{before,rate}' as "beforeRate", changes#>>'{after,rate}' as "afterRate"
      from audit_log where org_id=${f.orgId}
        and table_name='fx_revaluation_rate_evidence' and row_id=${successor.evidence.id}`,
          "objects",
        )
      )[0]!;
      assert.equal(evidenceAudit.beforeRate, "1.1200000000");
      assert.equal(evidenceAudit.afterRate, "1.1300000000");
      assert.equal(
        (await revaluationReadiness(f.orgId, f.bookId, f.periodId, [f.subsidiaryId]))
          .unrevaluedPositions,
        0,
      );
    } finally {
      await dropScratchOrg(f.orgId);
    }
  },
);

test(
  "a foreign payable revalues as a liability through its recorded closing rate",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      // CAD 1,000 owed, carried at 0.74 in the entity's USD measurement
      // currency (740). The period-end rate 0.75 grows the liability by 10.
      const usdSubsidiaryId = randomUUID();
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usdSubsidiaryId}, ${f.orgId}, ${f.subsidiaryId}, 'Northern Branch', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await f.seed({
        accountId: f.accounts.ap,
        currency: "CAD",
        base: "-740",
        foreign: "-1000",
        subsidiaryId: usdSubsidiaryId,
      });
      await f.record({
        subsidiaryId: usdSubsidiaryId,
        accountId: f.accounts.ap,
        transactionCurrency: "CAD",
        measurementCurrency: "USD",
        rate: "0.7500000000",
        reason: "Period-end bulletin rate for the July payable",
      });
      const run = await runRevaluation(f.orgId, f.periodId, f.actorId, [usdSubsidiaryId], f.bookId);
      assert.deepEqual(run.problems, []);
      assert.equal(
        run.posted[0]?.netDelta,
        "-10.0000",
        "the payable is credited 10 as the liability grows",
      );
      const mirror = (
        await db.execute<{ amount: string }>(
          sql`
      select coalesce(sum(l.amount),0)::text as amount from journal_lines l join journal_entries e on e.id=l.entry_id
      where e.org_id=${f.orgId} and e.period_id=${f.nextPeriodId} and e.origin='fx_revaluation'
        and l.account_id=${f.accounts.ap}`,
          "objects",
        )
      )[0]!.amount;
      assert.equal(mirror, "10.0000", "the next-period mirror debits the payable back");
    } finally {
      await dropScratchOrg(f.orgId);
    }
  },
);

test(
  "recordings refuse wrong scope, stale measurement and missing authority without writing",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await f.seed({ accountId: f.accounts.bank, currency: "EUR", base: "1100", foreign: "1000" });
      const count = async () =>
        (
          await db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from fx_revaluation_rate_evidence where org_id=${f.orgId}`,
            "objects",
          )
        )[0]!.n;
      await assert.rejects(
        f.record({ rateDate: "2026-07-30" }),
        /final day of its assigned period/,
      );
      await assert.rejects(
        f.record({ measurementCurrency: "USD" }),
        /measures the legal entity in CAD/,
      );
      await assert.rejects(
        f.record({ transactionCurrency: "CAD", measurementCurrency: "CAD" }),
        /no exchange rate to record/,
      );
      await assert.rejects(
        f.record({ transactionCurrency: "ZZZ" }),
        /registered transaction and measurement currencies/,
      );
      await assert.rejects(f.record({ accountId: f.accounts.revenue }), /active monetary account/);
      await assert.rejects(f.record({ accountId: randomUUID() }), /active monetary account/);
      await assert.rejects(f.record({ periodId: randomUUID() }), /assigned accounting period/);
      await assert.rejects(f.record({ bookId: randomUUID() }), /active posting book/);
      await assert.rejects(f.record({ subsidiaryId: randomUUID() }), ClosingFxEvidenceError);
      const outsiderId = (await seedFlowActors(f.orgId)).outsiderId;
      await assert.rejects(f.record({}, outsiderId), ScopeNotFoundError);
      assert.equal(await count(), 0, "every refusal writes nothing");

      // The book now measures the entity in USD: the CAD quote is stale, the
      // position refuses rather than falling back to organization rates, and
      // a successor in the current measurement corrects it.
      const measurementBookId = randomUUID();
      await db.execute(sql`insert into accounting_books (id,org_id,code,name,is_primary,is_active,posts_gl)
      values(${measurementBookId},${f.orgId},'MEASUREMENT','Measurement book',false,true,true)`);
      const recorded = await f.record({ bookId: measurementBookId });
      await db.execute(sql`insert into accounting_book_currencies
      (org_id, book_id, subsidiary_id, currency, rate_type, effective_from, reason, created_by, updated_by)
      values (${f.orgId}, ${measurementBookId}, ${f.subsidiaryId}, 'USD', 'spot', '2026-07-01', 'Book measurement changed for the close', ${f.actorId}, ${f.actorId})`);
      await f.seed({
        accountId: f.accounts.bank,
        currency: "EUR",
        base: "1100",
        foreign: "1000",
        bookId: measurementBookId,
        clearingCurrency: "USD",
      });
      const stale = await listRevaluationExposures(f.orgId, measurementBookId, f.periodId, [
        f.subsidiaryId,
      ]);
      assert.match(stale[0]!.rateRefusal ?? "", /record a successor closing rate/);
      assert.equal(stale[0]!.periodEndRate, null);
      assert.equal(
        (await f.run(measurementBookId)).problems.length,
        1,
        "a stale quote refuses the run instead of repricing globally",
      );
      const corrected = await f.record({
        bookId: measurementBookId,
        measurementCurrency: "USD",
        rate: "1.1300000000",
        expectedCurrentId: recorded.evidence.id,
        reason: "Successor rate in the book's current measurement currency",
      });
      assert.equal(corrected.evidence.measurementCurrency, "USD");
    } finally {
      await dropScratchOrg(f.orgId);
    }
  },
);

test(
  "feature, closed-period and reversal-period boundaries keep recordings non-posting",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await f.seed({ accountId: f.accounts.bank, currency: "EUR", base: "1100", foreign: "1000" });
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":false}'::jsonb) where id=${f.orgId}`);
      await assert.rejects(f.record(), ClosingFxEvidenceFeatureDisabledError);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${f.orgId}`);

      // Recording into a closed period prepares a correction only: it posts
      // no entry, does not reopen the period, and the run still refuses.
      await db.execute(sql`insert into period_locks
      (org_id,period_id,book_id,subsidiary_id,module,state,reason,locked_at,locked_by)
      values(${f.orgId},${f.periodId},${f.bookId},${f.subsidiaryId},'gl','closed','July close locked',now(),${f.actorId})`);
      const recorded = await f.record();
      assert.equal(recorded.evidence.version, 1);
      assert.equal(
        (
          await db.execute(
            sql`select id from journal_entries where org_id=${f.orgId} and origin='fx_revaluation'`,
            "objects",
          )
        ).length,
        0,
        "recording into a closed period posts nothing",
      );
      const refused = await f.run();
      assert.equal(refused.posted.length, 0);
      assert.equal(refused.problems.length, 1);

      // With the period open but no following period, the mandatory mirror
      // still refuses the run and leaves the recorded quote untouched.
      await db.execute(
        sql`update period_locks set state='open' where org_id=${f.orgId} and period_id=${f.periodId}`,
      );
      await db.execute(
        sql`delete from accounting_periods where org_id=${f.orgId} and id=${f.nextPeriodId}`,
      );
      const noMirror = await f.run();
      assert.equal(noMirror.posted.length, 0);
      assert.match(noMirror.problems[0]!, /no following accounting period/);
    } finally {
      await dropScratchOrg(f.orgId);
    }
  },
);

test(
  "replay, expected-head and fork controls admit exactly one current version",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await f.seed({ accountId: f.accounts.bank, currency: "EUR", base: "1100", foreign: "1000" });
      const requestId = randomUUID();
      const first = await f.record({ requestId });
      const replay = await f.record({ requestId });
      assert.equal(replay.replayed, true);
      assert.equal(replay.evidence.id, first.evidence.id);
      await assert.rejects(
        f.record({ requestId, rate: "1.2000000000" }),
        /already recorded a different closing rate/,
      );
      await assert.rejects(f.record(), /already has a recorded closing rate/);

      // Two concurrent successors against the same head: exactly one appends.
      const attempts = await Promise.allSettled([
        f.record({
          rate: "1.1300000000",
          expectedCurrentId: first.evidence.id,
          reason: "First concurrent successor quote",
        }),
        f.record({
          rate: "1.1400000000",
          expectedCurrentId: first.evidence.id,
          reason: "Second concurrent successor quote",
        }),
      ]);
      assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((a) => a.status === "rejected").length, 1);
      const versions = await db.execute<{ version: number }>(
        sql`
      select version from fx_revaluation_rate_evidence where org_id=${f.orgId} order by version`,
        "objects",
      );
      assert.deepEqual(
        versions.map((v) => v.version),
        [1, 2],
        "no forked version chain",
      );

      // Recorded quotes are immutable at storage level.
      await assert.rejects(
        db.execute(
          sql`update fx_revaluation_rate_evidence set rate=9 where org_id=${f.orgId} and id=${first.evidence.id}`,
        ),
        (error: unknown) =>
          /append-only/.test(
            guardRefusalMessage(error, { includeRaisedCheckViolations: true }) ?? "",
          ),
      );
      await assert.rejects(
        db.execute(
          sql`delete from fx_revaluation_rate_evidence where org_id=${f.orgId} and id=${first.evidence.id}`,
        ),
        (error: unknown) =>
          /append-only/.test(
            guardRefusalMessage(error, { includeRaisedCheckViolations: true }) ?? "",
          ),
      );
    } finally {
      await dropScratchOrg(f.orgId);
    }
  },
);

test(
  "one request identity serializes across positions and resolves to the supported replay contract",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await f.seed({ accountId: f.accounts.bank, currency: "EUR", base: "1100", foreign: "1000" });
      // The same request id raced against two different positions: exactly one
      // recording lands, and the other resolves through the replay contract
      // (already-recorded refusal), never a raw unique-index error.
      const requestId = randomUUID();
      const attempts = await Promise.allSettled([
        f.record({ requestId }),
        f.record({
          requestId,
          accountId: f.accounts.ar,
          rate: "1.2000000000",
          reason: "Concurrent quote for another position",
        }),
      ]);
      assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
      const rejected = attempts.find((a) => a.status === "rejected") as PromiseRejectedResult;
      assert.match(
        String((rejected.reason as Error).message),
        /already recorded a different closing rate/,
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from fx_revaluation_rate_evidence where org_id=${f.orgId}`,
            "objects",
          )
        ).length,
        1,
      );
    } finally {
      await dropScratchOrg(f.orgId);
    }
  },
);

test(
  "an expected current quote on an unrecorded position names the new-quote remedy",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        f.record({ expectedCurrentId: randomUUID() }),
        /has no recorded closing rate yet; reload it and record the first quote/,
      );
    } finally {
      await dropScratchOrg(f.orgId);
    }
  },
);

test(
  "accounts restricted to another legal entity are refused, and admitted child entities record",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const branchId = randomUUID();
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${branchId}, ${f.orgId}, ${f.subsidiaryId}, 'Branch Entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      // Restricted to the branch only: the parent entity cannot record
      // against it, while the branch itself can.
      const branchAccount = await seedPostingAccount(
        f.orgId,
        "1090",
        "Branch USD cash",
        "asset_bank",
        branchId,
      );
      await db.execute(
        sql`update accounts set subsidiary_include_children=false where org_id=${f.orgId} and id=${branchAccount}`,
      );
      await assert.rejects(
        f.record({ accountId: branchAccount }),
        /restricted to another subsidiary/,
      );
      const admitted = await f.record({ accountId: branchAccount, subsidiaryId: branchId });
      assert.equal(admitted.evidence.version, 1);
      // Restricted to the parent with children included: the branch records
      // under the native subtree admission.
      const parentAccount = await seedPostingAccount(
        f.orgId,
        "1091",
        "Group EUR cash",
        "asset_bank",
        f.subsidiaryId,
      );
      const child = await f.record({ accountId: parentAccount, subsidiaryId: branchId });
      assert.equal(child.evidence.version, 1);
    } finally {
      await dropScratchOrg(f.orgId);
    }
  },
);

test(
  "a secondary book prices only from its own recorded closing rates",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const taxBookId = randomUUID();
      await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${taxBookId}, ${f.orgId}, 'TAX', 'Tax book', false, true, true)`);
      await f.seed({
        accountId: f.accounts.bank,
        currency: "EUR",
        base: "1100",
        foreign: "1000",
        bookId: taxBookId,
      });
      await f.record();
      const taxRun = await f.run(taxBookId);
      assert.equal(taxRun.posted.length, 0, "the primary book's quote never prices the tax book");
      assert.equal(taxRun.problems.length, 1);
      await f.record({
        bookId: taxBookId,
        rate: "1.1500000000",
        reason: "Tax book closing rate for July",
      });
      const priced = await f.run(taxBookId);
      assert.deepEqual(priced.problems, []);
      assert.equal(priced.posted[0]?.netDelta, "50.0000");
      assert.equal(await f.bankTotal(f.periodId, taxBookId), "50.0000");
      assert.equal(await f.bankTotal(), "0", "the tax book's quote never prices the primary book");
    } finally {
      await dropScratchOrg(f.orgId);
    }
  },
);

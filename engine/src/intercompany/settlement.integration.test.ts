import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { toUnits } from "../money/money.ts";
import { IntercompanyError } from "./errors.ts";
import {
  loadIntercompanyFundTransfer,
  postIntercompanyFundTransfer,
  reverseIntercompanyFundTransfer,
  type FundTransferInput,
} from "./fund-transfers.ts";
import {
  cancelNettingRun,
  loadNettingRun,
  postNettingRun,
  proposeNettingRun,
  reverseNettingRun,
  submitNettingRun,
} from "./netting.ts";

interface SettlementFixture {
  org: ScratchOrg;
  actorId: string;
  viewerId: string;
  otherId: string;
  bankId: string;
  fromPositionId: string;
  toPositionId: string;
  transfer: FundTransferInput;
}

async function fixture(): Promise<SettlementFixture> {
  const org = await createScratchOrg();
  try {
    return await withBypassContext(async () => {
      const actorId = await createScratchUser(org.orgId, "Settlement controller", "admin");
      const viewerId = await createScratchUser(org.orgId, "Settlement viewer", "viewer");
      await db.execute(
        sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`,
      );
      await db.execute(
        sql`update orgs set settings = settings || '{"features":{"multiSubsidiary":true,"intercompanyTransactions":true,"intercompanyNetting":true}}'::jsonb where id = ${org.orgId}`,
      );
      const otherId = randomUUID();
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${otherId}, ${org.orgId}, ${org.subsidiaryId}, 'Receiving entity', 'CAD', 'CA')`);
      const makeAccount = async (
        number: string,
        type: string,
        subsidiaryId: string,
        eliminate: boolean,
      ) => {
        const id = randomUUID();
        await db.execute(sql`insert into accounts (id, org_id, number, name, type, subsidiary_id, is_active, is_summary, eliminate)
          values (${id}, ${org.orgId}, ${number}, ${number}, ${type}, ${subsidiaryId}, true, false, ${eliminate})`);
        return id;
      };
      const bankId = await makeAccount("1120", "asset_bank", otherId, false);
      const fromPositionId = await makeAccount("1380", "asset_other", org.subsidiaryId, true);
      const toPositionId = await makeAccount("2380", "liability_current_other", otherId, true);
      await db.execute(sql`insert into intercompany_pairs (org_id, from_subsidiary_id, to_subsidiary_id, due_from_account_id, due_to_account_id)
        values (${org.orgId}, ${org.subsidiaryId}, ${otherId}, ${fromPositionId}, ${toPositionId})`);
      return {
        org,
        actorId,
        viewerId,
        otherId,
        bankId,
        fromPositionId,
        toPositionId,
        transfer: {
          transferDate: org.date,
          fromSubsidiaryId: org.subsidiaryId,
          toSubsidiaryId: otherId,
          fromBankAccountId: org.accounts.bank,
          toBankAccountId: bankId,
          currency: "CAD",
          amount: "100.0000",
          reason: "Fund the receiving entity",
          memo: "Operating funds",
          idempotencyKey: randomUUID(),
        },
      };
    });
  } catch (error) {
    await dropScratchOrg(org.orgId);
    throw error;
  }
}

async function scenario(work: (f: SettlementFixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  try {
    await withOrgContext(f.org.orgId, () => work(f));
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
}

async function counts(orgId: string) {
  return (
    await db.execute<{ transfers: number; entries: number; runs: number }>(
      sql`
    select (select count(*)::int from intercompany_fund_transfers where org_id = ${orgId}) as transfers,
           (select count(*)::int from journal_entries where org_id = ${orgId}) as entries,
           (select count(*)::int from intercompany_netting_runs where org_id = ${orgId}) as runs`,
      "objects",
    )
  )[0]!;
}

async function accountBalance(orgId: string, accountId: string) {
  const row = (
    await db.execute<{ balance: string }>(
      sql`
    select coalesce(sum(l.amount), 0)::text as balance from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where l.org_id = ${orgId} and l.account_id = ${accountId} and e.status in ('posted', 'reversed')`,
      "objects",
    )
  )[0]!;
  return toUnits(row.balance);
}

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test(
  "a transfer balances each entity, replays once, and reverses through the native read path",
  { skip: !DB },
  async () =>
    scenario(async (f) => {
      const posted = await postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, f.transfer);
      assert.equal(posted.status, "posted");
      const entityBalances = await db.execute<{ subsidiary_id: string; balance: string }>(
        sql`
    select subsidiary_id, sum(amount)::text as balance from journal_lines
    where org_id = ${f.org.orgId} and entry_id = ${posted.entryId} group by subsidiary_id`,
        "objects",
      );
      assert.equal(entityBalances.length, 2);
      assert.ok(entityBalances.every((row) => toUnits(row.balance) === 0n));
      assert.equal(await accountBalance(f.org.orgId, f.fromPositionId), 1_000_000n);
      assert.equal(await accountBalance(f.org.orgId, f.toPositionId), -1_000_000n);
      const before = await counts(f.org.orgId);
      assert.equal(
        (await postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, f.transfer)).id,
        posted.id,
      );
      assert.deepEqual(await counts(f.org.orgId), before);
      const reversed = await reverseIntercompanyFundTransfer(
        f.org.orgId,
        f.actorId,
        posted.id,
        { reversalDate: f.org.date, reason: "Return operating funds" },
        null,
      );
      assert.equal(reversed.status, "reversed");
      assert.equal(
        (await loadIntercompanyFundTransfer(f.org.orgId, posted.id, null)).reversalEntryId,
        reversed.reversalEntryId,
      );
      assert.equal(await accountBalance(f.org.orgId, f.fromPositionId), 0n);
      assert.equal(await accountBalance(f.org.orgId, f.toPositionId), 0n);
      const after = await counts(f.org.orgId);
      await reverseIntercompanyFundTransfer(
        f.org.orgId,
        f.actorId,
        posted.id,
        { reversalDate: f.org.date, reason: "Return operating funds" },
        null,
      );
      assert.deepEqual(await counts(f.org.orgId), after);
      await assert.rejects(
        postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, f.transfer),
        (error) => error instanceof IntercompanyError && error.status === 409,
      );
      assert.deepEqual(
        await counts(f.org.orgId),
        after,
        "a reversed transfer key cannot return a live transfer or post again",
      );
    }),
);

test(
  "a transfer respects a destination entity close on its effective fiscal calendar",
  { skip: !DB },
  async () =>
    scenario(async (f) => {
      try {
        const calendarId = randomUUID();
        const periodId = randomUUID();
        const priorPeriodId = randomUUID();
        const priorDefaultPeriodId = randomUUID();
        const defaultCalendar = (
          await db.execute<{ id: string }>(
            sql`
      select id from fiscal_calendars where org_id = ${f.org.orgId} and is_default and is_active
    `,
            "objects",
          )
        )[0];
        assert.ok(defaultCalendar, "the scratch organization has an active default calendar");
        await db.execute(sql`
      insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                                    adjustment_period_enabled, is_default, is_active, config)
      values (${calendarId}, ${f.org.orgId}, 'Receiving entity calendar', 'monthly', 1, 1, 'UTC', false, false, true, '{}'::jsonb)
    `);
        await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
                                      is_adjustment, fiscal_calendar_id)
      values (${priorDefaultPeriodId}, ${f.org.orgId}, 2026, 6, '2026-06 Default', '2026-06-01', '2026-06-30', false, ${defaultCalendar.id})
    `);
        await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
                                      is_adjustment, fiscal_calendar_id)
      values (${priorPeriodId}, ${f.org.orgId}, 2026, 6, '2026-06 Receiving', '2026-06-01', '2026-06-30', false, ${calendarId})
    `);
        await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
                                      is_adjustment, fiscal_calendar_id)
      values (${periodId}, ${f.org.orgId}, 2026, 7, '2026-07 Receiving', '2026-07-01', '2026-07-31', false, ${calendarId})
    `);
        await db.execute(sql`
      insert into subsidiary_accounting_preferences (org_id, subsidiary_id, effective_from, fiscal_calendar_id, reason, created_by)
      values (${f.org.orgId}, ${f.otherId}, '2026-07-01', ${calendarId}, 'Use the receiving entity calendar', ${f.actorId})
    `);
        await db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, reason)
      values (${f.org.orgId}, ${periodId}, ${f.org.bookId}, ${f.otherId}, 'banking', 'closed', now(), 'Bank close completed')
    `);

        const before = await counts(f.org.orgId);
        await assert.rejects(
          postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, f.transfer),
          (error) => error instanceof IntercompanyError && /BANKING is closed/.test(error.message),
        );
        assert.deepEqual(
          await counts(f.org.orgId),
          before,
          "a closed destination period leaves no entry or transfer record",
        );
      } catch (error) {
        const outer = error instanceof Error ? error.message.replace(/\s+/g, " ") : String(error);
        const nested =
          error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
        throw new Error(
          `Destination entity period setup or close check failed: ${outer}${nested ? `; ${nested}` : ""}`,
          { cause: error },
        );
      }
    }),
);

test(
  "a transfer key refuses changed currency, memo or reason without another posting",
  { skip: !DB },
  async () =>
    scenario(async (f) => {
      await postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, f.transfer);
      const before = await counts(f.org.orgId);
      for (const changed of [
        { currency: "USD" },
        { memo: "Different purpose" },
        { reason: "Different authorization" },
      ]) {
        await assert.rejects(
          postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, { ...f.transfer, ...changed }),
          (error) => error instanceof IntercompanyError && error.status === 409,
        );
      }
      assert.deepEqual(await counts(f.org.orgId), before);
    }),
);

test("concurrent retries share one transfer and one balanced posting", { skip: !DB }, async () =>
  scenario(async (f) => {
    const before = await counts(f.org.orgId);
    const [first, second] = await Promise.all([
      postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, f.transfer),
      postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, f.transfer),
    ]);
    assert.equal(first.id, second.id);
    const after = await counts(f.org.orgId);
    assert.equal(after.transfers, before.transfers + 1);
    assert.equal(after.entries, before.entries + 1);
  }),
);

test(
  "transfer commands refuse missing live permissions and hidden entities before writing",
  { skip: !DB },
  async () =>
    scenario(async (f) => {
      const before = await counts(f.org.orgId);
      await assert.rejects(
        postIntercompanyFundTransfer(f.org.orgId, f.viewerId, null, f.transfer),
        (error) => error instanceof IntercompanyError && error.status === 403,
      );
      await assert.rejects(
        postIntercompanyFundTransfer(
          f.org.orgId,
          f.actorId,
          new Set([f.org.subsidiaryId]),
          f.transfer,
        ),
        (error) => error instanceof IntercompanyError && error.status === 404,
      );
      assert.deepEqual(await counts(f.org.orgId), before);
      const posted = await postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, f.transfer);
      await assert.rejects(
        loadIntercompanyFundTransfer(f.org.orgId, posted.id, new Set([f.org.subsidiaryId])),
        (error) => error instanceof IntercompanyError && error.status === 404,
      );
      const foreignOrgId = randomUUID();
      await assert.rejects(
        withOrgContext(foreignOrgId, () =>
          loadIntercompanyFundTransfer(foreignOrgId, posted.id, null),
        ),
        (error) => error instanceof IntercompanyError && error.status === 404,
      );
    }),
);

function proposal(f: SettlementFixture) {
  return {
    asOfDate: f.org.date,
    subsidiaryIds: [f.org.subsidiaryId, f.otherId],
    settleCash: true,
    bankAccounts: {
      [f.org.subsidiaryId]: { CAD: f.org.accounts.bank },
      [f.otherId]: { CAD: f.bankId },
    },
    reason: "Settle reciprocal balances",
    idempotencyKey: randomUUID(),
  };
}

test(
  "netting requires submission, clears reciprocal positions exactly once, and reverses them",
  { skip: !DB },
  async () =>
    scenario(async (f) => {
      await postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, f.transfer);
      const input = proposal(f);
      const run = await proposeNettingRun(f.org.orgId, f.actorId, null, input);
      assert.equal((await proposeNettingRun(f.org.orgId, f.actorId, null, input)).id, run.id);
      await assert.rejects(
        postNettingRun(f.org.orgId, f.actorId, run.id, null),
        /submit.*approval/,
      );
      assert.equal(
        (await submitNettingRun(f.org.orgId, f.actorId, run.id, null)).status,
        "approved",
      );
      const posted = await postNettingRun(f.org.orgId, f.actorId, run.id, null);
      assert.equal(posted.status, "posted");
      assert.equal(await accountBalance(f.org.orgId, f.fromPositionId), 0n);
      assert.equal(await accountBalance(f.org.orgId, f.toPositionId), 0n);
      const before = await counts(f.org.orgId);
      assert.equal((await postNettingRun(f.org.orgId, f.actorId, run.id, null)).id, run.id);
      assert.deepEqual(await counts(f.org.orgId), before);
      await reverseNettingRun(
        f.org.orgId,
        f.actorId,
        run.id,
        { reversalDate: f.org.date, reason: "Restore reciprocal balances" },
        null,
      );
      assert.equal((await loadNettingRun(f.org.orgId, run.id, null)).status, "reversed");
      assert.equal(await accountBalance(f.org.orgId, f.fromPositionId), 1_000_000n);
      assert.equal(await accountBalance(f.org.orgId, f.toPositionId), -1_000_000n);
    }),
);

test(
  "an approved netting proposal refuses changed balances and cancellation frees its scope",
  { skip: !DB },
  async () =>
    scenario(async (f) => {
      await postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, f.transfer);
      const run = await proposeNettingRun(f.org.orgId, f.actorId, null, proposal(f));
      await assert.rejects(
        proposeNettingRun(f.org.orgId, f.actorId, null, proposal(f)),
        /open.*post or cancel/,
      );
      await submitNettingRun(f.org.orgId, f.actorId, run.id, null);
      await postIntercompanyFundTransfer(f.org.orgId, f.actorId, null, {
        ...f.transfer,
        amount: "20",
        idempotencyKey: randomUUID(),
      });
      const before = await counts(f.org.orgId);
      await assert.rejects(
        postNettingRun(f.org.orgId, f.actorId, run.id, null),
        /balances changed/,
      );
      assert.deepEqual(await counts(f.org.orgId), before);
      assert.equal((await loadNettingRun(f.org.orgId, run.id, null)).status, "approved");
      await cancelNettingRun(f.org.orgId, f.actorId, run.id, "Recompute changed balances", null);
      assert.equal(
        (await proposeNettingRun(f.org.orgId, f.actorId, null, proposal(f))).status,
        "proposed",
      );
    }),
);

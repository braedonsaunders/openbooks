import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { Money } from "../money/brands.ts";
import { db, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { clearBalancingLegProviders, registerBalancingLegProvider } from "./balancing-hooks.ts";
import { postEntry } from "./post-entry.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "resolved entity period and caller lines identify one posting with provider legs on every retry",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    let calls = 0;
    registerBalancingLegProvider("canonical-replay", async (_runner, context, lines) => {
      if (context.orgId !== org.orgId) return [];
      calls += 1;
      assert.equal(lines.length, 2);
      const base = lines[0]!;
      return [
        {
          accountId: org.accounts.bank,
          amount: "1.0000" as Money,
          subsidiaryId: base.subsidiaryId,
          currency: "CAD",
          txnAmount: "1.0000" as Money,
          fxRate: "1",
          extraDims: {},
          memo: "Segment balancing",
        },
        {
          accountId: org.accounts.cogs,
          amount: "-1.0000" as Money,
          subsidiaryId: base.subsidiaryId,
          currency: "CAD",
          txnAmount: "-1.0000" as Money,
          fxRate: "1",
          extraDims: {},
          memo: "Segment balancing",
        },
      ];
    });
    try {
      await withOrgContext(org.orgId, async () => {
        const calendarId = randomUUID();
        const entityPeriodId = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into fiscal_calendars(id,org_id,name,is_active,is_default)
        values(${calendarId},${org.orgId},'Entity reporting calendar',true,false) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`insert into accounting_periods(id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
        select ${entityPeriodId},org_id,${calendarId},fiscal_year,period_number,'Entity July',starts_on,ends_on
        from accounting_periods where org_id=${org.orgId} and id=${org.periodId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`insert into subsidiary_accounting_preferences(org_id,subsidiary_id,effective_from,fiscal_calendar_id,reason)
        select ${org.orgId},${org.subsidiaryId},starts_on,${calendarId},'Entity reporting calendar assignment'
        from accounting_periods where org_id=${org.orgId} and id=${entityPeriodId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const key = randomUUID();
        const request = {
          orgId: org.orgId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          postingDate: org.date,
          origin: "manual",
          currency: "CAD",
          idempotencyKey: key,
          lines: [
            { accountId: org.accounts.bank, amount: "-10" },
            { accountId: org.accounts.cogs, amount: "10" },
          ],
        };
        const first = await postEntry(db, {
          ...request,
          periodId: org.periodId,
          entryNumber: "CALENDAR-ORIGINAL",
        });
        assert.equal(first.lines.length, 4);
        assert.equal(calls, 1);
        const state = async () =>
          (
            await db.execute<{ state: unknown }>(
              sql`select jsonb_build_object(
        'entry',(select to_jsonb(e) from journal_entries e where org_id=${org.orgId} and id=${first.entryId}),
        'lines',(select jsonb_agg(to_jsonb(l) order by line_number) from journal_lines l where org_id=${org.orgId} and entry_id=${first.entryId}),
        'audit',(select jsonb_agg(to_jsonb(a) order by id) from audit_log a where org_id=${org.orgId} and row_id=${first.entryId})
      ) as state`,
              "objects",
            )
          )[0]!.state;
        const before = await state();
        const header = (
          await db.execute<{ period_id: string; hash: string; leg_count: number; total: string }>(
            sql`
        select e.period_id,e.custom->>'postingRequestHash' as hash,count(l.id)::int as leg_count,sum(l.amount)::text as total
        from journal_entries e join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id
        where e.org_id=${org.orgId} and e.id=${first.entryId} group by e.id`,
            "objects",
          )
        )[0]!;
        assert.equal(header.period_id, entityPeriodId);
        assert.match(header.hash, /^[0-9a-f]{64}$/);
        assert.equal(header.leg_count, 4);
        assert.equal(header.total, "0.0000");
        for (const periodId of [entityPeriodId, org.periodId]) {
          const replay = await postEntry(db, {
            ...request,
            periodId,
            entryNumber: `CALENDAR-RETRY-${periodId}`,
          });
          assert.deepEqual(replay, first);
          assert.equal(
            calls,
            1,
            "a committed request returns all persisted provider legs without creating them again",
          );
          assert.deepEqual(await state(), before);
        }
        await assert.rejects(
          () =>
            postEntry(db, {
              ...request,
              periodId: entityPeriodId,
              entryNumber: "CALENDAR-CONFLICT",
              lines: [
                { accountId: org.accounts.bank, amount: "-20" },
                { accountId: org.accounts.cogs, amount: "20" },
              ],
            }),
          /different posting content/,
        );
        assert.deepEqual(await state(), before);
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int as n from journal_entries
        where org_id=${org.orgId} and custom->>'idempotencyKey'=${key}`,
              "objects",
            )
          )[0]!.n,
          1,
        );
      });
    } finally {
      clearBalancingLegProviders();
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a regular period cannot receive a posting dated outside its own window",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        await assert.rejects(
          () =>
            postEntry(db, {
              orgId: org.orgId,
              bookId: org.bookId,
              subsidiaryId: org.subsidiaryId,
              postingDate: "2026-08-15",
              periodId: org.periodId,
              entryNumber: "OUTSIDE-PERIOD",
              origin: "manual",
              currency: "CAD",
              idempotencyKey: randomUUID(),
              lines: [
                { accountId: org.accounts.bank, amount: "-10" },
                { accountId: org.accounts.cogs, amount: "10" },
              ],
            }),
          /posting date must fall within its accounting period.*choose the period covering 2026-08-15/,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from journal_entries where org_id=${org.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
        assert.equal(
          (await db.execute(sql`select id from journal_lines where org_id=${org.orgId}`, "objects"))
            .length,
          0,
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "calendar resolution never admits a period belonging to another organization",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const foreign = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        await assert.rejects(
          () =>
            postEntry(db, {
              orgId: org.orgId,
              bookId: org.bookId,
              subsidiaryId: org.subsidiaryId,
              postingDate: org.date,
              periodId: foreign.periodId,
              entryNumber: "FOREIGN-PERIOD",
              origin: "manual",
              currency: "CAD",
              lines: [
                { accountId: org.accounts.bank, amount: "-10" },
                { accountId: org.accounts.cogs, amount: "10" },
              ],
            }),
          /accounting period .* does not exist in this organization/,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from journal_entries where org_id=${org.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
      });
    } finally {
      await dropScratchOrg(foreign.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);

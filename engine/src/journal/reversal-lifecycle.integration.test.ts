import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { markEntryReversed, postEntry, type PostEntryInput } from "./post-entry.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function request(org: ScratchOrg, label: string, reversesEntryId?: string): PostEntryInput {
  return {
    orgId: org.orgId,
    bookId: org.bookId,
    subsidiaryId: org.subsidiaryId,
    entryNumber: `${label}-${randomUUID()}`,
    postingDate: org.date,
    periodId: org.periodId,
    origin: "manual",
    currency: "CAD",
    closeModules: ["gl"],
    idempotencyKey: randomUUID(),
    reversesEntryId,
    lines: reversesEntryId
      ? [
          { accountId: org.accounts.bank, amount: "-10" },
          { accountId: org.accounts.cogs, amount: "10" },
        ]
      : [
          { accountId: org.accounts.bank, amount: "10" },
          { accountId: org.accounts.cogs, amount: "-10" },
        ],
  };
}

async function history(org: ScratchOrg): Promise<unknown> {
  return (
    await db.execute<{ state: unknown }>(
      sql`select jsonb_build_object(
    'entries',(select jsonb_agg(to_jsonb(e) order by e.id) from journal_entries e where e.org_id=${org.orgId}),
    'lines',(select jsonb_agg(to_jsonb(l) order by l.id) from journal_lines l where l.org_id=${org.orgId}),
    'audit',(select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a
      where a.org_id=${org.orgId} and a.table_name='journal_entries')
  ) as state`,
      "objects",
    )
  )[0]!.state;
}

async function financialEntry(org: ScratchOrg, entryId: string): Promise<unknown> {
  return (
    await db.execute<{ state: unknown }>(
      sql`select jsonb_build_object(
    'header',(select to_jsonb(e)-'status'-'updated_at'-'updated_by' from journal_entries e
      where e.org_id=${org.orgId} and e.id=${entryId}),
    'lines',(select jsonb_agg(to_jsonb(l) order by l.line_number) from journal_lines l
      where l.org_id=${org.orgId} and l.entry_id=${entryId})
  ) as state`,
      "objects",
    )
  )[0]!.state;
}

test(
  "a retained reversal prevents another reversal while exact keyed replay preserves the full child",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const original = await postEntry(db, request(org, "ORIGINAL"));
        const originalFinancial = await financialEntry(org, original.entryId);
        const reversalRequest = request(org, "REVERSAL", original.entryId);
        const reversal = await postEntry(db, reversalRequest);
        assert.equal(reversal.lines.length, 2);
        const beforeMark = await history(org);
        await assert.rejects(
          () => postEntry(db, request(org, "SECOND-REVERSAL", original.entryId)),
          /already has a retained reversal/,
        );
        assert.deepEqual(
          await history(org),
          beforeMark,
          "a posted target with a reversal cannot produce a second child before its lifecycle marker",
        );

        await markEntryReversed(db, { orgId: org.orgId, entryId: original.entryId });
        assert.deepEqual(await financialEntry(org, original.entryId), originalFinancial);
        const retained = await history(org);
        const retry = await postEntry(db, { ...reversalRequest, entryNumber: "REVERSAL-RETRY" });
        assert.deepEqual(
          retry,
          reversal,
          "a retry returns every original persisted reversal line after the target is reversed",
        );
        await assert.rejects(
          () => postEntry(db, request(org, "REVERSED-TARGET", original.entryId)),
          /only a posted entry can be reversed/,
        );
        await assert.rejects(
          () => markEntryReversed(db, { orgId: org.orgId, entryId: original.entryId }),
          /only a posted entry can be marked reversed/,
        );
        assert.deepEqual(await history(org), retained);
        const rows = await db.execute<{ id: string; status: string; balance: string }>(
          sql`
        select e.id,e.status,sum(l.amount)::text as balance from journal_entries e
        join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id
        where e.org_id=${org.orgId} group by e.id order by e.id`,
          "objects",
        );
        assert.equal(rows.length, 2);
        assert.equal(rows.find((row) => row.id === original.entryId)!.status, "reversed");
        assert.equal(rows.find((row) => row.id === reversal.entryId)!.status, "posted");
        assert.ok(rows.every((row) => row.balance === "0.0000"));
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "concurrent different reversal keys serialize on the target and retain one child",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const original = await withOrgContext(org.orgId, () =>
        postEntry(db, request(org, "RACE-ORIGINAL")),
      );
      const originalFinancial = await withOrgContext(org.orgId, () =>
        financialEntry(org, original.entryId),
      );
      const outcomes = await Promise.allSettled(
        ["RACE-A", "RACE-B"].map((label) =>
          withOrgContext(org.orgId, () => postEntry(db, request(org, label, original.entryId))),
        ),
      );
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = outcomes.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      assert.match(String(rejected.reason), /already has a retained reversal/);
      await withOrgContext(org.orgId, async () => {
        const children = await db.execute<{ id: string; status: string; legs: number }>(
          sql`
        select e.id,e.status,count(l.id)::int as legs from journal_entries e
        join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id
        where e.org_id=${org.orgId} and e.reverses_entry_id=${original.entryId} group by e.id`,
          "objects",
        );
        assert.equal(children.length, 1);
        assert.equal(children[0]!.status, "posted");
        assert.equal(children[0]!.legs, 2);
        assert.deepEqual(await financialEntry(org, original.entryId), originalFinancial);
        await markEntryReversed(db, { orgId: org.orgId, entryId: original.entryId });
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a reversed child remains evidence against reversing its original target again",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const original = await postEntry(db, request(org, "CHAIN-ORIGINAL"));
        const reversal = await postEntry(db, request(org, "CHAIN-REVERSAL", original.entryId));
        const reverseReversal = request(org, "CHAIN-CORRECTION", reversal.entryId);
        reverseReversal.lines = [
          { accountId: org.accounts.bank, amount: "10" },
          { accountId: org.accounts.cogs, amount: "-10" },
        ];
        await postEntry(db, reverseReversal);
        await markEntryReversed(db, { orgId: org.orgId, entryId: reversal.entryId });
        const retained = await history(org);
        await assert.rejects(
          () => postEntry(db, request(org, "CHAIN-DUPLICATE", original.entryId)),
          /already has a retained reversal/,
        );
        assert.deepEqual(await history(org), retained);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "reversals honor the effective entity posting-date policy without changing retained history",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const old = await postEntry(db, request(org, "PRE-CUTOVER"));
        const backdatedTarget = await postEntry(db, request(org, "BACKDATED-TARGET"));
        const futureTarget = await postEntry(db, request(org, "FUTURE-TARGET"));
        if (
          (
            await db.execute(
              sql`select id from fx_rate_types where org_id=${org.orgId} and key='spot'`,
              "objects",
            )
          ).length === 0
        ) {
          assert.equal(
            (
              await db.execute(
                sql`insert into fx_rate_types(org_id,key,name,is_active)
          values(${org.orgId},'spot','Spot rate',true) returning id`,
                "objects",
              )
            ).length,
            1,
          );
        }
        assert.equal(
          (
            await db.execute(
              sql`insert into subsidiary_accounting_preferences
        (org_id,subsidiary_id,effective_from,allow_backdated_posting,allow_future_posting,reason)
        values(${org.orgId},${org.subsidiaryId},'2026-07-16',false,false,'Prospective posting-date policy') returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await withSimClock("2026-07-17T12:00:00Z", async () => {
          await postEntry(db, request(org, "PRE-CUTOVER-REVERSAL", old.entryId));
          const retained = await history(org);
          await assert.rejects(
            () =>
              postEntry(db, {
                ...request(org, "BACKDATED-REVERSAL", backdatedTarget.entryId),
                postingDate: "2026-07-16",
              }),
            /accounting policy refuses backdated postings/,
          );
          assert.deepEqual(await history(org), retained);
          await assert.rejects(
            () =>
              postEntry(db, {
                ...request(org, "FUTURE-REVERSAL", futureTarget.entryId),
                postingDate: "2026-07-18",
              }),
            /accounting policy refuses future-dated postings/,
          );
          assert.deepEqual(await history(org), retained);
        });
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

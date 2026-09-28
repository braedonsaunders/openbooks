import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { postEntry, type PostEntryInput } from "./post-entry.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.message} ${errorText(error.cause)}` : String(error);

function baseInput(org: Awaited<ReturnType<typeof createScratchOrg>>, key: string): PostEntryInput {
  return {
    orgId: org.orgId,
    bookId: org.bookId,
    subsidiaryId: org.subsidiaryId,
    entryNumber: `FXR-${randomUUID().slice(0, 8)}`,
    postingDate: org.date,
    periodId: org.periodId,
    origin: "manual",
    currency: "CAD",
    closeModules: ["gl"],
    idempotencyKey: key,
    lines: [],
  };
}

test(
  "a complete posting with lawful FX evidence balances and replays idempotently",
  { skip: !DB },
  async () => {
    // The bucket line stands 0.0002 off its translation while the five-line
    // group holds its 0.00025 bound: the entry posts, balances per
    // subsidiary, and a keyed replay returns the same entry, never a second.
    const org = await createScratchOrg();
    const key = `fx-residual-${randomUUID()}`;
    const lines: PostEntryInput["lines"] = [
      { accountId: org.accounts.bank, amount: "10.0002", txnAmount: "10.0000", fxRate: "1" },
      { accountId: org.accounts.cogs, amount: "20.0000", txnAmount: "20.0000", fxRate: "1" },
      { accountId: org.accounts.bank, amount: "-15.0000", txnAmount: "-15.0000", fxRate: "1" },
      { accountId: org.accounts.cogs, amount: "-15.0000", txnAmount: "-15.0000", fxRate: "1" },
      { accountId: org.accounts.bank, amount: "-0.0002", txnAmount: "-0.0002", fxRate: "1" },
    ];
    try {
      const first = await withOrgContext(org.orgId, () => postEntry(db, { ...baseInput(org, key), lines }));
      assert.equal(first.lines.length, 5);
      const state = await withOrgContext(org.orgId, () => db.execute<{ status: string; lines: number; sub: string }>(sql`
        select e.status, count(l.id)::int as lines, sum(l.amount)::text as sub
          from journal_entries e join journal_lines l on l.entry_id = e.id
         where e.org_id = ${org.orgId} and e.custom->>'idempotencyKey' = ${key}
           and l.subsidiary_id = ${org.subsidiaryId}
         group by e.status`));
      assert.deepEqual(state.rows, [{ status: "posted", lines: 5, sub: "0.0000" }]);
      const replay = await withOrgContext(org.orgId, () => postEntry(db, { ...baseInput(org, key), lines }));
      assert.equal(replay.entryId, first.entryId);
      assert.equal(replay.lines.length, 5);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a complete posting whose FX evidence exceeds the group bound is refused whole",
  { skip: !DB },
  async () => {
    // Balanced and lawful per line; only the group bound fails. No remnant survives.
    const org = await createScratchOrg();
    const key = `fx-residual-over-${randomUUID()}`;
    const lines: PostEntryInput["lines"] = [
      { accountId: org.accounts.bank, amount: "10.0003", txnAmount: "10.0000", fxRate: "1" },
      { accountId: org.accounts.cogs, amount: "20.0000", txnAmount: "20.0000", fxRate: "1" },
      { accountId: org.accounts.bank, amount: "-15.0000", txnAmount: "-15.0000", fxRate: "1" },
      { accountId: org.accounts.cogs, amount: "-15.0000", txnAmount: "-15.0000", fxRate: "1" },
      { accountId: org.accounts.bank, amount: "-0.0003", txnAmount: "-0.0002", fxRate: "1" },
    ];
    try {
      await assert.rejects(
        withOrgContext(org.orgId, () => postEntry(db, { ...baseInput(org, key), lines })),
        (error: unknown) => /exceeds the per-entry FX rounding bound/.test(errorText(error)),
      );
      const remnant = await withOrgContext(org.orgId, () => db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries
         where org_id = ${org.orgId} and custom->>'idempotencyKey' = ${key}`));
      assert.deepEqual(remnant.rows, [{ n: 0 }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

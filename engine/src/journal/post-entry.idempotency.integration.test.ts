import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { postEntry } from "./post-entry.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function keyedPost(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  entryNumber: string,
  idempotencyKey: string,
) {
  return withOrgContext(org.orgId, () => postEntry(db, {
    orgId: org.orgId,
    bookId: org.bookId,
    subsidiaryId: org.subsidiaryId,
    entryNumber,
    postingDate: org.date,
    periodId: org.periodId,
    origin: "manual",
    currency: "CAD",
    closeModules: ["gl"],
    idempotencyKey,
    lines: [
      { accountId: org.accounts.bank, amount: "-10" },
      { accountId: org.accounts.cogs, amount: "10" },
    ],
  }));
}

test(
  "concurrent posts with the same idempotency key produce one entry",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const key = `idem-${randomUUID()}`;
      const numbers = Array.from({ length: 4 }, () => `IDEM-${randomUUID().slice(0, 8)}`);
      const results = await Promise.all(numbers.map((number) => keyedPost(org, number, key)));
      for (const result of results) {
        assert.equal(result.entryId, results[0]!.entryId);
        assert.equal(result.lines.length, 2);
      }
      const stored = await withOrgContext(org.orgId, () => db.execute<{
        n: number;
        status: string;
      }>(sql`
        select count(*)::int as n, min(status) as status from journal_entries
         where org_id = ${org.orgId} and custom->>'idempotencyKey' = ${key}`));
      assert.deepEqual(stored.rows, [{ n: 1, status: "posted" }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the same idempotency key posts once per organization",
  { skip: !DB },
  async () => {
    const first = await createScratchOrg();
    const second = await createScratchOrg();
    try {
      const key = `idem-${randomUUID()}`;
      const [one, two] = await Promise.all([
        keyedPost(first, `IDEM-A-${randomUUID().slice(0, 8)}`, key),
        keyedPost(second, `IDEM-B-${randomUUID().slice(0, 8)}`, key),
      ]);
      assert.notEqual(one.entryId, two.entryId);
      for (const [org, result] of [[first, one], [second, two]] as const) {
        const stored = await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
          select id from journal_entries
           where org_id = ${org.orgId} and custom->>'idempotencyKey' = ${key}`));
        assert.deepEqual(stored.rows.map((row) => row.id), [result.entryId]);
      }
    } finally {
      await dropScratchOrg(second.orgId);
      await dropScratchOrg(first.orgId);
    }
  },
);

test(
  "posts without a key are unaffected by the idempotency index",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const one = await withOrgContext(org.orgId, () => postEntry(db, {
        orgId: org.orgId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        entryNumber: `PLAIN-A-${randomUUID().slice(0, 8)}`,
        postingDate: org.date,
        periodId: org.periodId,
        origin: "manual",
        currency: "CAD",
        closeModules: ["gl"],
        lines: [
          { accountId: org.accounts.bank, amount: "-10" },
          { accountId: org.accounts.cogs, amount: "10" },
        ],
      }));
      const two = await withOrgContext(org.orgId, () => postEntry(db, {
        orgId: org.orgId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        entryNumber: `PLAIN-B-${randomUUID().slice(0, 8)}`,
        postingDate: org.date,
        periodId: org.periodId,
        origin: "manual",
        currency: "CAD",
        closeModules: ["gl"],
        lines: [
          { accountId: org.accounts.bank, amount: "-10" },
          { accountId: org.accounts.cogs, amount: "10" },
        ],
      }));
      assert.notEqual(one.entryId, two.entryId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

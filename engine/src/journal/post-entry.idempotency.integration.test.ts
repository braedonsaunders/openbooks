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
  amount = "10",
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
      { accountId: org.accounts.bank, amount: `-${amount}` },
      { accountId: org.accounts.cogs, amount },
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

test(
  "a reused idempotency key returns the original only for an identical posting",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const key = `idem-${randomUUID()}`;
      const first = await keyedPost(org, `IDEM-${randomUUID().slice(0, 8)}`, key);
      // A retry may allocate a fresh entry number and pad amounts differently.
      const retry = await keyedPost(org, `IDEM-${randomUUID().slice(0, 8)}`, key, "10.00");
      assert.equal(retry.entryId, first.entryId);
      await assert.rejects(
        () => keyedPost(org, `IDEM-${randomUUID().slice(0, 8)}`, key, "25"),
        new RegExp(`this idempotency key was already used for a different entry \\(entry ${first.entryId}\\)`),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a foreign-currency line without its transaction amount and rate is refused by name",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await assert.rejects(
        () => withOrgContext(org.orgId, () => postEntry(db, {
          orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
          entryNumber: `FX-${randomUUID().slice(0, 8)}`, postingDate: org.date, periodId: org.periodId,
          origin: "manual", currency: "CAD", closeModules: ["gl"],
          lines: [
            { accountId: org.accounts.bank, amount: "-10", currency: "USD" },
            { accountId: org.accounts.cogs, amount: "10" },
          ],
        })),
        /line 1: USD differs from the subsidiary's functional currency CAD — supply the transaction amount and the exchange rate/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

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
      { accountId: org.accounts.bank, amount: "-" + amount },
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

test("reusing a journal key with different financial content refuses without changing the posted entry", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const key = `idem-${randomUUID()}`;
    const first = await keyedPost(org, "CONTENT-ORIGINAL", key);
    await assert.rejects(() => withOrgContext(org.orgId, () => postEntry(db, {
      orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
      entryNumber: "CONTENT-CONFLICT", postingDate: org.date, periodId: org.periodId,
      origin: "manual", currency: "CAD", closeModules: ["gl"], idempotencyKey: key,
      lines: [{ accountId: org.accounts.bank, amount: "-20" }, { accountId: org.accounts.cogs, amount: "20" }],
    })), /different posting content.*review that journal entry/);
    const rows = await withOrgContext(org.orgId, () => db.execute<{ id: string; amount: string; hash: string }>(sql`
      select je.id, jl.amount::text as amount, je.custom->>'postingRequestHash' as hash
      from journal_entries je join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id
      where je.org_id = ${org.orgId} and je.custom->>'idempotencyKey' = ${key} order by jl.line_number`));
    assert.equal(rows.rows.length, 2);
    assert.deepEqual(rows.rows.map(r => r.amount), ["-10.0000", "10.0000"]);
    assert.ok(rows.rows.every(r => r.id === first.entryId && /^[0-9a-f]{64}$/.test(r.hash)));
  } finally { await dropScratchOrg(org.orgId); }
});

test("concurrent different financial requests sharing a key admit only one posting", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const key = `idem-${randomUUID()}`;
    const outcomes = await Promise.allSettled([keyedPost(org, "RACE-FIRST", key, "10"), keyedPost(org, "RACE-SECOND", key, "20")]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    const refused = outcomes.find(r => r.status === "rejected") as PromiseRejectedResult;
    assert.match(String(refused.reason), /different posting content.*review that journal entry/);
    const count = await withOrgContext(org.orgId, () => db.execute<{ n: number }>(sql`select count(*)::int n from journal_entries where org_id=${org.orgId} and custom->>'idempotencyKey'=${key}`));
    assert.equal(count.rows[0]!.n, 1);
  } finally { await dropScratchOrg(org.orgId); }
});

test("historical keyed entries with no request stamp or an older fingerprint compare stored financial content", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    for (const legacy of [{}, { idempotencyFingerprint: "sha256:" + "0".repeat(64) }]) {
      const key = `legacy-${randomUUID()}`;
      const request = { orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
        entryNumber: `HISTORICAL-${randomUUID().slice(0, 8)}`, postingDate: org.date, periodId: org.periodId, origin: "manual", currency: "CAD",
        lines: [{ accountId: org.accounts.bank, amount: "-10" }, { accountId: org.accounts.cogs, amount: "10" }] };
      const first = await withOrgContext(org.orgId, () => postEntry(db, { ...request, custom: { ...legacy, idempotencyKey: key } }));
      assert.equal((await withOrgContext(org.orgId, () => postEntry(db, { ...request, entryNumber: "RETRY", idempotencyKey: key }))).entryId, first.entryId);
      await assert.rejects(() => withOrgContext(org.orgId, () => postEntry(db, { ...request, memo: "Different purpose", idempotencyKey: key })), /different posting content/);
      await assert.rejects(() => withOrgContext(org.orgId, () => postEntry(db, { ...request, idempotencyKey: key,
        lines: [{ accountId: org.accounts.bank, amount: "-25" }, { accountId: org.accounts.cogs, amount: "25" }] })), /different posting content/);
    }
  } finally { await dropScratchOrg(org.orgId); }
});

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
        new RegExp(`idempotency key.*entry ${first.entryId}.*different posting content`),
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

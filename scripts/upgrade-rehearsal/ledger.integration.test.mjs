import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { compareSnapshots, fingerprintColumnsOf, snapshotLedger } from "./ledger.mjs";

// Totals-preserving rewrites are the changes aggregates cannot see. Each case
// runs the real snapshot SQL over a throwaway schema, rewrites history
// without moving a single sum or count, and requires ledger parity to refuse.

const ORG = "00000000-0000-4000-8000-000000000001";
const BOOK = "00000000-0000-4000-8000-00000000000b";
const ids = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function withScratchSchema(fn) {
  const client = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  await client.connect();
  const schema = `upgrade_fp_${randomBytes(6).toString("hex")}`;
  try {
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path = ${schema}`);
    await client.query(`
      create table orgs (id uuid primary key);
      create table journal_entries (id uuid primary key, org_id uuid not null, book_id uuid not null, status text not null);
      create table journal_lines (id uuid primary key, org_id uuid not null, entry_id uuid not null,
        subsidiary_id uuid, account_id uuid not null, currency text not null,
        amount numeric(19,4) not null, txn_amount numeric(19,4) not null, updated_at timestamptz);
      create table documents (id uuid primary key, org_id uuid not null, kind text not null, status text not null,
        currency text not null, total numeric(19,4) not null, open_balance numeric(19,4),
        party_id uuid, subsidiary_id uuid, updated_at timestamptz);
      create table applications (id uuid primary key, org_id uuid not null, amount numeric(19,4) not null,
        from_line_id uuid not null, to_line_id uuid not null);
    `);
    await client.query(`insert into orgs values ($1)`, [ORG]);
    await client.query(`insert into journal_entries values ($1, $2, $3, 'posted'), ($4, $2, $3, 'posted')`, [ids(1), ORG, BOOK, ids(2)]);
    await client.query(`insert into journal_lines values
      ($1, $5, $2, $6, $7, 'USD', 100, 100, now()), ($3, $5, $2, $6, $8, 'USD', -100, -100, now()),
      ($4, $5, $9, $10, $7, 'USD', 100, 100, now()), ($11, $5, $9, $10, $8, 'USD', -100, -100, now())`,
      [ids(11), ids(1), ids(12), ids(13), ORG, ids(90), ids(80), ids(81), ids(2), ids(91), ids(14)]);
    await client.query(`insert into documents values
      ($1, $3, 'customer_invoice', 'posted', 'USD', 100, 100, $4, $6, now()),
      ($2, $3, 'customer_invoice', 'posted', 'USD', 100, 100, $5, $7, now())`,
      [ids(21), ids(22), ORG, ids(70), ids(71), ids(90), ids(91)]);
    await client.query(`insert into applications values ($1, $3, 40, $4, $5), ($2, $3, 40, $6, $7)`,
      [ids(31), ids(32), ORG, ids(11), ids(12), ids(13), ids(14)]);
    return await fn(client, schema);
  } finally {
    await client.query(`drop schema if exists ${schema} cascade`);
    await client.end();
  }
}

async function beforeAndAfter(client, schema, rewrite) {
  const before = await snapshotLedger(client, { schema });
  await client.query(`set search_path = ${schema}`);
  await rewrite(client);
  const after = await snapshotLedger(client, { schema, columns: fingerprintColumnsOf(before) });
  return compareSnapshots(before, after).map((difference) => difference.section);
}

test("an untouched ledger compares clean, and a trigger-bumped updated_at is not a change", async () => {
  await withScratchSchema(async (client, schema) => {
    const sections = await beforeAndAfter(client, schema, (c) => c.query("update documents set updated_at = now() + interval '1 day'"));
    assert.deepEqual(sections, []);
  });
});

test("swapping two equal invoices' parties keeps every total yet is refused", async () => {
  await withScratchSchema(async (client, schema) => {
    const sections = await beforeAndAfter(client, schema, (c) =>
      c.query(`update documents set party_id = case id when $1::uuid then $4::uuid else $3::uuid end where id in ($1, $2)`,
        [ids(21), ids(22), ids(70), ids(71)]));
    assert.deepEqual(sections, ["rowHashes.documents"]);
  });
});

test("moving an invoice to another subsidiary keeps every total yet is refused", async () => {
  await withScratchSchema(async (client, schema) => {
    const sections = await beforeAndAfter(client, schema, (c) =>
      c.query(`update documents set subsidiary_id = $2 where id = $1`, [ids(21), ids(91)]));
    assert.deepEqual(sections, ["rowHashes.documents"]);
  });
});

test("re-pointing two equal applications' settlement edges is refused", async () => {
  await withScratchSchema(async (client, schema) => {
    const sections = await beforeAndAfter(client, schema, (c) =>
      c.query(`update applications set to_line_id = case id when $1::uuid then $4::uuid else $3::uuid end where id in ($1, $2)`,
        [ids(31), ids(32), ids(12), ids(14)]));
    assert.deepEqual(sections, ["rowHashes.applications"]);
  });
});

test("a line moved between subsidiaries is refused by the trial balance and the row hashes", async () => {
  await withScratchSchema(async (client, schema) => {
    const sections = await beforeAndAfter(client, schema, (c) =>
      c.query(`update journal_lines set subsidiary_id = $2 where entry_id = $1`, [ids(1), ids(91)]));
    assert.ok(sections.includes("trialBalance"), sections.join(", "));
    assert.ok(sections.includes("rowHashes.journal_lines"), sections.join(", "));
  });
});

test("a column the upgrade drops is refused by name", async () => {
  await withScratchSchema(async (client, schema) => {
    const differences = [];
    const before = await snapshotLedger(client, { schema });
    await client.query(`set search_path = ${schema}`);
    await client.query("alter table documents drop column party_id");
    const after = await snapshotLedger(client, { schema, columns: fingerprintColumnsOf(before) });
    differences.push(...compareSnapshots(before, after));
    assert.equal(differences.length, 1);
    assert.match(differences[0].key, /documents: columns dropped by the upgrade/);
    assert.deepEqual(differences[0].before, ["party_id"]);
  });
});

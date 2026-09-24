import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { allocateDocumentNumber, reconcileDocumentSequences } from "./numbering.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * OM-01 sample-to-live number identity: the sample generator numbers its
 * documents from private in-memory counters (INV-000001…, BILL-000001…,
 * EXP-000001…) and never advances `number_sequences`, so the first live UI
 * document restarted at …-00001. `reconcileDocumentSequences` runs when the
 * sample completes (and again after the template is cloned) and floors every
 * canonical counter at the highest issued number — the next live document of
 * each kind continues the sample's run. Never renumbers existing history.
 */

async function seedNumberedDocument(orgId: string, kind: string, number: string): Promise<void> {
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, currency, subtotal, tax_total, total)
    values (${randomUUID()}, ${orgId}, ${kind}, 'draft', ${number}, '2026-07-15', 'CAD', '0', '0', '0')`);
}

async function sequenceRow(orgId: string, kind: string) {
  const rows = (await db.execute<{ prefix: string; next_number: number; allocated_through: number }>(sql`
    select prefix, next_number, allocated_through
      from number_sequences
     where org_id = ${orgId} and document_kind = ${kind}`));
  return rows.rows;
}

async function documentNumbers(orgId: string): Promise<string[]> {
  const rows = (await db.execute<{ n: string }>(sql`
    select document_number as n from documents where org_id = ${orgId} order by document_number`));
  return rows.rows.map((r) => r.n);
}

test("sample-issued numbers continue into live allocation without renumbering", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // A sample company's footprint: private-counter numbers under the live
    // prefixes (six-digit padding, like the generator emits) plus one-off
    // sample prefixes that must never steer a canonical sequence.
    for (const n of ["INV-000001", "INV-000002", "INV-000003"]) {
      await seedNumberedDocument(org.orgId, "customer_invoice", n);
    }
    for (const n of ["BILL-000001", "BILL-000002"]) {
      await seedNumberedDocument(org.orgId, "vendor_bill", n);
    }
    await seedNumberedDocument(org.orgId, "expense_report", "EXP-000001");
    await seedNumberedDocument(org.orgId, "customer_credit", "WOFF-deadbeef");
    await seedNumberedDocument(org.orgId, "customer_invoice", "FP-PROJ-20260101");
    await seedNumberedDocument(org.orgId, "customer_invoice", "TM-A-20260101");

    const before = await documentNumbers(org.orgId);

    const reconciled = await reconcileDocumentSequences(db, org.orgId);
    const byKind = new Map(reconciled.map((r) => [r.documentKind, r]));
    assert.equal(byKind.get("customer_invoice")?.nextNumber, 3);
    assert.equal(byKind.get("vendor_bill")?.nextNumber, 2);
    assert.equal(byKind.get("expense_report")?.nextNumber, 1);

    // The next live document of each sampled kind continues the run.
    assert.equal(await allocateDocumentNumber(db, org.orgId, "customer_invoice", "INV-"), "INV-00004");
    assert.equal(await allocateDocumentNumber(db, org.orgId, "vendor_bill", "BILL-"), "BILL-00003");
    assert.equal(await allocateDocumentNumber(db, org.orgId, "expense_report", "EXP-"), "EXP-00002");

    // One-off sample prefixes steer nothing: no customer_credit sequence was
    // created for WOFF-*, so live credit memos start their own canonical run.
    assert.deepEqual(await sequenceRow(org.orgId, "customer_credit"), []);
    assert.equal(await allocateDocumentNumber(db, org.orgId, "customer_credit", "CM-"), "CM-00001");

    // Reconciliation is idempotent — a second pass (the post-clone call)
    // changes nothing, and no document was ever renumbered.
    await reconcileDocumentSequences(db, org.orgId);
    assert.equal(await allocateDocumentNumber(db, org.orgId, "customer_invoice", "INV-"), "INV-00005");
    assert.deepEqual([...(await documentNumbers(org.orgId))].sort(), [...before].sort());
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("counters that already lead stay put", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedNumberedDocument(org.orgId, "journal", "JE-00001");
    await db.execute(sql`
      insert into number_sequences (org_id, document_kind, prefix, next_number, allocated_through)
      values (${org.orgId}, 'journal', 'JE-', 500, 500)`);

    await reconcileDocumentSequences(db, org.orgId);

    const rows = await sequenceRow(org.orgId, "journal");
    assert.equal(rows[0]?.next_number, 500);
    assert.equal(await allocateDocumentNumber(db, org.orgId, "journal", "JE-"), "JE-00501");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unmapped kind with issued numbers floors its handoff row past the max", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // custrec:equipment has no canonical prefix entry and no sequence row,
    // but live EQU-00001/02 are already issued. The handoff used to skip the
    // kind entirely, so the next live allocation lazily restarted at
    // EQU-00001 and died on the documents unique index mid-close.
    await seedNumberedDocument(org.orgId, "custrec:equipment", "EQU-00001");
    await seedNumberedDocument(org.orgId, "custrec:equipment", "EQU-00002");

    await reconcileDocumentSequences(db, org.orgId);

    const rows = await sequenceRow(org.orgId, "custrec:equipment");
    assert.equal(rows[0]?.prefix, "EQU-");
    assert.equal(rows[0]?.next_number, 2);
    const next = await allocateDocumentNumber(db, org.orgId, "custrec:equipment", "EQU-");
    assert.equal(next, "EQU-00003");
    await seedNumberedDocument(org.orgId, "custrec:equipment", next);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a lazy first allocation floors past issued numbers without any handoff", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedNumberedDocument(org.orgId, "custrec:equipment", "EQU-00001");
    await seedNumberedDocument(org.orgId, "custrec:equipment", "EQU-00002");

    // No reconcileDocumentSequences call: the allocator itself must floor
    // from max(issued) for the kind and prefix instead of restarting at 1.
    const next = await allocateDocumentNumber(db, org.orgId, "custrec:equipment", "EQU-");
    assert.equal(next, "EQU-00003");
    await seedNumberedDocument(org.orgId, "custrec:equipment", next);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a kind with two issued prefixes stays out of the handoff for the lazy floor", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // No single shared prefix: inferring either one would steer the other
    // run's numbers, so the handoff creates no row and the live allocator
    // floors under its own prefix at first use.
    await seedNumberedDocument(org.orgId, "custrec:mixed", "XX-00001");
    await seedNumberedDocument(org.orgId, "custrec:mixed", "YY-00007");

    await reconcileDocumentSequences(db, org.orgId);

    assert.deepEqual(await sequenceRow(org.orgId, "custrec:mixed"), []);
    assert.equal(await allocateDocumentNumber(db, org.orgId, "custrec:mixed", "XX-"), "XX-00002");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

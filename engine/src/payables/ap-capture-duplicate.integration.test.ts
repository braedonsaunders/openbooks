import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { NormalizedCapture } from "./ap-capture.ts";
import { CaptureMaterializationError, materializeCapture } from "./ap-capture-service.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Same-source AP capture duplicates.
 *
 * materializeCapture serializes on two advisory fences taken in canonical
 * (sorted) order: vendor + normalized invoice number, and org + content
 * hash. The hash fence is what stops two captures of ONE source file whose
 * invoice numbers diverge (duplicate upload plus a review correction, or
 * divergent OCR reads) from both passing the duplicate SELECTs before
 * either commits. Both fences carry the org id, so separate orgs never
 * block each other. The loser of either race rolls back before any write,
 * so it leaves no document, lines, attachments, or draft_created event.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

function normalized(invoiceNumber: string, accountId: string): NormalizedCapture {
  return {
    vendorName: "Acme Vendor",
    vendorTaxId: null,
    invoiceNumber,
    invoiceDate: "2026-07-15",
    dueDate: null,
    purchaseOrderNumber: null,
    currency: "CAD",
    subtotal: "10.0000",
    taxTotal: "0.0000",
    total: "10.0000",
    memo: null,
    lines: [{
      description: "Duplicate-source line",
      productCode: null,
      quantity: "1.0000",
      unit: "ea",
      unitPrice: "10.0000",
      amount: "10.0000",
      taxAmount: "0.0000",
      accountId,
      itemId: null,
      purchaseOrderLineId: null,
      confidence: "1.0000",
    }],
  };
}

async function seedOrg(org: ScratchOrg): Promise<{ folderId: string; fileId: string }> {
  const folderId = randomUUID();
  const fileId = randomUUID();
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, ap_account_id, default_expense_account_id)
    values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${org.accounts.cogs})
  `);
  await db.execute(sql`
    insert into folders (id, org_id, name) values (${folderId}, ${org.orgId}, 'AP duplicate fence')
  `);
  await db.execute(sql`
    insert into files (id, org_id, folder_id, name, content_type, size_bytes)
    values (${fileId}, ${org.orgId}, ${folderId}, 'same-invoice.pdf', 'application/pdf', 4)
  `);
  return { folderId, fileId };
}

async function insertCapture(
  org: ScratchOrg,
  fileId: string,
  invoiceNumber: string,
  contentHash: string,
  withDuplicateVerdict: boolean,
): Promise<string> {
  const captureId = randomUUID();
  const issues = withDuplicateVerdict
    ? [{ code: "possible_duplicate", severity: "blocking", field: "invoiceNumber" }]
    : [];
  await db.execute(sql`
    insert into ap_capture_items
      (id, org_id, file_id, status, original_filename, content_hash,
       document_kind, normalized, validation_issues, vendor_candidate_id,
       created_by, updated_by)
    values (${captureId}, ${org.orgId}, ${fileId}, 'needs_review', ${invoiceNumber + ".pdf"},
            ${contentHash}, 'vendor_bill',
            ${JSON.stringify(normalized(invoiceNumber, org.accounts.cogs))}::jsonb,
            ${JSON.stringify(issues)}::jsonb, ${org.vendorId},
            null, null)
  `);
  return captureId;
}

/**
 * Release both racers in the same tick to create overlap between their
 * transactions. The barrier does not prove any particular lock
 * interleaving — it only makes same-tick entry likely — so the assertions
 * below hold for every interleaving: a sequential run refuses the second
 * materialize through the same duplicate check, and the pre-fix run of
 * this file (both racers winning) is the evidence the overlap is real.
 */
type Materialized = { documentId: string; documentNumber: string };

async function racePair(
  orgId: string,
  firstId: string,
  secondId: string,
): Promise<[PromiseSettledResult<Materialized>, PromiseSettledResult<Materialized>]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = (captureItemId: string): Promise<Materialized> => (async () => {
    await gate;
    return materializeCapture({ orgId, captureItemId, actorId: null, allowedSubsidiaryIds: null });
  })();
  const first = run(firstId);
  const second = run(secondId);
  release();
  const settled = await Promise.allSettled([first, second]);
  return [settled[0]!, settled[1]!];
}

function assertExactlyOneDuplicateRefusal(
  raced: [PromiseSettledResult<Materialized>, PromiseSettledResult<Materialized>],
): { documentId: string } {
  const won = raced.filter((result) => result.status === "fulfilled");
  const lost = raced.filter((result) => result.status === "rejected");
  assert.equal(won.length, 1, `exactly one racer wins, got ${won.length}`);
  assert.equal(lost.length, 1, "exactly one racer loses");
  const refusal = (lost[0] as PromiseRejectedResult).reason;
  assert.ok(
    refusal instanceof CaptureMaterializationError,
    `the loser gets a usable duplicate refusal, got ${String(refusal)}`,
  );
  assert.match(refusal.message, /already uses this source or vendor invoice number/);
  return { documentId: (won[0] as PromiseFulfilledResult<{ documentId: string }>).value.documentId };
}

async function cleanup(orgId: string): Promise<void> {
  // dropScratchOrg owns capture-evidence teardown: it disables the exact
  // append-only triggers inside its own transaction and deletes the
  // org-scoped events, runs, fields, and items before their source files.
  // No test-local DDL is needed, and the triggers are never weakened.
  await dropScratchOrg(orgId);
}

test("same source file with divergent invoice numbers admits exactly one draft", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { fileId } = await seedOrg(org);
    // One upload; the second copy carries a review-corrected invoice number
    // plus the stored possible_duplicate verdict, mirroring production.
    const contentHash = `dupfence-${randomUUID().replaceAll("-", "")}`;
    const itemA = await insertCapture(org, fileId, "DUP-INV-A", contentHash, true);
    const itemB = await insertCapture(org, fileId, "DUP-INV-B", contentHash, false);
    const raced = await racePair(org.orgId, itemA, itemB);
    const { documentId } = assertExactlyOneDuplicateRefusal(raced);
    const loserId = ((await db.execute<{ id: string }>(sql`
      select id from ap_capture_items where org_id = ${org.orgId} and document_id is null
    `)).rows.map((row) => row.id));
    assert.equal(loserId.length, 1, "the loser stays unmaterialized and reusable");
    // No orphan writes on the loser: one bill, its lines, its attachment,
    // and exactly one draft_created event for the winner.
    const bills = (await db.execute<{ id: string }>(sql`
      select id from documents
       where org_id = ${org.orgId} and kind = 'vendor_bill' and status <> 'voided'
    `)).rows;
    assert.equal(bills.length, 1, "one source file produces one draft bill");
    assert.equal(bills[0]!.id, documentId);
    const lines = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from document_lines where org_id = ${org.orgId}
    `)).rows[0]!.n;
    assert.equal(lines, "1");
    const attachments = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from file_attachments
       where org_id = ${org.orgId} and target_table = 'documents'
    `)).rows[0]!.n;
    assert.equal(attachments, "1");
    const drafts = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from ap_capture_events
       where org_id = ${org.orgId} and event_kind = 'draft_created'
    `)).rows[0]!.n;
    assert.equal(drafts, "1", "only the winner records a draft_created event");
    // Sequential replay of the winner stays idempotent on the existing path.
    const replay = await materializeCapture({ orgId: org.orgId, captureItemId: (await db.execute<{ id: string }>(sql`
      select id from ap_capture_items where org_id = ${org.orgId} and document_id = ${documentId}
    `)).rows[0]!.id, actorId: null, allowedSubsidiaryIds: null });
    assert.equal(replay.documentId, documentId, "replaying a materialized capture returns the same draft");
  } finally {
    await cleanup(org.orgId);
  }
});

test("sequential duplicate of the same source file is refused", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { fileId } = await seedOrg(org);
    const contentHash = `dupseq-${randomUUID().replaceAll("-", "")}`;
    const first = await insertCapture(org, fileId, "SEQ-INV-A", contentHash, false);
    const second = await insertCapture(org, fileId, "SEQ-INV-B", contentHash, true);
    const won = await materializeCapture({ orgId: org.orgId, captureItemId: first, actorId: null, allowedSubsidiaryIds: null });
    assert.ok(won.documentId);
    await assert.rejects(
      materializeCapture({ orgId: org.orgId, captureItemId: second, actorId: null, allowedSubsidiaryIds: null }),
      (error: unknown) => error instanceof CaptureMaterializationError
        && /already uses this source or vendor invoice number/.test(error.message),
    );
    const count = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from documents
       where org_id = ${org.orgId} and kind = 'vendor_bill' and status <> 'voided'
    `)).rows[0]!.n;
    assert.equal(count, "1");
  } finally {
    await cleanup(org.orgId);
  }
});

test("same vendor invoice from different source files still admits exactly one draft", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { fileId } = await seedOrg(org);
    const itemA = await insertCapture(org, fileId, "SAME-INV", `hash-a-${randomUUID().replaceAll("-", "")}`, false);
    const itemB = await insertCapture(org, fileId, "SAME-INV", `hash-b-${randomUUID().replaceAll("-", "")}`, false);
    const raced = await racePair(org.orgId, itemA, itemB);
    assertExactlyOneDuplicateRefusal(raced);
    const count = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from documents
       where org_id = ${org.orgId} and kind = 'vendor_bill' and status <> 'voided'
         and regexp_replace(lower(nullif(reference_number, '')), '[^a-z0-9]', '', 'g') = 'sameinv'
    `)).rows[0]!.n;
    assert.equal(count, "1", "exactly one draft bill survives the same-invoice race");
  } finally {
    await cleanup(org.orgId);
  }
});

test("unrelated captures both materialize", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { fileId } = await seedOrg(org);
    const itemA = await insertCapture(org, fileId, "UNRELATED-A", `hash-u-a-${randomUUID().replaceAll("-", "")}`, false);
    const itemB = await insertCapture(org, fileId, "UNRELATED-B", `hash-u-b-${randomUUID().replaceAll("-", "")}`, false);
    const raced = await racePair(org.orgId, itemA, itemB);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 2, "unrelated captures both pass");
    const count = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from documents
       where org_id = ${org.orgId} and kind = 'vendor_bill' and status <> 'voided'
    `)).rows[0]!.n;
    assert.equal(count, "2");
  } finally {
    await cleanup(org.orgId);
  }
});

test("the source fence is org-scoped: identical hash and invoice in two orgs both pass", { skip: !DB }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const seedA = await seedOrg(orgA);
    const seedB = await seedOrg(orgB);
    const contentHash = `xorg-${randomUUID().replaceAll("-", "")}`;
    const itemA = await insertCapture(orgA, seedA.fileId, "XORG-INV", contentHash, false);
    const itemB = await insertCapture(orgB, seedB.fileId, "XORG-INV", contentHash, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runA = (async () => {
      await gate;
      return materializeCapture({ orgId: orgA.orgId, captureItemId: itemA, actorId: null, allowedSubsidiaryIds: null });
    })();
    const runB = (async () => {
      await gate;
      return materializeCapture({ orgId: orgB.orgId, captureItemId: itemB, actorId: null, allowedSubsidiaryIds: null });
    })();
    release();
    const raced = await Promise.allSettled([runA, runB]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 2, "no false cross-org collision");
    for (const [org, label] of [[orgA, "A"], [orgB, "B"]] as const) {
      const count = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from documents
         where org_id = ${org.orgId} and kind = 'vendor_bill' and status <> 'voided'
      `)).rows[0]!.n;
      assert.equal(count, "1", `org ${label} holds its own draft`);
    }
  } finally {
    await cleanup(orgA.orgId);
    await cleanup(orgB.orgId);
  }
});

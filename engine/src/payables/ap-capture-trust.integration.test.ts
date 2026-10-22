import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { NormalizedCapture } from "./ap-capture.ts";
import { materializeCapture } from "./ap-capture-service.ts";
import { considerCaptureAutoPost } from "./ap-capture-autopost.ts";
import { resolveAutoPostPolicy, vendorCaptureTrust } from "./ap-capture-trust.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Trust and the auto-post policy read from the real schema: policy versions
 * resolve by effective date and cannot be rewritten; trust evidence comes
 * from capture history (corrections, draft edits, document status), never
 * from a stored flag; and the auto-post decision is recorded on the capture
 * whenever the policy is on.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

function capture(invoiceNumber: string, accountId: string): NormalizedCapture {
  return {
    vendorName: "Trust Vendor",
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
      description: "Monthly service",
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

async function seed(org: ScratchOrg): Promise<string> {
  const fileFolder = randomUUID();
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, ap_account_id, default_expense_account_id)
    values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${org.accounts.cogs})
  `);
  await db.execute(sql`insert into folders (id, org_id, name) values (${fileFolder}, ${org.orgId}, 'Trust captures')`);
  return fileFolder;
}

async function insertCapture(org: ScratchOrg, folderId: string, invoiceNumber: string, status = "ready"): Promise<string> {
  const fileId = randomUUID();
  const captureId = randomUUID();
  await db.execute(sql`
    insert into files (id, org_id, folder_id, name, content_type, size_bytes)
    values (${fileId}, ${org.orgId}, ${folderId}, ${`${invoiceNumber}.pdf`}, 'application/pdf', 4)
  `);
  await db.execute(sql`
    insert into ap_capture_items
      (id, org_id, file_id, status, original_filename, content_hash, document_kind, normalized,
       validation_issues, vendor_candidate_id)
    values (${captureId}, ${org.orgId}, ${fileId}, ${status}, ${`${invoiceNumber}.pdf`}, ${randomUUID()}, 'vendor_bill',
            ${JSON.stringify(capture(invoiceNumber, org.accounts.cogs))}::jsonb, '[]'::jsonb, ${org.vendorId})
  `);
  return captureId;
}

test("policy versions resolve by effective date and are never rewritten", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await resolveAutoPostPolicy(db, org.orgId, "2026-10-01"), null, "no version reads as off");
    await db.execute(sql`
      insert into ap_capture_autopost_policies (org_id, effective_from, enabled, clean_streak, reason)
      values (${org.orgId}, '2026-09-01', true, 3, 'Trusted vendors post'),
             (${org.orgId}, '2026-11-01', false, 3, 'Paused for audit')
    `);
    assert.equal((await resolveAutoPostPolicy(db, org.orgId, "2026-08-31")), null);
    assert.equal((await resolveAutoPostPolicy(db, org.orgId, "2026-10-15"))?.enabled, true);
    assert.equal((await resolveAutoPostPolicy(db, org.orgId, "2026-11-01"))?.enabled, false);
    await assert.rejects(db.execute(sql`update ap_capture_autopost_policies set enabled = true where org_id = ${org.orgId}`));
    await assert.rejects(db.execute(sql`
      insert into ap_capture_autopost_policies (org_id, effective_from, enabled, clean_streak, max_amount, reason)
      values (${org.orgId}, '2026-12-01', true, 3, 500, 'Limit without currency')
    `), "a limit without its currency is refused");
    await assert.rejects(db.execute(sql`
      insert into ap_capture_autopost_policies (org_id, effective_from, enabled, clean_streak, reason)
      values (${org.orgId}, '2026-12-02', true, 1, 'Too short a streak')
    `), "a streak below two is refused");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("trust evidence comes from capture history: an unposted draft and a correction each break the streak", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const folderId = await seed(org);
    const older = await insertCapture(org, folderId, "T-1");
    await materializeCapture({ orgId: org.orgId, captureItemId: older, actorId: null, allowedSubsidiaryIds: null });
    const newer = await insertCapture(org, folderId, "T-2");
    await materializeCapture({ orgId: org.orgId, captureItemId: newer, actorId: null, allowedSubsidiaryIds: null });

    const pending = await vendorCaptureTrust(db, org.orgId, org.vendorId, 2);
    assert.equal(pending.trusted, false);
    assert.deepEqual(pending.brokenBy, { captureItemId: newer, reason: "not_posted" }, "a draft awaiting posting is not evidence");

    const reviewer = await createScratchUser(org.orgId, 'Reviewer', 'admin');
    await db.execute(sql`
      insert into ap_capture_corrections (org_id, capture_item_id, field_key, before_value, after_value, corrected_by)
      values (${org.orgId}, ${newer}, 'invoiceNumber', '"T-2"'::jsonb, '"T-2A"'::jsonb, ${reviewer})
    `);
    const edited = await vendorCaptureTrust(db, org.orgId, org.vendorId, 2);
    assert.deepEqual(edited.brokenBy, { captureItemId: newer, reason: "edited" }, "a review correction ends the streak");

    const excluded = await vendorCaptureTrust(db, org.orgId, org.vendorId, 2, newer);
    assert.equal(excluded.brokenBy?.captureItemId, older, "the capture being decided is left out of its own evidence");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("with the policy off nothing is recorded; with it on an untrusted vendor's capture stays in review with the reason", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const folderId = await seed(org);
    const captureId = await insertCapture(org, folderId, "T-9");
    let materialized = 0;
    const materialize = async () => {
      materialized += 1;
      return materializeCapture({ orgId: org.orgId, captureItemId: captureId, actorId: null, allowedSubsidiaryIds: null });
    };
    const off = await considerCaptureAutoPost({ orgId: org.orgId, captureItemId: captureId, actorId: null, materialize, onDate: "2026-10-21" });
    assert.deepEqual(off, { kind: "not_applicable" });
    await db.execute(sql`
      insert into ap_capture_autopost_policies (org_id, effective_from, enabled, clean_streak, reason)
      values (${org.orgId}, '2026-10-01', true, 2, 'Trusted vendors post')
    `);
    const on = await considerCaptureAutoPost({ orgId: org.orgId, captureItemId: captureId, actorId: null, materialize, onDate: "2026-10-21" });
    assert.deepEqual(on, { kind: "skipped", reason: "vendor_not_trusted" });
    assert.equal(materialized, 0, "no draft is created for an untrusted vendor");
    const events = (await db.execute<{ kind: string; reason: string }>(sql`
      select event_kind as kind, detail->>'reason' as reason from ap_capture_events where capture_item_id = ${captureId}
    `)).rows;
    assert.deepEqual(events, [{ kind: "auto_post_skipped", reason: "vendor_not_trusted" }]);
    const status = (await db.execute<{ status: string }>(sql`select status from ap_capture_items where id = ${captureId}`)).rows[0]!.status;
    assert.equal(status, "ready");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

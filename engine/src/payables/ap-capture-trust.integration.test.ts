import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import type { NormalizedCapture } from "./ap-capture.ts";
import { materializeCapture } from "./ap-capture-service.ts";
import { considerCaptureAutoPost, registerCaptureBillPoster } from "./ap-capture-autopost.ts";
import { resolveAutoPostPolicy, vendorCaptureTrust } from "./ap-capture-trust.ts";
import { beginInboundMessage, createMailbox } from "./ap-inbound-mailbox-service.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

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
    lines: [
      {
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
      },
    ],
  };
}

async function seed(org: ScratchOrg): Promise<string> {
  const fileFolder = randomUUID();
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, ap_account_id, default_expense_account_id)
    values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${org.accounts.cogs})
  `);
  await db.execute(
    sql`insert into folders (id, org_id, name) values (${fileFolder}, ${org.orgId}, 'Trust captures')`,
  );
  return fileFolder;
}

/** Approve and post a materialized bill through the ledger's own posting command, as a reviewer would. */
async function postBill(org: ScratchOrg, actorId: string, documentId: string): Promise<void> {
  await db.execute(
    sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${documentId} and status = 'draft'`,
  );
  await withOrg(org.orgId, () =>
    postDocument(
      documentId,
      { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
      { deferEffects: true, audit: { actorId, source: "api" } },
    ),
  );
}

/** A capture a reviewer accepted unchanged, created as a draft and posted. */
async function reviewedCapture(
  org: ScratchOrg,
  folderId: string,
  actorId: string,
  invoiceNumber: string,
): Promise<string> {
  const captureId = await insertCapture(org, folderId, invoiceNumber);
  const { documentId } = await materializeCapture({
    orgId: org.orgId,
    captureItemId: captureId,
    actorId: null,
    allowedSubsidiaryIds: null,
  });
  await postBill(org, actorId, documentId);
  return captureId;
}

/** A capture the auto-post policy created and posted (or submitted), recorded as automation does. */
async function automatedCapture(
  org: ScratchOrg,
  folderId: string,
  actorId: string,
  invoiceNumber: string,
  kind: "auto_posted" | "auto_post_submitted",
): Promise<string> {
  const captureId = await insertCapture(org, folderId, invoiceNumber);
  const { documentId } = await materializeCapture({
    orgId: org.orgId,
    captureItemId: captureId,
    actorId: null,
    allowedSubsidiaryIds: null,
  });
  if (kind === "auto_posted") await postBill(org, actorId, documentId);
  await db.execute(sql`
    insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
    values (${org.orgId}, ${captureId}, ${kind}, ${JSON.stringify({ documentId })}::jsonb, ${actorId})
  `);
  return captureId;
}

async function insertCapture(
  org: ScratchOrg,
  folderId: string,
  invoiceNumber: string,
  status = "ready",
): Promise<string> {
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

test(
  "policy versions resolve by effective date and are never rewritten",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      assert.equal(
        await resolveAutoPostPolicy(db, org.orgId, "2026-10-01"),
        null,
        "no version reads as off",
      );
      await db.execute(sql`
      insert into ap_capture_autopost_policies (org_id, effective_from, enabled, clean_streak, reason)
      values (${org.orgId}, '2026-09-01', true, 3, 'Trusted vendors post'),
             (${org.orgId}, '2026-11-01', false, 3, 'Paused for audit')
    `);
      assert.equal(await resolveAutoPostPolicy(db, org.orgId, "2026-08-31"), null);
      assert.equal((await resolveAutoPostPolicy(db, org.orgId, "2026-10-15"))?.enabled, true);
      assert.equal((await resolveAutoPostPolicy(db, org.orgId, "2026-11-01"))?.enabled, false);
      await assert.rejects(
        db.execute(
          sql`update ap_capture_autopost_policies set enabled = true where org_id = ${org.orgId}`,
        ),
      );
      await assert.rejects(
        db.execute(sql`
      insert into ap_capture_autopost_policies (org_id, effective_from, enabled, clean_streak, max_amount, reason)
      values (${org.orgId}, '2026-12-01', true, 3, 500, 'Limit without currency')
    `),
        "a limit without its currency is refused",
      );
      await assert.rejects(
        db.execute(sql`
      insert into ap_capture_autopost_policies (org_id, effective_from, enabled, clean_streak, reason)
      values (${org.orgId}, '2026-12-02', true, 1, 'Too short a streak')
    `),
        "a streak below two is refused",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "trust evidence comes from capture history: an unposted draft and a correction each break the streak",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const folderId = await seed(org);
      const older = await insertCapture(org, folderId, "T-1");
      await materializeCapture({
        orgId: org.orgId,
        captureItemId: older,
        actorId: null,
        allowedSubsidiaryIds: null,
      });
      const newer = await insertCapture(org, folderId, "T-2");
      await materializeCapture({
        orgId: org.orgId,
        captureItemId: newer,
        actorId: null,
        allowedSubsidiaryIds: null,
      });

      const pending = await vendorCaptureTrust(db, org.orgId, org.vendorId, 2);
      assert.equal(pending.trusted, false);
      assert.deepEqual(
        pending.brokenBy,
        { captureItemId: newer, reason: "not_posted" },
        "a draft awaiting posting is not evidence",
      );

      const reviewer = await createScratchUser(org.orgId, "Reviewer", "admin");
      await db.execute(sql`
      insert into ap_capture_corrections (org_id, capture_item_id, field_key, before_value, after_value, corrected_by)
      values (${org.orgId}, ${newer}, 'invoiceNumber', '"T-2"'::jsonb, '"T-2A"'::jsonb, ${reviewer})
    `);
      const edited = await vendorCaptureTrust(db, org.orgId, org.vendorId, 2);
      assert.deepEqual(
        edited.brokenBy,
        { captureItemId: newer, reason: "edited" },
        "a review correction ends the streak",
      );

      const excluded = await vendorCaptureTrust(db, org.orgId, org.vendorId, 2, newer);
      assert.equal(
        excluded.brokenBy?.captureItemId,
        older,
        "the capture being decided is left out of its own evidence",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "with the policy off nothing is recorded; with it on an untrusted vendor's capture stays in review with the reason",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const folderId = await seed(org);
      const captureId = await insertCapture(org, folderId, "T-9");
      let materialized = 0;
      const materialize = async () => {
        materialized += 1;
        return materializeCapture({
          orgId: org.orgId,
          captureItemId: captureId,
          actorId: null,
          allowedSubsidiaryIds: null,
        });
      };
      const off = await considerCaptureAutoPost({
        orgId: org.orgId,
        captureItemId: captureId,
        actorId: null,
        materialize,
        onDate: "2026-10-21",
      });
      assert.deepEqual(off, { kind: "not_applicable" });
      await db.execute(sql`
      insert into ap_capture_autopost_policies (org_id, effective_from, enabled, clean_streak, reason)
      values (${org.orgId}, '2026-10-01', true, 2, 'Trusted vendors post')
    `);
      const on = await considerCaptureAutoPost({
        orgId: org.orgId,
        captureItemId: captureId,
        actorId: null,
        materialize,
        onDate: "2026-10-21",
      });
      assert.deepEqual(on, { kind: "skipped", reason: "vendor_not_trusted" });
      assert.equal(materialized, 0, "no draft is created for an untrusted vendor");
      const events = await db.execute<{ kind: string; reason: string }>(
        sql`
      select event_kind as kind, detail->>'reason' as reason from ap_capture_events where capture_item_id = ${captureId}
    `,
        "objects",
      );
      assert.deepEqual(events, [{ kind: "auto_post_skipped", reason: "vendor_not_trusted" }]);
      const status = (
        await db.execute<{ status: string }>(
          sql`select status from ap_capture_items where id = ${captureId}`,
          "objects",
        )
      )[0]!.status;
      assert.equal(status, "ready");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "trust is earned only by reviewed captures: automated postings neither extend nor end the streak, and a break is re-earned by reviewers",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const folderId = await seed(org);
      const poster = await createScratchUser(org.orgId, "AP Poster", "admin");
      const c1 = await reviewedCapture(org, folderId, poster, "H-1");
      const c2 = await reviewedCapture(org, folderId, poster, "H-2");
      const earned = await vendorCaptureTrust(db, org.orgId, org.vendorId, 2);
      assert.equal(earned.trusted, true);
      assert.deepEqual(earned.evidence, [c2, c1]);

      await automatedCapture(org, folderId, poster, "A-1", "auto_posted");
      await automatedCapture(org, folderId, poster, "A-2", "auto_post_submitted");
      await automatedCapture(org, folderId, poster, "A-3", "auto_posted");
      const afterAutomation = await vendorCaptureTrust(db, org.orgId, org.vendorId, 2);
      assert.equal(
        afterAutomation.trusted,
        true,
        "automated postings, posted or awaiting approval, do not end the streak",
      );
      assert.equal(afterAutomation.cleanStreak, 2, "and do not extend it");
      assert.deepEqual(
        afterAutomation.evidence,
        [c2, c1],
        "the evidence remains the reviewed captures",
      );

      const reviewer = await createScratchUser(org.orgId, "Reviewer", "admin");
      const c3 = await reviewedCapture(org, folderId, poster, "H-3");
      await db.execute(sql`
      insert into ap_capture_corrections (org_id, capture_item_id, field_key, before_value, after_value, corrected_by)
      values (${org.orgId}, ${c3}, 'invoiceNumber', '"H-3"'::jsonb, '"H-3A"'::jsonb, ${reviewer})
    `);
      await automatedCapture(org, folderId, poster, "A-4", "auto_posted");
      await automatedCapture(org, folderId, poster, "A-5", "auto_posted");
      const broken = await vendorCaptureTrust(db, org.orgId, org.vendorId, 2);
      assert.equal(
        broken.trusted,
        false,
        "automated postings after a correction cannot restore trust",
      );
      assert.deepEqual(broken.brokenBy, { captureItemId: c3, reason: "edited" });

      const c4 = await reviewedCapture(org, folderId, poster, "H-4");
      assert.equal(
        (await vendorCaptureTrust(db, org.orgId, org.vendorId, 2)).trusted,
        false,
        "one reviewed capture is not yet a streak of two",
      );
      const c5 = await reviewedCapture(org, folderId, poster, "H-5");
      const reEarned = await vendorCaptureTrust(db, org.orgId, org.vendorId, 2);
      assert.equal(reEarned.trusted, true);
      assert.deepEqual(reEarned.evidence, [c5, c4]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an emailed capture auto-posts only when its delivery signature verified against the address's secret",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const folderId = await seed(org);
      const admin = await createScratchUser(org.orgId, "AP Admin", "admin");
      await db.execute(sql`
      insert into ap_capture_autopost_policies (org_id, effective_from, enabled, clean_streak, reason)
      values (${org.orgId}, '2026-10-01', true, 2, 'Trusted vendors post')
    `);
      const mailbox = (signingSecret: string | null) =>
        createMailbox({
          label: signingSecret ? "Signed bills" : "Unsigned bills",
          emailAddress: null,
          provider: "generic",
          allowedSenders: [],
          isActive: true,
          signingSecret,
          orgId: org.orgId,
          actorId: admin,
          subsidiaryId: org.subsidiaryId,
          allowedSubsidiaryIds: null,
        });
      const unsigned = await mailbox(null);
      const signed = await mailbox("generic-signing-secret-0001");
      let materialized = 0;
      const emailed = async (mailboxId: string, invoiceNumber: string, verified: boolean) => {
        const begun = await beginInboundMessage({
          orgId: org.orgId,
          mailboxId,
          attachmentCount: 1,
          contentDigest: "a".repeat(64),
          signature: { verified, nonce: null },
          email: {
            provider: "generic",
            from: "ap@vendor.example",
            subject: invoiceNumber,
            messageId: `<${invoiceNumber}@vendor.example>`,
          },
        });
        const captureId = await insertCapture(org, folderId, invoiceNumber);
        await db.execute(
          sql`update ap_capture_items set source = 'email', subsidiary_id = ${org.subsidiaryId} where id = ${captureId}`,
        );
        await db.execute(sql`
        insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
        values (${org.orgId}, ${captureId}, 'email_received', ${JSON.stringify({ inboundMessageId: begun.id })}::jsonb, ${admin})
      `);
        return captureId;
      };
      const decide = (captureId: string) =>
        considerCaptureAutoPost({
          orgId: org.orgId,
          captureItemId: captureId,
          actorId: admin,
          onDate: "2026-10-21",
          materialize: async () => {
            materialized += 1;
            throw new Error("no draft is expected");
          },
        });
      const reason = async (captureId: string) =>
        (
          await db.execute<{ reason: string }>(
            sql`
      select detail->>'reason' as reason from ap_capture_events where capture_item_id = ${captureId} and event_kind = 'auto_post_skipped'
    `,
            "objects",
          )
        ).map((row) => row.reason);

      const forged = await emailed(unsigned.id, "E-1", false);
      assert.deepEqual(
        await decide(forged),
        { kind: "skipped", reason: "unsigned_email" },
        "the address token alone never auto-posts",
      );
      assert.deepEqual(
        await reason(forged),
        ["unsigned_email"],
        "the reason is recorded on the capture",
      );

      const verified = await emailed(signed.id, "E-2", true);
      assert.deepEqual(
        await decide(verified),
        { kind: "skipped", reason: "vendor_not_trusted" },
        "a verified email passes the channel gate",
      );

      await db.execute(
        sql`delete from ap_capture_mailbox_credentials where org_id = ${org.orgId} and mailbox_id = ${signed.id}`,
      );
      const secretCleared = await emailed(signed.id, "E-3", true);
      assert.deepEqual(
        await decide(secretCleared),
        { kind: "skipped", reason: "unsigned_email" },
        "an address whose secret was removed no longer qualifies",
      );
      assert.equal(materialized, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the created draft's own currency and total are checked against the limit before anything posts",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const posted: string[] = [];
    registerCaptureBillPoster({
      post: async ({ documentId }) => {
        posted.push(documentId);
        return randomUUID();
      },
      afterCommit: async () => undefined,
    });
    try {
      const folderId = await seed(org);
      const admin = await createScratchUser(org.orgId, "AP Admin", "admin");
      await reviewedCapture(org, folderId, admin, "L-1");
      await reviewedCapture(org, folderId, admin, "L-2");
      await db.execute(sql`
      insert into ap_capture_autopost_policies (org_id, effective_from, enabled, clean_streak, max_amount, max_amount_currency, reason)
      values (${org.orgId}, '2026-10-01', true, 2, 15, 'CAD', 'Small trusted bills post')
    `);
      const withinLimit = await insertCapture(org, folderId, "L-4");
      const accepted = await considerCaptureAutoPost({
        orgId: org.orgId,
        captureItemId: withinLimit,
        actorId: admin,
        onDate: "2026-10-21",
        materialize: () =>
          materializeCapture({
            orgId: org.orgId,
            captureItemId: withinLimit,
            actorId: admin,
            allowedSubsidiaryIds: null,
          }),
      });
      assert.equal(
        accepted.kind,
        "posted",
        "a draft within the limit in the policy currency posts",
      );
      assert.equal(posted.length, 1);
      posted.length = 0;

      // The extraction reads 10.00 CAD; the draft command books the bill in
      // another currency, as a purchase order in that currency would.
      const captureId = await insertCapture(org, folderId, "L-3");
      const outcome = await considerCaptureAutoPost({
        orgId: org.orgId,
        captureItemId: captureId,
        actorId: admin,
        onDate: "2026-10-21",
        materialize: async () => {
          const created = await materializeCapture({
            orgId: org.orgId,
            captureItemId: captureId,
            actorId: admin,
            allowedSubsidiaryIds: null,
          });
          await db.execute(
            sql`update documents set currency = 'USD' where org_id = ${org.orgId} and id = ${created.documentId}`,
          );
          return created;
        },
      });
      assert.equal(outcome.kind, "refused");
      const documentId = outcome.kind === "refused" ? outcome.documentId : null;
      assert.ok(documentId, "the draft remains for review");
      assert.deepEqual(posted, [], "nothing posts");
      const document = (
        await db.execute<{ status: string }>(
          sql`select status from documents where id = ${documentId}`,
          "objects",
        )
      )[0]!;
      assert.equal(document.status, "draft");
      const event = await db.execute<{ stage: string; reason: string; message: string }>(
        sql`
      select detail->>'stage' as stage, detail->>'reason' as reason, detail->>'message' as message
        from ap_capture_events where capture_item_id = ${captureId} and event_kind = 'auto_post_refused'
    `,
        "objects",
      );
      assert.equal(event.length, 1);
      assert.equal(event[0]!.stage, "limit");
      assert.equal(event[0]!.reason, "currency_differs");
      assert.match(event[0]!.message, /USD/);
    } finally {
      registerCaptureBillPoster(null);
      await dropScratchOrg(org.orgId);
    }
  },
);

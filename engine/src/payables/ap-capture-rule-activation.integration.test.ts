import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { NormalizedCapture } from "./ap-capture.ts";
import { materializeCapture } from "./ap-capture-service.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * The third confirmation auto-activates a coding rule. That activation must
 * leave a retrievable trail — the rule, the alias, the vendor/account, the
 * capture that triggered it, the actor — written atomically with the
 * activation itself, and reported so the operator sees what future bills
 * will auto-code to.
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
      description: "Activation audit line",
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

async function insertCapture(org: ScratchOrg, fileId: string, invoiceNumber: string): Promise<string> {
  const captureId = randomUUID();
  await db.execute(sql`
    insert into ap_capture_items
      (id, org_id, file_id, status, original_filename, content_hash,
       document_kind, normalized, validation_issues, vendor_candidate_id, purchase_order_id,
       created_by, updated_by)
    values (${captureId}, ${org.orgId}, ${fileId}, 'ready', ${invoiceNumber + ".pdf"},
            ${`ruleact-${randomUUID().replaceAll("-", "")}`}, 'vendor_bill',
            ${JSON.stringify(normalized(invoiceNumber, org.accounts.cogs))}::jsonb,
            '[]'::jsonb, ${org.vendorId}, null,
            null, null)`);
  return captureId;
}

test("the third confirmation writes an activation audit and reports the rule", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "AP Approver", "admin");
    const fileId = randomUUID();
    await db.execute(sql`
      insert into vendor_roles (org_id, party_id, ap_account_id, default_expense_account_id)
      values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${org.accounts.cogs})`);
    await db.execute(sql`
      insert into folders (id, org_id, name) values (${randomUUID()}, ${org.orgId}, 'AP rule activation')`);
    await db.execute(sql`
      insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${org.orgId}, (select id from folders where org_id = ${org.orgId} limit 1),
              'rule-invoice.pdf', 'application/pdf', 4)`);

    const first = await materializeCapture({
      orgId: org.orgId,
      captureItemId: await insertCapture(org, fileId, `RULE-INV-1-${randomUUID().slice(0, 8)}`),
      actorId,
      allowedSubsidiaryIds: null,
    });
    assert.deepEqual(first.rulesActivated, [], "the first confirmation activates nothing");
    const second = await materializeCapture({
      orgId: org.orgId,
      captureItemId: await insertCapture(org, fileId, `RULE-INV-2-${randomUUID().slice(0, 8)}`),
      actorId,
      allowedSubsidiaryIds: null,
    });
    assert.deepEqual(second.rulesActivated, [], "the second confirmation activates nothing");

    const thirdCaptureId = await insertCapture(org, fileId, `RULE-INV-3-${randomUUID().slice(0, 8)}`);
    const third = await materializeCapture({ orgId: org.orgId, captureItemId: thirdCaptureId, actorId, allowedSubsidiaryIds: null });
    const kinds = third.rulesActivated.map((rule) => rule.ruleKind).sort();
    assert.deepEqual(kinds, ["vendor_account", "vendor_alias"]);

    const events = (await db.execute<{
      kind: string; detail: Record<string, unknown>; actorId: string | null; itemId: string;
    }>(sql`
      select event_kind as "kind", detail, actor_id as "actorId", capture_item_id as "itemId"
        from ap_capture_events
       where org_id = ${org.orgId} and event_kind = 'rule_activated'
       order by at`)).rows;
    assert.equal(events.length, 2, "each activation leaves its own audit row");
    for (const event of events) {
      assert.equal(event.itemId, thirdCaptureId, "the audit names the triggering capture");
      assert.equal(event.actorId, actorId, "the audit names the triggering actor");
      assert.equal(event.detail.confirmationCount, 3);
    }
    const aliasEvent = events.find((event) => event.detail.ruleKind === "vendor_alias")!;
    assert.deepEqual(aliasEvent.detail.output, { partyId: org.vendorId });
    assert.equal((aliasEvent.detail.match as { alias: string }).alias, "acmevendor");
    const accountEvent = events.find((event) => event.detail.ruleKind === "vendor_account")!;
    assert.deepEqual(accountEvent.detail.output, { accountId: org.accounts.cogs });

    const rules = (await db.execute<{ kind: string; active: boolean; count: number }>(sql`
      select rule_kind as "kind", is_active as "active", confirmation_count as "count"
        from ap_capture_rules where org_id = ${org.orgId}`)).rows;
    assert.ok(rules.every((rule) => rule.active && rule.count === 3));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

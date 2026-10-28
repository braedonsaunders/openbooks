import { before } from "node:test";

before(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { documentRevisionCounterSql } = await import("@openbooks/engine/records/revision");
const { ALL_EXPENSE_REPORTS } = await import("@openbooks/engine/records/expense-access");
const { loadExpenseReport } = await import("../expenses");
const { executeAssistantTool } = await import("../assistant/registry");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function context(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Test operator",
        orgId,
        roles: [{ key: "purchasing-role", name: "Purchasing role" }],
        envKind: "sandbox",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function seedApprovedExpense(
  orgId: string,
  userId: string,
  date: string,
  subsidiaryId: string,
) {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${orgId}, 'employee', 'Expense owner', true, '{}'::jsonb)
  `);
  await db.execute(
    sql`insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${employeeId})`,
  );
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id,
       currency, subtotal, tax_total, total, custom, created_by)
    values
      (${documentId}, ${orgId}, 'expense_report', 'approved', ${`EXP-${documentId.slice(0, 8)}`},
       ${date}, ${employeeId}, ${subsidiaryId}, 'USD', '12.50', '0', '12.50', '{}'::jsonb, ${userId})
  `);
  const revision = (
    await db.execute<{ revision: string }>(
      sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id = ${documentId} and org_id = ${orgId}`,
      "objects",
    )
  )[0]!.revision;
  return { documentId, revision };
}

async function seedApprovedPurchaseOrder(
  orgId: string,
  actorId: string,
  vendorId: string,
  subsidiaryId: string,
  documentDate: string,
  itemId: string,
  assetAccountId: string,
  stockLocationId: string,
) {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
       currency, status, subtotal, tax_total, total, created_by, updated_by)
    values
      (${orderId}, ${orgId}, 'purchase_order', ${`PO-${orderId.slice(0, 8)}`}, ${vendorId},
       ${subsidiaryId}, ${documentDate}, 'CAD', 'draft', '20', '0', '20', ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
       unit, unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed,
       stock_location_id, custom)
    values
      (${lineId}, ${orgId}, ${orderId}, 1, ${itemId}, ${assetAccountId}, 'Widget', '10',
       'ea', '2', '20', '0', '0', '0', ${stockLocationId}, '{}'::jsonb)
  `);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
    where id = ${orderId} and org_id = ${orgId}
  `);
  return { orderId, lineId };
}

test(
  "expense recall runs once, enforces permission and feature gates, and stays tenant scoped",
  { skip: !DB },
  async () => {
    const first = await withBypassContext(() => createScratchOrg());
    const second = await withBypassContext(() => createScratchOrg());
    try {
      const firstActors = await withBypassContext(() => seedFlowActors(first.orgId));
      const secondActors = await withBypassContext(() => seedFlowActors(second.orgId));
      const seeded = await withBypassContext(() =>
        seedApprovedExpense(first.orgId, firstActors.adminId, first.date, first.subsidiaryId),
      );
      const authorized = context(first.orgId, firstActors.adminId, ["expenses.create"]);
      const run = (ctx: ApplicationContext, key: string) =>
        withOrgContext(ctx.authz.user.orgId, () =>
          executeApplicationTool(applicationTool("recall_expense_report")!, ctx, {
            documentId: seeded.documentId,
            expectedUpdatedAt: seeded.revision,
            idempotencyKey: key,
          }),
        );

      const firstRun = (await run(authorized, "purchasing-recall-001")) as {
        replayed: boolean;
      };
      assert.equal(firstRun.replayed, false);
      const replay = (await run(authorized, "purchasing-recall-001")) as {
        replayed: boolean;
      };
      assert.equal(replay.replayed, true);
      const nativeRead = await withOrgContext(first.orgId, () =>
        loadExpenseReport(seeded.documentId, first.orgId, null, ALL_EXPENSE_REPORTS),
      );
      assert.equal(nativeRead?.doc.status, "draft");

      await assert.rejects(
        run(context(first.orgId, firstActors.adminId, []), "purchasing-recall-denied"),
        /forbidden/,
      );

      await withBypassContext(() =>
        db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features}',
            coalesce(settings->'features', '{}'::jsonb) || '{"expenses":false}'::jsonb, true)
          where id = ${first.orgId}
        `),
      );
      try {
        await assert.rejects(
          run(authorized, "purchasing-recall-feature-off"),
          /expense report not found/,
        );
      } finally {
        await withBypassContext(() =>
          db.execute(sql`
            update orgs set settings = jsonb_set(settings, '{features}',
              coalesce(settings->'features', '{}'::jsonb) || '{"expenses":true}'::jsonb, true)
            where id = ${first.orgId}
          `),
        );
      }

      const foreign = context(second.orgId, secondActors.adminId, ["expenses.create"]);
      await assert.rejects(run(foreign, "purchasing-recall-cross-org"), /expense report not found/);
      const stillDraft = await withOrgContext(first.orgId, () =>
        loadExpenseReport(seeded.documentId, first.orgId, null, ALL_EXPENSE_REPORTS),
      );
      assert.equal(stillDraft?.doc.status, "draft");
    } finally {
      await dropScratchOrg(first.orgId);
      await dropScratchOrg(second.orgId);
    }
  },
);

test(
  "purchase-order receipt runs once and is visible through the native order read",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await withOrgContext(org.orgId, () =>
        db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features}',
            coalesce(settings->'features', '{}'::jsonb) || '{"orders":true,"inventory":true}'::jsonb, true)
          where id = ${org.orgId}
        `),
      );
      const seeded = await withBypassContext(() =>
        seedApprovedPurchaseOrder(
          org.orgId,
          actors.adminId,
          org.vendorId,
          org.subsidiaryId,
          org.date,
          org.items.fifo,
          org.accounts.invAsset,
          org.stockLocationId,
        ),
      );
      const authorized = context(org.orgId, actors.adminId, [
        "goods_receipts.create",
        "items.post",
        "purchase_orders.read",
        "assistant.use",
      ]);
      const input = {
        documentId: seeded.orderId,
        receiptDate: org.date,
        lines: [{ sourceLineId: seeded.lineId, quantity: "4" }],
      };
      const run = (key: string) =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool("receive_purchase_order")!, authorized, {
            ...input,
            idempotencyKey: key,
          }),
        );

      assert.equal(
        ((await run("purchasing-po-receive-001")) as { replayed: boolean }).replayed,
        false,
      );
      assert.equal(
        ((await run("purchasing-po-receive-001")) as { replayed: boolean }).replayed,
        true,
      );
      const nativeRead = await withOrgContext(org.orgId, () =>
        executeAssistantTool(authorized.authz, "get_order", {
          kind: "purchase_order",
          id: seeded.orderId,
        }),
      );
      assert.equal(nativeRead.ok, true, JSON.stringify(nativeRead));
      const lines = (nativeRead as { data: { lines: Array<{ quantityFulfilled: string }> } }).data
        .lines;
      assert.equal(
        lines.find((line) => line.quantityFulfilled === "4.0000")?.quantityFulfilled,
        "4.0000",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "AP capture rejection runs once and is visible through the capture detail read",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const folderId = randomUUID();
      const fileId = randomUUID();
      const captureItemId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`insert into folders(id, org_id, name) values (${folderId}, ${org.orgId}, 'AP evidence')`,
        );
        await db.execute(sql`
          insert into files(id, org_id, folder_id, name, content_type, size_bytes)
          values (${fileId}, ${org.orgId}, ${folderId}, 'invoice.pdf', 'application/pdf', 0)
        `);
        await db.execute(sql`
          insert into ap_capture_items
            (id, org_id, file_id, status, original_filename, content_hash, document_kind,
             normalized, vendor_candidate_id, created_by, updated_by)
          values
            (${captureItemId}, ${org.orgId}, ${fileId}, 'needs_review', 'invoice.pdf',
             ${randomUUID()}, 'vendor_bill', '{}'::jsonb, ${org.vendorId}, ${actors.adminId}, ${actors.adminId})
        `);
      });
      const authorized = context(org.orgId, actors.adminId, ["ap.create", "ap.read"]);
      const run = (key: string) =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool("reject_ap_capture_item")!, authorized, {
            captureItemId,
            idempotencyKey: key,
          }),
        );

      assert.equal(
        ((await run("purchasing-ap-reject-001")) as { replayed: boolean }).replayed,
        false,
      );
      assert.equal(
        ((await run("purchasing-ap-reject-001")) as { replayed: boolean }).replayed,
        true,
      );
      const nativeRead = await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("get_ap_capture_item")!, authorized, {
          captureItemId,
        }),
      );
      assert.equal((nativeRead.item as { status: string }).status, "rejected");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

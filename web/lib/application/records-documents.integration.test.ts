import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
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
const { ApplicationError } = await import("./errors.ts");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function contextFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Records integration",
        orgId,
        roles: [{ key: "records-role", name: "Records role" }],
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

function run(context: ApplicationContext, name: string, input: Record<string, unknown>) {
  return withOrgContext(context.authz.user.orgId, () =>
    executeApplicationTool(applicationTool(name)!, context, input),
  );
}

async function enableOrders(orgId: string): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs
         set settings = jsonb_set(
           settings,
           '{features}',
           coalesce(settings->'features', '{}'::jsonb) || '{"orders":true}'::jsonb
         )
       where id = ${orgId}
    `),
  );
}

async function readRecord(
  context: ApplicationContext,
  typeKey: string,
  id: string,
): Promise<Record<string, unknown>> {
  const result = (await run(context, "get_record", { typeKey, id })) as {
    record: Record<string, unknown>;
  };
  return result.record;
}

async function createDraft(
  context: ApplicationContext,
  typeKey: string,
  subsidiaryId: string,
  key: string,
): Promise<Record<string, unknown>> {
  const created = (await run(context, "create_record", {
    typeKey,
    body: { subsidiaryId },
    idempotencyKey: key,
  })) as { result: Record<string, unknown>; href: string };
  assert.ok(created.href);
  return created.result;
}

async function updateOrder(
  context: ApplicationContext,
  typeKey: string,
  id: string,
  revision: string,
  partyId: string,
  accountId: string,
  key: string,
): Promise<void> {
  await run(context, "update_record", {
    typeKey,
    id,
    body: {
      expectedUpdatedAt: revision,
      partyId,
      documentDate: "2026-07-15",
      memo: "Reviewed through the application API",
      lines: [
        {
          accountId,
          description: "Professional services",
          quantity: "1",
          unitPrice: "125.0000",
        },
      ],
    },
    idempotencyKey: key,
  });
}

test(
  "generic records drive quote and order drafts through issue and conversion",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await enableOrders(org.orgId);
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const context = contextFor(org.orgId, actors.adminId, [
        "ar.create",
        "ar.read",
        "ap.create",
        "ap.read",
        "estimates.create",
        "estimates.read",
        "estimates.issue",
        "purchase_orders.create",
        "purchase_orders.read",
      ]);

      const salesOrder = (await run(context, "create_record", {
        typeKey: "sales-orders",
        body: {
          customer: { id: org.customerId },
          documentDate: "2026-07-15",
          currency: "CAD",
          subsidiaryId: org.subsidiaryId,
          lines: [
            {
              accountId: org.accounts.revenue,
              description: "Professional services",
              quantity: "1",
              unitPrice: "125.0000",
            },
          ],
        },
        idempotencyKey: "records-sales-create-1",
      })) as { result: Record<string, unknown>; href: string; replayed: boolean };
      assert.equal(salesOrder.replayed, false);
      assert.equal(salesOrder.href, `/sales-orders?order=${salesOrder.result.id}`);
      const salesDraft = await readRecord(context, "sales-orders", String(salesOrder.result.id));
      assert.equal(salesDraft.status, "draft");
      assert.equal((salesDraft.lines as unknown[]).length, 1);
      assert.ok(typeof salesDraft.revision === "string");
      await run(context, "update_record", {
        typeKey: "sales-orders",
        id: String(salesOrder.result.id),
        body: {
          expectedUpdatedAt: salesDraft.revision,
          memo: "Reviewed through the application API",
        },
        idempotencyKey: "records-sales-update-1",
      });
      const updatedSalesDraft = await readRecord(
        context,
        "sales-orders",
        String(salesOrder.result.id),
      );
      const issued = (await run(context, "issue_sales_order", {
        documentId: String(salesOrder.result.id),
        expectedUpdatedAt: String(updatedSalesDraft.revision),
        idempotencyKey: "records-sales-issue-1",
      })) as { result: { status: string; expectedUpdatedAt: string }; replayed: boolean };
      assert.equal(issued.replayed, false);
      assert.equal(issued.result.status, "approved");
      const issuedReplay = (await run(context, "issue_sales_order", {
        documentId: String(salesOrder.result.id),
        expectedUpdatedAt: String(updatedSalesDraft.revision),
        idempotencyKey: "records-sales-issue-1",
      })) as { replayed: boolean };
      assert.equal(issuedReplay.replayed, true);
      const liveSalesOrder = await readRecord(
        context,
        "sales-orders",
        String(salesOrder.result.id),
      );
      assert.equal(liveSalesOrder.status, "approved");
      const salesInvoice = (await run(context, "convert_sales_order", {
        documentId: String(salesOrder.result.id),
        targetKind: "customer_invoice",
        expectedUpdatedAt: String(liveSalesOrder.revision),
        idempotencyKey: "records-sales-convert-1",
      })) as { result: { id: string; kind: string } };
      assert.equal(salesInvoice.result.kind, "customer_invoice");
      assert.equal((await readRecord(context, "invoices", salesInvoice.result.id)).status, "draft");

      const quote = await createDraft(
        context,
        "quotes",
        org.subsidiaryId,
        "records-quote-create-1",
      );
      const quoteId = String(quote.id);
      const quoteDraft = await readRecord(context, "quotes", quoteId);
      await updateOrder(
        context,
        "quotes",
        quoteId,
        String(quoteDraft.revision),
        org.customerId,
        org.accounts.revenue,
        "records-quote-update-1",
      );
      const updatedQuote = await readRecord(context, "quotes", quoteId);
      const issuedQuote = (await run(context, "issue_quote", {
        documentId: quoteId,
        expectedUpdatedAt: String(updatedQuote.revision),
        idempotencyKey: "records-quote-issue-1",
      })) as { replayed: boolean };
      assert.equal(issuedQuote.replayed, false);
      const approvedQuote = await readRecord(context, "quotes", quoteId);
      assert.equal(approvedQuote.status, "approved");
      const convertedQuote = (await run(context, "convert_quote", {
        documentId: quoteId,
        targetKind: "sales_order",
        expectedUpdatedAt: String(approvedQuote.revision),
        idempotencyKey: "records-quote-convert-1",
      })) as { result: { id: string; kind: string } };
      assert.equal(convertedQuote.result.kind, "sales_order");
      // Conversion issues the new order through the native issuance path, which
      // approves it at once when no approval Flow gates sales orders.
      assert.equal(
        (await readRecord(context, "sales-orders", convertedQuote.result.id)).status,
        "approved",
      );

      const purchaseOrder = await createDraft(
        context,
        "purchase-orders",
        org.subsidiaryId,
        "records-po-create-1",
      );
      const purchaseOrderId = String(purchaseOrder.id);
      const purchaseDraft = await readRecord(context, "purchase-orders", purchaseOrderId);
      await updateOrder(
        context,
        "purchase-orders",
        purchaseOrderId,
        String(purchaseDraft.revision),
        org.vendorId,
        org.accounts.cogs,
        "records-po-update-1",
      );
      const updatedPurchaseOrder = await readRecord(context, "purchase-orders", purchaseOrderId);
      const issuedPurchaseOrder = (await run(context, "issue_purchase_order", {
        documentId: purchaseOrderId,
        expectedUpdatedAt: String(updatedPurchaseOrder.revision),
        idempotencyKey: "records-po-issue-1",
      })) as { replayed: boolean };
      assert.equal(issuedPurchaseOrder.replayed, false);
      assert.equal(
        (await readRecord(context, "purchase-orders", purchaseOrderId)).status,
        "approved",
      );
      const convertedPurchaseOrder = (await run(context, "convert_purchase_order", {
        documentId: purchaseOrderId,
        targetKind: "vendor_bill",
        expectedUpdatedAt: String(
          (await readRecord(context, "purchase-orders", purchaseOrderId)).revision,
        ),
        idempotencyKey: "records-po-convert-1",
      })) as { result: { id: string; kind: string } };
      assert.equal(convertedPurchaseOrder.result.kind, "vendor_bill");
      assert.equal(
        (await readRecord(context, "bills", convertedPurchaseOrder.result.id)).status,
        "draft",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "record commands preserve permission, feature, lifecycle, and organization boundaries",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const otherOrg = await withBypassContext(() => createScratchOrg());
    try {
      await Promise.all([enableOrders(org.orgId), enableOrders(otherOrg.orgId)]);
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const otherActors = await withBypassContext(() => seedFlowActors(otherOrg.orgId));
      const context = contextFor(org.orgId, actors.adminId, ["ar.create", "ar.read"]);
      const record = await createDraft(
        context,
        "sales-orders",
        org.subsidiaryId,
        "records-boundary-create-1",
      );
      const recordId = String(record.id);
      await assert.rejects(
        run(contextFor(org.orgId, actors.outsiderId, ["ar.read"]), "create_record", {
          typeKey: "sales-orders",
          body: { subsidiaryId: org.subsidiaryId },
          idempotencyKey: "records-no-create-1",
        }),
        (error: unknown) => error instanceof ApplicationError && error.status === 403,
      );
      await assert.rejects(
        run(contextFor(otherOrg.orgId, otherActors.adminId, ["ar.read"]), "get_record", {
          typeKey: "sales-orders",
          id: recordId,
        }),
        (error: unknown) => error instanceof ApplicationError && error.status === 404,
      );
      await assert.rejects(
        run(context, "submit_document", {
          documentId: recordId,
          idempotencyKey: "records-dedicated-submit-1",
        }),
        /dedicated lifecycle/,
      );

      await withBypassContext(() =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(
               settings,
               '{features}',
               coalesce(settings->'features', '{}'::jsonb) || '{"orders":false}'::jsonb
             )
           where id = ${org.orgId}
        `),
      );
      await assert.rejects(
        run(context, "create_record", {
          typeKey: "sales-orders",
          body: { subsidiaryId: org.subsidiaryId },
          idempotencyKey: "records-feature-off-1",
        }),
        (error: unknown) => error instanceof ApplicationError && error.status === 404,
      );
    } finally {
      await Promise.all([dropScratchOrg(org.orgId), dropScratchOrg(otherOrg.orgId)]);
    }
  },
);

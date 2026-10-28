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

async function seedExpenseEmployee(orgId: string, label: string): Promise<string> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${orgId}, 'employee', ${label}, true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id)
    values (${randomUUID()}, ${orgId}, ${employeeId})
  `);
  return employeeId;
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
  await withBypassContext(async () => {
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
  });
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
          /needs the expenses feature/,
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

test("expense report commands use the native writer and lifecycle", { skip: !DB }, async () => {
  const first = await withBypassContext(() => createScratchOrg());
  const second = await withBypassContext(() => createScratchOrg());
  try {
    const firstActors = await withBypassContext(() => seedFlowActors(first.orgId));
    const secondActors = await withBypassContext(() => seedFlowActors(second.orgId));
    const employeeId = await withBypassContext(() =>
      seedExpenseEmployee(first.orgId, "Expense command owner"),
    );
    await withBypassContext(() =>
      db.execute(sql`
        update orgs set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb), '{features}', '{"expenses":true}'::jsonb, true)
        where id in (${first.orgId}, ${second.orgId})
      `),
    );
    const authorized = context(first.orgId, firstActors.adminId, ["expenses.create", "ap.post"]);
    const run = (ctx: ApplicationContext, name: string, input: Record<string, unknown>) =>
      withOrgContext(ctx.authz.user.orgId, () =>
        executeApplicationTool(applicationTool(name)!, ctx, input),
      );
    const createKey = randomUUID();
    const createInput = {
      idempotencyKey: createKey,
      documentDate: first.date,
      partyId: employeeId,
      memo: "Travel expense",
      lines: [
        {
          accountId: first.accounts.cogs,
          amount: "12.50",
          quantity: "1",
          unitPrice: "12.50",
          description: "Travel meal",
          settlementType: "out_of_pocket",
        },
      ],
    };

    await assert.rejects(
      run(context(first.orgId, firstActors.adminId, []), "create_expense_report", {
        ...createInput,
        idempotencyKey: randomUUID(),
      }),
      /forbidden/,
    );

    const created = (await run(authorized, "create_expense_report", createInput)) as {
      id: string;
      status: string;
      replayed: boolean;
    };
    assert.equal(created.replayed, false);
    assert.equal(created.status, "draft");
    const createdRead = await withOrgContext(first.orgId, () =>
      loadExpenseReport(created.id, first.orgId, null, ALL_EXPENSE_REPORTS),
    );
    assert.equal(createdRead?.doc.status, "draft");
    assert.equal(createdRead?.lines.length, 1);

    const replay = (await run(authorized, "create_expense_report", createInput)) as {
      replayed: boolean;
    };
    assert.equal(replay.replayed, true);

    const updateInput = {
      documentId: created.id,
      expectedUpdatedAt: String(createdRead?.doc.updated_at),
      idempotencyKey: "purchasing-expense-update-1",
      memo: "Updated travel expense",
      lines: [
        {
          accountId: first.accounts.cogs,
          amount: "13.50",
          quantity: "1",
          unitPrice: "13.50",
          description: "Updated travel meal",
          settlementType: "out_of_pocket",
        },
      ],
    };
    const updated = (await run(authorized, "update_expense_report", updateInput)) as {
      replayed: boolean;
    };
    assert.equal(updated.replayed, false);
    const updatedRead = await withOrgContext(first.orgId, () =>
      loadExpenseReport(created.id, first.orgId, null, ALL_EXPENSE_REPORTS),
    );
    assert.equal(updatedRead?.doc.memo, "Updated travel expense");
    assert.equal(updatedRead?.doc.total, "13.5000");
    assert.equal(
      ((await run(authorized, "update_expense_report", updateInput)) as { replayed: boolean })
        .replayed,
      true,
    );

    await assert.rejects(
      run(
        context(second.orgId, secondActors.adminId, ["expenses.create", "ap.post"]),
        "update_expense_report",
        { ...updateInput, idempotencyKey: "purchasing-expense-cross-org" },
      ),
      (error: unknown) => (error as { code?: string }).code === "not_found",
    );

    await assert.rejects(
      run(authorized, "submit_document", {
        documentId: created.id,
        idempotencyKey: "purchasing-expense-generic-submit",
      }),
      /dedicated lifecycle/,
    );
    await run(authorized, "submit_expense_report", {
      documentId: created.id,
      idempotencyKey: "purchasing-expense-submit-1",
    });
    const submitted = await withOrgContext(first.orgId, () =>
      loadExpenseReport(created.id, first.orgId, null, ALL_EXPENSE_REPORTS),
    );
    assert.equal(submitted?.doc.status, "approved");
    await assert.rejects(
      run(authorized, "post_document", {
        documentId: created.id,
        idempotencyKey: "purchasing-expense-generic-post",
      }),
      /dedicated lifecycle/,
    );
    await run(authorized, "post_expense_report", {
      documentId: created.id,
      idempotencyKey: "purchasing-expense-post-1",
    });
    const posted = await withOrgContext(first.orgId, () =>
      loadExpenseReport(created.id, first.orgId, null, ALL_EXPENSE_REPORTS),
    );
    assert.equal(posted?.doc.status, "posted");

    await assert.rejects(
      run(authorized, "correct_document", {
        documentId: created.id,
        correction: {
          amendmentReason: "Correct the report after final receipts arrived",
          expectedUpdatedAt: String(posted?.doc.updated_at),
        },
        idempotencyKey: "purchasing-expense-generic-correct",
      }),
      /dedicated correction workflow/,
    );
    const corrected = (await run(authorized, "correct_expense_report", {
      documentId: created.id,
      expectedUpdatedAt: String(posted?.doc.updated_at),
      amendmentReason: "Correct the report after final receipts arrived",
      memo: "Corrected travel expense",
      lines: [
        {
          accountId: first.accounts.cogs,
          amount: "15.00",
          quantity: "1",
          unitPrice: "15.00",
          description: "Corrected travel meal",
          settlementType: "out_of_pocket",
        },
      ],
      idempotencyKey: "purchasing-expense-correct-1",
    })) as { id: string; status: string };
    assert.equal(corrected.status, "draft");
    const correctionRead = await withOrgContext(first.orgId, () =>
      loadExpenseReport(corrected.id, first.orgId, null, ALL_EXPENSE_REPORTS),
    );
    assert.equal(correctionRead?.doc.status, "draft");
    assert.equal(correctionRead?.doc.total, "15.0000");
    const sourceRead = await withOrgContext(first.orgId, () =>
      loadExpenseReport(created.id, first.orgId, null, ALL_EXPENSE_REPORTS),
    );
    assert.equal(sourceRead?.doc.status, "voided");

    const deleteKey = randomUUID();
    const deletable = (await run(authorized, "create_expense_report", {
      ...createInput,
      idempotencyKey: deleteKey,
    })) as { id: string };
    const deleteRead = await withOrgContext(first.orgId, () =>
      loadExpenseReport(deletable.id, first.orgId, null, ALL_EXPENSE_REPORTS),
    );
    await run(authorized, "delete_expense_report", {
      documentId: deletable.id,
      expectedUpdatedAt: String(deleteRead?.doc.updated_at),
      idempotencyKey: "purchasing-expense-delete-1",
    });
    assert.equal(
      await withOrgContext(first.orgId, () =>
        loadExpenseReport(deletable.id, first.orgId, null, ALL_EXPENSE_REPORTS),
      ),
      null,
    );

    await withBypassContext(() =>
      db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}', '{"expenses":false}'::jsonb, true)
        where id = ${first.orgId}
      `),
    );
    const featureOffId = randomUUID();
    await assert.rejects(
      run(authorized, "create_expense_report", { ...createInput, idempotencyKey: featureOffId }),
      /needs the expenses feature/,
    );
    assert.equal(
      await withOrgContext(first.orgId, () =>
        loadExpenseReport(featureOffId, first.orgId, null, ALL_EXPENSE_REPORTS),
      ),
      null,
    );
  } finally {
    await dropScratchOrg(first.orgId);
    await dropScratchOrg(second.orgId);
  }
});

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

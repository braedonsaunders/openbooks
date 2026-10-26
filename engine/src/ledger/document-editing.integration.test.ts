import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import type { CustomFieldViewer } from "../records/custom-fields.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  createDocumentFromInput,
  deleteDocumentInScope,
  DocumentEditingRefusal,
  editDocument,
  type DocumentEditingContext,
  type DocumentEditingRefusalCode,
} from "./document-editing.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const VIEWER: CustomFieldViewer = { roleKeys: ["admin"], canManageCustomFields: false };

function refusedWith(code: DocumentEditingRefusalCode, status: number) {
  return (error: unknown) =>
    error instanceof DocumentEditingRefusal && error.code === code && error.status === status;
}

async function storeFeatures(orgId: string, features: Record<string, boolean>): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs
         set settings = coalesce(settings, '{}'::jsonb)
           || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb)
       where id = ${orgId}`),
  );
}

async function seedDocument(
  org: ScratchOrg,
  userId: string,
  input: { kind: string; status: "draft" | "voided"; number: string },
): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, document_date, currency,
         subtotal, tax_total, total, created_by,
         voided_at, voided_by, void_reason)
      values
        (${id}, ${org.orgId}, ${input.kind}, ${input.status}, ${input.number}, ${org.subsidiaryId},
         ${org.date}, 'CAD', '0', '0', '0', ${userId},
         ${input.status === "voided" ? sql`now()` : null}, ${input.status === "voided" ? userId : null},
         ${input.status === "voided" ? "entered twice by mistake" : null})`),
  );
  return id;
}

async function documentMemos(orgId: string, kind: string): Promise<[string, string | null][]> {
  const rows = await withBypassContext(() =>
    db.execute<{ id: string; memo: string | null }>(
      sql`select id, memo from documents where org_id = ${orgId} and kind = ${kind} order by id`,
      "objects",
    ),
  );
  return rows.map((row) => [row.id, row.memo]);
}

test(
  "a switched-off transaction feature refuses document create, edit and delete as not found",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const userId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Document editor", "admin"),
      );
      await storeFeatures(org.orgId, { cashSales: true });
      const documentId = await seedDocument(org, userId, {
        kind: "cash_sale",
        status: "draft",
        number: "CS-FEATURE-OFF",
      });
      await storeFeatures(org.orgId, { cashSales: false });
      const ctx: DocumentEditingContext = {
        orgId: org.orgId,
        userId,
        source: "api",
        allowedSubsidiaryIds: null,
        customFieldViewer: VIEWER,
      };

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          createDocumentFromInput(ctx, { kind: "cash_sale", body: { memo: "refused" } }),
        ),
        refusedWith("not_found", 404),
      );
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          editDocument(ctx, { kind: "cash_sale", documentId, body: { memo: "refused" } }),
        ),
        refusedWith("not_found", 404),
      );
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          deleteDocumentInScope(ctx, { kind: "cash_sale", documentId }),
        ),
        refusedWith("not_found", 404),
      );
      // Disabling the feature preserves the stored draft and writes nothing new.
      assert.deepEqual(await documentMemos(org.orgId, "cash_sale"), [[documentId, null]]);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a currency on a document is refused as not found while multi-currency is off",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const userId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Document editor", "admin"),
      );
      const documentId = await seedDocument(org, userId, {
        kind: "vendor_bill",
        status: "draft",
        number: "VB-CURRENCY",
      });
      await storeFeatures(org.orgId, { multiCurrency: false });
      const ctx: DocumentEditingContext = {
        orgId: org.orgId,
        userId,
        source: "api",
        allowedSubsidiaryIds: null,
        customFieldViewer: VIEWER,
      };

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          createDocumentFromInput(ctx, { kind: "vendor_bill", body: { currency: "USD" } }),
        ),
        refusedWith("not_found", 404),
      );
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          editDocument(ctx, {
            kind: "vendor_bill",
            documentId,
            body: { currency: "USD", memo: "refused" },
          }),
        ),
        refusedWith("not_found", 404),
      );
      assert.deepEqual(await documentMemos(org.orgId, "vendor_bill"), [[documentId, null]]);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test("a voided document refuses edits and stays unchanged", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const userId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Document editor", "admin"),
    );
    const documentId = await seedDocument(org, userId, {
      kind: "vendor_bill",
      status: "voided",
      number: "VB-VOIDED",
    });
    const ctx: DocumentEditingContext = {
      orgId: org.orgId,
      userId,
      source: "mcp",
      allowedSubsidiaryIds: null,
      customFieldViewer: VIEWER,
    };

    await assert.rejects(
      withOrgContext(org.orgId, () =>
        editDocument(ctx, { kind: "vendor_bill", documentId, body: { memo: "changed" } }),
      ),
      (error: unknown) =>
        refusedWith("voided", 422)(error) &&
        (error as Error).message === "a voided document cannot be edited",
    );
    assert.deepEqual(await documentMemos(org.orgId, "vendor_bill"), [[documentId, null]]);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test(
  "a restricted actor can neither draft into nor edit another subsidiary",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const userId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Document editor", "admin"),
      );
      const documentId = await seedDocument(org, userId, {
        kind: "vendor_bill",
        status: "draft",
        number: "VB-SCOPE",
      });
      const ctx: DocumentEditingContext = {
        orgId: org.orgId,
        userId,
        source: "assistant",
        // A scope that excludes the organization's only subsidiary.
        allowedSubsidiaryIds: new Set([randomUUID()]),
        customFieldViewer: VIEWER,
      };

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          createDocumentFromInput(ctx, {
            kind: "vendor_bill",
            body: { subsidiaryId: org.subsidiaryId },
          }),
        ),
        refusedWith("forbidden_subsidiary", 403),
      );
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          editDocument(ctx, { kind: "vendor_bill", documentId, body: { memo: "changed" } }),
        ),
        refusedWith("not_found", 404),
      );
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          deleteDocumentInScope(ctx, { kind: "vendor_bill", documentId }),
        ),
        refusedWith("not_found", 404),
      );
      assert.deepEqual(await documentMemos(org.orgId, "vendor_bill"), [[documentId, null]]);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

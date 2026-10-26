import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { CustomFieldViewer } from "@openbooks/customization";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { applyDocumentEdit } from "./document-write.ts";
import { loadDocument, loadDocumentEditCurrent } from "./document-service.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const HEADER_FIELD = "private_margin";
const LINE_FIELD = "private_line_margin";
const CLERK: CustomFieldViewer = { roleKeys: ["clerk"], canManageCustomFields: false };
const BUYER: CustomFieldViewer = { roleKeys: ["buyer"], canManageCustomFields: false };

test(
  "document custom fields stay private and survive edits outside their allowed role",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const userId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Custom field editor", "admin"),
      );
      const documentId = randomUUID();
      const lineId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
        insert into custom_field_defs
          (org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active)
        values
          (${org.orgId}, 'documents', 'vendor_bill', ${HEADER_FIELD}, 'Private margin', 'text', '{"allowedRoles":["buyer"]}'::jsonb, false, true),
          (${org.orgId}, 'document_lines', 'vendor_bill', ${LINE_FIELD}, 'Private line margin', 'text', '{"allowedRoles":["buyer"]}'::jsonb, false, true)`);
        await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
           currency, subtotal, tax_total, total, custom, created_by)
        values
          (${documentId}, ${org.orgId}, 'vendor_bill', 'draft', 'PRIVATE-FIELDS', ${org.subsidiaryId},
           ${org.vendorId}, ${org.date}, 'CAD', '10', '0', '10',
           ${JSON.stringify({ [HEADER_FIELD]: "header value" })}::jsonb, ${userId})`);
        await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, description, quantity, unit_price,
           amount, tax_input_amount, tax_amount, tax_overridden, custom)
        values
          (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, 'Bill line', '1', '10',
           '10', '10', '0', false, ${JSON.stringify({ [LINE_FIELD]: "line value" })}::jsonb)`);
      });

      const hidden = await withOrgContext(org.orgId, () =>
        loadDocument(documentId, org.orgId, CLERK),
      );
      assert.ok(hidden);
      assert.equal(HEADER_FIELD in (hidden.doc.custom as Record<string, unknown>), false);
      assert.equal(LINE_FIELD in (hidden.lines[0]!.custom as Record<string, unknown>), false);
      const visible = await withOrgContext(org.orgId, () =>
        loadDocument(documentId, org.orgId, BUYER),
      );
      assert.equal((visible!.doc.custom as Record<string, unknown>)[HEADER_FIELD], "header value");
      assert.equal(
        (visible!.lines[0]!.custom as Record<string, unknown>)[LINE_FIELD],
        "line value",
      );

      const headerCurrent = await withOrgContext(org.orgId, () =>
        loadDocumentEditCurrent(documentId, org.orgId),
      );
      assert.ok(headerCurrent);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          applyDocumentEdit(
            documentId,
            headerCurrent,
            { expectedUpdatedAt: headerCurrent.updatedAt, custom: { [HEADER_FIELD]: "changed" } },
            { orgId: org.orgId, userId, source: "ui", customFieldViewer: CLERK },
          ),
        ),
        (error: unknown) => error instanceof DocumentEditError && error.status === 403,
      );

      const lineCurrent = await withOrgContext(org.orgId, () =>
        loadDocumentEditCurrent(documentId, org.orgId),
      );
      assert.ok(lineCurrent);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          applyDocumentEdit(
            documentId,
            lineCurrent,
            {
              expectedUpdatedAt: lineCurrent.updatedAt,
              lines: [
                {
                  lineId,
                  accountId: org.accounts.cogs,
                  description: "Changed description",
                  amount: "10",
                  quantity: "1",
                  unitPrice: "10",
                  custom: { [LINE_FIELD]: "changed" },
                },
              ],
            },
            { orgId: org.orgId, userId, source: "ui", customFieldViewer: CLERK },
          ),
        ),
        (error: unknown) => error instanceof DocumentEditError && error.status === 403,
      );

      const editCurrent = await withOrgContext(org.orgId, () =>
        loadDocumentEditCurrent(documentId, org.orgId),
      );
      assert.ok(editCurrent);
      await withOrgContext(org.orgId, () =>
        applyDocumentEdit(
          documentId,
          editCurrent,
          {
            expectedUpdatedAt: editCurrent.updatedAt,
            lines: [
              {
                lineId,
                accountId: org.accounts.cogs,
                description: "Changed description",
                amount: "10",
                quantity: "1",
                unitPrice: "10",
              },
            ],
          },
          { orgId: org.orgId, userId, source: "ui", customFieldViewer: CLERK },
        ),
      );
      const after = await withOrgContext(org.orgId, () =>
        loadDocument(documentId, org.orgId, BUYER),
      );
      assert.equal((after!.doc.custom as Record<string, unknown>)[HEADER_FIELD], "header value");
      assert.equal((after!.lines[0]!.custom as Record<string, unknown>)[LINE_FIELD], "line value");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

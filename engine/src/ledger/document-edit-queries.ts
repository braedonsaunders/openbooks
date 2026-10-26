import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import type { DocumentEditCurrent } from "./document-input.ts";
import { documentRevisionCounterSql } from "../records/revision.ts";

export interface DocumentKindScope {
  kind: string;
  subsidiaryId: string | null;
}

export async function loadDocumentKindScope(
  orgId: string,
  documentId: string,
): Promise<DocumentKindScope | undefined> {
  return withOrgTransaction(
    orgId,
    async () => {
      const rows = await db.execute<DocumentKindScope>(
        sql`
        select kind, subsidiary_id as "subsidiaryId"
          from documents
         where id = ${documentId} and org_id = ${orgId}
      `,
        "objects",
      );
      return rows[0];
    },
    { readOnly: true },
  );
}

export async function loadDocumentEditCurrent(
  orgId: string,
  documentId: string,
): Promise<(DocumentEditCurrent & { subsidiaryId: string | null }) | undefined> {
  return withOrgTransaction(
    orgId,
    async () => {
      const rows = await db.execute<DocumentEditCurrent & { subsidiaryId: string | null }>(
        sql`
        select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
               document_date as "documentDate",
               custom,
               ${documentRevisionCounterSql(sql.raw("revision_seq"))} as "updatedAt",
               subsidiary_id as "subsidiaryId"
          from documents
         where id = ${documentId} and org_id = ${orgId}
      `,
        "objects",
      );
      return rows[0];
    },
    { readOnly: true },
  );
}

export async function listDocumentLineItemIds(
  orgId: string,
  documentId: string,
): Promise<string[]> {
  return withOrgTransaction(
    orgId,
    async () => {
      const rows = await db.execute<{ item_id: string }>(
        sql`
        select item_id from document_lines
         where org_id = ${orgId} and document_id = ${documentId} and item_id is not null
      `,
        "objects",
      );
      return rows.map((row) => row.item_id);
    },
    { readOnly: true },
  );
}

export async function loadDocumentItemKind(
  orgId: string,
  itemId: string,
): Promise<string | undefined> {
  return withOrgTransaction(
    orgId,
    async () => {
      const rows = await db.execute<{ kind: string }>(
        sql`
        select kind from items where id = ${itemId} and org_id = ${orgId}
      `,
        "objects",
      );
      return rows[0]?.kind;
    },
    { readOnly: true },
  );
}

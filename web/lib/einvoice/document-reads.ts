import "server-only";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/platform/database";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";

type Scope = { orgId: string; allowedSubsidiaryIds: ReadonlySet<string> | null | undefined };

/** An invoice or credit the e-invoice surfaces may read, with its configured profile and buyer reference. */
export async function readEInvoiceSubject(
  tx: SqlExecutor,
  scope: Scope,
  documentId: string,
  options: { lock?: boolean } = {},
): Promise<{
  kind: string;
  status: string;
  configuredProfile: string | null;
  buyerReference: string | null;
} | null> {
  return (
    (
      await tx.execute<{
        kind: string;
        status: string;
        configuredProfile: string | null;
        buyerReference: string | null;
      }>(
        sql`
    select d.kind, d.status, coalesce(c.einvoice_profile, s.default_profile) as "configuredProfile",
      coalesce(d.reference_number, c.einvoice_buyer_reference) as "buyerReference"
    from documents d
    left join customer_roles c on c.org_id = d.org_id and c.party_id = d.party_id
    left join einvoice_settings s on s.org_id = d.org_id and s.subsidiary_id = d.subsidiary_id
    where d.org_id = ${scope.orgId} and d.id = ${documentId} and d.kind in ('customer_invoice', 'customer_credit')
      ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope.allowedSubsidiaryIds ?? null)}
      ${options.lock ? sql`for share of d` : sql``}`,
        "objects",
      )
    )[0] ?? null
  );
}

/** One sealed e-invoice archive of a document, with its original bytes. */
export async function readEInvoiceArchive(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
  archiveId: string,
) {
  return (
    (
      await tx.execute<{
        content: Uint8Array;
        fileName: string;
        mediaType: string;
        sha256: string;
      }>(
        sql`
    select content, file_name as "fileName", media_type as "mediaType", content_sha256 as sha256
    from einvoice_documents where org_id = ${orgId} and document_id = ${documentId} and id = ${archiveId}`,
        "objects",
      )
    )[0] ?? null
  );
}

/** Every sealed e-invoice issued for a document, oldest first. */
export async function listEInvoiceArchives(tx: SqlExecutor, orgId: string, documentId: string) {
  return await tx.execute<{
    id: string;
    profile: string;
    fileName: string;
    issuedAt: string;
    sha256: string;
    buyerReference: string | null;
  }>(
    sql`
    select id, profile, file_name as "fileName", issued_at::text as "issuedAt", content_sha256 as sha256, buyer_reference as "buyerReference"
    from einvoice_documents where org_id = ${orgId} and document_id = ${documentId} order by issued_at, id`,
    "objects",
  );
}

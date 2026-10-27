import { sql } from "drizzle-orm";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { db, schema } from "../platform/db.ts";

/** Store a generated payment file in the organization's system payment-files folder. */
export async function storeArtifactFile(
  orgId: string,
  userId: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
  hash: string,
): Promise<{ fileId: string; versionId: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`payment-files:${orgId}`}, 0))`,
    );
    const existing = await tx.execute<{ id: string }>(
      sql`
      select id from folders where org_id = ${orgId} and system_kind = 'payment_files' limit 1
    `,
      "objects",
    );
    let folderId = existing[0]?.id;
    if (!folderId) {
      const created = await tx.execute<{ id: string }>(
        sql`
        insert into folders (org_id, name, is_system, system_kind, created_by, updated_by)
        values (${orgId}, 'Payment files', true, 'payment_files', ${userId}, ${userId})
        returning id
      `,
        "objects",
      );
      folderId = created[0]?.id;
    }
    if (!folderId) throw new PaymentError("could not create the payment file cabinet folder");
    const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : null;
    const file = (
      await tx
        .insert(schema.files)
        .values({
          orgId,
          folderId,
          name: filename,
          extension,
          fileType: extension === "xml" ? "document" : extension === "csv" ? "csv" : "text",
          contentType,
          sizeBytes: bytes.length,
          contentHash: hash,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning({ id: schema.files.id })
    )[0]!;
    const version = (
      await tx
        .insert(schema.fileVersions)
        .values({
          fileId: file.id,
          versionNumber: 1,
          sizeBytes: bytes.length,
          contentType,
          contentHash: hash,
          createdBy: userId,
        })
        .returning({ id: schema.fileVersions.id })
    )[0]!;
    await tx.insert(schema.fileBlobs).values({ versionId: version.id, bytes });
    await tx.execute(
      sql`update files set current_version_id = ${version.id} where id = ${file.id} and org_id = ${orgId}`,
    );
    return { fileId: file.id, versionId: version.id };
  });
}

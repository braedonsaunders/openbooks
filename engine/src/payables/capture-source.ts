import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { getS3Blob, refuseMaskedStorageKind } from "../platform/file-storage.ts";

/**
 * The current bytes of a captured source file (vendor bill or expense
 * receipt). Only an active cabinet file of the organization resolves; a
 * masked sandbox tombstone refuses by name before any byte fetch.
 */
export async function loadCaptureSourceBlob(
  orgId: string,
  fileId: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const result = await db.execute<{
    version_id: string;
    storage_kind: string;
    content_type: string;
    bytes: Buffer | null;
  }>(
    sql`
    select fv.id as version_id, fv.storage_kind, fv.content_type, fb.bytes
      from files f
      join file_versions fv on fv.id = f.current_version_id and fv.file_id = f.id
      left join file_blobs fb on fb.version_id = fv.id
     where f.org_id = ${orgId} and f.id = ${fileId} and not f.is_inactive
  `,
    "objects",
  );
  const row = result[0];
  if (!row) throw new Error("Capture source file is missing");
  refuseMaskedStorageKind(row.storage_kind);
  const bytes = row.storage_kind === "s3" ? await getS3Blob(row.version_id) : row.bytes;
  if (!bytes) throw new Error("Capture source bytes are missing");
  return { bytes, contentType: row.content_type };
}

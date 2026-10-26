import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./db.ts";
import { activeStorageKind, putS3Blob } from "./file-storage.ts";
import { deriveExtension, deriveFileType } from "./file-names.ts";
import { recordFileEvent } from "./file-audit.ts";

export class FileIngestionError extends Error {
  readonly name = "FileIngestionError";
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

export type FileMeta = {
  id: string;
  folderId: string;
  name: string;
  extension: string | null;
  fileType: string;
  contentType: string;
  sizeBytes: number;
  isInactive: boolean;
  currentVersionId: string | null;
  sourceSystem?: string | null;
  sourceId?: string | null;
  contentHash?: string | null;
  versionCount: number;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  folderName: string | null;
};

/**
 * Create a file in the cabinet: file row + initial version + blob. All in one
 * transaction. Returns the new file metadata.
 */
export async function createCabinetFile(input: {
  orgId: string;
  folderId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  createdBy: string | null;
  executor: SqlExecutor;
  auditActorId?: string | null;
  sourceSystem?: string;
  sourceId?: string;
  auditReason?: string;
  authorizeFolder?: (tx: SqlExecutor) => Promise<void>;
  onStagedS3?: (staged: { versionId: string; fileId: string }) => void;
}): Promise<FileMeta> {
  const sourceSelected = input.sourceSystem !== undefined || input.sourceId !== undefined;
  if (
    sourceSelected &&
    (typeof input.sourceSystem !== "string" ||
      !input.sourceSystem.trim() ||
      input.sourceSystem.length > 100 ||
      typeof input.sourceId !== "string" ||
      !input.sourceId.trim() ||
      input.sourceId.length > 1000)
  ) {
    throw new FileIngestionError("Supply both sourceSystem and sourceId as nonblank text", 400);
  }
  const reason =
    input.auditReason === undefined
      ? undefined
      : typeof input.auditReason === "string"
        ? input.auditReason.trim()
        : "";
  if (
    (reason !== undefined && (!reason || reason.length > 2000)) ||
    (sourceSelected && (!reason || !input.auditActorId))
  ) {
    throw new FileIngestionError(
      "Source uploads require an audited actor and an adoption reason of 1–2000 characters",
      400,
    );
  }
  const extension = deriveExtension(input.filename);
  const fileType = deriveFileType(input.contentType);
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const kind = activeStorageKind();
  // The S3 put below cannot roll back with the row transaction. Track the
  // staged version so a later failure (or a commit failure) records a
  // durable cleanup intent instead of stranding the object. Nested callers
  // (executor passed) compensate at their outer boundary, where the final
  // commit verdict is known.
  const tx = input.executor;
  await input.authorizeFolder?.(tx);
  if (sourceSelected) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["file-source", input.orgId, input.sourceSystem, input.sourceId])}, 0))`,
    );
    const existing = await tx.execute(
      sql`select 1 from files where org_id=${input.orgId} and source_system=${input.sourceSystem!} and source_id=${input.sourceId!} limit 1`,
      "objects",
    );
    if (existing.length)
      throw new FileIngestionError(
        "This source file already has a retained representation; select its existing native file version instead of uploading a duplicate",
        409,
      );
  }
  {
    const fileIns = await tx.execute<{ id: string }>(
      sql`
      insert into files (org_id, folder_id, name, extension, file_type, content_type,
                         size_bytes, storage_kind, content_hash, created_by, updated_by,
                         created_at, updated_at, source_system, source_id)
      values (${input.orgId}, ${input.folderId}, ${input.filename}, ${extension}, ${fileType},
              ${input.contentType}, ${input.bytes.length}, ${kind}, ${contentHash}, ${input.createdBy}, ${input.createdBy},
              now(), now(), ${input.sourceSystem ?? null}, ${input.sourceId ?? null})
      returning id
    `,
      "objects",
    );
    const fileId = fileIns[0]?.id;
    if (!fileId) throw new Error("Cabinet file did not persist");

    const verIns = await tx.execute<{ id: string }>(
      sql`
      insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                                  content_hash, created_by, created_at)
      values (${fileId}, 1, ${input.bytes.length}, ${input.contentType}, ${kind}, ${contentHash}, ${input.createdBy}, now())
      returning id
    `,
      "objects",
    );
    const versionId = verIns[0]?.id;
    if (!versionId) throw new Error("Cabinet file version did not persist");

    const updated = await tx.execute(
      sql`
      update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${input.orgId} returning id
    `,
      "objects",
    );
    if (updated.length !== 1) throw new Error("Cabinet file version pointer did not persist");
    // Object-store put happens inside the transaction window: an upload
    // failure rolls the metadata back (never metadata without bytes), while
    // a later failure is compensated by the transaction owner using the
    // staged object callback below.
    if (kind === "s3") await putS3Blob(versionId, input.bytes, input.contentType);
    if (kind === "s3") {
      input.onStagedS3?.({ versionId, fileId });
    } else {
      const blob = await tx.execute(
        sql`
        insert into file_blobs (version_id, bytes) values (${versionId}, ${input.bytes}) returning version_id
      `,
        "objects",
      );
      if (blob.length !== 1) throw new Error("Cabinet file bytes did not persist");
    }

    if (input.auditActorId !== undefined) {
      await recordFileEvent({
        orgId: input.orgId,
        actorId: input.auditActorId,
        table: "files",
        rowId: fileId,
        action: "upload",
        changes: {
          before: null,
          ...(reason === undefined ? {} : { reason }),
          after: {
            id: fileId,
            name: input.filename,
            folderId: input.folderId,
            contentType: input.contentType,
            sizeBytes: input.bytes.length,
            currentVersionId: versionId,
            contentHash,
            sourceSystem: input.sourceSystem ?? null,
            sourceId: input.sourceId ?? null,
          },
        },
        executor: tx,
      });
    }

    const meta = await tx.execute<FileMeta>(
      sql`
      select fi.id, fi.folder_id as "folderId", fi.name, fi.extension, fi.file_type as "fileType",
             fi.content_type as "contentType", fi.size_bytes as "sizeBytes",
             fi.is_inactive as "isInactive", fi.current_version_id as "currentVersionId",
             fi.source_system as "sourceSystem", fi.source_id as "sourceId", fi.content_hash as "contentHash",
             1 as "versionCount",
             fi.created_at as "createdAt", fi.created_by as "createdBy",
             fi.updated_at as "updatedAt", fi.updated_by as "updatedBy",
             fo.name as "folderName"
        from files fi left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id where fi.id = ${fileId} and fi.org_id = ${input.orgId}
    `,
      "objects",
    );
    if (!meta[0]) throw new Error("Cabinet file readback was not found");
    return meta[0];
  }
}

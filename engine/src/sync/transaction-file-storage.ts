import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { deriveFileType } from "../platform/file-names.ts";
import { fileCabinetObjectKey, getS3Blob, putS3Blob, refuseMaskedStorageKind } from "../platform/file-storage.ts";
import { enqueueStorageCleanupStandalone } from "../platform/storage-cleanup.ts";

export interface SourceFile { id: string; name: string }

function extension(filename: string): string | null {
  const value = extname(filename).slice(1).toLowerCase();
  return value || null;
}

export function safeFilename(input: string, sourceId: string): string {
  const cleaned = basename((input || "").replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned || `attachment-${sourceId}`;
}

export function detectContentType(bytes: Buffer, _filename: string): string {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 12).toString("ascii");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 4 && (head.startsWith("II*\u0000") || head.startsWith("MM\u0000*"))) return "image/tiff";
  if (head.startsWith("BM")) return "image/bmp";
  if (bytes.length >= 12 && head.slice(4, 8) === "ftyp" && /hei[cf]|mif1/.test(head.slice(8, 12))) return "image/heic";

  // Preserve every source file while serving unrecognized bytes as downloads.
  // Extension alone never grants an executable or inline content type.
  return "application/octet-stream";
}

export function normalizeAttachmentBytes(bytes: Buffer): Buffer {
  if (!bytes.subarray(0, 13).toString("ascii").startsWith("%PDFfileName=")) return bytes;
  const boundedPrefix = bytes.subarray(0, Math.min(bytes.length, 1_024)).toString("ascii");
  const pdfHeader = boundedPrefix.indexOf("%PDF-", 5);
  if (pdfHeader < 0) return bytes;
  return bytes.subarray(pdfHeader);
}

/** Title-case a snake_case kind ("vendor_bill" -> "Vendor Bill"). Must match
 *  web/lib/file-cabinet.ts titleizeKind and the SQL backfill so the sync and the
 *  cabinet UI resolve attachments to the same kind group folder. */
function titleizeKind(s: string): string {
  return s
    .split("_")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

async function ensureRecordFolder(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  documentId: string,
): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attachments:${orgId}:${documentId}`}))`);
  const existing = (await tx.execute<{ id: string }>(sql`
    select id from folders where org_id = ${orgId} and record_table = 'documents' and record_id = ${documentId}
      and record_id is not null
  `));
  if (existing.rows[0]) return existing.rows[0].id;

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attachments-root:${orgId}`}))`);
  let root = (await tx.execute<{ id: string }>(sql`
    select id from folders where org_id = ${orgId} and system_kind = 'attachments' limit 1
  `));
  if (!root.rows[0]) {
    root = (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, name, is_system, system_kind, created_at, updated_at)
      values (${orgId}, 'Attachments', true, 'attachments', now(), now()) returning id
    `));
  }
  if (root.rows.length !== 1) throw new Error("File Cabinet attachment folder was not recorded");
  const rootId = root.rows[0]!.id;

  // Nest the per-record leaf under a kind group folder so the cabinet never
  // enumerates tens of thousands of flat attachment folders.
  const kindRow = (await tx.execute<{ kind: string | null }>(sql`
    select kind from documents where id = ${documentId} and org_id = ${orgId}
  `));
  const label = kindRow.rows[0]?.kind ? titleizeKind(kindRow.rows[0].kind) : "Documents";
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attach-group:${orgId}:${label}`}))`);
  let group = (await tx.execute<{ id: string }>(sql`
    select id from folders
     where org_id = ${orgId} and parent_folder_id = ${rootId} and record_id is null and name = ${label}
  `));
  if (!group.rows[0]) {
    group = (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, parent_folder_id, name, is_system, record_table, created_at, updated_at)
      values (${orgId}, ${rootId}, ${label}, true, 'documents', now(), now()) returning id
    `));
  }

  if (group.rows.length !== 1) throw new Error("File Cabinet transaction folder was not recorded");
  const inserted = (await tx.execute<{ id: string }>(sql`
    insert into folders (org_id, parent_folder_id, name, is_system, record_table, record_id, created_at, updated_at)
    values (${orgId}, ${group.rows[0]!.id}, ${`documents / ${documentId.slice(0, 8)}`}, true, 'documents', ${documentId}, now(), now())
    returning id
  `));
  if (inserted.rows.length !== 1) throw new Error("File Cabinet record folder was not recorded");
  return inserted.rows[0]!.id;
}

export async function persistTransactionFile(input: {
  orgId: string;
  sourceSystem: string;
  actorId: string | null;
  source: SourceFile;
  targetDocumentIds: string[];
  bytes: Buffer;
  contentType: string;
  sourceModifiedAt: Date | null;
}): Promise<{ fileId: string; created: boolean; versioned: boolean; unchanged: boolean; stale: boolean; createdLinks: number }> {
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const filename = safeFilename(input.source.name, input.source.id);
  const sourceModifiedAtIso = input.sourceModifiedAt?.toISOString() ?? null;
  // The S3 object staged inside the row transaction cannot
  // roll back with it. Track the staged key so a later failure records a
  // durable cleanup intent instead of stranding the blob.
  let stagedVersionId: string | null = null;
  let stagedFileId: string | null = null;
  return db.transaction(async (tx) => {
    if (!input.targetDocumentIds.length) throw new Error("Source file requires content and at least one native transaction");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`source-file:${input.orgId}:${input.sourceSystem}:${input.source.id}`}))`);
    for (const targetId of input.targetDocumentIds) {
      const target = (await tx.execute<{ id: string }>(sql`select id from documents where org_id=${input.orgId} and id=${targetId} for key share`)).rows[0];
      if (!target) throw new Error("Source attachment target is not a transaction in this organization");
    }
    const existing = (await tx.execute<{
      id: string;
      contentHash: string | null;
      name: string;
      sourceModifiedAt: Date | string | null;
      maxVersion: number;
      currentVersionReady: boolean;
    }>(sql`
      select id, name, content_hash as "contentHash", source_modified_at as "sourceModifiedAt",
             exists(select 1 from file_versions fv where fv.id = files.current_version_id
                      and fv.file_id = files.id and fv.storage_kind = 's3'
                      and files.storage_kind = 's3' and fv.content_hash = files.content_hash
                      and fv.size_bytes = files.size_bytes) as "currentVersionReady",
             (select coalesce(max(fv.version_number), 0)
                from file_versions fv
                join files fi on fi.id = fv.file_id and fi.org_id = ${input.orgId}
               where fv.file_id = files.id) as "maxVersion"
        from files
       where org_id = ${input.orgId} and source_system = ${input.sourceSystem} and source_id = ${input.source.id}
       for update
    `));

    let fileId = existing.rows[0]?.id;
    let created = false;
    let versioned = false;
    const unchanged = existing.rows[0]?.contentHash === hash && existing.rows[0]?.currentVersionReady === true;
    const storedModifiedAt = existing.rows[0]?.sourceModifiedAt == null
      ? null
      : new Date(existing.rows[0].sourceModifiedAt).getTime();
    const incomingModifiedAt = input.sourceModifiedAt?.getTime() ?? null;
    // The file row lock fences this comparison with every concurrent import.
    // A slower attempt may finish downloading an older source snapshot after a
    // newer attempt has already committed; it must not replace that version or
    // move the source watermark backwards.
    const stale = storedModifiedAt != null && incomingModifiedAt != null
      && incomingModifiedAt < storedModifiedAt;
    if (!fileId) {
      fileId = randomUUID();
      const folderId = await ensureRecordFolder(tx, input.orgId, input.targetDocumentIds[0]!);
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into files (id, org_id, folder_id, name, extension, file_type, content_type,
                           size_bytes, storage_kind, source_system, source_id, source_modified_at, content_hash,
                           created_by, updated_by, created_at, updated_at)
        values (${fileId}, ${input.orgId}, ${folderId}, ${filename}, ${extension(filename)},
                ${deriveFileType(input.contentType)}, ${input.contentType}, ${input.bytes.length}, 's3',
                ${input.sourceSystem}, ${input.source.id}, ${sourceModifiedAtIso}, ${hash}, ${input.actorId}, ${input.actorId}, now(), now()) returning id
      `);
      if (inserted.rows.length !== 1) throw new Error("Source file was not recorded; retry the sync");
      created = true;
    }

    if (stale) {
      // Keep the current blob and source marker. The source link graph is still
      // reconciled below because those links are independent of file version.
    } else if (created || !unchanged) {
      const versionId = randomUUID();
      const versionNumber = created ? 1 : Number(existing.rows[0]!.maxVersion) + 1;
      const insertedVersion = await tx.execute<{ id: string }>(sql`
        insert into file_versions (id, file_id, version_number, size_bytes, content_type, storage_kind,
                                   content_hash, created_by, created_at)
        values (${versionId}, ${fileId}, ${versionNumber}, ${input.bytes.length}, ${input.contentType}, 's3',
                ${hash}, ${input.actorId}, now()) returning id
      `);
      if (insertedVersion.rows.length !== 1) throw new Error("Source file version was not recorded; retry the sync");
      stagedVersionId = versionId;
      stagedFileId = fileId;
      await putS3Blob(versionId, input.bytes, input.contentType);
      const written = await tx.execute<{ id: string }>(sql`
        update files set current_version_id = ${versionId}, name = ${filename}, extension = ${extension(filename)},
                         file_type = ${deriveFileType(input.contentType)}, content_type = ${input.contentType},
                         size_bytes = ${input.bytes.length}, storage_kind = 's3', content_hash = ${hash},
                         source_modified_at = coalesce(${sourceModifiedAtIso}, source_modified_at),
                         updated_by = ${input.actorId}, updated_at = now()
         where id = ${fileId} and org_id = ${input.orgId} returning id
      `);
      if (written.rows.length !== 1) throw new Error("Imported file was not updated; retry after resolving its identity");
      versioned = !created;
    } else {
      const written = await tx.execute<{ id: string }>(sql`
        update files set name = ${filename}, extension = ${extension(filename)},
                         file_type = ${deriveFileType(input.contentType)}, content_type = ${input.contentType},
                         size_bytes = ${input.bytes.length},
                         source_modified_at = coalesce(${sourceModifiedAtIso}, source_modified_at),
                         updated_by = ${input.actorId}, updated_at = now()
         where id = ${fileId} and org_id = ${input.orgId} returning id
      `);
      if (written.rows.length !== 1) throw new Error("Imported file was not updated; retry after resolving its identity");
    }

    let createdLinks = 0;
    for (const documentId of input.targetDocumentIds) {
      const linked = (await tx.execute<{ id: string }>(sql`
        insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
        values (${input.orgId}, ${fileId}, 'documents', ${documentId}, ${input.actorId}, now())
        -- An existing attachment already links this file to this document; count only new associations.
        on conflict (org_id, file_id, target_table, target_id) do nothing
        returning id
      `));
      createdLinks += linked.rows.length;
    }
    if (created || versioned || createdLinks > 0 || (!stale && existing.rows[0]?.name !== filename)) {
      const audited = await tx.execute<{ id: string }>(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${input.orgId}, 'files', ${fileId}, ${created ? 'insert' : 'update'}, ${JSON.stringify({
          event: 'transaction_file_synced', sourceSystem: input.sourceSystem, sourceId: input.source.id,
          before: existing.rows[0] ? { contentHash: existing.rows[0].contentHash, name: existing.rows[0].name } : null,
          after: { name: stale ? existing.rows[0]?.name : filename, contentHash: stale ? existing.rows[0]?.contentHash : hash, targetDocumentIds: input.targetDocumentIds },
          createdLinks, versioned, reason: 'Synchronize source transaction evidence',
        })}::jsonb, ${input.actorId}) returning id`);
      if (audited.rows.length !== 1) throw new Error("Source file change was not audited; retry the sync");
    }
    return { fileId, created, versioned, unchanged: !created && unchanged, stale, createdLinks };
  }).catch(async (error) => {
    if (stagedVersionId) {
      await enqueueStorageCleanupStandalone({
        orgId: input.orgId,
        objectKey: fileCabinetObjectKey(stagedVersionId),
        ownerKind: "file_version",
        ownerId: stagedFileId ?? stagedVersionId,
      });
    }
    throw error;
  });
}

export async function verifyTransactionFiles(
  orgId: string,
  sourceSystem: string,
  fileToDocuments: Map<string, Set<string>>,
  verifyStoredBytes: boolean,
): Promise<void> {
  const sourceFileIds = Array.from(fileToDocuments.keys());
  if (sourceFileIds.length === 0) return;
  const sourceIdsSql = sql.join(sourceFileIds.map((fileId) => sql`${fileId}`), sql`, `);
  const filesResult = (await db.execute<{
      sourceId: string;
      id: string;
      currentVersionId: string | null;
      storageKind: string;
      sizeBytes: number;
      contentHash: string | null;
      versionStorageKind: string | null;
      versionSizeBytes: number | null;
      versionContentHash: string | null;
    }>(sql`
    select f.source_id as "sourceId", f.id, f.current_version_id as "currentVersionId",
           f.storage_kind as "storageKind", f.size_bytes as "sizeBytes",
           f.content_hash as "contentHash", fv.storage_kind as "versionStorageKind",
           fv.size_bytes as "versionSizeBytes", fv.content_hash as "versionContentHash"
      from files f
      left join file_versions fv on fv.id = f.current_version_id and fv.file_id = f.id
     where f.org_id = ${orgId} and f.source_system = ${sourceSystem}
       and f.source_id in (${sourceIdsSql})
  `));
  const filesBySourceId = new Map(filesResult.rows.map((row) => [row.sourceId, row]));

  for (const sourceFileId of sourceFileIds) {
    const row = filesBySourceId.get(sourceFileId);
    // A masked-clone tombstone refuses by name: without this the generic
    // S3 check below would misreport masked rows as "no current S3 version".
    refuseMaskedStorageKind(row?.storageKind);
    refuseMaskedStorageKind(row?.versionStorageKind);
    if (!row?.currentVersionId || row.storageKind !== "s3" || row.versionStorageKind !== "s3") {
      throw new Error(`verification failed: source file ${sourceFileId} has no current S3 version`);
    }
    if (
      !row.contentHash
      || row.contentHash !== row.versionContentHash
      || row.sizeBytes !== row.versionSizeBytes
    ) {
      throw new Error(`verification failed: source file ${sourceFileId} metadata does not match its current version`);
    }
    if (verifyStoredBytes) {
      const bytes = await getS3Blob(row.currentVersionId);
      if (!bytes) throw new Error(`verification failed: source file ${sourceFileId} is missing from object storage`);
      const storedHash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== row.sizeBytes || storedHash !== row.contentHash) {
        throw new Error(`verification failed: source file ${sourceFileId} object bytes do not match the database`);
      }
    }
  }

  const linksResult = (await db.execute<{ sourceId: string; targetId: string }>(sql`
    select f.source_id as "sourceId", fa.target_id as "targetId"
      from files f
      join file_attachments fa
        on fa.org_id = f.org_id and fa.file_id = f.id and fa.target_table = 'documents'
     where f.org_id = ${orgId} and f.source_system = ${sourceSystem}
       and f.source_id in (${sourceIdsSql})
  `));
  const actualLinks = new Set(
    linksResult.rows.map((row) => `${row.sourceId}\0${row.targetId}`),
  );
  for (const [sourceFileId, documentIds] of fileToDocuments) {
    for (const documentId of documentIds) {
      if (!actualLinks.has(`${sourceFileId}\0${documentId}`)) {
        throw new Error(
          `verification failed: source file ${sourceFileId} is not linked to document ${documentId}`,
        );
      }
    }
  }
}


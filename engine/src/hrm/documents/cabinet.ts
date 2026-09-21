import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";

/**
 * HR-19 engine-side File Cabinet writer.
 *
 * The cabinet's own helpers live in web/lib/file-cabinet.ts, which the
 * engine module graph cannot import (web owns engine, never the reverse).
 * HRM document generation, signed-PDF appends, and DSAR zips must land
 * their bytes in the SAME transaction as the document row they evidence —
 * a rendered file without its row (or a row pointing at a file that
 * rolled back) is a split-brain write, so the engine carries its own
 * minimal writer here instead of splitting the unit across a route call.
 *
 * It mirrors the cabinet's insert shapes exactly (files + file_versions +
 * file_blobs + file_attachments, per-record folder under the Attachments
 * system root with the same advisory-lock serialization), and only ever
 * writes storage_kind 'db': cabinet reads branch on the per-file kind, so
 * an HRM file stays byte-identical through the normal download path
 * regardless of the org's default store.
 *
 * Grants: the caller passes user-principal viewer grants (resolved from
 * users.party_id by the service — the subject, their manager, the acting
 * HR user). HR-wide reads ride the hrm.documents.read gate in the
 * documents API, not cabinet grants.
 */

export interface CabinetStoreInput {
  orgId: string;
  /** Per-record folder key, e.g. ('hrm_documents', documentId). */
  recordTable: string;
  recordId: string;
  groupLabel: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  createdBy: string | null;
  /** User ids (users.id) receiving a viewer grant on the file. */
  viewerUserIds?: readonly string[];
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

function fileTypeOf(contentType: string): string {
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("text/")) return "text";
  return "other";
}

async function ensureRecordFolder(
  tx: SqlExecutor,
  orgId: string,
  recordTable: string,
  recordId: string,
  groupLabel: string,
): Promise<string> {
  // Same serialization as web/lib/file-cabinet.ts ensureRecordFolder: no
  // unique key on the nullable record columns, so concurrent writers share
  // one leaf folder instead of duplicating system folders.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"hrm-attach-record:" + orgId + ":" + recordTable + ":" + recordId}))`,
  );
  const existing = (await tx.execute<{ id: string }>(sql`
    select id from folders
     where org_id = ${orgId} and record_table = ${recordTable} and record_id = ${recordId}
       and record_id is not null
       for share
  `)).rows[0];
  if (existing) return existing.id;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"hrm-attachments-root:" + orgId}))`,
  );
  const root = (await tx.execute<{ id: string }>(sql`
    select id from folders where org_id = ${orgId} and system_kind = 'attachments'
  `)).rows[0];
  const rootId =
    root?.id ??
    (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, name, is_system, system_kind, created_at, updated_at)
      values (${orgId}, 'Attachments', true, 'attachments', now(), now())
      returning id
    `)).rows[0]!.id;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"hrm-attach-group:" + orgId + ":" + groupLabel}))`,
  );
  const group = (await tx.execute<{ id: string }>(sql`
    select id from folders
     where org_id = ${orgId} and parent_folder_id = ${rootId}
       and record_id is null and name = ${groupLabel}
  `)).rows[0];
  const groupId =
    group?.id ??
    (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, parent_folder_id, name, is_system, record_table, created_at, updated_at)
      values (${orgId}, ${rootId}, ${groupLabel}, true, ${recordTable}, now(), now())
      returning id
    `)).rows[0]!.id;
  const leaf = (await tx.execute<{ id: string }>(sql`
    insert into folders (org_id, parent_folder_id, name, is_system, record_table, record_id, created_at, updated_at)
    values (${orgId}, ${groupId}, ${recordTable + " / " + recordId.slice(0, 8)}, true, ${recordTable}, ${recordId}, now(), now())
    returning id
  `)).rows[0]!.id;
  return leaf;
}

/** Store bytes as a new cabinet file; returns the file id. */
export async function storeCabinetFile(
  tx: SqlExecutor,
  input: CabinetStoreInput,
): Promise<{ fileId: string; versionId: string }> {
  const folderId = await ensureRecordFolder(
    tx,
    input.orgId,
    input.recordTable,
    input.recordId,
    input.groupLabel,
  );
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const fileId = (await tx.execute<{ id: string }>(sql`
    insert into files (org_id, folder_id, name, extension, file_type, content_type,
                       size_bytes, storage_kind, content_hash, created_by, updated_by,
                       created_at, updated_at)
    values (${input.orgId}, ${folderId}, ${input.filename}, ${extensionOf(input.filename)},
            ${fileTypeOf(input.contentType)}, ${input.contentType}, ${input.bytes.length},
            'db', ${contentHash}, ${input.createdBy}, ${input.createdBy}, now(), now())
    returning id
  `)).rows[0]!.id;
  const versionId = (await tx.execute<{ id: string }>(sql`
    insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                               content_hash, created_by, created_at)
    values (${fileId}, 1, ${input.bytes.length}, ${input.contentType}, 'db',
            ${contentHash}, ${input.createdBy}, now())
    returning id
  `)).rows[0]!.id;
  await tx.execute(sql`
    update files set current_version_id = ${versionId}
     where id = ${fileId} and org_id = ${input.orgId}
  `);
  await tx.execute(sql`
    insert into file_blobs (version_id, bytes) values (${versionId}, ${input.bytes})
  `);
  // on conflict do nothing is justified here (not a dropped write): the
  // file_attachments_unique key makes link creation idempotent, so a
  // retried unit (worker crash between link and commit) converges instead
  // of failing the retry on its own earlier effect.
  await tx.execute(sql`
    insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
    values (${input.orgId}, ${fileId}, ${input.recordTable}, ${input.recordId}, ${input.createdBy}, now())
    on conflict (org_id, file_id, target_table, target_id) do nothing
  `);
  for (const userId of input.viewerUserIds ?? []) {
    // Same justification: resource_grants_unique makes re-granting the
    // same viewer on remind/re-send converge instead of double-granting.
    await tx.execute(sql`
      insert into resource_grants (org_id, resource_type, resource_id, principal_type, principal_id, access, created_at, updated_at)
      values (${input.orgId}, 'file', ${fileId}, 'user', ${userId}, 'viewer', now(), now())
      on conflict (org_id, resource_type, resource_id, principal_type, principal_id) do nothing
    `);
  }
  return { fileId, versionId };
}

/**
 * Append bytes as a NEW version of an existing cabinet file (the signed
 * PDF with its signature page). The file row keeps pointing at the latest
 * version; history stays in file_versions. Returns the version id.
 */
export async function appendCabinetVersion(
  tx: SqlExecutor,
  orgId: string,
  fileId: string,
  contentType: string,
  bytes: Buffer,
  createdBy: string | null,
): Promise<string> {
  const file = (await tx.execute<{ id: string; maxv: number }>(sql`
    select f.id, coalesce(max(v.version_number), 0) as maxv
      from files f left join file_versions v on v.file_id = f.id
     where f.id = ${fileId} and f.org_id = ${orgId}
     group by f.id
  `)).rows[0];
  // A write matching zero rows is a failure: the file is gone or foreign.
  if (!file) {
    throw new Error("the signed PDF has no cabinet file in this organization — regenerate the document instead of signing a ghost");
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const versionId = (await tx.execute<{ id: string }>(sql`
    insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                               content_hash, created_by, created_at)
    values (${fileId}, ${file.maxv + 1}, ${bytes.length}, ${contentType}, 'db',
            ${contentHash}, ${createdBy}, now())
    returning id
  `)).rows[0]!.id;
  await tx.execute(sql`
    update files
       set current_version_id = ${versionId}, size_bytes = ${bytes.length},
           content_hash = ${contentHash}, updated_at = now(), updated_by = ${createdBy}
     where id = ${fileId} and org_id = ${orgId}
  `);
  await tx.execute(sql`
    insert into file_blobs (version_id, bytes) values (${versionId}, ${bytes})
  `);
  return versionId;
}

/** Remove the bytes of a file (retention delete) while keeping the file
 * row, its versions' metadata, and every event that cites it. */
export async function purgeCabinetBytes(
  tx: SqlExecutor,
  orgId: string,
  fileId: string,
): Promise<void> {
  const file = (await tx.execute<{ id: string }>(sql`
    select id from files where id = ${fileId} and org_id = ${orgId}
  `)).rows[0];
  if (!file) {
    throw new Error("the retention delete matched no cabinet file in this organization — the delete is refused, never a silent success");
  }
  await tx.execute(sql`
    delete from file_blobs
     where version_id in (select id from file_versions where file_id = ${fileId})
  `);
}

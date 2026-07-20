import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { putS3Blob, s3Enabled } from "../file-storage.ts";
import { netsuiteRestlet, type NetSuiteCreds } from "../netsuite.ts";
import {
  DEFAULT_NETSUITE_BRIDGE_DEPLOYMENT_ID,
  DEFAULT_NETSUITE_BRIDGE_SCRIPT_ID,
} from "../netsuite-bridge.ts";
import { unsealJson } from "../secrets.ts";

const SOURCE_SYSTEM = "netsuite";
const RESTLET_BATCH_SIZE = 50;

type SourceKind = "vendor_bill" | "expense_report";

interface SourceDocument {
  id: string;
  nsId: string;
  kind: SourceKind;
}

interface SourceFile {
  id: string;
  name: string;
}

export interface ImportOptions {
  org: string;
  connectionId?: string;
  execute: boolean;
  concurrency: number;
  limit?: number;
}

export interface AttachmentImportFailure {
  fileId: string;
  message: string;
}

export interface ImportSummary {
  sourceDocuments: number;
  sourceDocumentsWithoutId: number;
  sourceFiles: number;
  sourceLinks: number;
  createdFiles: number;
  newVersions: number;
  unchangedFiles: number;
  createdLinks: number;
  failures: number;
  failureDetails: AttachmentImportFailure[];
}

export class AttachmentImportError extends Error {
  constructor(public readonly summary: ImportSummary) {
    super(`${summary.failures} source files failed to import`);
    this.name = "AttachmentImportError";
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function concurrentMap<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      result[index] = await task(values[index], index);
    }
  }));
  return result;
}

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

export function detectContentType(bytes: Buffer, filename: string): string {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 12).toString("ascii");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 4 && (head.startsWith("II*\u0000") || head.startsWith("MM\u0000*"))) return "image/tiff";
  if (head.startsWith("BM")) return "image/bmp";
  if (bytes.length >= 12 && head.slice(4, 8) === "ftyp" && /hei[cf]|mif1/.test(head.slice(8, 12))) return "image/heic";

  throw new Error(`unsupported attachment content for source file ${filename || "(unnamed)"}`);
}

export function expenseReportFileIds(record: unknown): string[] {
  if (!record || typeof record !== "object") return [];
  const expense = (record as { expense?: unknown }).expense;
  if (!expense || typeof expense !== "object") return [];
  const items = (expense as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const ids = items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const media = (item as { expmediaitem?: unknown }).expmediaitem;
    if (!media || typeof media !== "object") return [];
    const id = (media as { id?: unknown }).id;
    return typeof id === "string" || typeof id === "number" ? [String(id)] : [];
  });
  return Array.from(new Set(ids.filter((id) => /^\d+$/.test(id))));
}

async function resolveContext(options: ImportOptions): Promise<{
  orgId: string;
  actorId: string;
  creds: NetSuiteCreds;
  bridge: { script: string; deploy: string };
}> {
  const orgResult = (await db.execute(sql`
    select id, name from orgs where id::text = ${options.org} or name = ${options.org}
  `)) as unknown as { rows: { id: string; name: string }[] };
  if (orgResult.rows.length !== 1) throw new Error(`tenant not found or ambiguous: ${options.org}`);
  const orgId = orgResult.rows[0].id;

  const connectionResult = (await db.execute(sql`
    select id, config, secrets
      from connections
     where org_id = ${orgId} and source = 'netsuite'
       ${options.connectionId ? sql`and id = ${options.connectionId}` : sql``}
     order by (status = 'active') desc, created_at desc
     limit 1
  `)) as unknown as { rows: { id: string; config: Record<string, unknown>; secrets: string | null }[] };
  const connection = connectionResult.rows[0];
  if (!connection) throw new Error("tenant does not have a NetSuite connection");
  const secret = unsealJson<Partial<NetSuiteCreds>>(connection.secrets);
  if (!secret?.consumerKey || !secret.consumerSecret || !secret.tokenKey || !secret.tokenSecret) {
    throw new Error("tenant NetSuite connection is missing sealed credentials");
  }
  const account = String(connection.config.account ?? "");
  const host = String(connection.config.host ?? "");
  if (!account || !host) throw new Error("tenant NetSuite connection is missing account or host configuration");

  const actorResult = (await db.execute(sql`
    select id from users where org_id = ${orgId} and role = 'admin' and is_active order by created_at limit 1
  `)) as unknown as { rows: { id: string }[] };
  if (!actorResult.rows[0]) throw new Error("tenant needs an active admin user to own imported file audit rows");
  return {
    orgId,
    actorId: actorResult.rows[0].id,
    creds: {
      account,
      host,
      consumerKey: secret.consumerKey,
      consumerSecret: secret.consumerSecret,
      tokenKey: secret.tokenKey,
      tokenSecret: secret.tokenSecret,
    },
    bridge: {
      script: String(connection.config.bridgeScriptId || DEFAULT_NETSUITE_BRIDGE_SCRIPT_ID),
      deploy: String(connection.config.bridgeDeploymentId || DEFAULT_NETSUITE_BRIDGE_DEPLOYMENT_ID),
    },
  };
}

async function sourceDocuments(orgId: string, limit?: number): Promise<{
  documents: SourceDocument[];
  withoutSourceId: number;
}> {
  const result = (await db.execute(sql`
    select id, kind, custom->>'nsId' as "nsId"
      from documents
     where org_id = ${orgId} and kind in ('vendor_bill', 'expense_report')
     order by kind, id
     ${limit ? sql`limit ${limit}` : sql``}
  `)) as unknown as { rows: { id: string; kind: SourceKind; nsId: string | null }[] };
  return {
    documents: result.rows.filter((row): row is SourceDocument => Boolean(row.nsId)),
    withoutSourceId: result.rows.filter((row) => !row.nsId).length,
  };
}

async function attachmentInventory(
  documents: SourceDocument[],
  creds: NetSuiteCreds,
  concurrency: number,
  bridge: { script: string; deploy: string },
): Promise<Map<string, Set<string>>> {
  const batches = chunks(documents, RESTLET_BATCH_SIZE);
  const results = await concurrentMap(batches, concurrency, async (batch, index) => {
    const response = await netsuiteRestlet<{
      ok?: boolean;
      error?: string;
      records?: Record<string, string[]>;
    }>(bridge.script, bridge.deploy, {
      action: "attachmentInventory",
      records: batch.map((doc) => ({
        recordType: doc.kind === "vendor_bill" ? "vendorBill" : "expenseReport",
        internalId: doc.nsId,
      })),
    }, creds, "POST");
    if (!response.ok || !response.records) throw new Error(response.error || "attachment inventory failed");
    if ((index + 1) % 20 === 0 || index + 1 === batches.length) {
      console.log(`[inventory] ${Math.min((index + 1) * RESTLET_BATCH_SIZE, documents.length)}/${documents.length} transactions`);
    }
    return { batch, records: response.records };
  });

  const sourceIdToDocumentIds = new Map(documents.map((doc) => [doc.nsId, doc.id]));
  const fileToDocuments = new Map<string, Set<string>>();
  for (const result of results) {
    for (const [sourceTransactionId, fileIds] of Object.entries(result.records)) {
      const documentId = sourceIdToDocumentIds.get(sourceTransactionId);
      if (!documentId) throw new Error(`resolver returned unknown source transaction ${sourceTransactionId}`);
      for (const fileId of fileIds) {
        if (!/^\d+$/.test(fileId)) throw new Error(`resolver returned malformed file id for transaction ${sourceTransactionId}`);
        const targets = fileToDocuments.get(fileId) ?? new Set<string>();
        targets.add(documentId);
        fileToDocuments.set(fileId, targets);
      }
    }
  }
  return fileToDocuments;
}

export function decodeBridgeAttachment(response: unknown, expectedFileId: string): {
  source: SourceFile;
  bytes: Buffer;
} {
  if (!response || typeof response !== "object") throw new Error("attachment bridge returned an invalid response");
  const body = response as { ok?: unknown; error?: unknown; file?: Record<string, unknown> };
  if (body.ok !== true || !body.file) throw new Error(String(body.error || "attachment bridge download failed"));
  const id = String(body.file.id ?? "");
  const name = String(body.file.name ?? "");
  const size = Number(body.file.size);
  const encoding = String(body.file.encoding ?? "");
  const contents = body.file.contents;
  if (id !== expectedFileId || !/^\d+$/.test(id)) throw new Error("attachment bridge returned the wrong file");
  if (!name || encoding !== "base64" || typeof contents !== "string") {
    throw new Error(`attachment bridge returned malformed content for source file ${id}`);
  }
  const bytes = Buffer.from(contents, "base64");
  if (!bytes.length || !Number.isSafeInteger(size) || size <= 0 || bytes.length !== size) {
    throw new Error(`attachment bridge size mismatch for source file ${id}`);
  }
  return { source: { id, name }, bytes };
}

async function downloadSourceFile(
  fileId: string,
  creds: NetSuiteCreds,
  bridge: { script: string; deploy: string },
): Promise<{ source: SourceFile; bytes: Buffer }> {
  const response = await netsuiteRestlet<unknown>(bridge.script, bridge.deploy, {
    action: "attachmentContent",
    fileId,
  }, creds, "POST");
  return decodeBridgeAttachment(response, fileId);
}

async function ensureRecordFolder(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  documentId: string,
): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attachments:${orgId}:${documentId}`}))`);
  const existing = (await tx.execute(sql`
    select id from folders where org_id = ${orgId} and record_table = 'documents' and record_id = ${documentId}
  `)) as unknown as { rows: { id: string }[] };
  if (existing.rows[0]) return existing.rows[0].id;

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attachments-root:${orgId}`}))`);
  let root = (await tx.execute(sql`
    select id from folders where org_id = ${orgId} and system_kind = 'attachments' limit 1
  `)) as unknown as { rows: { id: string }[] };
  if (!root.rows[0]) {
    root = (await tx.execute(sql`
      insert into folders (org_id, name, is_system, system_kind, created_at, updated_at)
      values (${orgId}, 'Attachments', true, 'attachments', now(), now()) returning id
    `)) as unknown as { rows: { id: string }[] };
  }
  const inserted = (await tx.execute(sql`
    insert into folders (org_id, parent_folder_id, name, is_system, record_table, record_id, created_at, updated_at)
    values (${orgId}, ${root.rows[0].id}, ${`documents / ${documentId.slice(0, 8)}`}, true, 'documents', ${documentId}, now(), now())
    returning id
  `)) as unknown as { rows: { id: string }[] };
  return inserted.rows[0].id;
}

function derivedFileType(contentType: string): "pdf" | "image" {
  return contentType === "application/pdf" ? "pdf" : "image";
}

async function persistFile(input: {
  orgId: string;
  actorId: string;
  source: SourceFile;
  targetDocumentIds: string[];
  bytes: Buffer;
  contentType: string;
}): Promise<{ created: boolean; versioned: boolean; unchanged: boolean; createdLinks: number }> {
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const filename = safeFilename(input.source.name, input.source.id);
  return db.transaction(async (tx) => {
    const existing = (await tx.execute(sql`
      select id, content_hash as "contentHash",
             (select coalesce(max(version_number), 0) from file_versions where file_id = files.id) as "maxVersion"
        from files
       where org_id = ${input.orgId} and source_system = ${SOURCE_SYSTEM} and source_id = ${input.source.id}
       for update
    `)) as unknown as { rows: { id: string; contentHash: string | null; maxVersion: number }[] };

    let fileId = existing.rows[0]?.id;
    let created = false;
    let versioned = false;
    const unchanged = existing.rows[0]?.contentHash === hash;
    if (!fileId) {
      fileId = randomUUID();
      const folderId = await ensureRecordFolder(tx, input.orgId, input.targetDocumentIds[0]);
      await tx.execute(sql`
        insert into files (id, org_id, folder_id, name, extension, file_type, content_type,
                           size_bytes, storage_kind, source_system, source_id, content_hash,
                           created_by, updated_by, created_at, updated_at)
        values (${fileId}, ${input.orgId}, ${folderId}, ${filename}, ${extension(filename)},
                ${derivedFileType(input.contentType)}, ${input.contentType}, ${input.bytes.length}, 's3',
                ${SOURCE_SYSTEM}, ${input.source.id}, ${hash}, ${input.actorId}, ${input.actorId}, now(), now())
      `);
      created = true;
    }

    if (created || !unchanged) {
      const versionId = randomUUID();
      const versionNumber = created ? 1 : Number(existing.rows[0].maxVersion) + 1;
      await tx.execute(sql`
        insert into file_versions (id, file_id, version_number, size_bytes, content_type, storage_kind,
                                   content_hash, created_by, created_at)
        values (${versionId}, ${fileId}, ${versionNumber}, ${input.bytes.length}, ${input.contentType}, 's3',
                ${hash}, ${input.actorId}, now())
      `);
      await putS3Blob(versionId, input.bytes, input.contentType);
      await tx.execute(sql`
        update files set current_version_id = ${versionId}, name = ${filename}, extension = ${extension(filename)},
                         file_type = ${derivedFileType(input.contentType)}, content_type = ${input.contentType},
                         size_bytes = ${input.bytes.length}, storage_kind = 's3', content_hash = ${hash},
                         updated_by = ${input.actorId}, updated_at = now()
         where id = ${fileId} and org_id = ${input.orgId}
      `);
      versioned = !created;
    } else {
      await tx.execute(sql`
        update files set name = ${filename}, extension = ${extension(filename)},
                         file_type = ${derivedFileType(input.contentType)}, content_type = ${input.contentType},
                         size_bytes = ${input.bytes.length}, updated_by = ${input.actorId}, updated_at = now()
         where id = ${fileId} and org_id = ${input.orgId}
      `);
    }

    let createdLinks = 0;
    for (const documentId of input.targetDocumentIds) {
      const linked = (await tx.execute(sql`
        insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
        values (${input.orgId}, ${fileId}, 'documents', ${documentId}, ${input.actorId}, now())
        on conflict (org_id, file_id, target_table, target_id) do nothing
        returning id
      `)) as unknown as { rows: { id: string }[] };
      createdLinks += linked.rows.length;
    }
    return { created, versioned, unchanged: !created && unchanged, createdLinks };
  });
}

async function verifyImport(orgId: string, fileToDocuments: Map<string, Set<string>>): Promise<void> {
  const expectedFiles = fileToDocuments.size;
  const expectedLinks = Array.from(fileToDocuments.values()).reduce((sum, ids) => sum + ids.size, 0);
  const counts = (await db.execute(sql`
    select count(distinct f.id) as files, count(fa.id) as links,
           count(*) filter (where fv.id is null) as "missingVersions"
      from files f
      left join file_versions fv on fv.id = f.current_version_id and fv.storage_kind = 's3'
      left join file_attachments fa on fa.file_id = f.id and fa.org_id = f.org_id and fa.target_table = 'documents'
     where f.org_id = ${orgId} and f.source_system = ${SOURCE_SYSTEM}
  `)) as unknown as { rows: { files: string; links: string; missingVersions: string }[] };
  const row = counts.rows[0];
  if (Number(row.files) < expectedFiles || Number(row.links) < expectedLinks || Number(row.missingVersions) > 0) {
    throw new Error(`verification failed: expected ${expectedFiles} files/${expectedLinks} links, found ${row.files}/${row.links}`);
  }
}

async function prioritizeMissingFiles(orgId: string, fileIds: string[]): Promise<string[]> {
  const imported = (await db.execute(sql`
    select source_id as "sourceId"
      from files
     where org_id = ${orgId} and source_system = ${SOURCE_SYSTEM} and source_id is not null
  `)) as unknown as { rows: { sourceId: string }[] };
  const existing = new Set(imported.rows.map((row) => row.sourceId));
  return [...fileIds].sort((left, right) => Number(existing.has(left)) - Number(existing.has(right)));
}

export async function importNetSuiteAttachments(options: ImportOptions): Promise<ImportSummary> {
  const { orgId, actorId, creds, bridge } = await resolveContext(options);
  if (options.execute && !s3Enabled) {
    throw new Error("S3/MinIO is not configured; refusing to fall back to database blobs");
  }
  const { documents, withoutSourceId } = await sourceDocuments(orgId, options.limit);
  console.log(`[inventory] resolving attachments for ${documents.length} source transactions`);
  const fileToDocuments = await attachmentInventory(
    documents,
    creds,
    options.concurrency,
    bridge,
  );
  const sourceLinks = Array.from(fileToDocuments.values()).reduce((sum, ids) => sum + ids.size, 0);
  const summary: ImportSummary = {
    sourceDocuments: documents.length,
    sourceDocumentsWithoutId: withoutSourceId,
    sourceFiles: fileToDocuments.size,
    sourceLinks,
    createdFiles: 0,
    newVersions: 0,
    unchangedFiles: 0,
    createdLinks: 0,
    failures: 0,
    failureDetails: [],
  };
  console.log(`[inventory] found ${summary.sourceFiles} unique files across ${summary.sourceLinks} transaction links`);
  if (!options.execute) return summary;

  const fileIds = await prioritizeMissingFiles(orgId, Array.from(fileToDocuments.keys()));
  await concurrentMap(fileIds, options.concurrency, async (fileId, index) => {
    try {
      const { source, bytes } = await downloadSourceFile(fileId, creds, bridge);
      const contentType = detectContentType(bytes, source.name);
      const persisted = await persistFile({
        orgId,
        actorId,
        source,
        targetDocumentIds: Array.from(fileToDocuments.get(source.id) ?? []),
        bytes,
        contentType,
      });
      if (persisted.created) summary.createdFiles++;
      if (persisted.versioned) summary.newVersions++;
      if (persisted.unchanged) summary.unchangedFiles++;
      summary.createdLinks += persisted.createdLinks;
    } catch (error) {
      summary.failures++;
      const message = error instanceof Error ? error.message : String(error);
      summary.failureDetails.push({ fileId, message });
      console.error(`[import] source file ${fileId} failed: ${message}`);
    }
    if ((index + 1) % 100 === 0 || index + 1 === fileIds.length) {
      console.log(`[import] ${index + 1}/${fileIds.length} files (${summary.failures} failed)`);
    }
  });
  if (summary.failures) throw new AttachmentImportError(summary);
  await verifyImport(orgId, fileToDocuments);
  return summary;
}

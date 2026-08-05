import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { getS3Blob, putS3Blob, s3Enabled } from "../file-storage.ts";
import {
  netsuiteRestlet,
  netsuiteSoapFileGet,
  netsuiteSoapTransactionIdsForFile,
  type NetSuiteCreds,
} from "../netsuite.ts";
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
  /** Restrict an operational retry to these upstream NetSuite file IDs.
   * Indexed source joins resolve only these files and their transaction links;
   * no unrelated transaction inventory or file bytes are read. */
  sourceFileIds?: string[];
}

export interface AttachmentImportFailure {
  fileId: string;
  message: string;
}

export interface ImportSummary {
  scope: "all" | "source_file_ids";
  requestedSourceFileIds: string[];
  sourceDocuments: number;
  sourceDocumentsWithoutId: number;
  sourceFiles: number;
  sourceLinks: number;
  createdFiles: number;
  newVersions: number;
  unchangedFiles: number;
  /** Already-imported files skipped without download (source last-modified
   * matches the stored marker, or marker safely backfilled — see below). */
  skippedUnchanged: number;
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

export function normalizeSourceFileIds(values: readonly string[]): string[] {
  const normalized = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  const malformed = normalized.filter((value) => !/^\d+$/.test(value));
  if (malformed.length > 0) {
    throw new Error(`source file ids must be numeric: ${malformed.join(", ")}`);
  }
  return normalized.sort((left, right) => Number(left) - Number(right));
}

export function selectRequestedAttachmentFiles(
  inventory: ReadonlyMap<string, Set<string>>,
  requestedSourceFileIds: readonly string[],
): Map<string, Set<string>> {
  const requested = normalizeSourceFileIds(requestedSourceFileIds);
  if (requested.length === 0) return new Map(inventory);

  const missing = requested.filter((fileId) => !inventory.has(fileId));
  if (missing.length > 0) {
    throw new Error(
      `requested source files are not attached to an imported vendor bill or expense report: ${missing.join(", ")}`,
    );
  }
  return new Map(requested.map((fileId) => [fileId, new Set(inventory.get(fileId)!)]));
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

export function normalizeAttachmentBytes(bytes: Buffer): Buffer {
  if (!bytes.subarray(0, 13).toString("ascii").startsWith("%PDFfileName=")) return bytes;
  const boundedPrefix = bytes.subarray(0, Math.min(bytes.length, 1_024)).toString("ascii");
  const pdfHeader = boundedPrefix.indexOf("%PDF-", 5);
  if (pdfHeader < 0) return bytes;
  return bytes.subarray(pdfHeader);
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
  soapEndpointVersion: string;
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
    soapEndpointVersion: String(connection.config.soapEndpoint || "2022_1"),
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

async function targetedAttachmentInventory(
  orgId: string,
  sourceFileIds: string[],
  creds: NetSuiteCreds,
  concurrency: number,
  soapEndpointVersion?: string,
): Promise<{
  documents: SourceDocument[];
  fileToDocuments: Map<string, Set<string>>;
}> {
  const relationships = await concurrentMap(
    sourceFileIds,
    concurrency,
    async (fileId) => ({
      fileId,
      transactionIds: await netsuiteSoapTransactionIdsForFile(
        fileId,
        creds,
        soapEndpointVersion,
      ),
    }),
  );
  const sourceTransactionIds = Array.from(
    new Set(relationships.flatMap((row) => row.transactionIds)),
  );
  if (sourceTransactionIds.length === 0) {
    throw new Error(
      `requested source files have no NetSuite transaction relationships: ${sourceFileIds.join(", ")}`,
    );
  }
  const sourceIdsSql = sql.join(
    sourceTransactionIds.map((sourceId) => sql`${sourceId}`),
    sql`, `,
  );
  const result = (await db.execute(sql`
    select id, kind, custom->>'nsId' as "nsId"
      from documents
     where org_id = ${orgId}
       and kind in ('vendor_bill', 'expense_report')
       and custom->>'nsId' in (${sourceIdsSql})
     order by kind, id
  `)) as unknown as {
    rows: Array<{ id: string; kind: SourceKind; nsId: string | null }>;
  };
  const documents = result.rows.filter(
    (row): row is SourceDocument => Boolean(row.nsId),
  );
  const documentBySourceId = new Map<string, SourceDocument>();
  for (const document of documents) {
    if (documentBySourceId.has(document.nsId)) {
      throw new Error(
        `multiple imported documents share NetSuite transaction ${document.nsId}`,
      );
    }
    documentBySourceId.set(document.nsId, document);
  }

  const fileToDocuments = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    const targets = new Set<string>();
    for (const transactionId of relationship.transactionIds) {
      const document = documentBySourceId.get(transactionId);
      if (document) targets.add(document.id);
    }
    if (targets.size === 0) {
      throw new Error(
        `requested source file ${relationship.fileId} is not attached to an imported vendor bill or expense report`,
      );
    }
    fileToDocuments.set(relationship.fileId, targets);
  }
  return { documents, fileToDocuments };
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

export async function downloadSourceFile(
  fileId: string,
  creds: NetSuiteCreds,
  bridge: { script: string; deploy: string },
  soapEndpointVersion?: string,
): Promise<{ source: SourceFile; bytes: Buffer }> {
  const response = await netsuiteRestlet<unknown>(bridge.script, bridge.deploy, {
    action: "attachmentContent",
    fileId,
  }, creds, "POST");
  const body = response as { ok?: unknown; error?: unknown; file?: Record<string, unknown> };
  const encoding = body?.file ? String(body.file.encoding ?? "") : "";
  if (encoding === "base64") return decodeBridgeAttachment(response, fileId);
  if (body?.ok === true && (encoding === "oversized" || encoding === "base64-chunks")) {
    // The file is too large for the RESTlet transport. Every SuiteScript
    // read path is capped or broken (getContents 10.0MB cap, FileReader read
    // budget, getSegments' unconsumable iterable — all verified live), so
    // pull the whole file through SuiteTalk SOAP instead: the only NetSuite
    // read path without a size ceiling (proven to 23MB+). The 'base64-chunks'
    // marker from older bridges is honoured the same way.
    const { name, bytes } = await netsuiteSoapFileGet(fileId, creds, soapEndpointVersion);
    return { source: { id: fileId, name }, bytes };
  }
  throw new Error(String(body?.error || "attachment bridge download failed"));
}

/** Title-case a snake_case kind ("vendor_bill" -> "Vendor Bill"). Must match
 *  web/lib/file-cabinet.ts titleizeKind and the SQL backfill so the sync and the
 *  cabinet UI resolve attachments to the same kind group folder. */
function titleizeKind(s: string): string {
  return s
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

async function ensureRecordFolder(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  documentId: string,
): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attachments:${orgId}:${documentId}`}))`);
  const existing = (await tx.execute(sql`
    select id from folders where org_id = ${orgId} and record_table = 'documents' and record_id = ${documentId}
      and record_id is not null
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
  const rootId = root.rows[0].id;

  // Nest the per-record leaf under a kind group folder so the cabinet never
  // enumerates tens of thousands of flat attachment folders.
  const kindRow = (await tx.execute(sql`
    select kind from documents where id = ${documentId} and org_id = ${orgId}
  `)) as unknown as { rows: { kind: string | null }[] };
  const label = kindRow.rows[0]?.kind ? titleizeKind(kindRow.rows[0].kind) : "Documents";
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attach-group:${orgId}:${label}`}))`);
  let group = (await tx.execute(sql`
    select id from folders
     where org_id = ${orgId} and parent_folder_id = ${rootId} and record_id is null and name = ${label}
  `)) as unknown as { rows: { id: string }[] };
  if (!group.rows[0]) {
    group = (await tx.execute(sql`
      insert into folders (org_id, parent_folder_id, name, is_system, record_table, created_at, updated_at)
      values (${orgId}, ${rootId}, ${label}, true, 'documents', now(), now()) returning id
    `)) as unknown as { rows: { id: string }[] };
  }

  const inserted = (await tx.execute(sql`
    insert into folders (org_id, parent_folder_id, name, is_system, record_table, record_id, created_at, updated_at)
    values (${orgId}, ${group.rows[0].id}, ${`documents / ${documentId.slice(0, 8)}`}, true, 'documents', ${documentId}, now(), now())
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
  sourceModifiedAt: Date | null;
}): Promise<{ fileId: string; created: boolean; versioned: boolean; unchanged: boolean; createdLinks: number }> {
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const filename = safeFilename(input.source.name, input.source.id);
  const sourceModifiedAtIso = input.sourceModifiedAt?.toISOString() ?? null;
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
                           size_bytes, storage_kind, source_system, source_id, source_modified_at, content_hash,
                           created_by, updated_by, created_at, updated_at)
        values (${fileId}, ${input.orgId}, ${folderId}, ${filename}, ${extension(filename)},
                ${derivedFileType(input.contentType)}, ${input.contentType}, ${input.bytes.length}, 's3',
                ${SOURCE_SYSTEM}, ${input.source.id}, ${sourceModifiedAtIso}, ${hash}, ${input.actorId}, ${input.actorId}, now(), now())
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
                         source_modified_at = ${sourceModifiedAtIso},
                         updated_by = ${input.actorId}, updated_at = now()
         where id = ${fileId} and org_id = ${input.orgId}
      `);
      versioned = !created;
    } else {
      await tx.execute(sql`
        update files set name = ${filename}, extension = ${extension(filename)},
                         file_type = ${derivedFileType(input.contentType)}, content_type = ${input.contentType},
                         size_bytes = ${input.bytes.length}, source_modified_at = ${sourceModifiedAtIso},
                         updated_by = ${input.actorId}, updated_at = now()
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
    return { fileId, created, versioned, unchanged: !created && unchanged, createdLinks };
  });
}

async function verifyImport(
  orgId: string,
  fileToDocuments: Map<string, Set<string>>,
  verifyStoredBytes: boolean,
): Promise<void> {
  const sourceFileIds = Array.from(fileToDocuments.keys());
  if (sourceFileIds.length === 0) return;
  const sourceIdsSql = sql.join(sourceFileIds.map((fileId) => sql`${fileId}`), sql`, `);
  const filesResult = (await db.execute(sql`
    select f.source_id as "sourceId", f.id, f.current_version_id as "currentVersionId",
           f.storage_kind as "storageKind", f.size_bytes as "sizeBytes",
           f.content_hash as "contentHash", fv.storage_kind as "versionStorageKind",
           fv.size_bytes as "versionSizeBytes", fv.content_hash as "versionContentHash"
      from files f
      left join file_versions fv on fv.id = f.current_version_id
     where f.org_id = ${orgId} and f.source_system = ${SOURCE_SYSTEM}
       and f.source_id in (${sourceIdsSql})
  `)) as unknown as {
    rows: {
      sourceId: string;
      id: string;
      currentVersionId: string | null;
      storageKind: string;
      sizeBytes: number;
      contentHash: string | null;
      versionStorageKind: string | null;
      versionSizeBytes: number | null;
      versionContentHash: string | null;
    }[];
  };
  const filesBySourceId = new Map(filesResult.rows.map((row) => [row.sourceId, row]));

  for (const sourceFileId of sourceFileIds) {
    const row = filesBySourceId.get(sourceFileId);
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

  const linksResult = (await db.execute(sql`
    select f.source_id as "sourceId", fa.target_id as "targetId"
      from files f
      join file_attachments fa
        on fa.org_id = f.org_id and fa.file_id = f.id and fa.target_table = 'documents'
     where f.org_id = ${orgId} and f.source_system = ${SOURCE_SYSTEM}
       and f.source_id in (${sourceIdsSql})
  `)) as unknown as { rows: { sourceId: string; targetId: string }[] };
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

/**
 * Upstream last-modified per source file id, in epoch ms. The source's wall
 * clock is read as UTC (the codebase's watermark convention) — only equality
 * across runs matters, so the absolute frame is irrelevant. Files missing
 * from the result (deleted upstream, or metadata not exposed) simply stay
 * download-eligible, the always-safe default.
 */
export async function fetchSourceFileModified(
  fileIds: string[],
  creds: NetSuiteCreds,
  bridge: { script: string; deploy: string },
): Promise<Map<string, number>> {
  const modified = new Map<string, number>();
  for (const chunk of chunks(fileIds, 250)) {
    const response = await netsuiteRestlet<{
      ok?: boolean;
      error?: string;
      rows?: { id: string | number; lastmod: string | null }[];
    }>(bridge.script, bridge.deploy, {
      action: "query",
      sql: `SELECT id, TO_CHAR(lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS lastmod FROM file WHERE id IN (${chunk.join(",")})`,
    }, creds, "POST");
    if (response.ok === false) throw new Error(response.error || "source file metadata query failed");
    for (const row of response.rows ?? []) {
      const ms = row.lastmod ? Date.parse(`${row.lastmod.replace(" ", "T")}Z`) : NaN;
      if (Number.isFinite(ms)) modified.set(String(row.id), ms);
    }
  }
  return modified;
}

/** Clock-skew margin for the marker backfill: the source's wall clock and ours
 *  need not agree, so only treat a stored version as definitively newer than
 *  the source's last change when a full day separates the two instants. */
const BACKFILL_SKEW_MS = 24 * 60 * 60_000;

export async function importNetSuiteAttachments(options: ImportOptions): Promise<ImportSummary> {
  const requestedSourceFileIds = normalizeSourceFileIds(options.sourceFileIds ?? []);
  if (requestedSourceFileIds.length > 0 && options.limit !== undefined) {
    throw new Error("targeted source-file retries cannot be combined with a document limit");
  }
  const { orgId, actorId, creds, bridge, soapEndpointVersion } = await resolveContext(options);
  if (options.execute && !s3Enabled) {
    throw new Error("S3/MinIO is not configured; refusing to fall back to database blobs");
  }
  let documents: SourceDocument[];
  let withoutSourceId: number;
  let fileToDocuments: Map<string, Set<string>>;
  if (requestedSourceFileIds.length > 0) {
    const targeted = await targetedAttachmentInventory(
      orgId,
      requestedSourceFileIds,
      creds,
      options.concurrency,
      soapEndpointVersion,
    );
    documents = targeted.documents;
    withoutSourceId = 0;
    fileToDocuments = targeted.fileToDocuments;
    console.log(
      `[inventory] resolved ${requestedSourceFileIds.length} requested files directly across ${documents.length} source transactions`,
    );
  } else {
    const source = await sourceDocuments(orgId, options.limit);
    documents = source.documents;
    withoutSourceId = source.withoutSourceId;
    console.log(
      `[inventory] resolving attachments for ${documents.length} source transactions`,
    );
    fileToDocuments = await attachmentInventory(
      documents,
      creds,
      options.concurrency,
      bridge,
    );
  }
  const sourceLinks = Array.from(fileToDocuments.values()).reduce((sum, ids) => sum + ids.size, 0);
  const summary: ImportSummary = {
    scope: requestedSourceFileIds.length > 0 ? "source_file_ids" : "all",
    requestedSourceFileIds,
    sourceDocuments: documents.length,
    sourceDocumentsWithoutId: withoutSourceId,
    sourceFiles: fileToDocuments.size,
    sourceLinks,
    createdFiles: 0,
    newVersions: 0,
    unchangedFiles: 0,
    skippedUnchanged: 0,
    createdLinks: 0,
    failures: 0,
    failureDetails: [],
  };
  console.log(
    requestedSourceFileIds.length > 0
      ? `[inventory] selected ${summary.sourceFiles} requested files across ${summary.sourceLinks} transaction links`
      : `[inventory] found ${summary.sourceFiles} unique files across ${summary.sourceLinks} transaction links`,
  );
  if (!options.execute) return summary;

  // -- incremental decision: download only new or provably-changed files ------
  // The source's own last-modified instant is the equality token. A file is
  // skipped when its stored marker matches; a pre-marker row (imported before
  // markers existed) is backfilled WITHOUT a download when the stored version
  // was created long after the source's last change (skew-margined) — the
  // bytes held are then provably current. Everything else is downloaded:
  // unknown, marker-mismatch, or metadata missing. A metadata outage degrades
  // to the old full re-read, which is always correct — never to silent skips.
  const sourceModified = await fetchSourceFileModified(
    Array.from(fileToDocuments.keys()),
    creds,
    bridge,
  ).catch((error: unknown) => {
    console.error(`[import] source file metadata unavailable — falling back to a full re-read: ${(error as Error).message}`);
    return null;
  });
  const requestedIdsSql = requestedSourceFileIds.length > 0
    ? sql`and f.source_id in (${sql.join(
      requestedSourceFileIds.map((fileId) => sql`${fileId}`),
      sql`, `,
    )})`
    : sql``;
  const imported = (await db.execute(sql`
    select f.source_id as "sourceId",
           f.source_modified_at as "sourceModifiedAt",
           fv.created_at as "versionCreatedAt"
      from files f
      left join file_versions fv on fv.id = f.current_version_id
     where f.org_id = ${orgId} and f.source_system = ${SOURCE_SYSTEM} and f.source_id is not null
       ${requestedIdsSql}
  `)) as unknown as { rows: { sourceId: string; sourceModifiedAt: string | null; versionCreatedAt: string | null }[] };
  const importedById = new Map(imported.rows.map((row) => [row.sourceId, {
    modifiedMs: row.sourceModifiedAt ? Date.parse(row.sourceModifiedAt) : null,
    versionCreatedMs: row.versionCreatedAt ? Date.parse(row.versionCreatedAt) : null,
  }]));

  const downloadIds: string[] = [];
  const downloadSet = new Set<string>();
  const backfill: { fileId: string; modifiedMs: number }[] = [];
  for (const fileId of fileToDocuments.keys()) {
    const lastModifiedMs = sourceModified?.get(fileId) ?? null;
    const have = importedById.get(fileId);
    if (!have) {
      downloadIds.push(fileId);
      downloadSet.add(fileId);
      continue;
    }
    if (lastModifiedMs != null && have.modifiedMs != null && have.modifiedMs === lastModifiedMs) {
      summary.skippedUnchanged++;
      continue;
    }
    if (lastModifiedMs != null && have.modifiedMs == null && have.versionCreatedMs != null
        && lastModifiedMs <= have.versionCreatedMs - BACKFILL_SKEW_MS) {
      backfill.push({ fileId, modifiedMs: lastModifiedMs });
      summary.skippedUnchanged++;
      continue;
    }
    downloadIds.push(fileId);
    downloadSet.add(fileId);
  }
  for (const batch of chunks(backfill, 500)) {
    const tuples = batch
      .map(({ fileId, modifiedMs }) => `('${fileId}', '${new Date(modifiedMs).toISOString()}'::timestamptz)`)
      .join(",");
    await db.execute(sql.raw(`
      update files f set source_modified_at = v.marker
        from (values ${tuples}) as v(source_id, marker)
       where f.org_id = '${orgId}' and f.source_system = '${SOURCE_SYSTEM}' and f.source_id = v.source_id
    `));
  }
  if (backfill.length > 0) {
    console.log(`[import] backfilled last-modified markers for ${backfill.length} already-current files`);
  }

  // Skipped files bypass persistFile, but the source's link graph may have
  // grown (an already-held file attached to another transaction) — ensure
  // every inventoried link exists.
  const linkTuples: string[] = [];
  for (const [fileId, documentIds] of fileToDocuments) {
    if (downloadSet.has(fileId) || !importedById.has(fileId)) continue;
    for (const documentId of documentIds) linkTuples.push(`('${fileId}', '${documentId}'::uuid)`);
  }
  for (const batch of chunks(linkTuples, 1000)) {
    const res = (await db.execute(sql.raw(`
      insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
      select '${orgId}', f.id, 'documents', v.did, '${actorId}', now()
        from (values ${batch.join(",")}) as v(sid, did)
        join files f on f.org_id = '${orgId}' and f.source_system = '${SOURCE_SYSTEM}' and f.source_id = v.sid
      on conflict (org_id, file_id, target_table, target_id) do nothing
    `))) as unknown as { rowCount?: number };
    summary.createdLinks += res.rowCount ?? 0;
  }

  downloadIds.sort((left, right) => Number(left) - Number(right));
  console.log(`[import] downloading ${downloadIds.length} new/changed files (${summary.skippedUnchanged} skipped unchanged)`);
  await concurrentMap(downloadIds, options.concurrency, async (fileId, index) => {
    try {
      const { source, bytes: sourceBytes } = await downloadSourceFile(fileId, creds, bridge, soapEndpointVersion);
      const bytes = normalizeAttachmentBytes(sourceBytes);
      const contentType = detectContentType(bytes, source.name);
      const lastModifiedMs = sourceModified?.get(fileId) ?? null;
      const persisted = await persistFile({
        orgId,
        actorId,
        source,
        targetDocumentIds: Array.from(fileToDocuments.get(source.id) ?? []),
        bytes,
        contentType,
        sourceModifiedAt: lastModifiedMs != null ? new Date(lastModifiedMs) : null,
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
    if ((index + 1) % 100 === 0 || index + 1 === downloadIds.length) {
      console.log(`[import] ${index + 1}/${downloadIds.length} files (${summary.failures} failed)`);
    }
  });
  if (summary.failures) throw new AttachmentImportError(summary);
  await verifyImport(orgId, fileToDocuments, requestedSourceFileIds.length > 0);
  return summary;
}

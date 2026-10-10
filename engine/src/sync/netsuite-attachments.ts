import { AttachmentImportError, type ImportSummary } from "./attachment-contract.ts";
export { AttachmentImportError, type ImportSummary, type AttachmentImportFailure } from "./attachment-contract.ts";
import { linkExistingTransactionFiles } from "./transaction-attachments.ts";
import { detectContentType, normalizeAttachmentBytes, persistTransactionFile, verifyTransactionFiles } from "./transaction-file-storage.ts";
export { safeFilename, detectContentType, normalizeAttachmentBytes } from "./transaction-file-storage.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { s3Enabled } from "../platform/file-storage.ts";
import {
  netsuiteRestlet,
  netsuiteSoapFileGet,
  netsuiteSoapTransactionIdsForFile,
  type NetSuiteCreds,
} from "../connectors/netsuite.ts";
import {
  DEFAULT_NETSUITE_BRIDGE_DEPLOYMENT_ID,
  DEFAULT_NETSUITE_BRIDGE_SCRIPT_ID,
} from "../connectors/netsuite-bridge.ts";
import { unsealJson } from "../platform/secrets.ts";
import { isUuid } from "../platform/uuid.ts";

const SOURCE_SYSTEM = "netsuite";
const RESTLET_BATCH_SIZE = 50;

type SourceKind = string;

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
  /** Authenticated user who authorized this import; omitted for connector/system runs. */
  actorId?: string | null;
  execute: boolean;
  concurrency: number;
  limit?: number;
  /** Restrict an operational retry to these upstream NetSuite file IDs.
   * Indexed source joins resolve only these files and their transaction links;
   * no unrelated transaction inventory or file bytes are read. */
  sourceFileIds?: string[];
}

/**
 * Normalize the optional audit actor without inventing an identity. A missing
 * actor is an intentional system import and is persisted as NULL; a supplied
 * value must be a UUID so resolveContext can re-authorize it in this tenant.
 */
export function normalizeImportActorId(actorId: string | null | undefined): string | null {
  if (actorId == null) return null;
  if (typeof actorId !== "string") throw new Error("attachment import actorId must be a valid user id");
  const normalized = actorId.trim();
  if (!normalized) return null;
  if (!isUuid(normalized)) throw new Error("attachment import actorId must be a valid user id");
  return normalized;
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
      `requested source files are not attached to an imported transaction: ${missing.join(", ")}`,
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
      result[index] = await task(values[index]!, index);
    }
  }));
  return result;
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
  actorId: string | null;
  creds: NetSuiteCreds;
  bridge: { script: string; deploy: string };
  soapEndpointVersion: string;
  connectionId: string;
}> {
  const orgResult = (await db.execute<{ id: string; name: string }>(sql`
    select id, name from orgs where id::text = ${options.org} or name = ${options.org}
  `));
  if (orgResult.rows.length !== 1) throw new Error(`tenant not found or ambiguous: ${options.org}`);
  const orgId = orgResult.rows[0]!.id;

  const connectionResult = (await db.execute<{ id: string; config: Record<string, unknown>; secrets: string | null }>(sql`
    select id, config, secrets
      from connections
     where org_id = ${orgId} and source = 'netsuite'
       ${options.connectionId ? sql`and id = ${options.connectionId}` : sql``}
     order by (status = 'active') desc, created_at desc
  `));
  if (connectionResult.rows.length > 1) throw new Error('Select one NetSuite connection before importing transaction files');
  const connection = connectionResult.rows[0];
  if (!connection) throw new Error("tenant does not have a NetSuite connection");
  const secret =
    connection.secrets == null
      ? null
      : unsealJson<Partial<NetSuiteCreds>>(connection.secrets, { orgId, purpose: "connection.secrets" });
  if (!secret?.consumerKey || !secret.consumerSecret || !secret.tokenKey || !secret.tokenSecret) {
    throw new Error("tenant NetSuite connection is missing sealed credentials");
  }
  const account = String(connection.config.account ?? "");
  const host = String(connection.config.host ?? "");
  if (!account || !host) throw new Error("tenant NetSuite connection is missing account or host configuration");

  const actorId = normalizeImportActorId(options.actorId);
  if (actorId) {
    const actorResult = (await db.execute<{ id: string }>(sql`
      select id from users where id = ${actorId} and org_id = ${orgId} and is_active
    `));
    if (!actorResult.rows[0]) {
      throw new Error("attachment import actor must be an active user in the tenant");
    }
  }
  return {
    orgId,
    connectionId: connection.id,
    actorId,
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

async function sourceDocuments(orgId: string, connectionId: string, limit?: number): Promise<{
  documents: SourceDocument[];
  withoutSourceId: number;
}> {
  const result = (await db.execute<{ id: string; kind: SourceKind; nsId: string | null }>(sql`
    select id, kind, custom->>'nsId' as "nsId"
      from documents
     where org_id = ${orgId} and custom->>'nsId' is not null
       and (custom->>'connectionId' is null or custom->>'connectionId'=${connectionId})
     order by kind, id
     ${limit ? sql`limit ${limit}` : sql``}
  `));
  return {
    documents: result.rows.filter((row): row is SourceDocument => Boolean(row.nsId)),
    withoutSourceId: result.rows.filter((row) => !row.nsId).length,
  };
}

async function targetedAttachmentInventory(
  orgId: string,
  connectionId: string,
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
  const result = (await db.execute<{ id: string; kind: SourceKind; nsId: string | null }>(sql`
    select id, kind, custom->>'nsId' as "nsId"
      from documents
     where org_id = ${orgId}
       and custom->>'nsId' is not null
       and (custom->>'connectionId' is null or custom->>'connectionId'=${connectionId})
       and custom->>'nsId' in (${sourceIdsSql})
     order by kind, id
  `));
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
        `requested source file ${relationship.fileId} is not attached to an imported transaction`,
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
        recordType: doc.kind === "expense_report" ? "expenseReport" : "transaction",
        internalId: doc.nsId,
      })),
    }, creds, "POST");
    if (!response.ok || !response.records) throw new Error(response.error || "attachment inventory failed");
    for (const document of batch) {
      if (!Array.isArray(response.records[document.nsId])) {
        throw new Error(`attachment inventory omitted source transaction ${document.nsId}; update the extraction bridge and retry`);
      }
    }
    if ((index + 1) % 20 === 0 || index + 1 === batches.length) {
      console.log(`[inventory] ${Math.min((index + 1) * RESTLET_BATCH_SIZE, documents.length)}/${documents.length} transactions`);
    }
    return { batch, records: response.records };
  });

  const sourceIdToDocumentIds = new Map<string, string>();
  for (const document of documents) {
    if (sourceIdToDocumentIds.has(document.nsId)) throw new Error(`Multiple native transactions share NetSuite identity ${document.nsId}`);
    sourceIdToDocumentIds.set(document.nsId, document.id);
  }
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
  if (body?.ok === true && (encoding === "oversized" || encoding === "base64-chunks" || encoding === "raw-bytes")) {
    // SOAP preserves source bytes for text and files exceeding the RESTlet
    // transport limit; older chunk markers use the same read path.
    const { name, bytes } = await netsuiteSoapFileGet(fileId, creds, soapEndpointVersion);
    return { source: { id: fileId, name }, bytes };
  }
  throw new Error(String(body?.error || "attachment bridge download failed"));
}

/**
 * Upstream last-modified per source file id, in epoch ms. The source's wall
 * clock is read as UTC; only equality across runs determines eligibility.
 * Missing metadata must be refused by the caller before any downloads.
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

export function attachmentNeedsDownload(input: {
  sourceModifiedMs: number;
  storedModifiedMs: number | null;
  currentVersionReady: boolean;
}): boolean {
  return !input.currentVersionReady || input.storedModifiedMs !== input.sourceModifiedMs;
}

export async function importNetSuiteAttachments(options: ImportOptions): Promise<ImportSummary> {
  const requestedSourceFileIds = normalizeSourceFileIds(options.sourceFileIds ?? []);
  if (requestedSourceFileIds.length > 0 && options.limit !== undefined) {
    throw new Error("targeted source-file retries cannot be combined with a document limit");
  }
  const { orgId, connectionId, actorId, creds, bridge, soapEndpointVersion } = await resolveContext(options);
  const otherConnection = (await db.execute(sql`select id from connections where org_id=${orgId} and source='netsuite' and id<>${connectionId} limit 1`)).rows[0];
  // Legacy NetSuite file identities are account-wide; never reuse them across connections.
  if (otherConnection) throw new Error("NetSuite file sync requires one source connection per organization; resolve the account identity before importing files");
  if (options.execute && !s3Enabled) {
    throw new Error("S3/MinIO is not configured; refusing to fall back to database blobs");
  }
  let documents: SourceDocument[];
  let withoutSourceId: number;
  let fileToDocuments: Map<string, Set<string>>;
  if (requestedSourceFileIds.length > 0) {
    const targeted = await targetedAttachmentInventory(
      orgId,
      connectionId,
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
    const source = await sourceDocuments(orgId, connectionId, options.limit);
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

  // The source marker is the change token. Metadata failures refuse before
  // downloading bytes, so a scheduled sync cannot become an archive reread.
  const sourceModified = await fetchSourceFileModified(
    Array.from(fileToDocuments.keys()), creds, bridge,
  );
  for (const fileId of fileToDocuments.keys()) {
    if (!sourceModified.has(fileId)) {
      throw new Error(`source file ${fileId} has no last-modified metadata; check extraction permissions and retry`);
    }
  }
  const requestedIdsSql = requestedSourceFileIds.length > 0
    ? sql`and f.source_id in (${sql.join(
      requestedSourceFileIds.map((fileId) => sql`${fileId}`),
      sql`, `,
    )})`
    : sql``;
  const imported = (await db.execute<{
    sourceId: string; sourceModifiedAt: string | null; currentVersionReady: boolean;
  }>(sql`
    select f.source_id as "sourceId", f.source_modified_at as "sourceModifiedAt",
           (f.storage_kind = 's3' and fv.storage_kind = 's3'
            and f.content_hash is not null and f.content_hash = fv.content_hash
            and f.size_bytes = fv.size_bytes) as "currentVersionReady"
      from files f
      left join file_versions fv on fv.id = f.current_version_id and fv.file_id = f.id
     where f.org_id = ${orgId} and f.source_system = ${SOURCE_SYSTEM} and f.source_id is not null
       ${requestedIdsSql}
  `));
  const importedById = new Map(imported.rows.map((row) => [row.sourceId, row]));
  const downloadIds: string[] = [];
  const downloadSet = new Set<string>();
  for (const fileId of fileToDocuments.keys()) {
    const have = importedById.get(fileId);
    if (attachmentNeedsDownload({
      sourceModifiedMs: sourceModified.get(fileId)!,
      storedModifiedMs: have?.sourceModifiedAt ? Date.parse(have.sourceModifiedAt) : null,
      currentVersionReady: have?.currentVersionReady === true,
    })) {
      downloadIds.push(fileId);
      downloadSet.add(fileId);
    } else summary.skippedUnchanged++;
  }

  // Skipped files bypass version persistence, but the source's link graph may have
  // grown (an already-held file attached to another transaction) — ensure
  // every inventoried link exists.
  const linkTuples: { sourceId: string; documentId: string }[] = [];
  for (const [fileId, documentIds] of fileToDocuments) {
    if (downloadSet.has(fileId) || !importedById.has(fileId)) continue;
    for (const documentId of documentIds) linkTuples.push({ sourceId: fileId, documentId });
  }
  for (const batch of chunks(linkTuples, 1000)) {
    summary.createdLinks += await linkExistingTransactionFiles(orgId, SOURCE_SYSTEM, actorId, batch);
  }

  downloadIds.sort((left, right) => Number(left) - Number(right));
  console.log(`[import] downloading ${downloadIds.length} new/changed files (${summary.skippedUnchanged} skipped unchanged)`);
  await concurrentMap(downloadIds, options.concurrency, async (fileId, index) => {
    try {
      const { source, bytes: sourceBytes } = await downloadSourceFile(fileId, creds, bridge, soapEndpointVersion);
      const bytes = normalizeAttachmentBytes(sourceBytes);
      const contentType = detectContentType(bytes, source.name);
      const lastModifiedMs = sourceModified.get(fileId) ?? null;
      const persisted = await persistTransactionFile({
        orgId,
        sourceSystem: SOURCE_SYSTEM,
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
      if (persisted.stale) summary.skippedUnchanged++;
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
  await verifyTransactionFiles(orgId, SOURCE_SYSTEM, fileToDocuments, requestedSourceFileIds.length > 0);
  return summary;
}

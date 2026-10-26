import { AttachmentImportError, type ImportSummary } from "./attachment-contract.ts";
export {
  AttachmentImportError,
  type ImportSummary,
  type AttachmentImportFailure,
} from "./attachment-contract.ts";
import { linkExistingTransactionFiles } from "./transaction-attachments.ts";
import {
  detectContentType,
  normalizeAttachmentBytes,
  persistTransactionFile,
  verifyTransactionFiles,
  type SourceFileTarget,
} from "./transaction-file-storage.ts";
export {
  safeFilename,
  detectContentType,
  normalizeAttachmentBytes,
} from "./transaction-file-storage.ts";
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
  NetSuiteBridgeClient,
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
  /** Incremental scope: inventory only transactions the mirror pulled since the
   * watermark plus those whose attached files changed on or after it. Omitted
   * for a full reconciliation of every imported transaction. */
  changes?: { since: Date; sourceRefs: readonly string[] };
}

/**
 * Normalize the optional audit actor without inventing an identity. A missing
 * actor is an intentional system import and is persisted as NULL; a supplied
 * value must be a UUID so resolveContext can re-authorize it in this tenant.
 */
export function normalizeImportActorId(actorId: string | null | undefined): string | null {
  if (actorId == null) return null;
  if (typeof actorId !== "string")
    throw new Error("attachment import actorId must be a valid user id");
  const normalized = actorId.trim();
  if (!normalized) return null;
  if (!isUuid(normalized)) throw new Error("attachment import actorId must be a valid user id");
  return normalized;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
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
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        result[index] = await task(values[index]!, index);
      }
    }),
  );
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
  const orgResult = await db.execute<{ id: string; name: string }>(
    sql`
    select id, name from orgs where id::text = ${options.org} or name = ${options.org}
  `,
    "objects",
  );
  if (orgResult.length !== 1) throw new Error(`tenant not found or ambiguous: ${options.org}`);
  const orgId = orgResult[0]!.id;

  const connectionResult = await db.execute<{
    id: string;
    config: Record<string, unknown>;
    secrets: string | null;
  }>(
    sql`
    select id, config, secrets
      from connections
     where org_id = ${orgId} and source = 'netsuite'
       ${options.connectionId ? sql`and id = ${options.connectionId}` : sql``}
     order by (status = 'active') desc, created_at desc
  `,
    "objects",
  );
  if (connectionResult.length > 1)
    throw new Error("Select one NetSuite connection before importing transaction files");
  const connection = connectionResult[0];
  if (!connection) throw new Error("tenant does not have a NetSuite connection");
  const secret =
    connection.secrets == null
      ? null
      : unsealJson<Partial<NetSuiteCreds>>(connection.secrets, {
          orgId,
          purpose: "connection.secrets",
        });
  if (!secret?.consumerKey || !secret.consumerSecret || !secret.tokenKey || !secret.tokenSecret) {
    throw new Error("tenant NetSuite connection is missing sealed credentials");
  }
  const account = String(connection.config.account ?? "");
  const host = String(connection.config.host ?? "");
  if (!account || !host)
    throw new Error("tenant NetSuite connection is missing account or host configuration");

  const actorId = normalizeImportActorId(options.actorId);
  if (actorId) {
    const actorResult = await db.execute<{ id: string }>(
      sql`
      select id from users where id = ${actorId} and org_id = ${orgId} and is_active
    `,
      "objects",
    );
    if (!actorResult[0]) {
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

async function sourceDocuments(
  orgId: string,
  connectionId: string,
  limit?: number,
  sourceRefs?: readonly string[],
): Promise<{
  documents: SourceDocument[];
  withoutSourceId: number;
}> {
  if (sourceRefs && sourceRefs.length === 0) return { documents: [], withoutSourceId: 0 };
  const result = await db.execute<{ id: string; kind: SourceKind; nsId: string | null }>(
    sql`
    select id, kind, custom->>'nsId' as "nsId"
      from documents
     where org_id = ${orgId} and custom->>'nsId' is not null
       and (custom->>'connectionId' is null or custom->>'connectionId'=${connectionId})
       ${sourceRefs ? sql`and custom->>'nsId' = any(${`{${sourceRefs.join(",")}}`}::text[])` : sql``}
     order by kind, id
     ${limit ? sql`limit ${limit}` : sql``}
  `,
    "objects",
  );
  return {
    documents: result.filter((row): row is SourceDocument => Boolean(row.nsId)),
    withoutSourceId: result.filter((row) => !row.nsId).length,
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
  const relationships = await concurrentMap(sourceFileIds, concurrency, async (fileId) => ({
    fileId,
    transactionIds: await netsuiteSoapTransactionIdsForFile(fileId, creds, soapEndpointVersion),
  }));
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
  const result = await db.execute<{ id: string; kind: SourceKind; nsId: string | null }>(
    sql`
    select id, kind, custom->>'nsId' as "nsId"
      from documents
     where org_id = ${orgId}
       and custom->>'nsId' is not null
       and (custom->>'connectionId' is null or custom->>'connectionId'=${connectionId})
       and custom->>'nsId' in (${sourceIdsSql})
     order by kind, id
  `,
    "objects",
  );
  const documents = result.filter((row): row is SourceDocument => Boolean(row.nsId));
  const documentBySourceId = new Map<string, SourceDocument>();
  for (const document of documents) {
    if (documentBySourceId.has(document.nsId)) {
      throw new Error(`multiple imported documents share NetSuite transaction ${document.nsId}`);
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

/** One native record and the NetSuite record whose Files subtab it mirrors. */
interface SourceRecordRef {
  id: string;
  nsId: string;
  /** Bridge inventory type: transaction, expenseReport, customer, vendor or employee. */
  recordType: string;
}

function transactionRecordRefs(documents: SourceDocument[]): SourceRecordRef[] {
  return documents.map((doc) => ({
    id: doc.id,
    nsId: doc.nsId,
    recordType: doc.kind === "expense_report" ? "expenseReport" : "transaction",
  }));
}

async function attachmentInventory(
  records: SourceRecordRef[],
  creds: NetSuiteCreds,
  concurrency: number,
  bridge: { script: string; deploy: string },
  label = "transactions",
): Promise<Map<string, Set<string>>> {
  const batches = chunks(records, RESTLET_BATCH_SIZE);
  const results = await concurrentMap(batches, concurrency, async (batch, index) => {
    const response = await netsuiteRestlet<{
      ok?: boolean;
      error?: string;
      records?: Record<string, string[]>;
    }>(
      bridge.script,
      bridge.deploy,
      {
        action: "attachmentInventory",
        records: batch.map((item) => ({ recordType: item.recordType, internalId: item.nsId })),
      },
      creds,
      "POST",
    );
    if (!response.ok || !response.records)
      throw new Error(response.error || "attachment inventory failed");
    for (const item of batch) {
      if (!Array.isArray(response.records[item.nsId])) {
        throw new Error(
          `attachment inventory omitted source record ${item.nsId}; update the extraction bridge and retry`,
        );
      }
    }
    if ((index + 1) % 20 === 0 || index + 1 === batches.length) {
      console.log(
        `[inventory] ${Math.min((index + 1) * RESTLET_BATCH_SIZE, records.length)}/${records.length} ${label}`,
      );
    }
    return { batch, records: response.records };
  });

  // One NetSuite identity may be requested under several record types (a
  // party that is both customer and vendor); it must still be one native record.
  const nativeIdBySourceId = new Map<string, string>();
  for (const item of records) {
    const prior = nativeIdBySourceId.get(item.nsId);
    if (prior && prior !== item.id)
      throw new Error(`Multiple native records share NetSuite identity ${item.nsId}`);
    nativeIdBySourceId.set(item.nsId, item.id);
  }
  const fileToTargets = new Map<string, Set<string>>();
  for (const result of results) {
    for (const [sourceId, fileIds] of Object.entries(result.records)) {
      const nativeId = nativeIdBySourceId.get(sourceId);
      if (!nativeId) throw new Error(`resolver returned unknown source record ${sourceId}`);
      for (const fileId of fileIds) {
        if (!/^\d+$/.test(fileId))
          throw new Error(`resolver returned malformed file id for source record ${sourceId}`);
        const targets = fileToTargets.get(fileId) ?? new Set<string>();
        targets.add(nativeId);
        fileToTargets.set(fileId, targets);
      }
    }
  }
  return fileToTargets;
}

/** Imported parties and the NetSuite entity types they mirror, one ref per role. */
async function sourcePartyRecords(
  orgId: string,
  nsIds?: readonly string[],
): Promise<SourceRecordRef[]> {
  if (nsIds && nsIds.length === 0) return [];
  const rows = await db.execute<{
    id: string;
    nsId: string;
    customer: boolean;
    vendor: boolean;
    employee: boolean;
  }>(
    sql`
    select p.id, p.custom->>'nsId' as "nsId",
           exists(select 1 from customer_roles r where r.org_id = p.org_id and r.party_id = p.id) as customer,
           exists(select 1 from vendor_roles r where r.org_id = p.org_id and r.party_id = p.id) as vendor,
           exists(select 1 from employee_roles r where r.org_id = p.org_id and r.party_id = p.id) as employee
      from parties p
     where p.org_id = ${orgId} and p.custom->>'nsId' ~ '^[0-9]+$'
       ${nsIds ? sql`and p.custom->>'nsId' = any(${`{${nsIds.join(",")}}`}::text[])` : sql``}
     order by p.id
  `,
    "objects",
  );
  return rows.flatMap((row) =>
    (["customer", "vendor", "employee"] as const)
      .filter((role) => row[role])
      .map((recordType) => ({ id: row.id, nsId: row.nsId, recordType })),
  );
}

export function decodeBridgeAttachment(
  response: unknown,
  expectedFileId: string,
): {
  source: SourceFile;
  bytes: Buffer;
} {
  if (!response || typeof response !== "object")
    throw new Error("attachment bridge returned an invalid response");
  const body = response as { ok?: unknown; error?: unknown; file?: Record<string, unknown> };
  if (body.ok !== true || !body.file)
    throw new Error(String(body.error || "attachment bridge download failed"));
  const id = String(body.file.id ?? "");
  const name = String(body.file.name ?? "");
  const size = Number(body.file.size);
  const encoding = String(body.file.encoding ?? "");
  const contents = body.file.contents;
  if (id !== expectedFileId || !/^\d+$/.test(id))
    throw new Error("attachment bridge returned the wrong file");
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
  const response = await netsuiteRestlet<unknown>(
    bridge.script,
    bridge.deploy,
    {
      action: "attachmentContent",
      fileId,
    },
    creds,
    "POST",
  );
  const body = response as { ok?: unknown; error?: unknown; file?: Record<string, unknown> };
  const encoding = body?.file ? String(body.file.encoding ?? "") : "";
  if (encoding === "base64") return decodeBridgeAttachment(response, fileId);
  if (
    body?.ok === true &&
    (encoding === "oversized" || encoding === "base64-chunks" || encoding === "raw-bytes")
  ) {
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
    }>(
      bridge.script,
      bridge.deploy,
      {
        action: "query",
        sql: `SELECT id, TO_CHAR(lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS lastmod FROM file WHERE id IN (${chunk.join(",")})`,
      },
      creds,
      "POST",
    );
    if (response.ok === false)
      throw new Error(response.error || "source file metadata query failed");
    for (const row of response.rows ?? []) {
      const ms = row.lastmod ? Date.parse(`${row.lastmod.replace(" ", "T")}Z`) : NaN;
      if (Number.isFinite(ms)) modified.set(String(row.id), ms);
    }
  }
  return modified;
}

/**
 * Source transactions whose attached files changed on or after the watermark's
 * calendar day (the source filters by date), unioned with the transactions the
 * mirror itself pulled. Re-inventorying a transaction is idempotent, so the
 * day-granular overlap only costs a few redundant lookups.
 */
export async function changedAttachmentTransactions(
  since: Date,
  pulledRefs: readonly string[],
  creds: NetSuiteCreds,
  bridge: { script: string; deploy: string },
  recordType = "transaction",
): Promise<string[]> {
  const day = new Date(since.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const response = await netsuiteRestlet<{ ok?: boolean; error?: string; transactions?: unknown }>(
    bridge.script,
    bridge.deploy,
    { action: "attachmentChanges", since: day, recordType },
    creds,
    "POST",
  );
  if (response.ok !== true || !Array.isArray(response.transactions)) {
    throw new Error(response.error || "attachment change lookup failed");
  }
  const refs = new Set(pulledRefs.map(String));
  for (const id of response.transactions) {
    const ref = String(id);
    if (!/^\d+$/.test(ref))
      throw new Error("attachment change lookup returned a malformed transaction id");
    refs.add(ref);
  }
  return Array.from(refs)
    .filter((ref) => /^\d+$/.test(ref))
    .sort((a, b) => Number(a) - Number(b));
}

export function attachmentNeedsDownload(input: {
  /** Null when the source exposes no change marker for the file. */
  sourceModifiedMs: number | null;
  storedModifiedMs: number | null;
  currentVersionReady: boolean;
}): boolean {
  if (!input.currentVersionReady) return true;
  if (input.sourceModifiedMs === null) return false;
  return input.storedModifiedMs !== input.sourceModifiedMs;
}

export async function importNetSuiteAttachments(options: ImportOptions): Promise<ImportSummary> {
  const requestedSourceFileIds = normalizeSourceFileIds(options.sourceFileIds ?? []);
  if (requestedSourceFileIds.length > 0 && options.limit !== undefined) {
    throw new Error("targeted source-file retries cannot be combined with a document limit");
  }
  if (options.changes && (requestedSourceFileIds.length > 0 || options.limit !== undefined)) {
    throw new Error(
      "an incremental attachment sync cannot be combined with file ids or a document limit",
    );
  }
  const { orgId, connectionId, actorId, creds, bridge, soapEndpointVersion } =
    await resolveContext(options);
  const otherConnection = (
    await db.execute(
      sql`select id from connections where org_id=${orgId} and source='netsuite' and id<>${connectionId} limit 1`,
      "objects",
    )
  )[0];
  // Legacy NetSuite file identities are account-wide; never reuse them across connections.
  if (otherConnection)
    throw new Error(
      "NetSuite file sync requires one source connection per organization; resolve the account identity before importing files",
    );
  if (options.execute && !s3Enabled) {
    throw new Error("S3/MinIO is not configured; refusing to fall back to database blobs");
  }
  // Inventory asks for every transaction type; older bridges accept only
  // bills and expense reports and would refuse mid-run.
  await new NetSuiteBridgeClient(creds, {
    scriptId: bridge.script,
    deploymentId: bridge.deploy,
  }).requireCompatible();
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
    const scopedRefs = options.changes
      ? await changedAttachmentTransactions(
          options.changes.since,
          options.changes.sourceRefs,
          creds,
          bridge,
        )
      : undefined;
    const source = await sourceDocuments(orgId, connectionId, options.limit, scopedRefs);
    documents = source.documents;
    withoutSourceId = source.withoutSourceId;
    console.log(`[inventory] resolving attachments for ${documents.length} source transactions`);
    fileToDocuments = await attachmentInventory(
      transactionRecordRefs(documents),
      creds,
      options.concurrency,
      bridge,
    );
  }
  // Customer, vendor and employee Files subtabs. Operator retries of named
  // files stay transaction-scoped.
  let partyRecords: SourceRecordRef[] = [];
  let fileToParties = new Map<string, Set<string>>();
  if (requestedSourceFileIds.length === 0 && options.limit === undefined) {
    let changedPartyIds: string[] | undefined;
    if (options.changes) {
      const changed = new Set<string>();
      for (const recordType of ["customer", "vendor", "employee"]) {
        for (const id of await changedAttachmentTransactions(
          options.changes.since,
          [],
          creds,
          bridge,
          recordType,
        ))
          changed.add(id);
      }
      changedPartyIds = [...changed];
    }
    partyRecords = await sourcePartyRecords(orgId, changedPartyIds);
    fileToParties = await attachmentInventory(
      partyRecords,
      creds,
      options.concurrency,
      bridge,
      "party records",
    );
  }
  const sourceLinks = [...fileToDocuments.values(), ...fileToParties.values()].reduce(
    (sum, ids) => sum + ids.size,
    0,
  );
  const summary: ImportSummary = {
    scope:
      requestedSourceFileIds.length > 0 ? "source_file_ids" : options.changes ? "changes" : "all",
    ...(options.changes ? { changedSince: options.changes.since.toISOString() } : {}),
    requestedSourceFileIds,
    sourceDocuments: documents.length,
    sourceDocumentsWithoutId: withoutSourceId,
    sourceParties: new Set(partyRecords.map((record) => record.id)).size,
    sourceFiles: new Set([...fileToDocuments.keys(), ...fileToParties.keys()]).size,
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

  const graph = {
    orgId,
    actorId,
    creds,
    bridge,
    soapEndpointVersion,
    concurrency: options.concurrency,
    summary,
    verifyStoredBytes: requestedSourceFileIds.length > 0 || Boolean(options.changes),
  };
  // Transactions first, so a file shared with a party is downloaded once and
  // the party pass only links it.
  await importFileGraph({ ...graph, targetTable: "documents", fileToTargets: fileToDocuments });
  await importFileGraph({ ...graph, targetTable: "parties", fileToTargets: fileToParties });
  return summary;
}

/**
 * Import one inventoried source-file graph: download new or changed bytes,
 * link already-held files to any new targets, then verify every link and
 * stored version. Failures accumulate in the summary and refuse the run.
 */
async function importFileGraph(input: {
  orgId: string;
  actorId: string | null;
  creds: NetSuiteCreds;
  bridge: { script: string; deploy: string };
  soapEndpointVersion: string;
  concurrency: number;
  summary: ImportSummary;
  verifyStoredBytes: boolean;
  targetTable: SourceFileTarget;
  fileToTargets: Map<string, Set<string>>;
}): Promise<void> {
  const { orgId, actorId, creds, bridge, soapEndpointVersion, summary, targetTable } = input;
  const fileToDocuments = input.fileToTargets;
  if (fileToDocuments.size === 0) return;

  // The source marker is the change token, so a scheduled sync never rereads
  // the archive: held files download again only when their marker moves.
  const sourceModified = await fetchSourceFileModified(
    Array.from(fileToDocuments.keys()),
    creds,
    bridge,
  );
  // The metadata query cannot see files in folders the integration role may
  // not browse, although the inventory search and download path can. Such a
  // file has no change marker: it is imported when not yet held and kept when
  // held, and the count is reported rather than refusing the whole graph.
  for (const fileId of fileToDocuments.keys()) {
    if (!sourceModified.has(fileId))
      summary.filesWithoutSourceMarker = (summary.filesWithoutSourceMarker ?? 0) + 1;
  }
  const inventoriedIds = Array.from(fileToDocuments.keys());
  const imported = await db.execute<{
    sourceId: string;
    sourceModifiedAt: string | null;
    currentVersionReady: boolean;
  }>(
    sql`
    select f.source_id as "sourceId", f.source_modified_at as "sourceModifiedAt",
           (f.storage_kind = 's3' and fv.storage_kind = 's3'
            and f.content_hash is not null and f.content_hash = fv.content_hash
            and f.size_bytes = fv.size_bytes) as "currentVersionReady"
      from files f
      left join file_versions fv on fv.id = f.current_version_id and fv.file_id = f.id
     where f.org_id = ${orgId} and f.source_system = ${SOURCE_SYSTEM}
       and f.source_id = any(${`{${inventoriedIds.join(",")}}`}::text[])
  `,
    "objects",
  );
  const importedById = new Map(imported.map((row) => [row.sourceId, row]));
  const downloadIds: string[] = [];
  const downloadSet = new Set<string>();
  for (const fileId of fileToDocuments.keys()) {
    const have = importedById.get(fileId);
    if (
      attachmentNeedsDownload({
        sourceModifiedMs: sourceModified.get(fileId) ?? null,
        storedModifiedMs: have?.sourceModifiedAt ? Date.parse(have.sourceModifiedAt) : null,
        currentVersionReady: have?.currentVersionReady === true,
      })
    ) {
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
    summary.createdLinks += await linkExistingTransactionFiles(
      orgId,
      SOURCE_SYSTEM,
      actorId,
      batch,
      targetTable,
    );
  }

  downloadIds.sort((left, right) => Number(left) - Number(right));
  console.log(
    `[import] ${targetTable}: downloading ${downloadIds.length} new/changed files (${summary.skippedUnchanged} skipped unchanged)`,
  );
  await concurrentMap(downloadIds, input.concurrency, async (fileId, index) => {
    try {
      const { source, bytes: sourceBytes } = await downloadSourceFile(
        fileId,
        creds,
        bridge,
        soapEndpointVersion,
      );
      const bytes = normalizeAttachmentBytes(sourceBytes);
      const contentType = detectContentType(bytes, source.name);
      const lastModifiedMs = sourceModified.get(fileId) ?? null;
      const persisted = await persistTransactionFile({
        orgId,
        sourceSystem: SOURCE_SYSTEM,
        actorId,
        source,
        targetTable,
        targetIds: Array.from(fileToDocuments.get(source.id) ?? []),
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
  await verifyTransactionFiles(
    orgId,
    SOURCE_SYSTEM,
    fileToDocuments,
    input.verifyStoredBytes,
    targetTable,
  );
}

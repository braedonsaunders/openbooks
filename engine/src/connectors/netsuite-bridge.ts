import { netsuiteRestlet, type NetSuiteCreds } from "./netsuite.ts";
import { randomUUID } from "node:crypto";

export const NETSUITE_BRIDGE_SCHEMA_VERSION = 1;
export const DEFAULT_NETSUITE_BRIDGE_SCRIPT_ID = "customscript_openbooks_bridge_rl";
export const DEFAULT_NETSUITE_BRIDGE_DEPLOYMENT_ID = "customdeploy_openbooks_bridge_rl";

export interface NetSuiteBridgeConfig {
  scriptId?: string | number;
  deploymentId?: string | number;
}

export interface NetSuiteBridgeHealth {
  ok: true;
  bridgeVersion: string;
  schemaVersion: number;
  accountId: string;
  environment: string;
  role: { id: string; name: string };
  serverTime: string;
  features: Record<string, boolean | null>;
  remainingUsage: number;
}

export interface NetSuiteDeletedRecord {
  internalId: string;
  deletedAt: string;
  recordType: string;
  name: string;
  externalId: string;
}

export interface NetSuitePaymentTerm {
  id: string;
  name: string;
  netDays: number;
  discountPercent: string | null;
  discountDays: number | null;
}

export interface NetSuiteExportFile {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
}

interface BridgeError {
  ok: false;
  error: string;
  name?: string;
  schemaVersion?: number;
}

interface QueryPage<T> {
  schemaVersion: number;
  pageIndex: number;
  pageSize: number;
  totalRows: number;
  hasMore: boolean;
  rows: T[];
}

interface NetSuiteExportChunkManifest {
  id: string;
  name: string;
  rows: number;
}

interface NetSuiteExportPartManifest {
  partId: string;
  status: "complete" | "failed";
  rows: number;
  chunks: NetSuiteExportChunkManifest[];
}

interface NetSuiteExportSummary {
  schemaVersion: number;
  jobId: string;
  status: "complete" | "failed";
  rows: number;
  parts: NetSuiteExportPartManifest[];
}

interface ExpectedExportChunk extends NetSuiteExportChunkManifest {
  pageIndex: number;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOwnedExportFile(name: string, jobId: string): boolean {
  return name === `ob-summary-${jobId}.json` || [
    `ob-request-${jobId}-`,
    `ob-complete-${jobId}-`,
    `ob-chunk-${jobId}-`,
    `ob-error-${jobId}-`,
    `ob-failed-${jobId}-`,
  ].some((prefix) => name.startsWith(prefix));
}

function parseManifestPageIndex(name: string, jobId: string, partId: string): number | undefined {
  const prefix = `ob-chunk-${jobId}-${partId}-`;
  if (!name.startsWith(prefix) || !name.endsWith(".json")) return undefined;
  const page = name.slice(prefix.length, -".json".length);
  if (!/^\d+$/.test(page)) return undefined;
  const pageIndex = Number(page);
  return Number.isSafeInteger(pageIndex) && pageIndex >= 0 ? pageIndex : undefined;
}

function assertNoForeignExportFiles(files: NetSuiteExportFile[], jobId: string): void {
  const foreign = files.filter((file) => !isOwnedExportFile(file.name, jobId));
  if (foreign.length > 0) {
    throw new Error(
      `NetSuite bulk export ${jobId} file listing contains ambiguous names: ${foreign.map((file) => file.name).join(", ")}`,
    );
  }
}

type BridgeRequest = <T>(params: Record<string, unknown>) => Promise<T>;

function assertBridgeResponse<T extends { schemaVersion?: number }>(value: T | BridgeError): T {
  if ((value as BridgeError).ok === false) {
    const error = value as BridgeError;
    throw new Error(`NetSuite bridge ${error.name ?? "error"}: ${error.error}`);
  }
  if (value.schemaVersion !== NETSUITE_BRIDGE_SCHEMA_VERSION) {
    throw new Error(
      `NetSuite bridge schema ${String(value.schemaVersion)} is incompatible; expected ${NETSUITE_BRIDGE_SCHEMA_VERSION}`,
    );
  }
  return value as T;
}

/**
 * Tenant-authenticated client for the account-installed extraction bridge.
 * The transport is injectable so paging, version, and error guarantees are
 * testable without a NetSuite account.
 */
export class NetSuiteBridgeClient {
  private readonly request: BridgeRequest;

  constructor(
    creds: NetSuiteCreds,
    config: NetSuiteBridgeConfig = {},
    request?: BridgeRequest,
  ) {
    const scriptId = config.scriptId ?? DEFAULT_NETSUITE_BRIDGE_SCRIPT_ID;
    const deploymentId = config.deploymentId ?? DEFAULT_NETSUITE_BRIDGE_DEPLOYMENT_ID;
    this.request = request ?? (<T>(params: Record<string, unknown>) =>
      netsuiteRestlet<T>(scriptId, deploymentId, params, creds, "POST"));
  }

  async health(): Promise<NetSuiteBridgeHealth> {
    return assertBridgeResponse(await this.request<NetSuiteBridgeHealth | BridgeError>({ action: "health" }));
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    opts: { pageSize?: number; params?: Array<string | number | boolean | null> } = {},
  ): Promise<T[]> {
    const rows: T[] = [];
    let pageIndex = 0;
    for (;;) {
      const page = assertBridgeResponse(await this.request<QueryPage<T> | BridgeError>({
        action: "query",
        sql,
        pageIndex,
        pageSize: opts.pageSize ?? 1_000,
        ...(opts.params ? { params: opts.params } : {}),
      }));
      if (page.pageIndex !== pageIndex) {
        throw new Error(`NetSuite bridge returned page ${page.pageIndex}; expected ${pageIndex}`);
      }
      rows.push(...page.rows);
      if (!page.hasMore) return rows;
      pageIndex += 1;
      if (pageIndex > 100_000) throw new Error("NetSuite bridge paging exceeded its safety limit");
    }
  }

  async deletedRecords(since: Date, recordType?: string): Promise<NetSuiteDeletedRecord[]> {
    const response = assertBridgeResponse(await this.request<{
      schemaVersion: number;
      rows: NetSuiteDeletedRecord[];
    } | BridgeError>({
      action: "deleted",
      since: since.toISOString(),
      ...(recordType ? { recordType } : {}),
    }));
    return response.rows;
  }

  async paymentTerms(): Promise<NetSuitePaymentTerm[]> {
    const response = assertBridgeResponse(await this.request<{
      schemaVersion: number;
      rows: NetSuitePaymentTerm[];
    } | BridgeError>({ action: "paymentTerms" }));
    return response.rows;
  }

  async record<T = Record<string, unknown>>(recordType: string, internalId: string): Promise<T> {
    return assertBridgeResponse(await this.request<T & { schemaVersion: number } | BridgeError>({
      action: "record",
      recordType,
      internalId,
    })) as T;
  }

  async startExport(
    jobId: string,
    partitions: Array<{ id: string; sql: string; pageSize?: number; params?: Array<string | number | boolean | null> }>,
  ): Promise<{ schemaVersion: number; jobId: string; taskId: string; partitions: number }> {
    return assertBridgeResponse(await this.request<{
      schemaVersion: number;
      jobId: string;
      taskId: string;
      partitions: number;
    } | BridgeError>({ action: "startExport", jobId, partitions }));
  }

  async exportStatus(jobId: string): Promise<{
    schemaVersion: number;
    jobId: string;
    status: "running" | "complete" | "failed";
    files: NetSuiteExportFile[];
  }> {
    return assertBridgeResponse(await this.request<{
      schemaVersion: number;
      jobId: string;
      status: "running" | "complete" | "failed";
      files: NetSuiteExportFile[];
    } | BridgeError>({ action: "exportStatus", jobId }));
  }

  async listExports(): Promise<NetSuiteExportFile[]> {
    const response = assertBridgeResponse(await this.request<{
      schemaVersion: number;
      files: NetSuiteExportFile[];
    } | BridgeError>({ action: "listExports" }));
    return response.files;
  }

  async readChunk(fileId: string): Promise<{ schemaVersion: number; fileId: string; name: string; contents: string }> {
    return assertBridgeResponse(await this.request<{
      schemaVersion: number;
      fileId: string;
      name: string;
      contents: string;
    } | BridgeError>({ action: "readChunk", fileId }));
  }

  async deleteExport(jobId: string): Promise<{ schemaVersion: number; jobId: string; deleted: number }> {
    const files = await this.listExports();
    const related = files.filter((file) => file.name.includes(jobId));
    assertNoForeignExportFiles(related, jobId);
    return this.deleteExportBatches(jobId);
  }

  private async deleteExportBatches(jobId: string): Promise<{ schemaVersion: number; jobId: string; deleted: number }> {
    let deleted = 0;
    for (let batch = 0; batch < 1_000; batch += 1) {
      const response = assertBridgeResponse(await this.request<{
        schemaVersion: number;
        jobId: string;
        deleted: number;
        remaining?: number;
      } | BridgeError>({ action: "deleteExport", jobId }));
      if (
        response.jobId !== jobId
        || !isSafeCount(response.deleted)
        || (response.remaining !== undefined && !isSafeCount(response.remaining))
      ) {
        throw new Error(`NetSuite bulk export ${jobId} cleanup returned an invalid response`);
      }
      deleted += response.deleted;
      if (!response.remaining) return { schemaVersion: response.schemaVersion, jobId: response.jobId, deleted };
    }
    throw new Error(`NetSuite bulk export ${jobId} cleanup exceeded its safety limit`);
  }

  async bulkQuery<T = Record<string, unknown>>(
    partitions: Array<{ id: string; sql: string; params?: Array<string | number | boolean | null> }>,
    opts: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<Map<string, T[]>> {
    if (partitions.length === 0) return new Map();
    const duplicate = partitions.find((part, index) => partitions.findIndex((candidate) => candidate.id === part.id) !== index);
    if (duplicate) throw new Error(`NetSuite bulk export partition ${duplicate.id} is duplicated`);
    const out = new Map(partitions.map((partition) => [partition.id, [] as T[]]));
    const pollMs = opts.pollMs ?? 2_000;
    const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
    const batches = Array.from({ length: Math.ceil(partitions.length / 250) }, (_, index) =>
      partitions.slice(index * 250, (index + 1) * 250),
    );

    for (const batch of batches) {
      const jobId = `ob-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      let started = false;
      let cleanupSafe = true;
      try {
        const startedExport = await this.startExport(jobId, batch.map((partition) => ({ ...partition, pageSize: 1_000 })));
        if (startedExport.jobId !== jobId || startedExport.partitions !== batch.length) {
          throw new Error(`NetSuite bulk export ${jobId} returned an invalid start response`);
        }
        started = true;
        const deadline = Date.now() + timeoutMs;
        let state: Awaited<ReturnType<NetSuiteBridgeClient["exportStatus"]>>;
        for (;;) {
          state = await this.exportStatus(jobId);
          if (!Array.isArray(state.files)) {
            cleanupSafe = false;
            throw new Error(`NetSuite bulk export ${jobId} returned an invalid file listing`);
          }
          if (
            state.jobId !== jobId
            || !["running", "complete", "failed"].includes(state.status)
          ) {
            cleanupSafe = false;
            throw new Error(`NetSuite bulk export ${jobId} returned an invalid status response`);
          }
          try {
            assertNoForeignExportFiles(state.files, jobId);
          } catch (error) {
            cleanupSafe = false;
            throw error;
          }
          if (state.status !== "running") break;
          if (Date.now() >= deadline) throw new Error(`NetSuite bulk export ${jobId} timed out`);
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        if (state.status === "failed") {
          const errors: string[] = [];
          for (const file of state.files.filter((item) => item.name.includes("-error-"))) {
            const read = await this.readChunk(file.id);
            try {
              const body = JSON.parse(read.contents) as { error?: string };
              if (body.error) errors.push(body.error);
            } catch {
              errors.push(`${file.name} could not be parsed`);
            }
          }
          throw new Error(`NetSuite bulk export failed${errors.length ? `: ${errors.join("; ")}` : ""}`);
        }
        const summaryFiles = state.files.filter((item) => item.name === `ob-summary-${jobId}.json`);
        if (summaryFiles.length !== 1) {
          throw new Error(`NetSuite bulk export ${jobId} returned ${summaryFiles.length} summary manifests; expected exactly one`);
        }
        let summary: NetSuiteExportSummary;
        try {
          const read = await this.readChunk(summaryFiles[0]!.id);
          summary = JSON.parse(read.contents) as NetSuiteExportSummary;
          if (read.name !== summaryFiles[0]!.name) throw new Error("summary filename does not match its listing");
        } catch (error) {
          throw new Error(`NetSuite bulk export ${jobId} returned an invalid summary manifest: ${String(error)}`);
        }
        if (
          summary.schemaVersion !== NETSUITE_BRIDGE_SCHEMA_VERSION
          || summary.jobId !== jobId
          || summary.status !== "complete"
          || !isSafeCount(summary.rows)
          || !Array.isArray(summary.parts)
        ) {
          throw new Error(`NetSuite bulk export ${jobId} returned an invalid summary manifest`);
        }

        const expectedPartitionIds = new Set(batch.map((partition) => partition.id));
        const manifests = new Map<string, { rows: number; chunks: Map<number, ExpectedExportChunk> }>();
        for (const part of summary.parts) {
          if (
            typeof part.partId !== "string"
            || !expectedPartitionIds.has(part.partId)
            || part.status !== "complete"
            || !isSafeCount(part.rows)
            || !Array.isArray(part.chunks)
          ) {
            throw new Error(`NetSuite bulk export ${jobId} returned an invalid partition manifest`);
          }
          if (manifests.has(part.partId)) {
            throw new Error(`NetSuite bulk export ${jobId} returned a duplicate partition manifest ${part.partId}`);
          }
          const manifest = { rows: part.rows, chunks: new Map<number, ExpectedExportChunk>() };
          manifests.set(part.partId, manifest);
          for (const chunk of part.chunks) {
            if (
              typeof chunk.id !== "string"
              || chunk.id.length === 0
              || typeof chunk.name !== "string"
              || !isSafeCount(chunk.rows)
            ) {
              throw new Error(`NetSuite bulk export ${jobId} returned an invalid chunk manifest`);
            }
            const pageIndex = parseManifestPageIndex(chunk.name, jobId, part.partId);
            if (pageIndex === undefined) {
              throw new Error(`NetSuite bulk export ${jobId} returned an invalid chunk name ${chunk.name}`);
            }
            if (manifest.chunks.has(pageIndex)) {
              throw new Error(`NetSuite bulk export ${jobId} returned a duplicate chunk manifest ${chunk.name}`);
            }
            manifest.chunks.set(pageIndex, { ...chunk, pageIndex });
          }
        }
        if (manifests.size !== batch.length) {
          throw new Error(`NetSuite bulk export ${jobId} summary is missing a partition`);
        }
        const summaryRows = [...manifests.values()].reduce((total, part) => total + part.rows, 0);
        if (summaryRows !== summary.rows) {
          throw new Error(`NetSuite bulk export ${jobId} summary row count does not reconcile`);
        }

        const listedChunks = state.files.filter((item) => item.name.startsWith(`ob-chunk-${jobId}-`));
        const listedById = new Map(listedChunks.map((file) => [file.id, file]));
        const listedNames = new Set(listedChunks.map((file) => file.name));
        const expectedChunks = [...manifests.values()].flatMap((part) => [...part.chunks.values()]);
        if (listedById.size !== listedChunks.length || listedNames.size !== listedChunks.length) {
          throw new Error(`NetSuite bulk export ${jobId} returned duplicate chunk files`);
        }
        if (expectedChunks.length !== listedChunks.length) {
          throw new Error(`NetSuite bulk export ${jobId} chunk listing does not match its summary`);
        }
        for (const chunk of expectedChunks) {
          const listed = listedById.get(chunk.id);
          if (!listed || listed.name !== chunk.name) {
            throw new Error(`NetSuite bulk export ${jobId} is missing chunk ${chunk.name}`);
          }
        }

        for (const [partId, manifest] of manifests) {
          const target = out.get(partId)!;
          const pageIndexes = [...manifest.chunks.keys()].sort((a, b) => a - b);
          if (pageIndexes.some((pageIndex, index) => pageIndex !== index)) {
            throw new Error(`NetSuite bulk export ${jobId} has non-contiguous chunks for partition ${partId}`);
          }
          let rows = 0;
          for (const pageIndex of pageIndexes) {
            const chunk = manifest.chunks.get(pageIndex)!;
            const listed = listedById.get(chunk.id)!;
            const read = await this.readChunk(listed.id);
            if (read.name !== listed.name) throw new Error(`NetSuite bulk export returned an invalid chunk ${listed.name}`);
            let body: {
              schemaVersion?: number;
              jobId?: string;
              partId?: string;
              pageIndex?: number;
              rows?: T[];
            };
            try {
              body = JSON.parse(read.contents) as typeof body;
            } catch {
              throw new Error(`NetSuite bulk export returned an invalid chunk ${listed.name}`);
            }
            if (
              body.schemaVersion !== NETSUITE_BRIDGE_SCHEMA_VERSION
              || body.jobId !== jobId
              || body.partId !== partId
              || body.pageIndex !== pageIndex
              || !isSafeCount(body.pageIndex)
              || !Array.isArray(body.rows)
              || body.rows.length !== chunk.rows
            ) {
              throw new Error(`NetSuite bulk export returned an invalid chunk ${listed.name}`);
            }
            const pageRows = body.rows;
            target.push(...pageRows);
            rows += pageRows.length;
          }
          if (rows !== manifest.rows) {
            throw new Error(`NetSuite bulk export ${jobId} row count does not reconcile for partition ${partId}`);
          }
        }
      } finally {
        if (started && cleanupSafe) await this.deleteExportBatches(jobId);
      }
    }
    return out;
  }
}

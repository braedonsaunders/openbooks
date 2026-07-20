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
    let deleted = 0;
    for (let batch = 0; batch < 1_000; batch += 1) {
      const response = assertBridgeResponse(await this.request<{
        schemaVersion: number;
        jobId: string;
        deleted: number;
        remaining?: number;
      } | BridgeError>({ action: "deleteExport", jobId }));
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
      try {
        await this.startExport(jobId, batch.map((partition) => ({ ...partition, pageSize: 1_000 })));
        started = true;
        const deadline = Date.now() + timeoutMs;
        let state: Awaited<ReturnType<NetSuiteBridgeClient["exportStatus"]>>;
        for (;;) {
          state = await this.exportStatus(jobId);
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
        for (const file of state.files.filter((item) => item.name.startsWith(`ob-chunk-${jobId}-`))) {
          const read = await this.readChunk(file.id);
          const body = JSON.parse(read.contents) as {
            schemaVersion?: number;
            jobId?: string;
            partId?: string;
            rows?: T[];
          };
          if (body.schemaVersion !== NETSUITE_BRIDGE_SCHEMA_VERSION || body.jobId !== jobId || !body.partId) {
            throw new Error(`NetSuite bulk export returned an invalid chunk ${file.name}`);
          }
          const target = out.get(body.partId);
          if (!target || !Array.isArray(body.rows)) {
            throw new Error(`NetSuite bulk export returned an unknown partition ${body.partId}`);
          }
          target.push(...body.rows);
        }
      } finally {
        if (started) await this.deleteExport(jobId);
      }
    }
    return out;
  }
}

import { netsuiteRestlet, type NetSuiteCreds } from "./netsuite.ts";

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
        pageSize: opts.pageSize ?? 500,
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
    partitions: Array<{ id: string; sql: string; pageSize?: number }>,
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

  async readChunk(fileId: string): Promise<{ schemaVersion: number; fileId: string; name: string; contents: string }> {
    return assertBridgeResponse(await this.request<{
      schemaVersion: number;
      fileId: string;
      name: string;
      contents: string;
    } | BridgeError>({ action: "readChunk", fileId }));
  }

  async deleteExport(jobId: string): Promise<{ schemaVersion: number; jobId: string; deleted: number }> {
    return assertBridgeResponse(await this.request<{
      schemaVersion: number;
      jobId: string;
      deleted: number;
    } | BridgeError>({ action: "deleteExport", jobId }));
  }
}

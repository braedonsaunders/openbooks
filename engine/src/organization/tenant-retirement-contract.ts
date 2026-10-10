export interface TenantRetirementRecovery {
  backupSha256: string;
  restoreReceiptSha256: string;
  preservationReceiptSha256: string;
  objectRetentionReceiptSha256: string;
  verifiedAt: string;
  verifier: string;
}
export interface TenantRetirementRegistration {
  runId: string;
  planDigest: string;
  catalogDigest: string;
  database: { database: string; serverAddress: string; serverPort: number; clusterName: string };
  retainOrgIds: string[];
  retireOrgIds: string[];
  actorId: string;
  reason: string;
  recovery: TenantRetirementRecovery;
  reviewedState: Record<string, { digest: string }>;
}
export interface TenantRetirementStatus {
  run: { id: string; plan_digest: string; catalog_digest: string; database_identity: TenantRetirementRegistration["database"]; retain_ids: string[]; target_ids: string[]; reviewed_state: Record<string, { digest: string }> };
  events: Array<{ id: number; run_id: string; tenant_id: string | null; kind: string; login_name: string; detail: Record<string, unknown>; created_at: string }>;
  targets: Array<{ tenant_id: string; run_id: string | null; state: "active" | "quarantined" | "deleted"; receipt: unknown }>;
}
const DIGEST = /^[0-9a-f]{64}$/;
export function parseTenantRetirementRecovery(value: unknown): TenantRetirementRecovery {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recovery evidence must be an explicit artifact attestation");
  const record = value as Record<string, unknown>;
  const keys = ["backupSha256", "restoreReceiptSha256", "preservationReceiptSha256", "objectRetentionReceiptSha256", "verifiedAt", "verifier"];
  if (Object.keys(record).length !== keys.length || keys.some(key => !(key in record))) throw new Error("Recovery evidence must contain exactly backupSha256, restoreReceiptSha256, preservationReceiptSha256, objectRetentionReceiptSha256, verifiedAt, verifier");
  if (keys.slice(0, 4).some(key => typeof record[key] !== "string" || !DIGEST.test(record[key] as string))) throw new Error("Recovery artifact digests must be SHA256 values from verified backup/restore receipts");
  if (typeof record.verifiedAt !== "string" || !Number.isFinite(Date.parse(record.verifiedAt)) || (typeof record.verifiedAt === "string" && Number.isFinite(Date.parse(record.verifiedAt)) && new Date(record.verifiedAt).toISOString() !== record.verifiedAt) || typeof record.verifier !== "string" || record.verifier.trim().length < 3) throw new Error("Recovery evidence needs a verifier and an ISO verification timestamp");
  return {
    backupSha256: record.backupSha256 as string,
    restoreReceiptSha256: record.restoreReceiptSha256 as string,
    preservationReceiptSha256: record.preservationReceiptSha256 as string,
    objectRetentionReceiptSha256: record.objectRetentionReceiptSha256 as string,
    verifiedAt: record.verifiedAt,
    verifier: record.verifier,
  };
}

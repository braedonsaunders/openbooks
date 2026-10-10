import { createHash } from "node:crypto";
import { isUuid } from "../platform/uuid.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

export interface RetirementDatabaseIdentity {
  database: string; serverAddress: string; serverPort: number; clusterName: string;
}
export interface SampleRetirementSelection {
  version: 1;
  database: RetirementDatabaseIdentity;
  retainOrgIds: string[];
  retireOrgIds: string[];
  reason: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SampleCompanyError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  if (Object.keys(value).some(key => !expected.includes(key)) || expected.some(key => !(key in value))) {
    throw new SampleCompanyError(`${label} must contain exactly ${expected.join(", ")}.`);
  }
}
function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000 || value.some(id => !isUuid(id))) {
    throw new SampleCompanyError(`${label} needs one through 1,000 explicit native company UUIDs; names and wildcard selections are not supported.`);
  }
  const result = (value as string[]).map(id => id.toLowerCase()).sort();
  if (new Set(result).size !== result.length) throw new SampleCompanyError(`${label} contains duplicate company identities.`);
  return result;
}

/** A complete explicit retain/delete partition is required before any database read. */
export function parseRetirementSelection(input: unknown): SampleRetirementSelection {
  const value = object(input, "Retirement selection");
  exactKeys(value, ["version", "database", "retainOrgIds", "retireOrgIds", "reason"], "Retirement selection");
  if (value.version !== 1) throw new SampleCompanyError("Unsupported retirement selection version.");
  const database = object(value.database, "Database identity");
  exactKeys(database, ["database", "serverAddress", "serverPort", "clusterName"], "Database identity");
  for (const key of ["database", "serverAddress", "clusterName"] as const) {
    if (typeof database[key] !== "string" || (key !== "clusterName" && !database[key].trim()) || database[key].length > 200) throw new SampleCompanyError(`Database identity requires an explicit ${key} from the native read receipt.`);
  }
  if (!Number.isInteger(database.serverPort) || Number(database.serverPort) < 1 || Number(database.serverPort) > 65535) throw new SampleCompanyError("Database identity requires a valid serverPort.");
  const retainOrgIds = ids(value.retainOrgIds, "retainOrgIds");
  const retireOrgIds = ids(value.retireOrgIds, "retireOrgIds");
  if (retireOrgIds.some(id => retainOrgIds.includes(id))) throw new SampleCompanyError("A company cannot be both retained and retired.");
  if (typeof value.reason !== "string" || value.reason.trim().length < 12 || value.reason.length > 2000) throw new SampleCompanyError("Retirement needs a specific reason of 12 through 2,000 characters.");
  return { version: 1, database: database as unknown as RetirementDatabaseIdentity, retainOrgIds, retireOrgIds, reason: value.reason.trim() };
}

export function assertRetirementDatabase(expected: RetirementDatabaseIdentity, actual: RetirementDatabaseIdentity): void {
  for (const key of ["database", "serverAddress", "serverPort", "clusterName"] as const) {
    if (actual[key] !== expected[key]) throw new SampleCompanyError(`Retirement database ${key} differs from the reviewed native receipt. Nothing was changed; inspect the connection and obtain a fresh selection for the intended database.`);
  }
}

export function assertRetirementPartition(selection: SampleRetirementSelection, liveOrgIds: readonly string[]): void {
  const reviewed = new Set([...selection.retainOrgIds, ...selection.retireOrgIds]);
  const live = new Set(liveOrgIds.map(id => id.toLowerCase()));
  if (liveOrgIds.length !== live.size || reviewed.size !== live.size || [...reviewed].some(id => !live.has(id))) {
    throw new SampleCompanyError("The tenant inventory differs from the explicit retain/retire partition. Nothing was changed; review newly created or missing companies and prepare a fresh selection.");
  }
}

/** Object property order does not change a reviewed maintenance digest. */
export function retirementDigest(input: unknown): string {
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : value;
  return createHash("sha256").update(JSON.stringify(normalize(input))).digest("hex");
}

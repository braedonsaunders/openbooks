import { createHash } from "node:crypto";

/**
 * Canonical normalization evidence and hash for SaaS metrics.
 *
 * Every normalized metrics row is denominated in the organization's base
 * currency and stamped with this machine version plus the full evidence the
 * amounts were priced from. The versioned hash covers the exact inputs and
 * the exact evidence together, so a later recompute either reproduces the
 * stored hash byte-for-byte or reports changed inputs (which a closed month
 * refuses). Rows written before normalization keep all three reporting
 * columns null; this module never backfills them.
 */
export const SAAS_METRICS_DENOMINATION_VERSION = "v1";

/**
 * Deterministic JSON with object keys sorted recursively, so the hash over a
 * payload never depends on the insertion order the caller happened to build.
 * Plain JSON.stringify would hash equal payloads differently.
 */
export function canonicalNormalizationJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalNormalizationJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalNormalizationJson(entry)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

export interface NormalizationHashPayload {
  denominationVersion: string;
  orgId: string;
  month: string;
  reportingCurrency: string;
  inputs: unknown;
  evidence: unknown;
}

/**
 * Canonical versioned hash over the exact inputs-plus-evidence payload a run
 * stored. The `v: 1` envelope keeps the digest domain-separated from earlier
 * unversioned hashes; the denomination version inside the payload keeps v1
 * rows distinct from any later denomination that prices the same inputs
 * differently.
 */
export function normalizationInputsHash(payload: NormalizationHashPayload): string {
  return createHash("sha256").update(canonicalNormalizationJson({ v: 1, ...payload })).digest("hex");
}

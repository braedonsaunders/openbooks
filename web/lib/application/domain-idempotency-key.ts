import { createHash } from "node:crypto";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";

/** Adapt an application retry key to native operations that require UUID keys. */
export function domainUuidIdempotencyKey(orgId: string, key: string): string {
  if (UUID_RE.test(key)) return key;
  const digest = createHash("sha1").update(`openbooks:application:${orgId}:${key}`).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

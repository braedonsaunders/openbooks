/**
 * Shared connection-route refusals: tenant-supplied connector URLs and
 * callback-owned OAuth identity keys. Imported by the four connection routes
 * so the predicates cannot drift.
 *
 * The URL classifier itself is canonical in
 * `engine/src/connectors/ssrf-guard.ts` (re-exported here): the engine
 * connector clients and the AI endpoint checks enforce the same predicate
 * at request time, so this file must not fork it.
 */

export {
  CONNECTOR_URL_REFUSED,
  connectorUrlRefusal,
  guardedFetch,
  isPublicUnicastAddress,
  resolveVerifiedAddresses,
  type AddressLookup,
} from "@openbooks/engine/src/connectors/ssrf-guard.ts";

import {
  connectorUrlRefusal,
  type AddressLookup,
} from "@openbooks/engine/src/connectors/ssrf-guard.ts";

export const CALLBACK_OWNED_CONFIG_KEYS = [
  "realmId",
  "tenantId",
  "companyId",
  "companyName",
] as const;

export async function connectionConfigUrlRefusal(
  config: unknown,
  lookupAddresses?: AddressLookup,
): Promise<string | null> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const row = config as Record<string, unknown>;
  return (
    (await connectorUrlRefusal(row.url, lookupAddresses)) ??
    (await connectorUrlRefusal(row.host, lookupAddresses))
  );
}

export function callerOwnedConfigRefusal(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const row = config as Record<string, unknown>;
  for (const key of CALLBACK_OWNED_CONFIG_KEYS) {
    if (Object.hasOwn(row, key)) {
      return `${key} can only be set by completing the Connect flow for this connection`;
    }
  }
  return null;
}

export function declaredSourceConfig(
  manifest: { configFields: ReadonlyArray<{ key: string }> },
  config: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(manifest.configFields.map((field) => field.key));
  const declared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (allowed.has(key)) declared[key] = value;
  }
  return declared;
}

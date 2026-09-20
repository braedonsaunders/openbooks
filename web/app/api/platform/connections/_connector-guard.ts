/**
 * Shared connection-route refusals: tenant-supplied connector URLs and
 * callback-owned OAuth identity keys. Imported by the four connection routes
 * so the predicates cannot drift.
 */

export const CONNECTOR_URL_REFUSED =
  "Connector URL must be a public http:// or https:// address. Loopback, link-local, metadata, and non-http(s) URLs are refused.";

export const CALLBACK_OWNED_CONFIG_KEYS = [
  "realmId",
  "tenantId",
  "companyId",
  "companyName",
] as const;

function stripIpv6Brackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

/** Node canonicalizes ::ffff:127.0.0.1 to ::ffff:7f00:1. Decode both forms. */
function ipv4FromMapped6(host: string): string | null {
  const prefixes = ["::ffff:", "0:0:0:0:0:ffff:"] as const;
  let rest: string | null = null;
  for (const prefix of prefixes) {
    if (host.startsWith(prefix)) {
      rest = host.slice(prefix.length);
      break;
    }
  }
  if (rest == null) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(rest)) return rest;
  const groups = rest.split(":");
  if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    const high = Number.parseInt(groups[0]!, 16);
    const low = Number.parseInt(groups[1]!, 16);
    return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
  }
  return null;
}

function isRefusedIpv4(ipv4: string): boolean {
  const parts = ipv4.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function isRefusedHost(host: string): boolean {
  const normalized = stripIpv6Brackets(host);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1"
  ) {
    return true;
  }
  if (normalized.startsWith("fe80:")) return true;
  const mapped = ipv4FromMapped6(normalized);
  if (mapped && isRefusedIpv4(mapped)) return true;
  return isRefusedIpv4(normalized);
}

export function connectorUrlRefusal(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return CONNECTOR_URL_REFUSED;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return CONNECTOR_URL_REFUSED;
  }
  if (isRefusedHost(url.hostname)) return CONNECTOR_URL_REFUSED;
  return null;
}

export function connectionConfigUrlRefusal(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const row = config as Record<string, unknown>;
  return connectorUrlRefusal(row.url) ?? connectorUrlRefusal(row.host);
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

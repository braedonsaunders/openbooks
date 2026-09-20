/**
 * Shared connection-route refusals: tenant-supplied connector URLs and
 * callback-owned OAuth identity keys. Imported by the four connection routes
 * so the predicates cannot drift.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const CONNECTOR_URL_REFUSED =
  "Connector URL must use http or https and every resolved address must be public unicast. RFC1918, loopback, link-local, metadata, ULA, unspecified, and non-http(s) URLs are refused.";

export const CALLBACK_OWNED_CONFIG_KEYS = [
  "realmId",
  "tenantId",
  "companyId",
  "companyName",
] as const;

export type AddressLookup = (hostname: string) => Promise<string[]>;

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

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

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isPublicUnicastIpv4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0) return false;
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a >= 224) return false;
  return true;
}

function expandIpv6(host: string): number[] | null {
  if (host.includes(".")) return null;
  const parseSide = (side: string): number[] => {
    if (side === "") return [];
    return side.split(":").map((group) => Number.parseInt(group, 16));
  };
  let groups: number[];
  if (host.includes("::")) {
    if (host.indexOf("::") !== host.lastIndexOf("::")) return null;
    const [head, tail] = host.split("::");
    const left = parseSide(head ?? "");
    const right = parseSide(tail ?? "");
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array<number>(fill).fill(0), ...right];
  } else {
    groups = host.split(":").map((group) => Number.parseInt(group, 16));
  }
  if (groups.length !== 8) return null;
  if (groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return null;
  }
  return groups;
}

function isPublicUnicastIpv6(host: string): boolean {
  const mapped = ipv4FromMapped6(host);
  if (mapped) return isPublicUnicastIpv4(mapped);
  const groups = expandIpv6(host);
  if (!groups) return false;
  if (groups.every((group) => group === 0)) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false;
  const first = groups[0]!;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xff00) === 0xff00) return false;
  return (first & 0xe000) === 0x2000;
}

export function isPublicUnicastAddress(address: string): boolean {
  const host = stripIpv6Brackets(address);
  const kind = isIP(host);
  if (kind === 4) return isPublicUnicastIpv4(host);
  if (kind === 6) return isPublicUnicastIpv6(host);
  const mapped = ipv4FromMapped6(host);
  if (mapped) return isPublicUnicastIpv4(mapped);
  return false;
}

export async function connectorUrlRefusal(
  value: unknown,
  lookupAddresses: AddressLookup = defaultLookup,
): Promise<string | null> {
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
  const host = stripIpv6Brackets(url.hostname);
  if (!host) return CONNECTOR_URL_REFUSED;
  const kind = isIP(host);
  if (kind === 4 || kind === 6) {
    return isPublicUnicastAddress(host) ? null : CONNECTOR_URL_REFUSED;
  }
  let addresses: string[];
  try {
    addresses = await lookupAddresses(host);
  } catch {
    return CONNECTOR_URL_REFUSED;
  }
  if (addresses.length === 0) return CONNECTOR_URL_REFUSED;
  if (!addresses.every((address) => isPublicUnicastAddress(address))) {
    return CONNECTOR_URL_REFUSED;
  }
  return null;
}

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

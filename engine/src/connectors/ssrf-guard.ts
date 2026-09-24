/**
 * Single shared SSRF guard for every outbound request to an
 * operator-configured URL (migration-connector origins, custom AI endpoints).
 *
 * Two layers, one refusal: resolve the hostname and require EVERY resolved
 * address to be public unicast (RFC1918, loopback, link-local, metadata,
 * ULA, documentation and other special ranges are refused, as are hosts
 * that fail to resolve), then connect with a custom lookup pinned to the
 * addresses just checked — the socket can only open to an address the
 * check saw, so DNS cannot rebind between the check and the connect.
 * Redirects are never followed: these requests carry API keys and secrets
 * that must not cross a Location boundary to an unconfigured host.
 *
 * Stdlib only (`node:dns`, `node:http/https`) so the `connectors` engine
 * module keeps its zero-dependency edge set; web re-exports this from
 * `web/app/api/platform/connections/_connector-guard.ts` rather than
 * forking the classifier.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

type LookupFunction = NonNullable<RequestOptions["lookup"]>;

export const CONNECTOR_URL_REFUSED =
  "Connector URL must use http or https and every resolved address must be public unicast. IANA special-purpose, RFC1918, loopback, link-local, metadata, ULA, unspecified, and non-http(s) addresses are refused.";

export type AddressLookup = (hostname: string) => Promise<string[]>;

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
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

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

type AddressRange = { cidr: string; globallyReachable: boolean };

/**
 * Derived from IANA's IPv4/IPv6 Special-Purpose Address Registries
 * (checked 2026-09-24; registry revision 2025-10-09):
 * https://www.iana.org/assignments/iana-ipv4-special-registry
 * https://www.iana.org/assignments/iana-ipv6-special-registry
 * Globally reachable suballocations are explicit longest-prefix exceptions
 * (notably 192.0.0.9/.10 and the registered 2001::/23 anycasts). The
 * surrounding special-purpose allocations remain refused.
 */
const IPV4_SPECIAL_PURPOSE: readonly AddressRange[] = [
  { cidr: "0.0.0.0/8", globallyReachable: false },
  { cidr: "10.0.0.0/8", globallyReachable: false },
  { cidr: "100.64.0.0/10", globallyReachable: false },
  { cidr: "127.0.0.0/8", globallyReachable: false },
  { cidr: "169.254.0.0/16", globallyReachable: false },
  { cidr: "172.16.0.0/12", globallyReachable: false },
  { cidr: "192.0.0.0/24", globallyReachable: false },
  { cidr: "192.0.0.9/32", globallyReachable: true },
  { cidr: "192.0.0.10/32", globallyReachable: true },
  { cidr: "192.0.2.0/24", globallyReachable: false },
  { cidr: "192.88.99.0/24", globallyReachable: false },
  { cidr: "192.168.0.0/16", globallyReachable: false },
  { cidr: "198.18.0.0/15", globallyReachable: false },
  { cidr: "198.51.100.0/24", globallyReachable: false },
  { cidr: "203.0.113.0/24", globallyReachable: false },
  { cidr: "224.0.0.0/4", globallyReachable: false },
  { cidr: "240.0.0.0/4", globallyReachable: false },
  { cidr: "255.255.255.255/32", globallyReachable: false },
].map((range) => ({ ...range, bits: Number(range.cidr.split("/")[1]) })) as readonly AddressRange[];

const IPV6_SPECIAL_PURPOSE: readonly AddressRange[] = [
  { cidr: "::/128", globallyReachable: false },
  { cidr: "::1/128", globallyReachable: false },
  { cidr: "::ffff:0:0/96", globallyReachable: false },
  { cidr: "64:ff9b:1::/48", globallyReachable: false },
  { cidr: "100::/64", globallyReachable: false },
  { cidr: "100:0:0:1::/64", globallyReachable: false },
  { cidr: "2001::/23", globallyReachable: false },
  { cidr: "2001:1::1/128", globallyReachable: true },
  { cidr: "2001:1::2/128", globallyReachable: true },
  { cidr: "2001:1::3/128", globallyReachable: true },
  { cidr: "2001:3::/32", globallyReachable: true },
  { cidr: "2001:4:112::/48", globallyReachable: true },
  { cidr: "2001:20::/28", globallyReachable: true },
  { cidr: "2001:30::/28", globallyReachable: true },
  { cidr: "2001:db8::/32", globallyReachable: false },
  { cidr: "2002::/16", globallyReachable: false },
  { cidr: "3fff::/20", globallyReachable: false },
  { cidr: "5f00::/16", globallyReachable: false },
  { cidr: "fc00::/7", globallyReachable: false },
  { cidr: "fe80::/10", globallyReachable: false },
  { cidr: "ff00::/8", globallyReachable: false },
].map((range) => ({ ...range, bits: Number(range.cidr.split("/")[1]) })) as readonly AddressRange[];

function ipv4Value(ip: string): bigint | null {
  const octets = parseIpv4(ip);
  if (!octets) return null;
  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6Value(ip: string): bigint | null {
  const groups = expandIpv6(ip);
  if (!groups) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function cidrContains(address: bigint, network: bigint, bits: number, width: number): boolean {
  const shift = BigInt(width - bits);
  return (address >> shift) === (network >> shift);
}

function registeredRangeDecision(ip: string, ranges: readonly AddressRange[], width: number): boolean | null {
  const address = width === 32 ? ipv4Value(ip) : ipv6Value(ip);
  if (address === null) return null;
  const matching = ranges
    .map((range) => {
      const [networkText, bitsText] = range.cidr.split("/");
      const network = width === 32 ? ipv4Value(networkText!) : ipv6Value(networkText!);
      const bits = Number(bitsText);
      return network !== null && cidrContains(address, network, bits, width) ? { range, bits } : null;
    })
    .filter((match): match is { range: AddressRange; bits: number } => match !== null)
    .sort((left, right) => right.bits - left.bits)[0];
  return matching?.range.globallyReachable ?? null;
}

function isPublicUnicastIpv4(ip: string): boolean {
  if (!parseIpv4(ip)) return false;
  const registryDecision = registeredRangeDecision(ip, IPV4_SPECIAL_PURPOSE, 32);
  if (registryDecision !== null) return registryDecision;
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
  const groups = expandIpv6(host);
  if (!groups) return false;
  const first = groups[0]!;
  const registryDecision = registeredRangeDecision(host, IPV6_SPECIAL_PURPOSE, 128);
  if (registryDecision !== null) return registryDecision;
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

/**
 * The addresses a request to `rawUrl` may use: the literal IP when the URL
 * carries one, otherwise the hostname's current DNS answers. Throws the
 * shared refusal unless the URL is http(s) and EVERY address is public
 * unicast — a single private/failed answer fails the whole host closed.
 */
export async function resolveVerifiedAddresses(
  rawUrl: string | URL,
  lookupAddresses: AddressLookup = defaultLookup,
): Promise<string[]> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    throw new Error(CONNECTOR_URL_REFUSED);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(CONNECTOR_URL_REFUSED);
  }
  const host = stripIpv6Brackets(url.hostname);
  if (!host) throw new Error(CONNECTOR_URL_REFUSED);
  const kind = isIP(host);
  if (kind === 4 || kind === 6) {
    if (!isPublicUnicastAddress(host)) throw new Error(CONNECTOR_URL_REFUSED);
    return [host];
  }
  let addresses: string[];
  try {
    addresses = await lookupAddresses(host);
  } catch {
    throw new Error(CONNECTOR_URL_REFUSED);
  }
  if (addresses.length === 0 || !addresses.every((address) => isPublicUnicastAddress(address))) {
    throw new Error(CONNECTOR_URL_REFUSED);
  }
  return addresses;
}

function sanitizeStatusText(value: string | undefined): string {
  return (value ?? "").replace(/[^\x20-\x7e]/g, "");
}

/**
 * fetch() for operator-configured URLs. Resolves and verifies the target at
 * request time (saved-time checks go stale when DNS rebinds), pins the
 * connection to the verified addresses with a custom lookup, and refuses
 * redirects instead of following them — `http.request` never follows a
 * Location on its own, so a 3xx can only surface as an error, never as a
 * second request carrying the caller's secrets. Accepts the same
 * (input, init) shape as fetch so clients can default to it; `opts.lookup`
 * exists so tests can prove the refusal without owning public DNS.
 */
export async function guardedFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  opts: { lookup?: AddressLookup } = {},
): Promise<Response> {
  const normalizedInit: RequestInit & { duplex?: string } = { ...init };
  if (
    typeof ReadableStream !== "undefined" &&
    normalizedInit.body instanceof ReadableStream &&
    normalizedInit.duplex === undefined
  ) {
    normalizedInit.duplex = "half";
  }
  const req = new Request(input, normalizedInit);
  const target = new URL(req.url);
  const verified = await resolveVerifiedAddresses(target, opts.lookup);
  const pinned = verified[0]!;
  const family = isIP(stripIpv6Brackets(pinned));
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, pinned, family === 6 ? 6 : 4);
  };

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const bodyBytes = await req.arrayBuffer();
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const incoming: IncomingMessage = await new Promise((resolve, reject) => {
    const out = send(
      target,
      { method: req.method, headers, lookup: pinnedLookup, signal: req.signal },
      resolve,
    );
    out.on("error", reject);
    if (bodyBytes.byteLength > 0) out.write(Buffer.from(bodyBytes));
    out.end();
  });
  const status = incoming.statusCode ?? 200;
  if (status >= 300 && status < 400) {
    incoming.resume();
    throw new Error(
      `Refused ${status} redirect from ${target.origin}: credentialed requests never follow redirects`,
    );
  }
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => resolve());
    incoming.on("error", reject);
  });
  const payload = Buffer.concat(chunks);
  const outHeaders = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) outHeaders.append(key, item);
    } else {
      outHeaders.set(key, value);
    }
  }
  const hasBody = payload.byteLength > 0 && status !== 204 && status !== 304;
  return new Response(hasBody ? payload : null, {
    status,
    statusText: sanitizeStatusText(incoming.statusMessage),
    headers: outHeaders,
  });
}

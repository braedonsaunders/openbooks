/**
 * SSRF-guard tests (no DB — pure network logic with injected DNS).
 *
 * The guard fails closed: any unresolvable, empty, or non-fully-public
 * answer refuses the whole host, and a refused target is never connected
 * to (the loopback servers below must see zero requests).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import {
  CONNECTOR_URL_REFUSED,
  connectorUrlRefusal,
  guardedFetch,
  isPublicUnicastAddress,
  resolveVerifiedAddresses,
  type AddressLookup,
} from "./ssrf-guard.ts";

const PUBLIC_V4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "192.0.0.9", "192.0.0.10"];
const PUBLIC_V6 = ["2606:4700:4700::1111", "2001:4860:4860::8888", "2001:1::1", "2001:1::2", "2001:1::3", "2001:4:112::1"];
const PRIVATE = [
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "127.0.0.1",
  "0.0.0.0",
  "169.254.169.254",
  "192.0.2.1",
  "192.0.0.1",
  "192.0.0.8",
  "192.0.0.170",
  "192.0.0.171",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "100.64.0.1",
  "224.0.0.1",
  "::1",
  "::",
  "fe80::1",
  "fc00::1",
  "fd00::1",
  "ff02::1",
  "2001:db8::1",
  "2001:2::1",
  "2001:100::1",
  "2001:4:113::1",
  "3fff::1",
  "5f00::1",
  "64:ff9b:1::1",
  "100::1",
  "100:0:0:1::1",
  "::ffff:808:808",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:0a00:1",
];

test("public unicast passes, every special range fails", () => {
  for (const ip of [...PUBLIC_V4, ...PUBLIC_V6]) {
    assert.equal(isPublicUnicastAddress(ip), true, `${ip} must pass`);
  }
  for (const ip of PRIVATE) {
    assert.equal(isPublicUnicastAddress(ip), false, `${ip} must fail`);
  }
  assert.equal(isPublicUnicastAddress("not-an-ip"), false);
  assert.equal(isPublicUnicastAddress(""), false);
});

test("literal private URLs are refused without any DNS", async () => {
  for (const ip of PRIVATE) {
    const host = ip.includes(":") ? `[${ip}]` : ip;
    const refusal = await connectorUrlRefusal(`http://${host}/`, () => {
      throw new Error("DNS must not be consulted for literal IPs");
    });
    assert.equal(refusal, CONNECTOR_URL_REFUSED, `${ip} must be refused`);
  }
});

test("literal public URLs pass without any DNS", async () => {
  for (const ip of PUBLIC_V4) {
    assert.equal(await connectorUrlRefusal(`https://${ip}/api`), null);
  }
});

test("non-http(s) and unparsable URLs are refused", async () => {
  assert.equal(await connectorUrlRefusal("ftp://8.8.8.8/x"), CONNECTOR_URL_REFUSED);
  assert.equal(await connectorUrlRefusal("file:///etc/passwd"), CONNECTOR_URL_REFUSED);
  assert.equal(await connectorUrlRefusal("not a url"), CONNECTOR_URL_REFUSED);
  assert.equal(await connectorUrlRefusal(null), null);
  assert.equal(await connectorUrlRefusal("  "), null);
});

test("hostnames fail closed on private, mixed, empty, or failed DNS", async () => {
  const answers: Record<string, string[] | Error> = {
    "public.example": ["93.184.216.34"],
    "private.example": ["10.1.2.3"],
    "mixed.example": ["93.184.216.34", "192.168.1.9"],
    "empty.example": [],
    "dead.example": new Error("ENOTFOUND"),
  };
  const lookup: AddressLookup = async (host) => {
    const answer = answers[host];
    if (answer instanceof Error) throw answer;
    return answer ?? [];
  };
  assert.equal(await connectorUrlRefusal("https://public.example/x", lookup), null);
  assert.equal(
    await connectorUrlRefusal("https://private.example/x", lookup),
    CONNECTOR_URL_REFUSED,
  );
  // One private answer poisons the whole host — no silent majority.
  assert.equal(await connectorUrlRefusal("https://mixed.example/x", lookup), CONNECTOR_URL_REFUSED);
  assert.equal(await connectorUrlRefusal("https://empty.example/x", lookup), CONNECTOR_URL_REFUSED);
  assert.equal(await connectorUrlRefusal("https://dead.example/x", lookup), CONNECTOR_URL_REFUSED);
  // A name resolving to the metadata service is refused by address, not text.
  assert.equal(
    await connectorUrlRefusal("https://meta.example/x", async () => ["169.254.169.254"]),
    CONNECTOR_URL_REFUSED,
  );
});

test("resolveVerifiedAddresses returns the checked set or throws the refusal", async () => {
  assert.deepEqual(await resolveVerifiedAddresses("https://8.8.8.8/x"), ["8.8.8.8"]);
  assert.deepEqual(
    await resolveVerifiedAddresses("https://public.example/x", async () => ["93.184.216.34"]),
    ["93.184.216.34"],
  );
  await assert.rejects(resolveVerifiedAddresses("https://10.0.0.1/x"), /public unicast/);
  await assert.rejects(
    resolveVerifiedAddresses("https://private.example/x", async () => ["10.9.9.9"]),
    /public unicast/,
  );
  await assert.rejects(resolveVerifiedAddresses("gopher://8.8.8.8/x"), /public unicast/);
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("guardedFetch never connects to a refused target", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const port = await listen(server);
  try {
    await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`), /public unicast/);
    await assert.rejects(guardedFetch(`http://localhost:${port}/`), /public unicast/);
    await assert.rejects(guardedFetch(`http://[::ffff:7f00:1]:${port}/`), /public unicast/);
    assert.equal(requests, 0, "no socket may open to a refused target");
  } finally {
    await close(server);
  }
});

test("guardedFetch refuses without resolving when DNS fails", async () => {
  await assert.rejects(guardedFetch("https://no-such-host.invalid/"), /public unicast/);
  await assert.rejects(guardedFetch("ftp://8.8.8.8/x"), /public unicast/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  CALLBACK_OWNED_CONFIG_KEYS,
  callerOwnedConfigRefusal,
  connectionConfigUrlRefusal,
  connectorUrlRefusal,
  declaredSourceConfig,
  isPublicUnicastAddress,
  mergedDeclaredSourceConfig,
} from "./_connector-guard.ts";

const refusedLiterals = [
  ["RFC1918 10.0.0.1", "http://10.0.0.1/"],
  ["IPv6 ULA fd00::1", "http://[fd00::1]/"],
  ["unspecified 0.0.0.0", "http://0.0.0.0/"],
  ["RFC1918 192.168.1.1", "http://192.168.1.1/"],
  ["RFC1918 172.16.0.1", "http://172.16.0.1/"],
  ["loopback IPv4", "http://127.0.0.1/"],
  ["loopback IPv6", "http://[::1]/"],
  ["IPv4-mapped hex loopback", "http://[::ffff:7f00:1]/"],
  ["IPv4-mapped dotted loopback", "http://[::ffff:127.0.0.1]/"],
  ["IPv4-mapped RFC1918", "http://[::ffff:0a00:1]/"],
  ["IPv4-mapped unspecified", "http://[::ffff:0:0]/"],
  ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
  ["unspecified IPv6", "http://[::]/"],
  ["TEST-NET-1 192.0.2.1", "http://192.0.2.1/"],
  ["benchmark 198.18.0.1", "http://198.18.0.1/"],
  ["TEST-NET-2 198.51.100.1", "http://198.51.100.1/"],
  ["TEST-NET-3 203.0.113.1", "http://203.0.113.1/"],
  ["IPv6 documentation 2001:db8::1", "http://[2001:db8::1]/"],
  ["file scheme", "file:///etc/passwd"],
] as const;

test("IPv4-mapped IPv6 loopback ::ffff:7f00:1 is refused", async () => {
  const hex = await connectorUrlRefusal("http://[::ffff:7f00:1]/");
  const dotted = await connectorUrlRefusal("http://[::ffff:127.0.0.1]/");
  assert.equal(typeof hex, "string", "Node's ::ffff:7f00:1 form must be refused");
  assert.equal(typeof dotted, "string", "::ffff:127.0.0.1 must be refused");
  assert.equal(
    await connectionConfigUrlRefusal({ url: "http://[::ffff:7f00:1]/" }),
    hex,
  );
});

test("public-unicast allowlist refuses RFC1918, ULA, unspecified, loopback, and non-http(s)", async () => {
  for (const [name, url] of refusedLiterals) {
    const error = await connectorUrlRefusal(url);
    assert.equal(typeof error, "string", `${name} must be refused, got ${String(error)}`);
  }
  assert.equal(typeof await connectorUrlRefusal("http://localhost:8069"), "string");
  assert.equal(await connectorUrlRefusal("https://1.1.1.1"), null);
  assert.equal(await connectorUrlRefusal("https://[2606:4700:4700::1111]"), null);
});

test("a test fails if 10.0.0.1, fd00::1, or 0.0.0.0 is accepted", async () => {
  for (const url of ["http://10.0.0.1/", "http://[fd00::1]/", "http://0.0.0.0/"]) {
    assert.equal(
      typeof await connectorUrlRefusal(url),
      "string",
      `${url} must not be accepted by a public-unicast allowlist`,
    );
    assert.equal(isPublicUnicastAddress(new URL(url).hostname), false, `${url} is not public unicast`);
  }
});

test("a test fails if 192.0.2.1, 198.18.0.1, 198.51.100.1, 203.0.113.1, or 2001:db8::1 is accepted", async () => {
  for (const url of [
    "http://192.0.2.1/",
    "http://198.18.0.1/",
    "http://198.51.100.1/",
    "http://203.0.113.1/",
    "http://[2001:db8::1]/",
  ]) {
    assert.equal(
      typeof await connectorUrlRefusal(url),
      "string",
      `${url} must not be accepted by a public-unicast allowlist`,
    );
    assert.equal(
      isPublicUnicastAddress(new URL(url).hostname),
      false,
      `${url} is reserved and not public unicast`,
    );
  }
});

test("DNS A/AAAA results fail closed unless every address is public unicast", async () => {
  assert.equal(
    typeof await connectorUrlRefusal("http://evil.example/", async () => ["10.0.0.1"]),
    "string",
  );
  assert.equal(
    typeof await connectorUrlRefusal("http://ula.example/", async () => ["fd00::1"]),
    "string",
  );
  assert.equal(
    typeof await connectorUrlRefusal("http://any.example/", async () => ["0.0.0.0"]),
    "string",
  );
  assert.equal(
    typeof await connectorUrlRefusal("http://mix.example/", async () => ["1.1.1.1", "10.0.0.1"]),
    "string",
    "one private A/AAAA must refuse the whole name",
  );
  assert.equal(
    typeof await connectorUrlRefusal("http://empty.example/", async () => []),
    "string",
  );
  assert.equal(
    typeof await connectorUrlRefusal("http://nx.example/", async () => {
      throw new Error("ENOTFOUND");
    }),
    "string",
  );
  assert.equal(
    await connectorUrlRefusal("http://ok.example/", async () => ["1.1.1.1"]),
    null,
  );
});

test("callback-owned OAuth identity keys are refused by name", () => {
  for (const key of CALLBACK_OWNED_CONFIG_KEYS) {
    const error = callerOwnedConfigRefusal({ [key]: "attacker-bound" });
    assert.match(String(error), new RegExp(key));
    assert.match(String(error), /Connect flow/);
  }
  assert.equal(callerOwnedConfigRefusal({ url: "https://1.1.1.1" }), null);
});

test("declaredSourceConfig keeps only manifest keys", () => {
  const declared = declaredSourceConfig(
    { configFields: [{ key: "url" }, { key: "environment" }] },
    { url: "https://1.1.1.1", realmId: "should-not-persist", extra: 1 },
  );
  assert.deepEqual(declared, { url: "https://1.1.1.1" });
});

test("a PATCH validates the merged NetSuite host before replacing stored config", async () => {
  const merged = mergedDeclaredSourceConfig(
    { configFields: [{ key: "host" }, { key: "account" }] },
    { host: "https://123456.suitetalk.api.netsuite.com", account: "123456" },
    { host: "http://127.0.0.1:8080", ignored: "not persisted" },
  );
  assert.deepEqual(merged, { host: "http://127.0.0.1:8080", account: "123456" });
  assert.match(String(await connectionConfigUrlRefusal(merged)), /public unicast/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  CALLBACK_OWNED_CONFIG_KEYS,
  callerOwnedConfigRefusal,
  connectionConfigUrlRefusal,
  connectorUrlRefusal,
  declaredSourceConfig,
} from "./_connector-guard.ts";

test("IPv4-mapped IPv6 loopback ::ffff:7f00:1 is refused", () => {
  const hex = connectorUrlRefusal("http://[::ffff:7f00:1]/");
  const dotted = connectorUrlRefusal("http://[::ffff:127.0.0.1]/");
  assert.equal(typeof hex, "string", "Node's ::ffff:7f00:1 form must be refused");
  assert.equal(typeof dotted, "string", "::ffff:127.0.0.1 must be refused");
  assert.equal(
    connectionConfigUrlRefusal({ url: "http://[::ffff:7f00:1]/" }),
    hex,
  );
});

test("link-local metadata and non-http(s) connector URLs are refused", () => {
  assert.equal(typeof connectorUrlRefusal("http://169.254.169.254/latest/meta-data/"), "string");
  assert.equal(typeof connectorUrlRefusal("http://127.0.0.1/"), "string");
  assert.equal(typeof connectorUrlRefusal("http://localhost:8069"), "string");
  assert.equal(typeof connectorUrlRefusal("http://[::1]/"), "string");
  assert.equal(typeof connectorUrlRefusal("file:///etc/passwd"), "string");
  assert.equal(connectorUrlRefusal("https://odoo.example.com"), null);
});

test("callback-owned OAuth identity keys are refused by name", () => {
  for (const key of CALLBACK_OWNED_CONFIG_KEYS) {
    const error = callerOwnedConfigRefusal({ [key]: "attacker-bound" });
    assert.match(String(error), new RegExp(key));
    assert.match(String(error), /Connect flow/);
  }
  assert.equal(callerOwnedConfigRefusal({ url: "https://odoo.example.com" }), null);
});

test("declaredSourceConfig keeps only manifest keys", () => {
  const declared = declaredSourceConfig(
    { configFields: [{ key: "url" }, { key: "environment" }] },
    { url: "https://odoo.example.com", realmId: "should-not-persist", extra: 1 },
  );
  assert.deepEqual(declared, { url: "https://odoo.example.com" });
});

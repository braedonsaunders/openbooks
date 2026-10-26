// Run with:  node --import tsx --test web/lib/apps/bridge.test.ts   (from repo root)
// Unit tests for the pure bridge protocol helpers: request narrowing, result
// envelopes, document inlining, and SDK/CSP shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBridgeRequest,
  makeBridgeResult,
  isBridgeMethod,
  inlineDocument,
  bridgeClientSource,
  isBridgeHandshake,
  APP_CSP,
  BRIDGE_MARKER,
} from "./bridge.ts";

test("parseBridgeRequest accepts a well-formed call", () => {
  const r = parseBridgeRequest({
    [BRIDGE_MARKER]: true,
    type: "call",
    id: "c1",
    method: "callBackend",
    payload: { x: 1 },
  });
  assert.ok(r);
  assert.equal(r!.method, "callBackend");
  assert.deepEqual(r!.payload, { x: 1 });
});

test("parseBridgeRequest rejects junk and non-bridge messages", () => {
  assert.equal(parseBridgeRequest(null), null);
  assert.equal(parseBridgeRequest("hi"), null);
  assert.equal(parseBridgeRequest({ type: "call", id: "x", method: "m" }), null); // missing marker
  assert.equal(parseBridgeRequest({ [BRIDGE_MARKER]: true, type: "result", id: "x" }), null); // wrong type
  assert.equal(
    parseBridgeRequest({ [BRIDGE_MARKER]: true, type: "call", id: 1, method: "m" }),
    null,
  ); // bad id
});

test("makeBridgeResult builds ok and error envelopes", () => {
  const ok = makeBridgeResult("c1", true, { a: 1 });
  assert.deepEqual(ok, {
    [BRIDGE_MARKER]: true,
    type: "result",
    id: "c1",
    ok: true,
    result: { a: 1 },
  });
  const err = makeBridgeResult("c2", false, new Error("boom"));
  assert.equal(err.ok, false);
  assert.match(err.error!, /boom/);
});

test("isBridgeMethod allowlists only known methods", () => {
  assert.equal(isBridgeMethod("callBackend"), true);
  assert.equal(isBridgeMethod("records.list"), true);
  assert.equal(isBridgeMethod("platform.query"), true);
  assert.equal(isBridgeMethod("platform.schema"), true);
  assert.equal(isBridgeMethod("platform.create"), true);
  assert.equal(isBridgeMethod("storage.set"), false);
  assert.equal(isBridgeMethod("__proto__"), false);
});

test("inlineDocument substitutes asset refs and injects head", () => {
  const html = `<html><head><link rel="stylesheet" href="styles.css"></head><body><img src="./logo.png"><script src="app.js"></script></body></html>`;
  const out = inlineDocument(
    html,
    {
      "styles.css": "data:text/css;base64,AAAA",
      "logo.png": "data:image/png;base64,BBBB",
      "app.js": "data:text/javascript;base64,CCCC",
    },
    '<meta name="injected">',
  );
  assert.match(out, /href="data:text\/css;base64,AAAA"/);
  assert.match(out, /src="data:image\/png;base64,BBBB"/); // ./logo.png normalized
  assert.match(out, /src="data:text\/javascript;base64,CCCC"/);
  assert.ok(
    out.startsWith('<meta name="injected"><html>'),
    "the injection precedes everything the App wrote",
  );
});

test("inlineDocument injects ahead of App scripts placed before <head>, after only a doctype", () => {
  const out = inlineDocument(
    "<!DOCTYPE html><script>early()</script><html><head></head><body>hi</body></html>",
    {},
    "<script>sdk()</script>",
  );
  assert.ok(out.startsWith("<!DOCTYPE html><script>sdk()</script><script>early()</script>"), out);
  assert.ok(
    inlineDocument("<html><body>hi</body></html>", {}, '<meta name="x">').startsWith(
      '<meta name="x"><html>',
    ),
  );
});

test("bridgeClientSource embeds context and defines the SDK surface", () => {
  const src = bridgeClientSource(
    {
      app: { id: "a1", key: "demo", name: "Demo" },
      user: { id: "u1", name: "Ada", roles: ["admin"] },
    },
    "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  );
  assert.match(src, /window\.openbooks/);
  assert.match(src, /callBackend/);
  assert.match(src, /records/);
  assert.match(src, /platform/);
  assert.match(src, /delete: function/);
  assert.match(src, /"key":"demo"/);
  assert.match(src, /type: 'ready'/);
  // Calls ride the private channel handed over with the single-use proof,
  // never the shared window message bus.
  assert.match(src, /new MessageChannel\(\)/);
  assert.match(src, /proof: "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5" \}, '\*', \[channel\.port2\]/);
  assert.match(src, /port\.postMessage\(/);
  assert.doesNotMatch(src, /window\.parent\.postMessage\(\{ '__ob': true, type: 'call'/);
});

test("isBridgeHandshake accepts only the current proof on a ready envelope", () => {
  const proof = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
  assert.equal(isBridgeHandshake({ __ob: true, type: "ready", proof }, proof), true);
  assert.equal(isBridgeHandshake({ __ob: true, type: "ready", proof }, null), false);
  assert.equal(isBridgeHandshake({ __ob: true, type: "ready", proof: "other" }, proof), false);
  assert.equal(isBridgeHandshake({ __ob: true, type: "call", proof }, proof), false);
});

test("APP_CSP locks down default-src and blocks app network", () => {
  assert.match(APP_CSP, /default-src 'none'/);
  assert.match(APP_CSP, /connect-src 'none'/);
});

test("inlineDocument resolves script and stylesheet references relative to the HTML entry file", () => {
  const document = inlineDocument(
    '<html><head><link href="./styles.css"></head><body><script src="app.js"></script></body></html>',
    {
      "frontend/styles.css": "data:text/css;base64,eA==",
      "frontend/app.js": "data:text/javascript;base64,eQ==",
    },
    '<meta name="test">',
    "frontend/index.html",
  );
  assert.ok(document.includes('href="data:text/css;base64,eA=="'));
  assert.ok(document.includes('src="data:text/javascript;base64,eQ=="'));
});

test("relative frontend references prefer their own directory over same-named root assets", () => {
  const result = inlineDocument(
    '<script src="./app.js"></script><img src="../assets/icon.png"><a href="https://example.test">External</a>',
    { "app.js": "ROOT", "frontend/app.js": "LOCAL", "assets/icon.png": "ICON" },
    "",
    "frontend/index.html",
  );
  assert.ok(result.includes('src="LOCAL"'));
  assert.ok(result.includes('src="ICON"'));
  assert.ok(result.includes('href="https://example.test"'));
});

test("bridge context explicitly distinguishes draft samples from installed data", () => {
  for (const preview of [true, false]) {
    const source = bridgeClientSource(
      { preview, app: { id: "a1", key: "demo", name: "Demo" }, user: null },
      "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
    );
    assert.ok(source.includes(`"preview":${preview}`));
  }
});

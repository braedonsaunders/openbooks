import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });
const { beginOidcAuthorization, completeOidcAuthorization } = await import("./auth-oidc");
const { env } = await import("@openbooks/engine/src/db.ts");
env.SESSION_SECRET = "oidc-stream-boundary-test-secret";
env.OPENBOOKS_OIDC_CLIENT_ID = "stream-test";
env.OPENBOOKS_APP_URL = "https://books.example.test";

for (const stage of ["discovery", "token", "jwks"] as const) {
  for (const length of ["missing", "understated", "oversized"] as const) {
    test(`OIDC bounds ${stage} while streaming with ${length} Content-Length`, async () => {
      const issuer = `https://${stage}-${length}.example.test`;
      env.OPENBOOKS_OIDC_ISSUER = issuer;
      let pulls = 0;
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls <= 3) controller.enqueue(new Uint8Array(600_000));
          else controller.close();
        },
        cancel() { canceled = true; },
      }, { highWaterMark: 0 });
      const headers = length === "missing" ? undefined : { "content-length": length === "understated" ? "10" : "1800000" };
      const oversized = new Response(body, { headers });
      const original = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url === `${issuer}/.well-known/openid-configuration`) return stage === "discovery" ? oversized : Response.json({
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        });
        if (url === `${issuer}/token`) return stage === "token" ? oversized : Response.json({ id_token: "test-token" });
        if (url === `${issuer}/jwks`) return oversized;
        throw new Error("unexpected provider URL");
      };
      try {
        await assert.rejects(async () => {
          const flow = await beginOidcAuthorization(null);
          await completeOidcAuthorization({ code: "code", state: new URL(flow.url).searchParams.get("state")!, flowCookie: flow.flowCookie });
        }, /too large/);
        assert.equal(canceled, true, "overflow cancels the provider stream instead of draining it");
        assert.ok(pulls <= (length === "oversized" ? 0 : 2), "the reader stops as soon as the byte budget is exceeded");
        assert.equal(body.locked, false);
      } finally {
        globalThis.fetch = original;
        if (!body.locked) await body.cancel().catch(() => {});
      }
    });
  }
}

for (const size of [1_000_000, 1_000_001]) {
  test(`OIDC discovery handles split UTF-8 at ${size} bytes`, async () => {
    const issuer = `https://utf8-${size}.example.test`;
    env.OPENBOOKS_OIDC_ISSUER = issuer;
    const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, padding: "" };
    const paddingBytes = size - Buffer.byteLength(JSON.stringify(metadata));
    metadata.padding = "é".repeat(Math.floor(paddingBytes / 2)) + "x".repeat(paddingBytes % 2);
    const bytes = new TextEncoder().encode(JSON.stringify(metadata));
    assert.equal(bytes.byteLength, size);
    const split = bytes.indexOf(0xc3) + 1;
    const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(body);
    try {
      if (size === 1_000_000) {
        const result = await beginOidcAuthorization(null);
        assert.equal(new URL(result.url).origin, issuer);
        assert.equal(canceled, false);
      } else {
        await assert.rejects(() => beginOidcAuthorization(null), /too large/);
        assert.equal(canceled, true);
      }
      assert.equal(body.locked, false);
    } finally {
      globalThis.fetch = original;
      if (!body.locked) await body.cancel().catch(() => {});
    }
  });
}

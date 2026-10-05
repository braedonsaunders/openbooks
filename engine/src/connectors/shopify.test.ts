import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SHOPIFY_API_VERSION,
  ShopifyClient,
  buildShopifyInstallUrl,
  verifyShopifyCallbackHmac,
} from "./shopify.ts";
import { createHmac } from "node:crypto";

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

test("shop domain outside myshopify.com is refused before any request", () => {
  assert.throws(
    () =>
      new ShopifyClient({
        shopDomain: "https://evil.example.com",
        accessToken: "shpat_x",
        transport: async () => {
          throw new Error("must not be called");
        },
      }),
    /myshopify\.com/,
  );
});

test("throttled GraphQL call backs off and retries once", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const client = new ShopifyClient({
    shopDomain: "demo.myshopify.com",
    accessToken: "shpat_x",
    sleepMs: async (ms) => {
      sleeps.push(ms);
    },
    transport: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] },
          {},
        );
      }
      return jsonResponse({ data: { shop: { name: "Demo" } } });
    },
  });
  const result = await client.graphql<{ shop: { name: string } }>("{ shop { name } }");
  assert.equal(result.data.shop.name, "Demo");
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0]! > 0 && sleeps[0]! <= 60_000, `bounded backoff, got ${sleeps[0]}`);
});

test("a second consecutive THROTTLED exhausts the throttle budget by name", async () => {
  const client = new ShopifyClient({
    shopDomain: "demo.myshopify.com",
    accessToken: "shpat_x",
    sleepMs: async () => {},
    maxThrottleRetries: 1,
    transport: async () =>
      jsonResponse({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
  });
  await assert.rejects(() => client.graphql("{ shop { name } }"), /throttle budget/);
});

test("cursor pagination walks every page exactly once", async () => {
  const seen: unknown[] = [];
  const client = new ShopifyClient({
    shopDomain: "demo.myshopify.com",
    accessToken: "shpat_x",
    sleepMs: async () => {},
    transport: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { after?: string | null } };
      const after = body.variables?.after ?? null;
      seen.push(after);
      if (after === null) {
        return jsonResponse({
          data: { products: { edges: [{ node: { id: "gid://shopify/Product/1" } }], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
        });
      }
      return jsonResponse({
        data: { products: { edges: [{ node: { id: "gid://shopify/Product/2" } }], pageInfo: { hasNextPage: false, endCursor: "c2" } } },
      });
    },
  });
  const ids: string[] = [];
  for await (const node of client.paginate<{ id: string }>(
    "query ($after: String) { products(first: 2, after: $after) { edges { node { id } } pageInfo { hasNextPage endCursor } } }",
    {},
    (data) => (data as { products: { edges: { node: { id: string } }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }).products,
  )) {
    ids.push(node.id);
  }
  assert.deepEqual(ids, ["gid://shopify/Product/1", "gid://shopify/Product/2"]);
  assert.deepEqual(seen, [null, "c1"]);
});

test("bulk query polls to completion and streams JSONL lines", async () => {
  const urls: string[] = [];
  const client = new ShopifyClient({
    shopDomain: "demo.myshopify.com",
    accessToken: "shpat_x",
    sleepMs: async () => {},
    transport: async (url, init) => {
      const target = String(url);
      urls.push(target);
      if (target.endsWith("graphql.json")) {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("bulkOperationRunQuery")) {
          return jsonResponse({ data: { bulkOperationRunQuery: { bulkOperation: { id: "gid://shopify/BulkOperation/9", status: "CREATED" }, userErrors: [] } } });
        }
        return jsonResponse({ data: { currentBulkOperation: { id: "gid://shopify/BulkOperation/9", status: "COMPLETED", url: "https://bulk.example/dl.jsonl" } } });
      }
      return new Response('{"id":"gid://shopify/Product/1"}\n{"id":"gid://shopify/Product/2"}\n', { status: 200 });
    },
  });
  const lines: { id: string }[] = [];
  await client.bulkQuery("{ products { edges { node { id } } } }", async (line) => {
    lines.push(line as { id: string });
  });
  assert.deepEqual(lines.map((line) => line.id), ["gid://shopify/Product/1", "gid://shopify/Product/2"]);
  assert.ok(urls.some((url) => url === "https://bulk.example/dl.jsonl"), "downloads the result file");
});

test("install URL carries scopes, redirect and state to the shop's admin", () => {
  const url = buildShopifyInstallUrl({
    shopDomain: "demo.myshopify.com",
    clientId: "cid",
    scopes: ["read_products", "read_orders"],
    redirectUri: "https://app.example/api/channels/shopify/oauth/callback",
    state: "s1",
  });
  assert.ok(url.startsWith("https://demo.myshopify.com/admin/oauth/authorize?"));
  assert.ok(url.includes("scope=read_products%2Cread_orders") || url.includes("scope=read_products,read_orders"));
  assert.ok(url.includes("state=s1"));
});

test("callback HMAC verifies the sorted query string in constant time", () => {
  const secret = "shpss_test_secret";
  const params = { code: "c1", shop: "demo.myshopify.com", state: "s1", timestamp: "123" };
  const sorted = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const hmac = createHmac("sha256", secret).update(sorted).digest("hex");
  assert.equal(verifyShopifyCallbackHmac({ ...params, hmac }, secret), true);
  assert.equal(verifyShopifyCallbackHmac({ ...params, hmac: `${hmac}x` }, secret), false);
  assert.equal(verifyShopifyCallbackHmac(params, secret), false);
});

test("pinned Admin API version is a single quarterly constant", () => {
  assert.match(SHOPIFY_API_VERSION, /^\d{4}-\d{2}$/);
});

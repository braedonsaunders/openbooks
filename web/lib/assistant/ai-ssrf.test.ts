/**
 * AI-endpoint SSRF tests (no DB).
 *
 * An org admin's custom base URL is the SSRF sink: the shape check alone
 * admits any hostname text, so these prove DNS resolution refuses
 * private/loopback/link-local answers before the org's API key travels,
 * every request re-pins to a checked address, and failures never echo an
 * untrusted host's response body.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Same module-graph shim as chat-turn: the AI client is server-only.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const {
  guardedAiFetch,
  sanitizeAiError,
  validateAiBaseUrl,
  validateAiBaseUrlLive,
} = await import("./client.ts");
const { fetchJson, listModels } = await import("./models.ts");
import type { AiConfig } from "./client.ts";

const customConfig = (baseUrl: string): AiConfig => ({
  provider: "custom",
  apiKey: "sk-test-KEYMARKER",
  modelFast: "probe-fast",
  modelSmart: "probe-smart",
  baseUrl,
});

test("shape validation still refuses private-looking hosts without DNS", () => {
  assert.throws(() => validateAiBaseUrl("custom", "https://10.0.0.1/"), /public host/);
  assert.throws(() => validateAiBaseUrl("custom", "http://ai.example/"), /HTTPS/);
  assert.throws(() => validateAiBaseUrl("custom", ""), /required/);
  assert.throws(() => validateAiBaseUrl("anthropic", "https://ai.example/"), /does not support/);
  assert.equal(validateAiBaseUrl("openai", null), null);
  assert.equal(validateAiBaseUrl("custom", "https://ai.example/v1/"), "https://ai.example/v1");
});

test("live validation refuses private DNS answers before any key travels", async () => {
  await assert.rejects(
    validateAiBaseUrlLive("custom", "https://ai.example/v1", async () => ["10.9.9.9"]),
    /public host/,
  );
  await assert.rejects(
    validateAiBaseUrlLive("custom", "https://ai.example/v1", async () => {
      throw new Error("ENOTFOUND");
    }),
    /public host/,
  );
  assert.equal(
    await validateAiBaseUrlLive("custom", "https://ai.example/v1", async () => ["93.184.216.34"]),
    "https://ai.example/v1",
  );
  assert.equal(await validateAiBaseUrlLive("openai", null), null);
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

test("model listing refuses a rebinding base URL and never connects", async () => {
  let requests = 0;
  let authorization = "";
  const impostor = createServer((req, res) => {
    requests += 1;
    authorization = req.headers.authorization ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "evil-model" }] }));
  });
  const port = await listen(impostor);
  try {
    // The name looks innocent; DNS answers loopback (rebound after save).
    const lookup = async () => ["127.0.0.1"];
    await assert.rejects(
      listModels(customConfig(`https://ai-endpoint.test:${port}`), { lookup }),
      /public host/,
    );
    assert.equal(requests, 0, "the API key must never reach the rebound host");
    assert.equal(authorization, "");
  } finally {
    await close(impostor);
  }
});

test("model-listing failures name the status, never the response body", async () => {
  const hostile = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "SECRET-MARKER trace" } }));
  });
  const port = await listen(hostile);
  try {
    await assert.rejects(fetchJson(`http://127.0.0.1:${port}/models`, {}), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /^401\b/);
      assert.doesNotMatch(message, /SECRET-MARKER/);
      return true;
    });
  } finally {
    await close(hostile);
  }
});

test("fetchJson still passes real payloads through", async () => {
  const provider = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "real-model" }] }));
  });
  const port = await listen(provider);
  try {
    const json = (await fetchJson(`http://127.0.0.1:${port}/models`, {})) as {
      data: Array<{ id: string }>;
    };
    assert.deepEqual(json.data, [{ id: "real-model" }]);
  } finally {
    await close(provider);
  }
});

test("the SDK-facing fetch refuses internal targets", async () => {
  await assert.rejects(guardedAiFetch("http://127.0.0.1:9/v1/chat/completions"), /public unicast/);
});

test("error sanitizer hides untrusted bodies, keeps trusted diagnostics", () => {
  const hostile = new Error("401 Unauthorized — SECRET-MARKER trace");
  assert.equal(
    sanitizeAiError(customConfig("https://ai.example/v1"), hostile),
    "Request failed — check the base URL, model id and API key.",
  );
  assert.equal(sanitizeAiError(null, hostile), "Request failed — check the base URL, model id and API key.");
  const overridden: AiConfig = {
    provider: "openrouter",
    apiKey: "sk-or-test",
    modelFast: "x",
    modelSmart: "y",
    baseUrl: "https://proxy.example/v1",
  };
  assert.doesNotMatch(sanitizeAiError(overridden, hostile), /SECRET-MARKER/);
  const builtin: AiConfig = { provider: "anthropic", apiKey: "sk-ant-test" };
  assert.match(sanitizeAiError(builtin, hostile), /401 Unauthorized/);
});

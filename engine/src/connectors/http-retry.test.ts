import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fetchWithConnectorRetry } from "./http-retry.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("a stalled socket times out by name instead of hanging", async () => {
  // Accepts the connection and never responds: a bare fetch would hang here
  // forever, so the test also bounds the wall clock.
  const hanging = createServer(() => {});
  const origin = await listen(hanging);
  try {
    const started = Date.now();
    await assert.rejects(
      fetchWithConnectorRetry(`${origin}/stall`, {}, { describe: "QBO", timeoutMs: 50, maxAttempts: 2, transport: fetch }),
      /QBO request failed after 2 attempts/,
    );
    assert.ok(Date.now() - started < 10_000, "the socket deadline must bound a stalled call");
  } finally {
    await close(hanging);
  }
});

test("a 429 retries honoring Retry-After, then succeeds", async () => {
  let requests = 0;
  const flaky = createServer((_req, res) => {
    requests += 1;
    if (requests === 1) {
      res.writeHead(429, { "Retry-After": "1" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const origin = await listen(flaky);
  try {
    const started = Date.now();
    const res = await fetchWithConnectorRetry(`${origin}/limited`, {}, { describe: "QBO", maxAttempts: 3, transport: fetch });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(requests, 2, "one retry after the 429, then success");
    assert.ok(Date.now() - started >= 1_000, "Retry-After must be honored before retrying");
  } finally {
    await close(flaky);
  }
});

test("a persistent 5xx is returned after the bounded attempts, never retried forever", async () => {
  let requests = 0;
  const broken = createServer((_req, res) => {
    requests += 1;
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("down");
  });
  const origin = await listen(broken);
  try {
    const res = await fetchWithConnectorRetry(`${origin}/down`, {}, { describe: "QBO", maxAttempts: 2, transport: fetch });
    assert.equal(res.status, 500);
    assert.equal(requests, 2, "bounded attempts, then the caller refuses on the status");
  } finally {
    await close(broken);
  }
});

test("a redirect refusal is never retried", async () => {
  let requests = 0;
  const redirector = createServer((_req, res) => {
    requests += 1;
    res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" });
    res.end();
  });
  const origin = await listen(redirector);
  try {
    await assert.rejects(
      fetchWithConnectorRetry(`${origin}/moved`, { redirect: "error" }, { describe: "QBO", maxAttempts: 4, transport: fetch }),
      /redirect/i,
    );
    assert.equal(requests, 1, "a deterministic redirect must stay exactly one request");
  } finally {
    await close(redirector);
  }
});

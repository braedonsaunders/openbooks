import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { ErpNextParityClient } from "./erpnext-client.ts";
import type { ErpNextConfig } from "./types.ts";

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

const credentials = {
  apiKey: "parity-api-key",
  apiSecret: "parity-api-secret",
} as const;

function clientAt(url: string): ErpNextParityClient {
  const config: ErpNextConfig = {
    url,
    ...credentials,
    company: "Parity Company",
  };
  return new ErpNextParityClient(config);
}

function trackRedirectModes(originalFetch: typeof fetch): Array<RequestRedirect | undefined> {
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    redirectModes.push(init?.redirect);
    return originalFetch(input, init);
  };
  return redirectModes;
}

const redirectStatuses = [301, 302, 303, 307, 308] as const;

test("ERPNext parity requests refuse every redirect without leaking Frappe token credentials", async () => {
  let attackerRequests = 0;
  const attackerAuthorizations: Array<string | undefined> = [];
  const attackerMaterial: string[] = [];
  const attacker = createServer((request, response) => {
    attackerRequests += 1;
    attackerAuthorizations.push(request.headers.authorization);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      attackerMaterial.push(
        JSON.stringify({
          method: request.method,
          url: request.url,
          headers: request.rawHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { name: "credential-capture" } }));
    });
  });
  const attackerOrigin = await listen(attacker);
  const configuredAuthorizations: string[] = [];
  const configuredStatuses: number[] = [];
  const redirector = createServer((request, response) => {
    configuredAuthorizations.push(request.headers.authorization ?? "");
    const status = redirectStatuses[configuredStatuses.length]!;
    configuredStatuses.push(status);
    response.writeHead(status, { location: `${attackerOrigin}/credential-capture` });
    response.end();
  });
  const erpnextOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  const redirectModes = trackRedirectModes(originalFetch);

  try {
    const client = clientAt(erpnextOrigin);
    for (const status of redirectStatuses) {
      await assert.rejects(
        client.get("Sales Order", `SO-${status}`),
        /fetch failed|redirect/i,
        `HTTP ${status} must be refused`,
      );
    }

    assert.deepEqual(configuredStatuses, redirectStatuses);
    assert.deepEqual(
      configuredAuthorizations,
      redirectStatuses.map(() => `token ${credentials.apiKey}:${credentials.apiSecret}`),
      "the configured ERPNext origin must receive the actual Frappe token credential",
    );
    assert.deepEqual(redirectModes, redirectStatuses.map(() => "error"));
    assert.equal(attackerRequests, 0, "the redirect target must receive zero requests");
    assert.deepEqual(attackerAuthorizations, [], "the redirect target must receive no Authorization header");
    assert.equal(attackerMaterial.some((value) => value.includes(credentials.apiKey)), false);
    assert.equal(attackerMaterial.some((value) => value.includes(credentials.apiSecret)), false);
  } finally {
    globalThis.fetch = originalFetch;
    await close(redirector);
    await close(attacker);
  }
});

test("valid-origin ERPNext parity requests still send Frappe token credentials and return data", async () => {
  const authorizations: string[] = [];
  const erpnext = createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { name: "SO-0001", grand_total: 125.5 } }));
  });
  const erpnextOrigin = await listen(erpnext);
  const originalFetch = globalThis.fetch;
  const redirectModes = trackRedirectModes(originalFetch);

  try {
    const document = await clientAt(erpnextOrigin).get<{ name: string; grand_total: number }>(
      "Sales Order",
      "SO-0001",
    );

    assert.deepEqual(document, { name: "SO-0001", grand_total: 125.5 });
    assert.deepEqual(authorizations, [`token ${credentials.apiKey}:${credentials.apiSecret}`]);
    assert.deepEqual(redirectModes, ["error"]);
  } finally {
    globalThis.fetch = originalFetch;
    await close(erpnext);
  }
});

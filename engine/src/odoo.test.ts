import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import { OdooClient, type OdooCreds } from "./odoo.ts";

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

const credsFor = (origin: string): OdooCreds => ({
  // Trailing slash on purpose: the client must normalize it to /jsonrpc.
  url: `${origin}/`,
  database: "tenant-db",
  username: "integration-user",
  apiKey: "secret-api-key",
});

/** Record the redirect mode every client request is issued with so the tests
 *  can prove the credential-bearing POSTs never opt into following redirects. */
function spyRedirectMode(originalFetch: typeof fetch): Array<RequestRedirect | undefined> {
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    redirectModes.push(init?.redirect);
    return originalFetch(input, init);
  };
  return redirectModes;
}

// Every 3xx with a Location must be refused, not followed: 307/308 preserve
// method AND body (database, username, API key); the re-request after
// 301/302/303 would repost whichever credentials survive it to an attacker
// host that was never configured as the tenant's Odoo origin.
const redirectStatuses = [301, 302, 303, 307, 308] as const;

test("Odoo JSON-RPC calls refuse redirects without reposting credentials", async () => {
  let attackerRequests = 0;
  const attacker = createServer((_req, res) => {
    attackerRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const attackerOrigin = await listen(attacker);

  const redirectorPaths: string[] = [];
  const redirector = createServer((req, res) => {
    redirectorPaths.push(req.url ?? "");
    // Cycle the status so each client call meets a different redirect class.
    res.writeHead(redirectStatuses[redirectorPaths.length % redirectStatuses.length]!, {
      location: `${attackerOrigin}/credential-capture`,
    });
    res.end();
  });
  const odooOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  const redirectModes = spyRedirectMode(originalFetch);

  try {
    // authenticate() carries db + username + apiKey; execute_kw re-sends them.
    const authClient = new OdooClient(credsFor(odooOrigin));
    await assert.rejects(authClient.authenticate(), /fetch failed|redirect/i);

    const searchClient = new OdooClient(credsFor(odooOrigin));
    await assert.rejects(
      searchClient.searchReadAll("res.partner", [], ["name"]),
      /fetch failed|redirect/i,
    );

    // Exactly one request per client call reaches the configured origin —
    // never a second, followed hop — and the attacker sees zero.
    assert.deepEqual(
      redirectorPaths.map((p) => new URL(p, odooOrigin).pathname),
      ["/jsonrpc", "/jsonrpc"],
    );
    assert.deepEqual(redirectModes, ["error", "error"]);
    assert.equal(attackerRequests, 0, "credentials must never reach the redirect target");
  } finally {
    globalThis.fetch = originalFetch;
    await close(redirector);
    await close(attacker);
  }
});

test("valid same-origin calls succeed: authentication, execute_kw, paginated search_read", async () => {
  interface RpcCall {
    path: string;
    service?: string;
    method?: string;
    args?: unknown[];
    kwargs?: Record<string, unknown>;
  }
  const seen: RpcCall[] = [];
  const LIMIT = 500;
  const odoo = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as {
      id: number;
      params: { service: string; method: string; args: unknown[] };
    };
    const { service, method, args } = body.params;
    const lastArg = args.at(-1);
    seen.push({
      path: req.url ?? "",
      service,
      method,
      args,
      kwargs:
        service === "object" && method === "execute_kw" && typeof lastArg === "object" && lastArg !== null
          ? (lastArg as Record<string, unknown>)
          : undefined,
    });
    if (service === "common" && method === "authenticate") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: 42 }));
      return;
    }
    const offset = Number(seen.at(-1)?.kwargs?.offset ?? 0);
    const page =
      offset === 0
        ? Array.from({ length: LIMIT }, (_, i) => ({ id: i + 1, name: `Partner ${i + 1}` }))
        : [{ id: 501, name: "Partner 501" }, { id: 502, name: "Partner 502" }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: page }));
  });
  const odooOrigin = await listen(odoo);
  const originalFetch = globalThis.fetch;
  const redirectModes = spyRedirectMode(originalFetch);

  try {
    const client = new OdooClient(credsFor(odooOrigin));
    assert.equal(await client.authenticate(), 42);
    // The cached uid must suppress a second authenticate round-trip.
    assert.equal(await client.authenticate(), 42);

    const partners = await client.searchReadAll<{ id: number; name: string }>(
      "res.partner",
      [],
      ["name"],
      "name asc",
    );
    assert.equal(partners.length, LIMIT + 2);

    // Credentials travel only inside POST bodies to the configured origin:
    // authenticate carries db/user/key, execute_kw re-sends them per call.
    assert.deepEqual(
      seen.map((c) => new URL(c.path, odooOrigin).pathname),
      ["/jsonrpc", "/jsonrpc", "/jsonrpc"],
    );
    assert.deepEqual(redirectModes, ["error", "error", "error"]);

    const [authCall, , pageOne] = seen;
    assert.ok(authCall && pageOne);
    const authBody = JSON.stringify({ params: authCall });
    assert.match(authBody, /"service":"common"/);
    assert.match(authBody, /"method":"authenticate"/);
    for (const secret of ["tenant-db", "integration-user", "secret-api-key"]) {
      assert.ok(authBody.includes(secret), `authenticate body must carry ${secret}`);
    }

    const executeKwArgs = pageOne.args ?? [];
    assert.equal(pageOne.service, "object");
    assert.equal(pageOne.method, "execute_kw");
    assert.deepEqual(executeKwArgs.slice(0, 3), ["tenant-db", 42, "secret-api-key"]);
    assert.deepEqual(executeKwArgs.slice(3, 6), ["res.partner", "search_read", [[]]]);
    assert.deepEqual(pageOne.kwargs, {
      fields: ["name"],
      offset: LIMIT,
      limit: LIMIT,
      order: "name asc",
    });

    // A second searchReadAll on the same client reuses the authenticated uid.
    const beforeSecondPass = seen.length;
    await client.searchReadAll("res.partner", [["id", "=", 1]], ["name"]);
    assert.equal(seen.length - beforeSecondPass, 2, "cached uid must skip re-authentication");
  } finally {
    globalThis.fetch = originalFetch;
    await close(odoo);
  }
});

test("same-origin failures surface real errors instead of fake success", async () => {
  const cases: Array<{ status?: number; payload: string }> = [
    { status: 500, payload: "boom" },
    { payload: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 200, message: "Access Denied" } }) },
  ];
  for (const testCase of cases) {
    const odoo = createServer((_req, res) => {
      res.writeHead(testCase.status ?? 200, { "content-type": "application/json" });
      res.end(testCase.payload);
    });
    const odooOrigin = await listen(odoo);
    const originalFetch = globalThis.fetch;
    const redirectModes = spyRedirectMode(originalFetch);
    try {
      const client = new OdooClient(credsFor(odooOrigin));
      if (testCase.status !== undefined) {
        await assert.rejects(client.authenticate(), /Odoo HTTP 500/);
      } else {
        await assert.rejects(client.authenticate(), /Odoo RPC error: Access Denied/);
      }
      assert.deepEqual(redirectModes, ["error"]);
    } finally {
      globalThis.fetch = originalFetch;
      await close(odoo);
    }
  }
});

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { ErpNextClient, type ErpNextCreds } from "./erpnext.ts";

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

const creds: ErpNextCreds = {
  url: "http://erpnext.example:8080",
  apiKey: "erp-api-key",
  apiSecret: "erp-api-secret",
};

// Every credentialed surface of the ERPNext client funnels through req():
// list/getDoc hit /api/resource and ping hits the auth method — each carries
// `Authorization: token key:secret` for an Administrator-scoped key.
function clientAt(url: string): ErpNextClient {
  return new ErpNextClient({ ...creds, url });
}

/** Track every fetch's redirect mode while transparently delegating to the
 *  real fetch (the client already targets whatever creds.url says). */
function trackRedirectModes(originalFetch: typeof fetch): Array<RequestRedirect | undefined> {
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    redirectModes.push(init?.redirect);
    return originalFetch(input, init);
  };
  return redirectModes;
}

// Every 3xx with a Location must be refused, not followed: undici would
// re-send the token Authorization header to the redirect target, handing an
// Administrator API credential to whichever host the Location names.
const redirectStatuses = [301, 302, 303, 307, 308] as const;

test("ERPNext calls refuse redirects without forwarding the token Authorization header", async () => {
  let attackerRequests = 0;
  const attackerAuth: string[] = [];
  const attacker = createServer((req, res) => {
    attackerRequests += 1;
    attackerAuth.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const attackerOrigin = await listen(attacker);
  const erpnextPaths: string[] = [];
  const redirector = createServer((req, res) => {
    erpnextPaths.push(req.url ?? "");
    // Cycle the status so successive calls meet different redirect classes.
    res.writeHead(redirectStatuses[(erpnextPaths.length - 1) % redirectStatuses.length]!, {
      location: `${attackerOrigin}/credential-capture`,
    });
    res.end();
  });
  const erpnextOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  const redirectModes = trackRedirectModes(originalFetch);

  const client = clientAt(erpnextOrigin);
  try {
    await assert.rejects(client.listAll("Sales Order", ["name"]), /fetch failed|redirect/i);
    await assert.rejects(client.getDoc("Sales Order", "SO-0001"), /fetch failed|redirect/i);
    await assert.rejects(client.ping(), /fetch failed|redirect/i);

    // Exactly one request per client call reaches the configured origin —
    // never a second, followed hop.
    assert.deepEqual(
      erpnextPaths.map((p) => new URL(p, erpnextOrigin).pathname),
      [
        "/api/resource/Sales%20Order",
        "/api/resource/Sales%20Order/SO-0001",
        "/api/method/frappe.auth.get_logged_user",
      ],
    );
    // The exact opt-out: without it, fetch follows redirects and replays the
    // Authorization header against the redirect target.
    assert.deepEqual(redirectModes, ["error", "error", "error"]);
    assert.equal(attackerRequests, 0, "credentials must never reach the redirect target");
    assert.deepEqual(attackerAuth, []);
  } finally {
    globalThis.fetch = originalFetch;
    await close(redirector);
    await close(attacker);
  }
});

test("valid same-origin ERPNext responses pass with the token Authorization header intact", async () => {
  interface SeenRequest {
    pathname: string;
    query: URLSearchParams;
    authorization: string;
  }
  const seen: SeenRequest[] = [];
  const erpnext = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://erpnext.test");
    const pathname = decodeURIComponent(url.pathname);
    seen.push({
      pathname,
      query: url.searchParams,
      authorization: req.headers.authorization ?? "",
    });
    res.writeHead(200, { "content-type": "application/json" });
    if (pathname === "/api/method/frappe.auth.get_logged_user") {
      res.end(JSON.stringify({ message: "Administrator" }));
      return;
    }
    if (pathname === "/api/resource/Sales Order/SO-0001") {
      res.end(JSON.stringify({ data: { name: "SO-0001", customer: "Acme Ltd", grand_total: 123.45 } }));
      return;
    }
    res.end(JSON.stringify({ data: [{ name: "SO-0001" }, { name: "SO-0002" }, { name: "SO-0003" }] }));
  });
  const erpnextOrigin = await listen(erpnext);
  const originalFetch = globalThis.fetch;
  const redirectModes = trackRedirectModes(originalFetch);

  try {
    const client = clientAt(erpnextOrigin);
    const rows = await client.listAll<{ name: string }>("Sales Order", ["name"], [["customer", "=", "Acme Ltd"]]);
    assert.deepEqual(rows.map((r) => r.name), ["SO-0001", "SO-0002", "SO-0003"]);

    const doc = await client.getDoc<{ name: string; customer: string; grand_total: number }>(
      "Sales Order",
      "SO-0001",
    );
    assert.equal(doc.customer, "Acme Ltd");
    assert.equal(doc.grand_total, 123.45);

    assert.equal(await client.ping(), "Administrator");

    // Credentials travel only inside requests to the operator-configured
    // origin, and every request still opts out of redirect-following.
    assert.deepEqual(redirectModes, ["error", "error", "error"]);
    assert.deepEqual(seen.map((r) => r.pathname), [
      "/api/resource/Sales Order",
      "/api/resource/Sales Order/SO-0001",
      "/api/method/frappe.auth.get_logged_user",
    ]);
    for (const request of seen) {
      assert.equal(request.authorization, `token ${creds.apiKey}:${creds.apiSecret}`);
    }
    const listCall = seen[0]!;
    assert.equal(listCall.query.get("limit_start"), "0");
    assert.equal(listCall.query.get("limit_page_length"), "200");
    assert.equal(listCall.query.get("fields"), JSON.stringify(["name"]));
    assert.equal(listCall.query.get("filters"), JSON.stringify([["customer", "=", "Acme Ltd"]]));
  } finally {
    globalThis.fetch = originalFetch;
    await close(erpnext);
  }
});

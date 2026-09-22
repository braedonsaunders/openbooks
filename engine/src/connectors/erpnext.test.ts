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
function clientAt(url: string, transport?: typeof fetch): ErpNextClient {
  return new ErpNextClient({ ...creds, url }, transport);
}

/** Recording transport wrapping the real fetch: the client's default
 *  transport is the SSRF-guarded fetch, which would refuse these loopback
 *  test servers before connecting — so tests inject explicitly and record
 *  the redirect mode the client requests. */
function recordingTransport(spied: Array<RequestRedirect | undefined>): typeof fetch {
  return (input, init) => {
    spied.push(init?.redirect);
    return fetch(input, init);
  };
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
  const redirectModes: Array<RequestRedirect | undefined> = [];

  const client = clientAt(erpnextOrigin, recordingTransport(redirectModes));
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
  const redirectModes: Array<RequestRedirect | undefined> = [];

  try {
    const client = clientAt(erpnextOrigin, recordingTransport(redirectModes));
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
    await close(erpnext);
  }
});

// The injected transports above bypass the guard by explicit test choice.
// With the default transport, a non-public origin is refused at request
// time — even when nothing listens there, because the refusal precedes any
// socket: a saved URL that later rebinds to internal addresses fails closed.
test("the default transport refuses non-public origins without connecting", async () => {
  const loopback = new ErpNextClient({ ...creds, url: "http://127.0.0.1:9" });
  await assert.rejects(loopback.ping(), /public unicast/);
  const unresolvable = new ErpNextClient({ ...creds, url: "https://erpnext.invalid" });
  await assert.rejects(unresolvable.ping(), /public unicast/);
});

test("error responses name the status, never the response body", async () => {
  const erpnext = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/html" });
    res.end("<html>SECRET-MARKER internal trace</html>");
  });
  const erpnextOrigin = await listen(erpnext);
  try {
    const client = clientAt(erpnextOrigin, recordingTransport([]));
    await assert.rejects(client.ping(), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /ERPNext HTTP 500/);
      assert.doesNotMatch(message, /SECRET-MARKER/);
      return true;
    });
  } finally {
    await close(erpnext);
  }
});

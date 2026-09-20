import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  type NetSuiteCreds,
  netsuiteRecord,
  netsuiteRecords,
  netsuiteRestlet,
  netsuiteSoapFileGet,
  suiteql,
} from "./netsuite.ts";

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

const ACCOUNT = "123456";
const SUITETALK_ORIGIN = `https://${ACCOUNT}.suitetalk.api.netsuite.com`;
const RESTLET_ORIGIN = `https://${ACCOUNT}.restlets.api.netsuite.com`;

const creds: NetSuiteCreds = {
  account: ACCOUNT,
  host: SUITETALK_ORIGIN,
  consumerKey: "consumer-key",
  consumerSecret: "consumer-secret",
  tokenKey: "token-key",
  tokenSecret: "token-secret",
};

/** Remap the allowlisted NetSuite origins onto a local test server so the
 *  client exercises its real URL construction and credential placement
 *  without touching the network. Records the redirect mode of every call. */
function remapNetsuiteOrigins(originalFetch: typeof fetch, origins: string[], targetOrigin: string) {
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    redirectModes.push(init?.redirect);
    let url = String(input);
    for (const origin of origins) url = url.replace(origin, targetOrigin);
    return originalFetch(url, init);
  };
  return redirectModes;
}

// Every credentialed surface of the NetSuite client: SuiteQL and both
// SuiteTalk REST reads carry the OAuth1 Authorization header, RESTlet calls
// carry it too, and the SuiteTalk SOAP envelope embeds the TokenPassport
// credentials in its body. None of them may ever follow an HTTP redirect,
// which would replay those credentials to whatever host Location points at.
test("every credentialed NetSuite request opts out of redirect-following", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input, init) => {
    seen.push({ url: String(input), init });
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/suiteql")) {
      return Promise.resolve(new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 }));
    }
    if (/\/record\/v1\/customer\/\d+$/.test(pathname)) {
      return Promise.resolve(new Response(JSON.stringify({ id: "42" }), { status: 200 }));
    }
    if (pathname.includes("/record/v1/")) {
      return Promise.resolve(new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 }));
    }
    if (pathname.includes("/NetSuitePort_")) {
      return Promise.resolve(new Response(
        `<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"><soap-env:Body>` +
        `<getResponse isSuccess="true"><name>f.txt</name><content>${Buffer.from("hello").toString("base64")}</content></getResponse>` +
        `</soap-env:Body></soap-env:Envelope>`,
        { status: 200 },
      ));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }) as typeof fetch;

  try {
    await suiteql("select * from customer", creds);
    await netsuiteRecords("customer", creds);
    await netsuiteRecord("customer", 42, creds);
    await netsuiteRestlet("customscript_x", "customdeploy_x", {}, creds);
    await netsuiteRestlet("customscript_x", "customdeploy_x", { payload: { a: 1 } }, creds, "POST");
    await netsuiteSoapFileGet("42", creds);

    assert.deepEqual(seen.map(({ url }) => new URL(url).href), [
      `${SUITETALK_ORIGIN}/services/rest/query/v1/suiteql?limit=1000&offset=0`,
      `${SUITETALK_ORIGIN}/services/rest/record/v1/customer?limit=1000&offset=0`,
      `${SUITETALK_ORIGIN}/services/rest/record/v1/customer/42?expandSubResources=true`,
      `${RESTLET_ORIGIN}/app/site/hosting/restlet.nl?script=customscript_x&deploy=customdeploy_x`,
      `${RESTLET_ORIGIN}/app/site/hosting/restlet.nl?script=customscript_x&deploy=customdeploy_x`,
      `${SUITETALK_ORIGIN}/services/NetSuitePort_2022_1`,
    ]);
    // The exact opt-out: without it, fetch follows redirects and replays the
    // OAuth1 Authorization header (and POST bodies) against the redirect
    // target.
    assert.deepEqual(
      seen.map(({ init }) => init?.redirect),
      ["manual", "manual", "manual", "manual", "manual", "manual"],
    );
    const authorizations = seen.map(({ init }) =>
      String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "")
    );
    for (let i = 0; i < 5; i++) {
      assert.match(authorizations[i]!, /^OAuth realm="123456"/);
      assert.match(authorizations[i]!, /oauth_consumer_key="consumer-key"/);
      assert.match(authorizations[i]!, /oauth_token="token-key"/);
    }
    // The SOAP call carries no header, but the TokenPassport rides in the
    // envelope body — also credential material that must never be redirected.
    assert.equal(authorizations[5], "");
    assert.match(String(seen[5]!.init?.body), /tokenPassport[\s\S]*<token>token-key<\/token>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Every 3xx class must be refused, not followed: 307/308 preserve method AND
// body; 301/302/303 still leak whichever headers survive the re-request. The
// refusal must also be terminal — a deterministic security answer from the
// origin, not a transient fault worth retrying four times.
const redirectStatuses = [301, 302, 303, 307, 308] as const;

test("NetSuite SuiteQL/REST calls refuse every redirect class without forwarding credentials", async () => {
  let attackerRequests = 0;
  const attacker = createServer((_req, res) => {
    attackerRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const attackerOrigin = await listen(attacker);
  interface Hop {
    path: string;
    authorization: string;
    body: string;
  }
  const hops: Hop[] = [];
  // Cycle the status so successive calls meet different redirect classes.
  const redirector = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      hops.push({ path: req.url ?? "", authorization: req.headers.authorization ?? "", body: raw });
      res.writeHead(redirectStatuses[(hops.length - 1) % redirectStatuses.length]!, {
        location: `${attackerOrigin}/credential-capture`,
      });
      res.end();
    });
  });
  const netsuiteOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  const redirectModes = remapNetsuiteOrigins(originalFetch, [SUITETALK_ORIGIN, RESTLET_ORIGIN], netsuiteOrigin);

  try {
    await assert.rejects(suiteql("select * from customer", creds), /HTTP 301 redirect.*credential-capture/s);
    await assert.rejects(netsuiteRecords("customer", creds), /redirect/i);
    await assert.rejects(netsuiteRecord("customer", 42, creds), /redirect/i);
    await assert.rejects(netsuiteRestlet("customscript_x", "customdeploy_x", { p: "v" }, creds), /redirect/i);
    await assert.rejects(netsuiteRestlet("customscript_x", "customdeploy_x", { a: 1 }, creds, "POST"), /redirect/i);
    await assert.rejects(netsuiteSoapFileGet("42", creds), /redirect/i);

    // Exactly one hop per call reaches the allowlisted NetSuite origin —
    // never a second, followed hop — proving each refusal is terminal rather
    // than retried into the redirector.
    assert.deepEqual(hops.map(({ path }) => new URL(path, netsuiteOrigin).pathname), [
      "/services/rest/query/v1/suiteql",
      "/services/rest/record/v1/customer",
      "/services/rest/record/v1/customer/42",
      "/app/site/hosting/restlet.nl",
      "/app/site/hosting/restlet.nl",
      "/services/NetSuitePort_2022_1",
    ]);
    assert.deepEqual(redirectModes, ["manual", "manual", "manual", "manual", "manual", "manual"]);
    // The OAuth1 header was present on the legitimate hops — i.e. the exact
    // material a followed redirect would have leaked — yet the attacker saw
    // zero requests.
    for (let i = 0; i < 5; i++) assert.match(hops[i]!.authorization, /^OAuth realm="123456"/);
    assert.equal(hops[5]!.authorization, "");
    assert.match(hops[5]!.body, /tokenPassport[\s\S]*<token>token-key<\/token>/);
    assert.equal(attackerRequests, 0, "credentials must never reach the redirect target");
  } finally {
    globalThis.fetch = originalFetch;
    await close(redirector);
    await close(attacker);
  }
});

test("valid SuiteQL and SuiteTalk REST calls still succeed against a compliant origin", async () => {
  let suiteqlPages = 0;
  const seenAuthorizations: string[] = [];
  const netsuite = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      seenAuthorizations.push(req.headers.authorization ?? "");
      if (url.pathname === "/services/rest/query/v1/suiteql") {
        suiteqlPages += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(
          suiteqlPages === 1
            ? { items: [{ id: "1", entityid: "A" }, { id: "2", entityid: "B" }], hasMore: true }
            : { items: [{ id: "3", entityid: "C" }], hasMore: false },
        ));
        return;
      }
      if (url.pathname === "/services/rest/record/v1/customer/77") {
        assert.equal(url.searchParams.get("expandSubResources"), "true");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "77", entityid: "Acme" }));
        return;
      }
      if (url.pathname === "/services/rest/record/v1/customer") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [{ id: "77", entityid: "Acme" }], hasMore: false }));
        return;
      }
      if (url.pathname === "/app/site/hosting/restlet.nl") {
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ script: url.searchParams.get("script"), got: url.searchParams.get("p") }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ posted: JSON.parse(raw) }));
        }
        return;
      }
      if (url.pathname.includes("/NetSuitePort_")) {
        res.writeHead(200, { "content-type": "text/xml" });
        res.end(
          `<?xml version="1.0"?><soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">` +
          `<soap-env:Body><getResponse isSuccess="true"><name>invoice.pdf</name>` +
          `<content>${Buffer.from("pdf-bytes").toString("base64")}</content></getResponse></soap-env:Body>` +
          `</soap-env:Envelope>`,
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  const netsuiteOrigin = await listen(netsuite);
  const originalFetch = globalThis.fetch;
  // Only the RESTlet origin is rewritten here: its endpoint is derived from
  // the account id, so the other surfaces point at the local origin directly
  // via creds.host and exercise the real URL construction end to end.
  remapNetsuiteOrigins(originalFetch, [RESTLET_ORIGIN], netsuiteOrigin);

  try {
    const rows = await suiteql<{ id: string; entityid: string }>("select id, entityid from customer", { ...creds, host: netsuiteOrigin });
    assert.deepEqual(rows, [
      { id: "1", entityid: "A" },
      { id: "2", entityid: "B" },
      { id: "3", entityid: "C" },
    ]);
    assert.equal(suiteqlPages, 2, "pagination must follow hasMore with limit/offset");

    const collection = await netsuiteRecords<{ id: string }>("customer", { ...creds, host: netsuiteOrigin });
    assert.deepEqual(collection, [{ id: "77", entityid: "Acme" }]);

    const record = await netsuiteRecord<{ id: string }>("customer", "77", { ...creds, host: netsuiteOrigin });
    assert.equal(record.id, "77");

    const restletGet = await netsuiteRestlet<{ script: string; got: string }>(
      "customscript_x",
      "customdeploy_x",
      { p: "v" },
      creds,
    );
    assert.deepEqual(restletGet, { script: "customscript_x", got: "v" });

    const restletPost = await netsuiteRestlet<{ posted: unknown }>("customscript_x", "customdeploy_x", { a: 1 }, creds, "POST");
    assert.deepEqual(restletPost, { posted: { a: 1 } });

    const file = await netsuiteSoapFileGet("42", { ...creds, host: netsuiteOrigin });
    assert.equal(file.name, "invoice.pdf");
    assert.deepEqual(file.bytes, Buffer.from("pdf-bytes"));

    // Credentials travel only inside requests to the allowlisted origin, as
    // OAuth1 Authorization headers on SuiteQL/REST/RESTlet calls. The SOAP
    // file-get carries no header (its TokenPassport rides in the body).
    assert.equal(seenAuthorizations.length, 7);
    for (let i = 0; i < 6; i++) assert.match(seenAuthorizations[i]!, /^OAuth realm="123456"/);
    assert.equal(seenAuthorizations[6], "");

    // RESTlet GET parameters stay typed: objects are rejected before any
    // request is made.
    await assert.rejects(
      netsuiteRestlet("customscript_x", "customdeploy_x", { bad: { nested: true } } as never, creds),
      /must be a string or number/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await close(netsuite);
  }
});

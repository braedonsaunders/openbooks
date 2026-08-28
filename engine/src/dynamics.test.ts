import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { DynamicsClient, clientCredentialsToken, exchangeCode, listCompanies, refreshTokens } from "./dynamics.ts";

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

const app = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://app.example/callback",
  aadTenantId: "tenant-id",
};
const tokens = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

// Every credentialed surface of the Dynamics client: the OAuth token endpoints
// POST the client_secret in the body, every API call carries a bearer token.
// None of them may ever follow an HTTP redirect, which would re-send those
// credentials to whatever host the Location points at.
test("every credentialed Dynamics request opts out of redirect-following", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input, init) => {
    seen.push({ url: String(input), init });
    const pathname = new URL(String(input)).pathname;
    const body = pathname.endsWith("/token")
      ? JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 1800 })
      : pathname.endsWith("/companies")
      ? JSON.stringify({ value: [{ id: "company-id", name: "CRONUS" }] })
      : "{}";
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;

  try {
    await exchangeCode(app, "auth-code");
    await clientCredentialsToken(app);
    await refreshTokens(app, "refresh-token");
    await listCompanies(tokens.accessToken, app.aadTenantId, "PROD");
    await new DynamicsClient(app, "PROD", "company-id", tokens).list("items");

    assert.deepEqual(seen.map(({ url }) => new URL(url).href), [
      "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
      "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
      "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
      "https://api.businesscentral.dynamics.com/v2.0/tenant-id/PROD/api/v2.0/companies",
      "https://api.businesscentral.dynamics.com/v2.0/tenant-id/PROD/api/v2.0/companies(company-id)/items",
    ]);
    // The credentials that must never cross a redirect boundary: the client
    // secret rides in every token POST's body, the bearer token in every API
    // call's Authorization header.
    const tokenBodies = seen.slice(0, 3).map(({ init }) => String(init?.body));
    for (const body of tokenBodies) assert.match(body, /client_secret=client-secret\b/);
    const authorization = seen.map(({ init }) =>
      String((init?.headers as Record<string, string> | undefined)?.Authorization)
    );
    assert.deepEqual(authorization[3], "Bearer access-token");
    assert.deepEqual(authorization[4], "Bearer access-token");
    // The exact opt-out: without it, fetch follows redirects and replays those
    // credentials against the redirect target.
    assert.deepEqual(
      seen.map(({ init }) => init?.redirect),
      ["manual", "manual", "manual", "manual", "manual"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Every 3xx class must be refused, not followed: 307/308 preserve method AND
// the client_secret body; 301/302/303 still leak whichever credentials survive
// the re-request. The refusal must also be terminal — a deterministic security
// answer from the origin, not a transient fault worth retrying four times.
const redirectStatuses = [301, 302, 303, 307, 308] as const;

test("Dynamics OAuth and API calls refuse every redirect class without forwarding credentials", async () => {
  let attackerRequests = 0;
  const attacker = createServer((_req, res) => {
    attackerRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const attackerOrigin = await listen(attacker);
  const attemptedPaths: string[] = [];
  // Cycle the status so successive calls meet different redirect classes.
  const redirector = createServer((req, res) => {
    attemptedPaths.push(req.url ?? "");
    res.writeHead(redirectStatuses[(attemptedPaths.length - 1) % redirectStatuses.length]!, {
      location: `${attackerOrigin}/credential-capture`,
    });
    res.end();
  });
  const dynamicsOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  const dynamicsHosts = ["https://login.microsoftonline.com", "https://api.businesscentral.dynamics.com"];
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    redirectModes.push(init?.redirect);
    let rewritten = String(input);
    for (const host of dynamicsHosts) rewritten = rewritten.replace(host, dynamicsOrigin);
    return originalFetch(rewritten, init);
  };

  const client = new DynamicsClient(app, "PROD", "company-id", tokens);
  try {
    await assert.rejects(exchangeCode(app, "auth-code"), /HTTP 301 redirect.*credential-capture/s);
    await assert.rejects(clientCredentialsToken(app), /redirect/i);
    await assert.rejects(refreshTokens(app, "refresh-token"), /redirect/i);
    await assert.rejects(listCompanies(tokens.accessToken, app.aadTenantId, "PROD"), /redirect/i);
    await assert.rejects(client.list("items"), /redirect/i);

    // Exactly one hop per call reaches the allowlisted origin — never a
    // second, followed hop — even though DynamicsClient.send retries transient
    // faults: a redirect refusal is terminal by design.
    assert.deepEqual(attemptedPaths, [
      "/tenant-id/oauth2/v2.0/token",
      "/tenant-id/oauth2/v2.0/token",
      "/tenant-id/oauth2/v2.0/token",
      "/v2.0/tenant-id/PROD/api/v2.0/companies",
      "/v2.0/tenant-id/PROD/api/v2.0/companies(company-id)/items",
    ]);
    assert.deepEqual(redirectModes, ["manual", "manual", "manual", "manual", "manual"]);
    assert.equal(attackerRequests, 0, "credentials must never reach the redirect target");
  } finally {
    globalThis.fetch = originalFetch;
    await close(redirector);
    await close(attacker);
  }
});

// The guard only refuses redirects: ordinary responses from the configured
// origins keep flowing through unchanged.
test("normal non-redirected Dynamics responses pass through end to end", async () => {
  const upstream = createServer((req, res) => {
    const pathname = req.url ?? "";
    if (pathname.endsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 1800 }));
    } else if (pathname.endsWith("/companies")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: [{ id: "company-id", name: "CRONUS", displayName: "CRONUS Canada" }] }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: [{ No: "10000" }] }));
    }
  });
  const upstreamOrigin = await listen(upstream);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    let rewritten = String(input);
    for (const host of ["https://login.microsoftonline.com", "https://api.businesscentral.dynamics.com"]) {
      rewritten = rewritten.replace(host, upstreamOrigin);
    }
    return originalFetch(rewritten, init);
  };

  try {
    const exchanged = await exchangeCode(app, "auth-code");
    assert.equal(exchanged.accessToken, "at");
    assert.equal(exchanged.refreshToken, "rt");
    const appOnly = await clientCredentialsToken(app);
    assert.equal(appOnly.accessToken, "at");
    assert.equal(appOnly.refreshToken, "");
    const refreshed = await refreshTokens(app, "refresh-token");
    assert.equal(refreshed.refreshToken, "rt");
    const companies = await listCompanies(tokens.accessToken, app.aadTenantId, "PROD");
    assert.deepEqual(companies, [{ id: "company-id", name: "CRONUS", displayName: "CRONUS Canada" }]);
    const rows = await new DynamicsClient(app, "PROD", "company-id", tokens).list<{ No: string }>("items");
    assert.deepEqual(rows, [{ No: "10000" }]);
  } finally {
    globalThis.fetch = originalFetch;
    await close(upstream);
  }
});

test("Dynamics OData pagination refuses absolute and protocol-relative foreign nextLinks before sending the bearer token", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const nextLink of ["https://attacker.example/capture", "//attacker.example/capture"]) {
      const seen: Array<{ url: string; init?: RequestInit }> = [];
      let attackerRequests = 0;
      globalThis.fetch = ((input, init) => {
        const url = String(input);
        seen.push({ url, init });
        if (url.endsWith("/items")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ value: [{ No: "10000" }], "@odata.nextLink": nextLink }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        attackerRequests += 1;
        return Promise.resolve(new Response(JSON.stringify({ value: [{ No: "stolen" }] }), { status: 200 }));
      }) as typeof fetch;

      const client = new DynamicsClient(app, "PROD", "company-id", tokens);
      await assert.rejects(client.list<{ No: string }>("items"), /origin/i);
      assert.equal(seen.length, 1, "pagination must be rejected before a second fetch");
      assert.equal(attackerRequests, 0, "the foreign origin must never receive a request");
      assert.equal(
        (seen[0]?.init?.headers as Record<string, string> | undefined)?.Authorization,
        "Bearer access-token",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Dynamics OData pagination follows same-origin relative and absolute nextLinks", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const baseItemsUrl =
      "https://api.businesscentral.dynamics.com/v2.0/tenant-id/PROD/api/v2.0/companies(company-id)/items";
    for (const [nextLink, expectedNextLink] of [
      ["companies(company-id)/items?$skiptoken=relative", `${baseItemsUrl}?$skiptoken=relative`],
      [`${baseItemsUrl}?$skiptoken=absolute`, `${baseItemsUrl}?$skiptoken=absolute`],
    ] as const) {
      const seen: string[] = [];
      globalThis.fetch = ((input, _init) => {
        const url = String(input);
        seen.push(url);
        const body = seen.length === 1 ? { value: [{ No: "10000" }], "@odata.nextLink": nextLink } : { value: [{ No: "10001" }] };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }) as typeof fetch;

      const rows = await new DynamicsClient(app, "PROD", "company-id", tokens).list<{ No: string }>("items");
      assert.deepEqual(rows, [{ No: "10000" }, { No: "10001" }]);
      assert.deepEqual(seen, [baseItemsUrl, expectedNextLink]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Dynamics OData pagination never forwards bearer tokens across a redirect hop", async () => {
  let attackerRequests = 0;
  const attacker = createServer((_req, res) => {
    attackerRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ value: [{ No: "stolen" }] }));
  });
  const attackerOrigin = await listen(attacker);
  const redirectorRequests: Array<{ path: string; authorization?: string }> = [];
  const redirector = createServer((req, res) => {
    redirectorRequests.push({ path: req.url ?? "", authorization: req.headers.authorization });
    if ((req.url ?? "").endsWith("/items")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          value: [{ No: "10000" }],
          "@odata.nextLink":
            "https://api.businesscentral.dynamics.com/v2.0/tenant-id/PROD/api/v2.0/companies(company-id)/items?page=2",
        }),
      );
      return;
    }
    res.writeHead(302, { location: `${attackerOrigin}/credential-capture` });
    res.end();
  });
  const redirectorOrigin = await listen(redirector);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const rewritten = String(input).replace("https://api.businesscentral.dynamics.com", redirectorOrigin);
    return originalFetch(rewritten, init);
  };

  try {
    await assert.rejects(new DynamicsClient(app, "PROD", "company-id", tokens).list("items"), /redirect/i);
    assert.deepEqual(redirectorRequests.map(({ path }) => path), [
      "/v2.0/tenant-id/PROD/api/v2.0/companies(company-id)/items",
      "/v2.0/tenant-id/PROD/api/v2.0/companies(company-id)/items?page=2",
    ]);
    assert.deepEqual(
      redirectorRequests.map(({ authorization }) => authorization),
      ["Bearer access-token", "Bearer access-token"],
    );
    assert.equal(attackerRequests, 0, "redirect Location must never receive the bearer token");
  } finally {
    globalThis.fetch = originalFetch;
    await close(redirector);
    await close(attacker);
  }
});

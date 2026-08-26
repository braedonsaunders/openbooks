import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { verifyOidcIdToken } from "./auth-oidc-token";

// auth-oidc.ts is server-only (it pulls the engine's env snapshot and the
// session-secret policy), so the runner cannot import it as-is. The marker
// package gates only RSC bundling; shimming it to an empty module lets these
// tests exercise the production flow directly. node's test runner isolates
// each file in its own process, so the hook cannot leak elsewhere.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { beginOidcAuthorization, completeOidcAuthorization } = await import("./auth-oidc");
const { env } = await import("@openbooks/engine/src/db.ts");

// config() reads the module-load env snapshot; the fixed test command supplies
// no OIDC values, so seed them here once (each test file runs in its own
// process). NODE_ENV=test lets assertSecureEndpoint accept the loopback
// provider origins these tests stand up.
env.SESSION_SECRET = "oidc-flow-signing-secret-for-tests";
env.OPENBOOKS_OIDC_CLIENT_ID = "openbooks-test";
env.OPENBOOKS_OIDC_CLIENT_SECRET = "oidc-client-secret";
env.OPENBOOKS_APP_URL = "https://books.example.test";

function token(claimOverrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://id.example.test",
    sub: "subject-1",
    aud: "openbooks",
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    nonce: "nonce-1",
    email: "user@example.test",
    email_verified: true,
    ...claimOverrides,
  })).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url");
  return {
    idToken: `${header}.${claims}.${signature}`,
    keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256" }],
  };
}

test("OIDC ID-token validation verifies signature and security claims", () => {
  const fixture = token();
  assert.deepEqual(verifyOidcIdToken({
    ...fixture,
    issuer: "https://id.example.test",
    clientId: "openbooks",
    nonce: "nonce-1",
    nowEpoch: 1_900_000_100,
  }), {
    issuer: "https://id.example.test",
    subject: "subject-1",
    email: "user@example.test",
    emailVerified: true,
  });
});

test("OIDC ID-token validation rejects unverified email, nonce and audience", () => {
  for (const fixture of [
    token({ email_verified: false }),
    token({ nonce: "wrong" }),
    token({ aud: "another-client" }),
  ]) {
    assert.equal(verifyOidcIdToken({
      ...fixture,
      issuer: "https://id.example.test",
      clientId: "openbooks",
      nonce: "nonce-1",
      nowEpoch: 1_900_000_100,
    }), null);
  }
});

test("OIDC ID-token validation rejects a modified signed payload", () => {
  const fixture = token();
  const segments = fixture.idToken.split(".");
  segments[1] = Buffer.from(JSON.stringify({ sub: "attacker" })).toString("base64url");
  assert.equal(verifyOidcIdToken({
    ...fixture,
    idToken: segments.join("."),
    issuer: "https://id.example.test",
    clientId: "openbooks",
    nonce: "nonce-1",
    nowEpoch: 1_900_000_100,
  }), null);
});

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

/** Drive one real authorization-code exchange against a loopback provider:
 *  discovery, begin (minting the signed flow cookie), then the token POST. */
async function exchange(issuerOrigin: string): Promise<void> {
  env.OPENBOOKS_OIDC_ISSUER = issuerOrigin;
  const begin = await beginOidcAuthorization(null);
  const authorizeUrl = new URL(begin.url);
  const state = authorizeUrl.searchParams.get("state");
  if (!state) throw new Error("authorize URL carried no state");
  await completeOidcAuthorization({ code: "auth-code", state, flowCookie: begin.flowCookie });
}

// Every 3xx with a Location must be refused, not followed: 307/308 preserve
// method AND body (the client secret in form or Basic header); the re-request
// after 301/302/303 leaks whichever credentials survive it. A redirected
// discovery document would also choose where the NEXT secret-bearing request
// goes and which signing keys are trusted.
const redirectStatuses = [301, 302, 303, 307, 308] as const;

test("OIDC token exchange refuses redirects without forwarding the client secret", async () => {
  let attackerRequests = 0;
  const attacker = createServer((_req, res) => {
    attackerRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const attackerOrigin = await listen(attacker);

  const originalFetch = globalThis.fetch;
  const tokenFetchModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (input, init) => {
    if (new URL(String(input)).pathname === "/token") tokenFetchModes.push(init?.redirect);
    return originalFetch(input, init);
  };

  try {
    for (const branch of ["client_secret_basic", "client_secret_post"] as const) {
      let issuerOrigin = "";
      let tokenRequests = 0;
      const modesBeforeBranch = tokenFetchModes.length;
      const provider = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/.well-known/openid-configuration") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            issuer: issuerOrigin,
            authorization_endpoint: `${issuerOrigin}/authorize`,
            token_endpoint: `${issuerOrigin}/token`,
            jwks_uri: `${issuerOrigin}/jwks`,
            ...(branch === "client_secret_post"
              ? { token_endpoint_auth_methods_supported: ["client_secret_post"] }
              : {}),
          }));
          return;
        }
        // Cycle the status so each exchange meets a different redirect class.
        tokenRequests += 1;
        res.writeHead(redirectStatuses[tokenRequests % redirectStatuses.length]!, {
          location: `${attackerOrigin}/credential-capture`,
        });
        res.end();
      });
      issuerOrigin = await listen(provider);
      try {
        for (let i = 0; i < redirectStatuses.length; i++) {
          await assert.rejects(exchange(issuerOrigin), /fetch failed|redirect/i);
        }
      } finally {
        await close(provider);
      }
      // Exactly one request per exchange reaches the allowlisted provider —
      // never a second, followed hop — with every fetch refusing redirects.
      assert.equal(tokenRequests, redirectStatuses.length, `${branch}: no followed hop`);
      assert.equal(tokenFetchModes.length - modesBeforeBranch, redirectStatuses.length, `${branch}: call count`);
      assert.ok(
        tokenFetchModes.slice(modesBeforeBranch).every((mode) => mode === "error"),
        `${branch}: redirects refused`,
      );
    }
    assert.equal(attackerRequests, 0, "credentials must never reach the redirect target");
  } finally {
    globalThis.fetch = originalFetch;
    await close(attacker);
  }
});

interface ProviderOptions {
  branch: "client_secret_basic" | "client_secret_post";
  /** Status the JWKS endpoint answers with; defaults to 200 + public keys. */
  jwksStatus?: number;
  /** Where a refused-status Location points; defaults back onto itself. */
  redirectTarget?: string;
}

/** Stand up a loopback OIDC provider and record what it receives. The test
 *  fills in a freshly minted ID token (whose nonce/issuer match the flow it
 *  began) before completing an exchange against the 200 token endpoint. */
async function startProvider(options: ProviderOptions) {
  interface TokenRequest {
    authorization: string;
    body: URLSearchParams;
  }
  let minted: ReturnType<typeof token> | null = null;
  let issuerOrigin = "";
  const tokenRequests: TokenRequest[] = [];
  const provider = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          issuer: issuerOrigin,
          authorization_endpoint: `${issuerOrigin}/authorize`,
          token_endpoint: `${issuerOrigin}/token`,
          jwks_uri: `${issuerOrigin}/jwks`,
          ...(options.branch === "client_secret_post"
            ? { token_endpoint_auth_methods_supported: ["client_secret_post"] }
            : {}),
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/token") {
        tokenRequests.push({ authorization: req.headers.authorization ?? "", body: new URLSearchParams(raw) });
        if (!minted) {
          res.writeHead(500).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "access-token", id_token: minted.idToken }));
        return;
      }
      if (req.method === "GET" && req.url === "/jwks") {
        if ((options.jwksStatus ?? 200) !== 200) {
          res.writeHead(options.jwksStatus!, { location: options.redirectTarget ?? `${issuerOrigin}/elsewhere` });
          res.end();
          return;
        }
        if (!minted) {
          res.writeHead(500).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: minted.keys }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  issuerOrigin = await listen(provider);
  return {
    issuer: issuerOrigin,
    tokenRequests,
    /** Mint the flow-matching ID token this provider will hand out. The fixed
     *  fixture claims carry dates near 2030, which real-clock validation would
     *  reject as not-yet-issued, so stamp them around now instead. */
    mint: (nonce: string) => {
      const nowEpoch = Math.floor(Date.now() / 1000);
      minted = token({
        iss: issuerOrigin,
        aud: env.OPENBOOKS_OIDC_CLIENT_ID,
        nonce,
        iat: nowEpoch,
        exp: nowEpoch + 3_600,
      });
    },
    close: () => close(provider),
  };
}

test("OIDC token exchange refuses redirected JWKS after the secret was sent", async () => {
  let attackerRequests = 0;
  const attacker = createServer((_req, res) => {
    attackerRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [] }));
  });
  const attackerOrigin = await listen(attacker);
  try {
    for (const status of redirectStatuses) {
      const provider = await startProvider({
        branch: "client_secret_basic",
        jwksStatus: status,
        redirectTarget: `${attackerOrigin}/attacker-keys`,
      });
      try {
        env.OPENBOOKS_OIDC_ISSUER = provider.issuer;
        const begin = await beginOidcAuthorization(null);
        provider.mint(new URL(begin.url).searchParams.get("nonce")!);
        const state = new URL(begin.url).searchParams.get("state")!;
        await assert.rejects(
          completeOidcAuthorization({ code: "auth-code", state, flowCookie: begin.flowCookie }),
          /fetch failed|redirect/i,
        );
      } finally {
        await provider.close();
      }    }
    assert.equal(attackerRequests, 0, "key trust must never follow a redirect");
  } finally {
    await close(attacker);
  }
});

test("normal OIDC responses pass: the client secret reaches only the token endpoint", async () => {
  for (const branch of ["client_secret_basic", "client_secret_post"] as const) {
    const provider = await startProvider({ branch });
    try {
      env.OPENBOOKS_OIDC_ISSUER = provider.issuer;
      const begin = await beginOidcAuthorization(null);
      const authorizeUrl = new URL(begin.url);
      const state = authorizeUrl.searchParams.get("state")!;
      provider.mint(authorizeUrl.searchParams.get("nonce")!);

      const result = await completeOidcAuthorization({ code: "auth-code", state, flowCookie: begin.flowCookie });
      assert.deepEqual(result.claims, {
        issuer: provider.issuer,
        subject: "subject-1",
        email: "user@example.test",
        emailVerified: true,
      });

      assert.equal(provider.tokenRequests.length, 1);
      const seen = provider.tokenRequests[0]!;
      const expectedBasic = `Basic ${Buffer.from(
        `${encodeURIComponent(env.OPENBOOKS_OIDC_CLIENT_ID!)}:${encodeURIComponent(env.OPENBOOKS_OIDC_CLIENT_SECRET!)}`,
      ).toString("base64")}`;
      if (branch === "client_secret_basic") {
        assert.equal(seen.authorization, expectedBasic);
        assert.equal(seen.body.get("client_secret"), null);
      } else {
        assert.equal(seen.authorization, "");
        assert.equal(seen.body.get("client_secret"), env.OPENBOOKS_OIDC_CLIENT_SECRET);
      }
      assert.equal(seen.body.get("grant_type"), "authorization_code");
      assert.equal(seen.body.get("client_id"), env.OPENBOOKS_OIDC_CLIENT_ID);
      assert.ok(seen.body.get("code_verifier"));
    } finally {
      await provider.close();
    }
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const post = (url: string, headers: Record<string, string>) =>
  new Request(url, { method: "POST", headers });

test("only state-changing methods count as unsafe", async () => {
  const { isUnsafeMethod } = await import("./csrf.ts");
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    assert.equal(isUnsafeMethod(method), true, method);
  }
  for (const method of ["GET", "HEAD", "OPTIONS", "", "PROPFIND"]) {
    assert.equal(isUnsafeMethod(method), false, method);
  }
});

test("token-authenticated surfaces are CSRF-exempt", async () => {
  const { isCsrfExemptPath } = await import("./proxy-policy.ts");
  for (const path of [
    "/mcp",
    "/api/auth/oidc/callback",
    "/api/v1/records",
    "/api/v1/records/contacts/123",
    "/pay/tok_v1abc",
    "/api/pay/tok_v1abc",
    "/api/payments/webhooks/stripe",
    "/api/internal/scheduler/tick",
  ]) {
    assert.equal(isCsrfExemptPath(path), true, path);
  }
});

test("cookie-session and public browser forms are NOT exempt", async () => {
  const { isCsrfExemptPath } = await import("./proxy-policy.ts");
  for (const path of [
    "/",
    "/login",
    "/dashboard",
    "/api/login",
    "/api/password-reset",
    "/api/accounts",
    "/api/accounts/123",
    "/api/v1/health",
    "/api/flows/email-action",
    "/mcp-evil-lookalike",
  ]) {
    assert.equal(isCsrfExemptPath(path), false, path);
  }
});

test("same-origin mutations pass the origin check", async () => {
  const { hasTrustedOrigin } = await import("./csrf.ts");
  assert.equal(
    hasTrustedOrigin(post("https://books.example/api/accounts", {
      origin: "https://books.example",
    })),
    true,
  );
  // Scheme-insensitive: TLS terminates at the edge, internal hop is http.
  assert.equal(
    hasTrustedOrigin(post("http://books.example/api/accounts", {
      origin: "https://books.example",
    })),
    true,
  );
});

test("the operator-declared canonical URL wins over forwarded hosts", async () => {
  const { hasTrustedOrigin } = await import("./csrf.ts");
  const environment = { OPENBOOKS_APP_URL: "https://erp.rassaun.com" };
  assert.equal(
    hasTrustedOrigin(
      post("https://internal-hop.local/api/accounts", {
        origin: "https://erp.rassaun.com",
        "x-forwarded-host": "evil.example",
      }),
      environment,
    ),
    true,
  );
  assert.equal(
    hasTrustedOrigin(
      post("https://erp.rassaun.com/api/accounts", {
        origin: "https://erp.rassaun.com.evil.example",
      }),
      environment,
    ),
    false,
  );
});

test("a misconfigured canonical URL fails closed instead of widening policy", async () => {
  const { hasTrustedOrigin } = await import("./csrf.ts");
  assert.throws(
    () => hasTrustedOrigin(post("https://books.example/api/x", {}), {
      OPENBOOKS_APP_URL: "not a url",
    }),
    /OPENBOOKS_APP_URL/,
  );
});

test("the outermost x-forwarded-host anchors the check behind proxies", async () => {
  const { hasTrustedOrigin } = await import("./csrf.ts");
  const req = post("http://web:4780/api/accounts", {
    origin: "https://books.example",
    "x-forwarded-host": "books.example, web:4780",
  });
  assert.equal(hasTrustedOrigin(req, {}), true);
});

test("cross-site origins are rejected, including suffix spoofs", async () => {
  const { hasTrustedOrigin } = await import("./csrf.ts");
  const attacker = (origin: string) =>
    hasTrustedOrigin(post("https://books.example/api/accounts", { origin }), {});
  assert.equal(attacker("https://evil.example"), false);
  assert.equal(attacker("https://books.example.evil.example"), false);
  assert.equal(attacker("https://books.example:8443"), false);
  assert.equal(attacker("null"), false);
  assert.equal(attacker("::::"), false);
});

test("referer anchors the decision when Origin is absent", async () => {
  const { hasTrustedOrigin } = await import("./csrf.ts");
  assert.equal(
    hasTrustedOrigin(post("https://books.example/api/accounts", {
      referer: "https://books.example/dashboard",
    }), {}),
    true,
  );
  // A form can suppress Referer but never Origin; a mismatched Referer with
  // no Origin is an attack signal, not a legacy client.
  assert.equal(
    hasTrustedOrigin(post("https://books.example/api/accounts", {
      referer: "https://evil.example/trap",
    }), {}),
    false,
  );
  assert.equal(
    hasTrustedOrigin(post("https://books.example/api/accounts", {
      referer: "not a url",
    }), {}),
    false,
  );
});

test("requests without any browser-origin evidence pass as non-browser clients", async () => {
  const { hasTrustedOrigin } = await import("./csrf.ts");
  assert.equal(hasTrustedOrigin(post("https://books.example/api/login", {})), true);
  // Safe methods are never judged.
  assert.equal(
    hasTrustedOrigin(new Request("https://books.example/", { headers: { origin: "https://evil.example" } }), {}),
    true,
  );
});

test("safe methods skip host resolution entirely", async () => {
  const { hasTrustedOrigin } = await import("./csrf.ts");
  assert.equal(
    hasTrustedOrigin({ method: "GET", headers: new Headers(), url: "not a url" }, {}),
    true,
  );
});

test("the proxy gates unsafe methods before any route short-circuit", async () => {
  const source = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(source, /isUnsafeMethod\(req\.method\)/);
  assert.match(source, /isCsrfExemptPath\(pathname\)/);
  assert.match(source, /!hasTrustedOrigin\(req\)/);
  const gateIndex = source.indexOf("isUnsafeMethod(req.method)");
  const publicIndex = source.indexOf("if (isPublicPath(pathname))");
  assert.ok(gateIndex >= 0 && publicIndex > gateIndex);
});

test("the CSRF module stays Edge-runtime safe", () => {
  for (const file of ["csrf.ts", "proxy-policy.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "node:/, file);
    assert.doesNotMatch(source, /require\(/, file);
  }
});

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { isPublicPath } from "./proxy-policy";

// The public surface of the proxy policy is derived from the registry file
// itself (enumeration only — every assertion below is on a live proxy or
// route response, never on the file text), so a newly listed surface is
// exercised the moment it ships. Reformatting the registry without changing
// its entries keeps every test green.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      const path = `../${specifier.slice(2)}`;
      return {
        shortCircuit: true,
        url: new URL(path.endsWith(".ts") ? path : `${path}.ts`, import.meta.url).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { proxy } = await import("../proxy.ts");
const { mintSigningToken, verifySigningToken } = await import("./field-ticket-token.ts");
const { POST: signPost } = await import("../app/api/sign/field-tickets/route.ts");

const policy = readFileSync(new URL("./proxy-policy.ts", import.meta.url), "utf8");
const listedPaths = (listName: string): string[] => {
  const block = new RegExp(`const ${listName}[^\\[]*\\[([\\s\\S]*?)\\]`).exec(policy)?.[1] ?? "";
  return [...block.matchAll(/"(\/[^"]*)"/g)].map((entry) => entry[1]!);
};

function get(path: string): Promise<NextResponse> {
  return proxy(new NextRequest(`http://openbooks.test${path}`));
}

test("every listed public surface passes the proxy without a session", async () => {
  const exact = listedPaths("EXACT_PUBLIC_PATHS");
  const roots = listedPaths("PUBLIC_SEGMENT_ROOTS");
  assert.ok(exact.length > 5, "the registry enumeration found the exact paths");
  assert.ok(roots.length > 5, "the registry enumeration found the segment roots");
  const probes = [...exact, ...roots.flatMap((root) => [root, `${root}/probe-child`])];
  for (const path of probes) {
    const response = await get(path);
    const location = response.headers.get("location") ?? "";
    assert.ok(
      response.status !== 307 && !location.includes("/login"),
      `${path} must not redirect a sessionless caller to login`,
    );
  }
  // Controls: the harness really gates. A private API path refuses 401 JSON
  // and a private page redirects to login when no session rides along.
  const apiControl = await get("/api/gl/accounts");
  assert.equal(apiControl.status, 401);
  const pageControl = await get("/journal");
  assert.equal(pageControl.status, 307);
  assert.ok((pageControl.headers.get("location") ?? "").includes("/login?next="));
});

test("field-ticket signing tokens verify possession before any request lookup", () => {
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  try {
    const token = mintSigningToken(randomUUID(), randomUUID(), randomUUID(), new Date(Date.now() + 600_000));
    const claims = verifySigningToken(token);
    assert.ok(claims, "a freshly minted token verifies");
    assert.equal(typeof claims!.orgId, "string");

    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    assert.equal(verifySigningToken(tampered), null, "a tampered signature verifies to nothing");

    const expired = mintSigningToken(randomUUID(), randomUUID(), randomUUID(), new Date(Date.now() - 1000));
    assert.equal(verifySigningToken(expired), null, "an expired token verifies to nothing");

    assert.equal(verifySigningToken("not-a-token"), null);
  } finally {
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
  }
});

test("the customer-sign API refuses a tampered token with 401 before any lookup", async () => {
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  try {
    const token = mintSigningToken(randomUUID(), randomUUID(), randomUUID(), new Date(Date.now() + 600_000));
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const response = (await signPost(
      new Request("http://openbooks.test/api/sign/field-tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: tampered, signature: "data:image/png;base64,AAAA", name: "Mallory" }),
      }),
    )) as Response;
    assert.equal(response.status, 401);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "This signing link is invalid or expired",
    );
    assert.ok(isPublicPath("/api/sign/field-tickets"), "the sign API stays publicly reachable");
  } finally {
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
  }
});

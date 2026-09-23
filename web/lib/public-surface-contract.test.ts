import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isCsrfExemptPath, isPublicPath } from "./proxy-policy";

/**
 * Public-surface contract: the edge session gate (web/proxy.ts) lets a
 * request through without an `ob_session` cookie ONLY when isPublicPath()
 * says so, so every path the policy calls public must authenticate inside
 * its own route — and every route that authenticates itself must actually
 * be reachable. Both directions are DERIVED by walking the filesystem, so
 * a new route file can neither silently become public nor silently 401:
 *
 * - every route.ts under web/app/api/v1 must be public AND carry an
 *   in-route API-key check (withV1Request / resolveApiKeyAuth / guardApiKey
 *   or the v1-orders/v1-records helpers built on withV1Request), and must
 *   never read the session cookie;
 * - the sessionless HR/time routes (document signing, survey responses,
 *   kiosk devices) and their pages must be public AND verify their path
 *   token in-route, with CSRF exemption only for the token-authenticated
 *   API routes;
 * - conversely, walking each public root's directory must find no route
 *   file WITHOUT its surface's auth marker — a future session-only route
 *   landing under a public root fails here, not in production.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const webApp = join(repoRoot, "web", "app");

function walkFiles(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(child, name));
    else if (entry.name === name) out.push(child);
  }
  return out;
}

/** web/app/api/v1/vendors/route.ts -> /api/v1/vendors ; [id] -> x. */
function routeSamplePath(file: string): string {
  const rel = file.slice(webApp.length).replaceAll("\\", "/");
  return rel
    .replace(/\/route\.ts$/, "")
    .replace(/\[\.\.\.[^\]]+\]/g, "x")
    .replace(/\[[^\]]+\]/g, "x") || "/";
}

/** web/app/survey/[token]/page.tsx -> /survey/x. */
function pageSamplePath(file: string): string {
  const rel = file.slice(webApp.length).replaceAll("\\", "/");
  const withoutSuffix = rel.replace(/\/page\.tsx$/, "");
  const withoutGroup = withoutSuffix
    .split("/")
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .join("/");
  return withoutGroup.replace(/\[[^\]]+\]/g, "x") || "/";
}

/** In-route API-key auth for the versioned API (all fail closed 401). */
const V1_AUTH = /withV1Request|resolveApiKeyAuth|guardApiKey|v1-orders|v1-records/;
/** The one documented-unauthenticated v1 route (process liveness). */
const V1_HEALTH = /web\/app\/api\/v1\/health\/route\.ts$/;
/** Session-cookie reads that must never appear in a public v1 route. */
const SESSION_READ = /ob_session|currentUser|getAuthz|getSession\(|authRequestContext/;

test("every /api/v1 route is reachable by the edge session gate", () => {
  const files = walkFiles(join(webApp, "api", "v1"), "route.ts");
  assert.ok(files.length > 50, `expected the v1 surface, found ${files.length} route files`);
  for (const file of files) {
    const urlPath = routeSamplePath(file);
    assert.equal(isPublicPath(urlPath), true, `${urlPath} must be public (see ${file})`);
  }
});

test("every /api/v1 route authenticates in-route and never reads the session cookie", () => {
  const files = walkFiles(join(webApp, "api", "v1"), "route.ts");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const rel = file.slice(webApp.length + 1);
    if (V1_HEALTH.test(file)) {
      assert.match(source, /Unauthenticated health/, `${rel} is the documented-unauthenticated exception`);
      assert.doesNotMatch(source, SESSION_READ, `${rel} must not read the session cookie`);
      continue;
    }
    assert.match(source, V1_AUTH, `${rel} must authenticate with an API key in-route`);
    assert.doesNotMatch(source, SESSION_READ, `${rel} must not read the session cookie`);
  }
  // The shared gates behind those markers fail closed without a key.
  const v1Request = readFileSync(join(repoRoot, "web", "lib", "api", "v1-request.ts"), "utf8");
  assert.match(v1Request, /invalid or missing API key/);
  assert.match(v1Request, /status: 401/);
  const apiAuth = readFileSync(join(repoRoot, "web", "lib", "api-auth.ts"), "utf8");
  assert.match(apiAuth, /invalid or missing API key/);
  // The helpers the routes import are the same gate, not a second one.
  for (const helper of ["v1-orders.ts", "v1-records.ts"]) {
    const source = readFileSync(join(repoRoot, "web", "lib", "api", helper), "utf8");
    assert.match(source, /withV1Request/, `${helper} must funnel through withV1Request`);
  }
});

type TokenSurface = {
  dir: string;
  kind: "api" | "page";
  /** Token verification that must appear in the route/page (or its engine service). */
  tokenMarker: RegExp;
  /** Refusal the surface must render/return for a bad token. */
  refusalMarker: RegExp;
};

const TOKEN_SURFACES: TokenSurface[] = [
  {
    dir: join(webApp, "api", "documents", "sign"),
    kind: "api",
    tokenMarker: /readTokenDocument|signTokenDocument|declineTokenDocument|acknowledgeDocument/,
    refusalMarker: /hrmDocumentsErrorResponse/,
  },
  {
    dir: join(webApp, "api", "surveys", "respond"),
    kind: "api",
    tokenMarker: /verifySurveyInvitationToken/,
    refusalMarker: /invalid or expired|no longer available/,
  },
  {
    dir: join(webApp, "api", "time", "kiosk"),
    kind: "api",
    tokenMarker: /resolveKioskByToken/,
    refusalMarker: /\bbad\(error\.message, 404\)/,
  },
  {
    dir: join(webApp, "sign", "[token]"),
    kind: "page",
    tokenMarker: /verifyDocumentSignerToken/,
    refusalMarker: /notFound\(\)/,
  },
  {
    dir: join(webApp, "survey"),
    kind: "page",
    tokenMarker: /verifySurveyInvitationToken/,
    refusalMarker: /notFound\(\)/,
  },
  {
    dir: join(webApp, "kiosk"),
    kind: "page",
    tokenMarker: /resolveKioskByToken/,
    refusalMarker: /notFound\(\)/,
  },
];

test("sessionless HR/time surfaces are public, token-authenticated in-route, and CSRF-exempt only as APIs", () => {
  for (const surface of TOKEN_SURFACES) {
    const files = surface.kind === "api"
      ? walkFiles(surface.dir, "route.ts")
      : walkFiles(surface.dir, "page.tsx");
    assert.ok(files.length > 0, `expected route files under ${surface.dir}`);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const rel = file.slice(webApp.length + 1);
      const urlPath = surface.kind === "api" ? routeSamplePath(file) : pageSamplePath(file);
      assert.equal(isPublicPath(urlPath), true, `${urlPath} must be public (${rel})`);
      assert.match(source, surface.tokenMarker, `${rel} must verify its path token in-route`);
      assert.match(source, surface.refusalMarker, `${rel} must refuse bad tokens, not render them`);
      assert.doesNotMatch(source, SESSION_READ, `${rel} must not read the session cookie`);
      if (surface.kind === "api") {
        // POST/PUT here carry the path token (an explicit credential browsers
        // never attach cross-site), never the ambient cookie — origin-checking
        // them would 403 every signer, respondent, and device.
        assert.equal(isCsrfExemptPath(urlPath), true, `${urlPath} must be CSRF-exempt (${rel})`);
      }
    }
  }
  // The document-signing engine service behind the route verifies the HMAC
  // token itself — the route marker above is not a pass-through claim.
  const documents = readFileSync(
    join(repoRoot, "engine", "src", "hrm", "documents", "documents.ts"),
    "utf8",
  );
  assert.match(documents, /verifyDocumentSignerToken\(token\)/);
});

test("no public API root covers a route without its surface's auth marker", () => {
  const v1Files = walkFiles(join(webApp, "api", "v1"), "route.ts");
  for (const file of v1Files) {
    if (V1_HEALTH.test(file)) continue;
    assert.match(readFileSync(file, "utf8"), V1_AUTH, `${file} sits under public /api/v1 without API-key auth`);
  }
  for (const surface of TOKEN_SURFACES.filter((surface) => surface.kind === "api")) {
    for (const file of walkFiles(surface.dir, "route.ts")) {
      assert.match(readFileSync(file, "utf8"), surface.tokenMarker, `${file} sits on a public token root without its token check`);
    }
  }
});

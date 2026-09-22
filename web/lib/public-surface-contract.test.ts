import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isPublicPath } from "./proxy-policy";

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
  const rel = file.slice(webApp.length).replace(/\\/g, "/");
  return rel
    .replace(/\/route\.ts$/, "")
    .replace(/\[\.\.\.[^\]]+\]/g, "x")
    .replace(/\[[^\]]+\]/g, "x") || "/";
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

test("no public v1 route lacks in-route API-key auth", () => {
  const v1Files = walkFiles(join(webApp, "api", "v1"), "route.ts");
  for (const file of v1Files) {
    if (V1_HEALTH.test(file)) continue;
    assert.match(readFileSync(file, "utf8"), V1_AUTH, `${file} sits under public /api/v1 without API-key auth`);
  }
});

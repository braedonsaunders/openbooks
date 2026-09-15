import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = pathToFileURL(process.cwd() + "/").href;

/**
 * Saved-reports boundary: a malformed body id (DELETE) or a non-string path
 * (POST) must be a clean 4xx, never a Postgres uuid cast error or a
 * TypeError surfacing as a 500.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/api/json") {
      return next(root + "web/lib/api/json.ts", context);
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/saved-reports/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardPermission(){
              return {
                user: { orgId: 'org-1', id: 'user-1' },
                permissions: new Set(['*']),
              };
            }
          `),
      };
    }
    return next(specifier, context);
  },
});
const { POST, DELETE } = await import("./route.ts");

const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/saved-reports", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("DELETE answers a malformed id with 4xx, never a 500", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const response = await DELETE(json("DELETE", { id: "not-a-uuid" }));
  assert.ok(
    response.status === 400 || response.status === 403,
    `expected 4xx, got ${response.status}`,
  );
});

test("POST answers a non-string path with 400, never a 500", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const response = await POST(json("POST", { name: "Board pack", path: 42 }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "name and a /reports path required" });
});

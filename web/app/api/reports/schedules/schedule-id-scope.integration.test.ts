import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Schedule routes: a malformed schedule id must be a clean 404 (never a
 * Postgres uuid cast error surfacing as a 500) on autosave and delete — the
 * same boundary the definition, run-download, view, and journal routes keep.
 */
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/api/json") {
      return next(root + "web/lib/api/json.ts", context);
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/reports/schedules/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardPermission(){
              return {
                user: { orgId: 'org-1', id: 'user-1' },
                permissions: new Set(['reports.schedule']),
              };
            }
          `),
      };
    }
    return next(specifier, context);
  },
});
const { PATCH, DELETE } = await import("./[id]/route.ts");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/reports/schedules", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("schedule autosave and delete answer a malformed id with 404", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  for (const id of ["not-a-uuid", "new"]) {
    // NOTE: no fixture row is needed — the uuid cast fails before any row
    // could resolve, which is exactly the defect.
    const patched = await PATCH(json("PATCH", { active: false }), params(id));
    assert.equal(patched.status, 404, `PATCH ${id}`);
    assert.deepEqual(await patched.json(), { error: "not found" });

    const deleted = await DELETE(json("DELETE", {}), params(id));
    assert.equal(deleted.status, 404, `DELETE ${id}`);
    assert.deepEqual(await deleted.json(), { error: "not found" });
  }
});

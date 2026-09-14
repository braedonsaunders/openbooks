import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * View routes: a malformed view id must be a clean 404 (never a Postgres uuid
 * cast error surfacing as a 500) on every verb — the same boundary the
 * dunning, journal, project, and record-type routes keep.
 */
import { pathToFileURL } from "node:url";

const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/api/json") {
      return next(root + "web/lib/api/json.ts", context);
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/views/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardPermission(){
              return {
                user: { orgId: 'org-1', id: 'user-1' },
                permissions: new Set(['reports.read', 'reports.create']),
              };
            }
          `),
      };
    }
    return next(specifier, context);
  },
});
const { GET, PATCH, DELETE } = await import("./[id]/route.ts");
const { POST: run } = await import("./[id]/run/route.ts");
const { GET: exportView } = await import("./[id]/export/route.ts");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/views", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("every view verb answers a malformed id with 404", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  for (const id of ["not-a-uuid", "new"]) {
    const got = await GET(json("GET"), params(id));
    assert.equal(got.status, 404, `GET ${id}`);
    assert.deepEqual(await got.json(), { error: "not found" });

    const patched = await PATCH(json("PATCH", { name: "Renamed" }), params(id));
    assert.equal(patched.status, 404, `PATCH ${id}`);
    assert.deepEqual(await patched.json(), { error: "not found" });

    const deleted = await DELETE(json("DELETE"), params(id));
    assert.equal(deleted.status, 404, `DELETE ${id}`);
    assert.deepEqual(await deleted.json(), { error: "not found" });

    const ran = await run(json("POST"), params(id));
    assert.equal(ran.status, 404, `run ${id}`);
    assert.deepEqual(await ran.json(), { error: "not found" });

    const exported = await exportView(
      new Request(`http://audit.local/api/views/${id}/export?format=csv`),
      params(id),
    );
    assert.equal(exported.status, 404, `export ${id}`);
    assert.deepEqual(await exported.json(), { error: "not found" });
  }
});

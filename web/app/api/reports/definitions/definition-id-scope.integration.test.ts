import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Report-definition routes: a malformed definition id must be a clean 404
 * (never a Postgres uuid cast error surfacing as a 500) on read, autosave,
 * delete, and export — the same boundary the dunning, journal, project, and
 * view routes keep.
 */
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/api/json") {
      return next(root + "web/lib/api/json.ts", context);
    }
    if (specifier === "@/lib/custom-record-report-catalog") {
      return next(root + "web/lib/custom-record-report-catalog.ts", context);
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/reports/")) {
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
const { GET: exportDefinition } = await import("./[id]/export/route.ts");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/reports/definitions", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("definition read, autosave, delete, and export answer a malformed id with 404", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  for (const id of ["not-a-uuid", "new"]) {
    const got = await GET(json("GET"), params(id));
    assert.equal(got.status, 404, `GET ${id}`);
    assert.deepEqual(await got.json(), { error: "not found" });

    const patched = await PATCH(
      json("PATCH", { name: "Renamed", expectedUpdatedAt: "2026-01-01T00:00:00.000000Z" }),
      params(id),
    );
    assert.equal(patched.status, 404, `PATCH ${id}`);
    assert.deepEqual(await patched.json(), { error: "not found" });

    const deleted = await DELETE(json("DELETE"), params(id));
    assert.equal(deleted.status, 404, `DELETE ${id}`);
    assert.deepEqual(await deleted.json(), { error: "not found" });

    const exported = await exportDefinition(
      new Request(`http://audit.local/api/reports/definitions/${id}/export?format=csv`),
      params(id),
    );
    assert.equal(exported.status, 404, `export ${id}`);
    const exportedBody = (await exported.json()) as { error: string };
    assert.equal(exportedBody.error, "report not found", `export ${id} keeps its not-found shape`);
  }
});

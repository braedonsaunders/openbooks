import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * Recorded-run reads: a malformed run id must be a clean 404 (never a
 * Postgres uuid cast error surfacing as a 500) on both the CSV download and
 * the rendered-artifact routes — the same boundary the definition, view, and
 * journal routes keep.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/reports/runs/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardPermission(){
              return {
                user: { orgId: 'org-1', id: 'user-1' },
                permissions: new Set(['reports.read']),
              };
            }
          `),
      };
    }
    return next(specifier, context);
  },
});
const { GET: csv } = await import("./[id]/csv/route.ts");
const { GET: artifact } = await import("./[id]/artifact/route.ts");

const params = (id: string) => ({ params: Promise.resolve({ id }) });

test("run CSV and artifact downloads answer a malformed id with 404", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  for (const id of ["not-a-uuid", "new"]) {
    // NOTE: no fixture row is needed — the uuid cast fails before any row
    // could resolve, which is exactly the defect.
    const download = await csv(
      new Request("http://audit.local/api/reports/runs/x/csv"),
      params(id),
    );
    assert.equal(download.status, 404, `csv ${id}`);
    assert.deepEqual(await download.json(), { error: "not found" });

    const rendered = await artifact(
      new Request("http://audit.local/api/reports/runs/x/artifact"),
      params(id),
    );
    assert.equal(rendered.status, 404, `artifact ${id}`);
    assert.deepEqual(await rendered.json(), { error: "not found" });
  }
});

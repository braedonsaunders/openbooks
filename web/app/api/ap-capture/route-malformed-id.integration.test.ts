import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Every ap-capture item route interpolates the path id straight into a uuid
 * column. A malformed id must be the same clean 404 as an unknown one — never
 * a PostgreSQL 22P02 cast error escaping as a 500.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: randomUUID(), id: randomUUID() } };
Object.assign(globalThis, { __apCaptureRouteUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/ap-capture/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__apCaptureRouteUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}};export function can(){return true};export function guardSubsidiaryScope(){return null}",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { GET: getDetail, PATCH: patchDetail } = await import("./[id]/route");
const { POST: materialize } = await import("./[id]/materialize/route");
const { GET: getFile } = await import("./[id]/file/route");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patchBody = () =>
  new Request("http://audit.local/api/ap-capture/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ normalized: { lines: [] } }),
  });

test("ap-capture item routes return 404 for a malformed capture id", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  for (const id of ["not-a-uuid", "new", "00000000-0000-0000-0000-00000000000"]) {
    const detail = await getDetail(new Request("http://audit.local/x"), params(id));
    assert.equal(detail.status, 404, `GET detail ${id}`);
    const patched = await patchDetail(patchBody(), params(id));
    assert.equal(patched.status, 404, `PATCH detail ${id}`);
    const materialized = await materialize(new Request("http://audit.local/x", { method: "POST" }), params(id));
    assert.equal(materialized.status, 404, `POST materialize ${id}`);
    const file = await getFile(new Request("http://audit.local/x"), params(id));
    assert.equal(file.status, 404, `GET file ${id}`);
  }
  // A well-formed id that names nothing keeps each route's established
  // shape (materialize maps the engine's missing-item error to 422 today).
  const missing = randomUUID();
  assert.equal((await getDetail(new Request("http://audit.local/x"), params(missing))).status, 404);
  assert.equal((await materialize(new Request("http://audit.local/x", { method: "POST" }), params(missing))).status, 422);
  assert.equal((await getFile(new Request("http://audit.local/x"), params(missing))).status, 404);
});

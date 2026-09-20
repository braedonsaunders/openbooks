import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Account-group routes bind path and body ids straight into uuid columns. A
 * malformed id must be the same clean client error as an unknown one — never
 * a PostgreSQL uuid cast error escaping as a 500.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __accountGroupRouteUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/account-groups/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__accountGroupRouteUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}}",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { PATCH: patchGroup } = await import("./[id]/route");
const { POST: pin, DELETE: unpin } = await import("./[id]/pins/route");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patchJson = (body: unknown) =>
  new Request("http://audit.local/api/account-groups/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const pinJson = (body: unknown) =>
  new Request("http://audit.local/api/account-groups/x/pins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const unpinUrl = (accountId: string) => new Request(`http://audit.local/api/account-groups/x/pins?accountId=${accountId}`, { method: "DELETE" });

test("account-group routes reject malformed ids as client errors", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    const groupId = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into account_groups (id, org_id, dimension, key, name)
      values (${groupId}, ${org.orgId}, 'test-dimension', 'test-group', 'Test group')`));

    for (const id of ["not-a-uuid", "new"]) {
      assert.equal((await patchGroup(patchJson({ name: "Renamed" }), params(id))).status, 404, `PATCH group ${id}`);
      assert.equal((await pin(pinJson({ accountId: org.accounts.bank }), params(id))).status, 404, `POST pin ${id}`);
      assert.equal((await unpin(unpinUrl(org.accounts.bank), params(id))).status, 404, `DELETE pin ${id}`);
    }
    // Malformed account references are the same 400 the missing ones get.
    assert.equal((await pin(pinJson({ accountId: "not-a-uuid" }), params(groupId))).status, 400);
    assert.equal((await unpin(unpinUrl("not-a-uuid"), params(groupId))).status, 400);

    // Controls: well-formed-but-missing ids keep the not-found shape, and
    // valid requests still work.
    const missing = randomUUID();
    assert.equal((await patchGroup(patchJson({ name: "Renamed" }), params(missing))).status, 404);
    assert.equal((await pin(pinJson({ accountId: org.accounts.bank }), params(missing))).status, 404);
    const renamed = await patchGroup(patchJson({ name: "Renamed" }), params(groupId));
    assert.equal(renamed.status, 200, JSON.stringify(await renamed.clone().json()));
    const pinned = await pin(pinJson({ accountId: org.accounts.bank }), params(groupId));
    assert.equal(pinned.status, 200, JSON.stringify(await pinned.clone().json()));
    const unpinned = await unpin(unpinUrl(org.accounts.bank), params(groupId));
    assert.equal(unpinned.status, 200, JSON.stringify(await unpinned.clone().json()));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

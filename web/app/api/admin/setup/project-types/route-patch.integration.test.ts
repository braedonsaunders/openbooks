import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Project-type PATCH must not clobber fields the caller did not send. The
 * collection POST requires a non-empty name, but PATCH unconditionally wrote
 * name/description/is-active/sort-order from body-or-default — so a PATCH
 * that only changed the billing classification blanked the name, wiped the
 * description, reset the sort order to 50, and silently reactivated an
 * archived type.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __projectTypePatchUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/admin/setup/project-types/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__projectTypePatchUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}}",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { PATCH } = await import("./route");

const patchJson = (body: unknown) =>
  new Request("http://audit.local/api/admin/setup/project-types", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const STANDARD_PROFILE = {
  billingProcedure: "standard",
  allowedBases: ["time_selection"],
  defaultBasis: "time_selection",
};

async function typeRow(orgId: string, id: string) {
  const r = await withBypassContext(() =>
    db.execute<{ name: string; description: string | null; is_active: boolean; sort_order: number }>(
      sql`select name, description, is_active, sort_order from project_types where id = ${id} and org_id = ${orgId}`,
    ),
  );
  return r.rows[0]!;
}

test("project-type PATCH leaves unsent fields alone and rejects a blank name", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    await withBypassContext(() =>
      db.execute(sql`update orgs set settings = settings || '{"features": {"projects": true}}'::jsonb where id = ${org.orgId}`),
    );
    const id = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into project_types
      (id, org_id, key, name, description, is_active, sort_order, billing_method, invoicing_profile, backup_profile)
      values (${id}, ${org.orgId}, 'tm', 'Time and materials', 'Hourly work', false, 7,
        'time_and_materials', ${JSON.stringify(STANDARD_PROFILE)}::jsonb, '{}'::jsonb)`));

    // A PATCH that only touches the billing classification must not rewrite
    // the name, description, active flag, or sort order.
    const touched = await PATCH(patchJson({ id, billingMethod: "cost_plus" }));
    assert.equal(touched.status, 200, JSON.stringify(await touched.clone().json()));
    assert.deepEqual(await typeRow(org.orgId, id), {
      name: "Time and materials",
      description: "Hourly work",
      is_active: false,
      sort_order: 7,
    });

    // A blank name is refused, like the collection POST requires.
    const blanked = await PATCH(patchJson({ id, billingMethod: "cost_plus", name: "  " }));
    assert.equal(blanked.status, 422, JSON.stringify(await blanked.clone().json()));
    assert.equal((await typeRow(org.orgId, id)).name, "Time and materials");

    // Controls: sent fields still write.
    const renamed = await PATCH(patchJson({ id, billingMethod: "cost_plus", name: "T&M", sortOrder: 3, isActive: true }));
    assert.equal(renamed.status, 200, JSON.stringify(await renamed.clone().json()));
    assert.deepEqual(await typeRow(org.orgId, id), {
      name: "T&M",
      description: "Hourly work",
      is_active: true,
      sort_order: 3,
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

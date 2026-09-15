import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Project-type writes must validate their scalar flags. PATCH coerced
 * isActive with `!== false`, so a mistyped isActive: "false" (or 0)
 * ACTIVATED an archived type with a 200 instead of failing closed; and
 * neither POST nor PATCH validated sortOrder, so a non-numeric value rode
 * Number() into the integer column and surfaced as a storage error instead
 * of a field error. Same boolean-flag class the fleet closed on
 * form-layouts/pdf-templates/list-views/projects PATCH.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __projectTypeFlagsUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/admin/setup/project-types/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__projectTypeFlagsUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}}",
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

async function typeRow(orgId: string, id: string) {
  const r = await withBypassContext(() =>
    db.execute<{ name: string; is_active: boolean; sort_order: number }>(
      sql`select name, is_active, sort_order from project_types where id = ${id} and org_id = ${orgId}`,
    ),
  );
  return r.rows[0]!;
}

test("project-type PATCH refuses non-boolean isActive without writing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    await withBypassContext(() =>
      db.execute(sql`update orgs set settings = settings || '{"features": {"projects": true}}'::jsonb where id = ${org.orgId}`),
    );
    const id = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into project_types
      (id, org_id, key, name, description, is_active, sort_order, billing_method, invoicing_profile, backup_profile)
      values (${id}, ${org.orgId}, 'tm-flags', 'Flags probe', null, false, 7,
        'time_and_materials', '{"billingProcedure":"standard","allowedBases":["time_selection"],"defaultBasis":"time_selection"}'::jsonb, '{}'::jsonb)`));

    // The string "false" must not activate an archived type with a 200.
    const str = await PATCH(patchJson({ id, billingMethod: "time_and_materials", isActive: "false" }));
    assert.equal(str.status, 400, JSON.stringify(await str.clone().json()));
    assert.equal((await typeRow(org.orgId, id)).is_active, false);

    // The number 0 must not activate it either.
    const zero = await PATCH(patchJson({ id, billingMethod: "time_and_materials", isActive: 0 }));
    assert.equal(zero.status, 400, JSON.stringify(await zero.clone().json()));
    assert.equal((await typeRow(org.orgId, id)).is_active, false);

    // Control: a real boolean still writes.
    const ok = await PATCH(patchJson({ id, billingMethod: "time_and_materials", isActive: true }));
    assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
    assert.equal((await typeRow(org.orgId, id)).is_active, true);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("project-type PATCH refuses a non-numeric sortOrder with a field error", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    await withBypassContext(() =>
      db.execute(sql`update orgs set settings = settings || '{"features": {"projects": true}}'::jsonb where id = ${org.orgId}`),
    );
    const id = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into project_types
      (id, org_id, key, name, description, is_active, sort_order, billing_method, invoicing_profile, backup_profile)
      values (${id}, ${org.orgId}, 'tm-sort', 'Sort probe', null, true, 7,
        'time_and_materials', '{"billingProcedure":"standard","allowedBases":["time_selection"],"defaultBasis":"time_selection"}'::jsonb, '{}'::jsonb)`));

    const bad = await PATCH(patchJson({ id, billingMethod: "time_and_materials", sortOrder: "abc" }));
    assert.equal(bad.status, 400, JSON.stringify(await bad.clone().json()));
    assert.match(JSON.stringify(await bad.clone().json()), /sortOrder/i);
    assert.equal((await typeRow(org.orgId, id)).sort_order, 7);

    const frac = await PATCH(patchJson({ id, billingMethod: "time_and_materials", sortOrder: 1.5 }));
    assert.equal(frac.status, 400, JSON.stringify(await frac.clone().json()));
    assert.equal((await typeRow(org.orgId, id)).sort_order, 7);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

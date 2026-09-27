import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";

const state: { authz: unknown } = { authz: null };
Object.assign(globalThis, { __demandRouteState: state, __demandNextResponse: NextResponse });
const realAuthz = new URL("../../../lib/authz.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== "@/lib/authz" && !(specifier === "./authz" && context.parentURL?.includes("/web/lib/feature-gates"))) return next(specifier, context);
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(`
        import { can } from '${realAuthz}';
        export * from '${realAuthz}';
        export async function getAuthz() { return globalThis.__demandRouteState.authz }
        export async function guardPermission(permission) {
          const authz = globalThis.__demandRouteState.authz;
          if (!authz) return globalThis.__demandNextResponse.json({ error: 'unauthorized' }, { status: 401 });
          if (!can(authz, permission)) return globalThis.__demandNextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 });
          return authz;
        }
      `),
    };
  },
});

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
type SQL = import("drizzle-orm").SQL;
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("./demand/route.ts");
const { PATCH } = await import("./demand/[id]/route.ts");
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test("demand creation fences, validates custom fields, replays idempotently, and hides departments", enabled, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Demand operator", "admin"));
    const departmentId = randomUUID(), customId = randomUUID();
    const write = async (query: SQL) => {
      const result = await db.execute(query);
      assert.equal(result.rowCount, 1);
    };
    await withBypassContext(async () => {
      await write(sql`insert into departments (id, org_id, subsidiary_id, name, is_active) values (${departmentId}, ${org.orgId}, ${org.subsidiaryId}, 'Delivery', true) returning id`);
      await write(sql`insert into custom_field_defs (id, org_id, target_table, key, label, field_type, is_required) values (${customId}, ${org.orgId}, 'res_demand_lines', 'staffing_owner', 'Staffing owner', 'text', true) returning id`);
      await write(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":false}'::jsonb) where id = ${org.orgId} returning id`);
    });
    const authz = (allowedSubsidiaryIds: Set<string> | null = null) => ({
      user: { id: actorId, orgId: org.orgId, roles: [] },
      permissions: new Set(["resourcing.manage"]), allowedSubsidiaryIds,
    });
    const call = async (body: unknown, key: string) => {
      const request = new Request("http://resourcing.test/api/resourcing/demand", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
      const response = await withOrgContext(org.orgId, () => POST(request));
      return { response, text: await response.text() };
    };
    const patchCall = async (id: string, value: unknown) => withOrgContext(org.orgId, () => PATCH(
      new Request(`http://resourcing.test/api/resourcing/demand/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
      }), { params: Promise.resolve({ id }) },
    ));
    const body = {
      departmentId, jobTitle: "Consultant", firstWeek: "2026-10-04", lastWeek: "2026-10-04",
      hoursPerWeek: "12.0000", custom: { staffing_owner: "Practice lead" },
    };
    state.authz = authz();
    const off = await call(body, randomUUID());
    assert.equal(off.response.status, 404);
    assert.deepEqual(JSON.parse(off.text), { error: "not_found" });
    assert.doesNotMatch(off.text, /resourcing|demand/i);
    await withBypassContext(() => write(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true}'::jsonb) where id = ${org.orgId} returning id`));
    const missingCustom = await call({ ...body, custom: {} }, randomUUID());
    assert.equal(missingCustom.response.status, 422);
    assert.match(JSON.parse(missingCustom.text).errors.staffing_owner, /Staffing owner is required/);
    const unknownCreate = await call({ ...body, custom: { ...body.custom, unknown_custom_key: true } }, randomUUID());
    assert.deepEqual([unknownCreate.response.status, JSON.parse(unknownCreate.text).error], [422, "unknown custom field: unknown_custom_key"]);
    const key = randomUUID();
    const first = await call(body, key), replay = await call(body, key);
    assert.equal(first.response.status, 201);
    assert.equal(replay.response.status, 201);
    const id = JSON.parse(first.text).id;
    assert.equal(JSON.parse(replay.text).id, id);
    const unknownPatch = await patchCall(id, { ...body, custom: { unknown_custom_key: true } });
    assert.deepEqual([unknownPatch.status, (await unknownPatch.json()).error], [422, "unknown custom field: unknown_custom_key"]);
    const stored = await withBypassContext(() => db.execute<{ lines: string; audits: string }>(sql`
      select (select count(*)::text from res_demand_lines where org_id = ${org.orgId} and id = ${key}) as lines,
             (select count(*)::text from audit_log where org_id = ${org.orgId} and table_name = 'res_demand_lines' and row_id = ${key} and request_id = ${key}) as audits
    `));
    assert.deepEqual(stored.rows[0], { lines: "1", audits: "1" });
    state.authz = authz(new Set([randomUUID()]));
    const hidden = await call(body, randomUUID());
    const missing = await call({ ...body, departmentId: randomUUID() }, randomUUID());
    assert.equal(hidden.response.status, 404);
    assert.equal(hidden.text, missing.text);
  } finally {
    state.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

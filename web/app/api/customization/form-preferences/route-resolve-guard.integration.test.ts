import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Live-Postgres regression for PUT /api/customization/form-preferences.
// The ownership probe used to accept any in-org layout for the record type.
// resolveFormLayout only selects is_active rows and then drops any the
// caller cannot access (rowIsAccessible / admin bypass), so a stored
// preference for an inactive or role-restricted form had no observable
// effect — the save reported {ok:true} and resolve ignored it.

const root = pathToFileURL(process.cwd() + "/").href;
const state: {
  orgId: string;
  actorId: string;
  roles: Array<{ key: string; name: string }>;
} = { orgId: "", actorId: "", roles: [] };
Object.assign(globalThis, { __formPrefResolveGuardState: state });

const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "../../../../lib/authz") {
      return virtual(`
        export async function getAuthz() {
          const s = globalThis.__formPrefResolveGuardState;
          return { user: { orgId: s.orgId, id: s.actorId, roles: s.roles }, permissions: [], allowedSubsidiaryIds: null };
        }
      `);
    }
    if (specifier === "../../../../lib/customization/gates") {
      return virtual(`export async function refuseDisabledRecordType() { return null }`);
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});

const { PUT } = (await import("./route.ts?form-pref-resolve-guard")) as typeof import("./route.ts");
hooks.deregister();

const { db, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

async function put(body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await withOrgContext(state.orgId, () =>
    PUT(
      new Request("http://custom.test/api/customization/form-preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
  return { status: response.status, json: await response.json() };
}

async function preferenceRows(): Promise<Array<{ layoutId: string | null }>> {
  return (
    await db.execute<{ layoutId: string | null }>(sql`
    select layout_id as "layoutId" from user_form_preferences
     where org_id = ${state.orgId} and user_id = ${state.actorId} and record_type = 'vendor_bill'`)
  ).rows;
}

test(
  "PUT refuses inactive or role-inaccessible layouts and does not write a preference",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (
        await db.execute<{ id: string }>(sql`
        insert into users (org_id, email, name, password_hash, is_active)
        values (${org.orgId}, 'formpref-guard@test.local', 'Form Pref Guard', 'x', false)
        returning id`)
      ).rows[0]!.id;
      state.orgId = org.orgId;
      state.actorId = actorId;
      state.roles = [{ key: "accountant", name: "Accountant" }];

      const layout = '{"schemaVersion": 1, "recordType": "vendor_bill"}';
      const activeId = randomUUID();
      const inactiveId = randomUUID();
      const restrictedId = randomUUID();
      await db.execute(sql`
        insert into form_layouts (id, org_id, record_type, name, is_active, allowed_roles, layout, created_by, updated_by)
        values
          (${activeId}, ${org.orgId}, 'vendor_bill', 'Active open', true, null, ${layout}::jsonb, ${actorId}, ${actorId}),
          (${inactiveId}, ${org.orgId}, 'vendor_bill', 'Inactive', false, null, ${layout}::jsonb, ${actorId}, ${actorId}),
          (${restrictedId}, ${org.orgId}, 'vendor_bill', 'AP only', true, ${JSON.stringify(["ap_clerk"])}::jsonb, ${layout}::jsonb, ${actorId}, ${actorId})
      `);

      const inactive = await put({ recordType: "vendor_bill", layoutId: inactiveId });
      assert.equal(inactive.status, 422, JSON.stringify(inactive.json));
      assert.match(
        String((inactive.json as { error?: string }).error),
        /form layout is inactive/,
      );
      assert.match(
        String((inactive.json as { error?: string }).error),
        /activate it in Customization|choose an active form/,
      );
      assert.equal((await preferenceRows()).length, 0, "inactive refusal must not write a preference");

      const restricted = await put({ recordType: "vendor_bill", layoutId: restrictedId });
      assert.equal(restricted.status, 403, JSON.stringify(restricted.json));
      assert.match(
        String((restricted.json as { error?: string }).error),
        /restricted to other roles/,
      );
      assert.equal(
        (await preferenceRows()).length,
        0,
        "role-inaccessible refusal must not write a preference",
      );

      // The guard is selective: an active, unrestricted layout still saves, so
      // a blanket refuse would fail this assertion rather than look like a pass.
      const ok = await put({ recordType: "vendor_bill", layoutId: activeId });
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.deepEqual(ok.json, { ok: true, layoutId: activeId });
      assert.deepEqual(await preferenceRows(), [{ layoutId: activeId }]);

      state.roles = [{ key: "admin", name: "Admin" }];
      const adminRestricted = await put({ recordType: "vendor_bill", layoutId: restrictedId });
      assert.equal(adminRestricted.status, 200, JSON.stringify(adminRestricted.json));
      assert.deepEqual(await preferenceRows(), [{ layoutId: restrictedId }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

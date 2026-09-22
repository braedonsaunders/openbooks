import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/src/platform/db.ts";
import { actorAllowedSubsidiaryIds } from "@openbooks/engine/src/organization/actor-subsidiaries.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "@openbooks/engine/src/testing/fixtures.ts";

// Delegation-ceiling suite for /api/admin/roles against the real schema.
//
// A restricted administrator's subsidiary lens (gate.allowedSubsidiaryIds,
// server-derived) caps every role grant alongside the existing permission
// ceiling: creating or widening a role beyond the lens, adding permissions
// (even owned ones) to a wider role, or deleting into a wider replacement
// is refused with 403 and leaves storage and audit evidence untouched.
// Narrowing-only edits keep the legitimate removal contract.

const stateKey = Symbol.for("openbooks.admin-roles-delegation-ceiling");
interface RouteState {
  authz: {
    user: { orgId: string; id: string; isSuperAdmin: boolean };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.admin-roles-delegation-ceiling')]
  export async function guardPermission(perm) {
    if (!state.authz) return Response.json({ error: 'unauthorized' }, { status: 401 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    if (specifier === "../../../../lib/authz") {
      return { url: "mock:delegation-roles-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:delegation-roles-authz") return { format: "module", source: mockAuthz, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const routeUrl = "./route.ts?admin-roles-delegation";
const { POST, PATCH, DELETE } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const skip = !process.env.OPENBOOKS_DB_URL;

function call(method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>): Promise<Response> {
  const handler = method === "POST" ? POST : method === "PATCH" ? PATCH : DELETE;
  return handler(
    new Request("http://openbooks.test/api/admin/roles", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

interface Fixture {
  orgId: string;
  subA: string;
  subB: string;
  actorId: string;
  leafActorId: string;
  heldId: string;
  leafHeldId: string;
  wideId: string;
  narrowId: string;
  leafId: string;
  victimId: string;
  victimUserId: string;
}

async function seed(): Promise<Fixture> {
  const scratch = await withBypass(() => createScratchOrg());
  const orgId = scratch.orgId;
  const subA = scratch.subsidiaryId;
  const subB = randomUUID();
  const actorId = randomUUID();
  const leafActorId = randomUUID();
  const victimUserId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const ids = await withBypass(async () => {
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${subB}, ${orgId}, ${subA}, 'Hidden entity', 'CAD', 'CA')
    `);
    const mk = async (key: string, permissions: string[], restriction: object) =>
      (await db.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions, subsidiary_restriction)
        values (${orgId}, ${key}, ${key}, false,
                ${JSON.stringify(permissions)}::jsonb, ${JSON.stringify(restriction)}::jsonb)
        returning id
      `)).rows[0]!.id;
    const heldId = await mk(`held_${tag}`, ["admin.roles.manage", "gl.read"], { mode: "list", subsidiaryIds: [subA.toLowerCase()] });
    const leafHeldId = await mk(`leafheld_${tag}`, ["admin.roles.manage", "gl.read"], { mode: "list", subsidiaryIds: [subB.toLowerCase()] });
    const wideId = await mk(`wide_${tag}`, [], { mode: "all" });
    const narrowId = await mk(`narrow_${tag}`, [], { mode: "list", subsidiaryIds: [subA.toLowerCase()] });
    const leafId = await mk(`leaf_${tag}`, [], { mode: "list", subsidiaryIds: [subB.toLowerCase()] });
    const victimId = await mk(`victim_${tag}`, [], { mode: "list", subsidiaryIds: [subA.toLowerCase()] });
    for (const [uid, name, roleId] of [
      [actorId, "Ceiling actor", heldId],
      [leafActorId, "Leaf actor", leafHeldId],
      [victimUserId, "Victim user", victimId],
    ] as const) {
      await db.execute(sql`
        insert into users (id, org_id, email, name, password_hash, is_active)
        values (${uid}, ${orgId}, ${`dc-${uid.slice(0, 8)}@scratch.test`}, ${name}, 'x', true)
      `);
      await db.execute(sql`
        insert into role_assignments (org_id, user_id, role_id)
        values (${orgId}, ${uid}, ${roleId})
      `);
    }
    return { heldId, leafHeldId, wideId, narrowId, leafId, victimId };
  });
  routeState.authz = {
    user: { orgId, id: actorId, isSuperAdmin: false },
    permissions: new Set(["admin.roles.manage", "gl.read"]),
    allowedSubsidiaryIds: new Set([subA.toLowerCase()]),
  };
  return { orgId, subA: subA.toLowerCase(), subB: subB.toLowerCase(), actorId, leafActorId, victimUserId, ...ids };
}

async function teardown(f: Fixture): Promise<void> {
  routeState.authz = null;
  await withBypass(() => dropScratchOrg(f.orgId));
}

async function roleCount(f: Fixture): Promise<number> {
  const inner = await withBypass(async () => {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from app_roles where org_id = ${f.orgId}`,
    );
    return rows;
  });
  return inner.rows[0]!.n;
}

async function auditCount(f: Fixture): Promise<number> {
  const inner = await withBypass(async () => {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_log where org_id = ${f.orgId}`,
    );
    return rows;
  });
  return inner.rows[0]!.n;
}

async function restrictionOf(roleId: string): Promise<unknown> {
  const inner = await withBypass(async () => {
    const rows = await db.execute<{ subsidiary_restriction: unknown }>(
      sql`select subsidiary_restriction from app_roles where id = ${roleId}`,
    );
    return rows;
  });
  return inner.rows[0]?.subsidiary_restriction;
}

test("POST without a restriction defaults to all and refuses a scoped actor", { skip }, async () => {
  const f = await seed();
  try {
    const rolesBefore = await roleCount(f);
    const auditsBefore = await auditCount(f);
    const res = await call("POST", { name: "Default scope", key: `def_${f.subA.slice(0, 4)}` });
    assert.equal(res.status, 403, await res.text());
    assert.equal(await roleCount(f), rolesBefore, "no role was created");
    assert.equal(await auditCount(f), auditsBefore, "no audit was written");
  } finally { await teardown(f); }
});

test("POST inside the lens succeeds; POST covering a hidden entity refuses", { skip }, async () => {
  const f = await seed();
  try {
    const ok = await call("POST", {
      name: "In lens", key: `inlens_${f.subA.slice(0, 4)}`,
      subsidiaryRestriction: { mode: "list", subsidiaryIds: [f.subA] },
    });
    assert.equal(ok.status, 200, await ok.text());
    const auditsBefore = await auditCount(f);
    const res = await call("POST", {
      name: "Hidden", key: `hidden_${f.subA.slice(0, 4)}`,
      subsidiaryRestriction: { mode: "list", subsidiaryIds: [f.subA, f.subB] },
    });
    assert.equal(res.status, 403, await res.text());
    assert.equal(await auditCount(f), auditsBefore, "refusal wrote no audit");
  } finally { await teardown(f); }
});

test("PATCH widening a held role to all refuses and leaves the real lens scoped", { skip }, async () => {
  const f = await seed();
  try {
    const before = await withBypass(() => actorAllowedSubsidiaryIds(db, f.orgId, f.actorId));
    assert.notEqual(before, null, "actor starts subsidiary-scoped");
    const auditsBefore = await auditCount(f);
    const res = await call("PATCH", { id: f.heldId, subsidiaryRestriction: { mode: "all" } });
    assert.equal(res.status, 403, await res.text());
    assert.deepEqual(await restrictionOf(f.heldId), { mode: "list", subsidiaryIds: [f.subA] });
    assert.equal(await auditCount(f), auditsBefore, "refusal wrote no audit");
    const after = await withBypass(() => actorAllowedSubsidiaryIds(db, f.orgId, f.actorId));
    assert.notEqual(after, null, "real derived actor lens is unchanged after refusal");
    assert.deepEqual(after, before);
  } finally { await teardown(f); }
});

test("PATCH adding an owned permission to an all-scope role still refuses", { skip }, async () => {
  const f = await seed();
  try {
    const res = await call("PATCH", { id: f.wideId, permissions: ["gl.read"] });
    assert.equal(res.status, 403, await res.text());
    const perms = await withBypass(async () => {
      const rows = await db.execute<{ permissions: unknown }>(
        sql`select permissions from app_roles where id = ${f.wideId}`,
      );
      return rows;
    });
    assert.deepEqual(perms.rows[0]!.permissions, []);
  } finally { await teardown(f); }
});

test("PATCH removing permissions from a wider role keeps the removal contract", { skip }, async () => {
  const f = await seed();
  try {
    await withBypass(() => db.execute(sql`
      update app_roles set permissions = '["gl.read"]'::jsonb where id = ${f.wideId}`));
    const res = await call("PATCH", { id: f.wideId, permissions: [] });
    assert.equal(res.status, 200, await res.text());
  } finally { await teardown(f); }
});

test("PATCH narrowing all to the actor lens succeeds", { skip }, async () => {
  const f = await seed();
  try {
    const res = await call("PATCH", { id: f.wideId, subsidiaryRestriction: { mode: "list", subsidiaryIds: [f.subA] } });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(await restrictionOf(f.wideId), { mode: "list", subsidiaryIds: [f.subA] });
  } finally { await teardown(f); }
});

test("PATCH widening a list and moving list to subtree on a leaf both refuse", { skip }, async () => {
  const f = await seed();
  try {
    const wider = await call("PATCH", {
      id: f.narrowId, subsidiaryRestriction: { mode: "list", subsidiaryIds: [f.subA, f.subB] },
    });
    assert.equal(wider.status, 403, await wider.text());
    assert.deepEqual(await restrictionOf(f.narrowId), { mode: "list", subsidiaryIds: [f.subA] });
    // subB is a leaf: list[subB] and subtree(subB) enumerate identically
    // today, but the subtree grants future children — still widening.
    const policy = await call("PATCH", {
      id: f.leafId, subsidiaryRestriction: { mode: "subtree", subsidiaryId: f.subB },
    });
    assert.equal(policy.status, 403, await policy.text());
    assert.deepEqual(await restrictionOf(f.leafId), { mode: "list", subsidiaryIds: [f.subB] });
  } finally { await teardown(f); }
});

test("DELETE into an all-scope replacement refuses; into an in-lens one succeeds", { skip }, async () => {
  const f = await seed();
  try {
    const auditsBefore = await auditCount(f);
    const refused = await call("DELETE", { id: f.victimId, replacementRoleId: f.wideId });
    assert.equal(refused.status, 403, await refused.text());
    const victim = await withBypass(() => db.execute(
      sql`select id from app_roles where id = ${f.victimId}`,
    ));
    assert.ok(victim.rows[0], "refused deletion kept the role");
    assert.equal(await auditCount(f), auditsBefore, "refusal wrote no audit");
    const ok = await call("DELETE", { id: f.victimId, replacementRoleId: f.narrowId });
    assert.equal(ok.status, 200, await ok.text());
    const held = await withBypass(async () => {
      const rows = await db.execute<{ role_id: string }>(
        sql`select role_id from role_assignments where org_id = ${f.orgId} and user_id = ${f.victimUserId}`,
      );
      return rows;
    });
    assert.deepEqual(held.rows.map((r) => r.role_id), [f.narrowId]);
  } finally { await teardown(f); }
});

test("POST refuses an open subtree matching today's enumeration", { skip }, async () => {
  // The leaf actor holds list[subB]: POSTing subtree(subB) enumerates
  // identically today but grants subB's future children, so it refuses on
  // every grant path — while the closed list succeeds as a control.
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.leafActorId, isSuperAdmin: false },
      permissions: new Set(["admin.roles.manage", "gl.read"]),
      allowedSubsidiaryIds: new Set([f.subB]),
    };
    const refused = await call("POST", {
      name: "Leaf subtree", key: `leafsub_${f.subA.slice(0, 4)}`,
      subsidiaryRestriction: { mode: "subtree", subsidiaryId: f.subB },
    });
    assert.equal(refused.status, 403, await refused.text());
    const control = await call("POST", {
      name: "Leaf list", key: `leaflist_${f.subA.slice(0, 4)}`,
      subsidiaryRestriction: { mode: "list", subsidiaryIds: [f.subB] },
    });
    assert.equal(control.status, 200, await control.text());
  } finally { await teardown(f); }
});

test("unrestricted actor keeps full role scope authority", { skip }, async () => {
  const f = await seed();
  try {
    // Widen the actor's own stored role first so the stubbed unrestricted
    // lens matches the real derivation the route loads.
    await withBypass(() => db.execute(sql`
      update app_roles set subsidiary_restriction = '{"mode":"all"}'::jsonb where id = ${f.heldId}`));
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId, isSuperAdmin: false },
      permissions: new Set(["admin.roles.manage", "gl.read"]),
      allowedSubsidiaryIds: null,
    };
    const res = await call("PATCH", { id: f.heldId, subsidiaryRestriction: { mode: "all" } });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(await restrictionOf(f.heldId), { mode: "all" });
  } finally { await teardown(f); }
});

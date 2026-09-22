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
import { UNUSABLE_PASSWORD_HASH } from "./invite";

// Delegation-ceiling suite for /api/admin/users against the real schema.
//
// A restricted administrator's subsidiary lens caps every user grant: the
// assigned/invited role's resolved scope must sit inside the lens (the
// target's access is the union of all their roles, so even an
// empty-permission all-scope role broadens a scoped user), and re-issuing
// an invite or reactivating an account re-checks the target's stored roles —
// plus stored permission overrides — against the same lens. Refusals are
// 403 with a usable remedy, and leave storage and audit evidence untouched.
// Outbound delivery is stubbed: refusals are asserted before issuance, and
// synthetic recipients never leave the process.

const stateKey = Symbol.for("openbooks.admin-users-delegation-ceiling");
const state: {
  authz: {
    user: { orgId: string; id: string; isSuperAdmin: boolean };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
  deliveries: { to: string }[];
} = { authz: null, deliveries: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const hooks = registerHooks({
  resolve(specifier, context, next) {
    const virtual = (source: string) => ({
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(source),
    });
    if (specifier === "server-only") return virtual("export {}");
    const parent = String(context.parentURL ?? "");
    if (specifier === "../../../../lib/authz" && parent.includes("/api/admin/users/route.ts")) {
      return virtual(`
        const state = globalThis[Symbol.for('openbooks.admin-users-delegation-ceiling')];
        export async function guardPermission() {
          if (!state.authz) return Response.json({ error: 'unauthorized' }, { status: 401 });
          return state.authz;
        }
      `);
    }
    if (specifier === "next-intl/server") {
      return virtual(`
        export async function getTranslations() { return (key) => key; }
        export async function getLocale() { return 'en'; }
      `);
    }
    if (specifier === "./request-org" && parent.includes("/web/lib/auth.ts")) {
      return virtual("export function setRequestOrg() {}");
    }
    if (parent.includes("auth-reset.ts") && specifier === "@openbooks/emails") {
      return virtual(`
        const state = globalThis[Symbol.for('openbooks.admin-users-delegation-ceiling')];
        export const deriveEmailDeliveryKey = () => 'isolated-delivery';
        export const passwordResetEmail = ({ resetUrl }) => ({ subject: 'Set your password', text: resetUrl, html: resetUrl });
        export async function sendVia(transport, message) {
          state.deliveries.push({ to: message.to });
          return { kind: 'sent', providerMessageId: 'isolated' };
        }
      `);
    }
    if (parent.includes("auth-reset.ts") && specifier === "@openbooks/engine/src/delivery/email-config.ts") {
      return virtual(`
        export async function resolveOrgEmailTransport() { return { provider: 'isolated' }; }
        export async function insertEmailLog(row) { return 'isolated-log'; }
        export async function markEmailSent(orgId, logId) {}
        export async function markEmailUncertain() {}
        export async function markEmailFailed() {}
      `);
    }
    return next(specifier, context);
  },
});
const routeUrl = "./route.ts?admin-users-delegation";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const skip = !process.env.OPENBOOKS_DB_URL;

const post = (body: object) =>
  POST(
    new Request("http://localhost/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

interface Fixture {
  orgId: string;
  subA: string;
  subB: string;
  actorId: string;
  leafActorId: string;
  targetId: string;
  wideId: string;
  baseId: string;
  extraId: string;
  leafSubId: string;
  leafBaseId: string;
}

async function seed(): Promise<Fixture> {
  const scratch = await withBypass(() => createScratchOrg());
  const orgId = scratch.orgId;
  const subA = scratch.subsidiaryId;
  const subB = randomUUID();
  const actorId = randomUUID();
  const leafActorId = randomUUID();
  const targetId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const ids = await withBypass(async () => {
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${subB}, ${orgId}, ${subA}, 'Hidden entity', 'CAD', 'CA')
    `);
    const mk = async (key: string, restriction: object) =>
      (await db.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions, subsidiary_restriction)
        values (${orgId}, ${key}, ${key}, false, '[]'::jsonb, ${JSON.stringify(restriction)}::jsonb)
        returning id
      `)).rows[0]!.id;
    const heldId = await mk(`held_${tag}`, { mode: "list", subsidiaryIds: [subA.toLowerCase()] });
    await db.execute(sql`
      update app_roles set permissions = '["admin.users.manage"]'::jsonb where id = ${heldId}`);
    const wideId = await mk(`wide_${tag}`, { mode: "all" });
    const baseId = await mk(`base_${tag}`, { mode: "list", subsidiaryIds: [subA.toLowerCase()] });
    const extraId = await mk(`extra_${tag}`, { mode: "list", subsidiaryIds: [subA.toLowerCase()] });
    const leafHeldId = await mk(`leafheld_${tag}`, { mode: "list", subsidiaryIds: [subB.toLowerCase()] });
    await db.execute(sql`
      update app_roles set permissions = '["admin.users.manage"]'::jsonb where id = ${leafHeldId}`);
    const leafSubId = await mk(`leafsub_${tag}`, { mode: "subtree", subsidiaryId: subB.toLowerCase() });
    const leafBaseId = await mk(`leafbase_${tag}`, { mode: "list", subsidiaryIds: [subB.toLowerCase()] });
    for (const [uid, name, roleId] of [
      [actorId, "Ceiling actor", heldId],
      [leafActorId, "Leaf actor", leafHeldId],
      [targetId, "Ceiling target", baseId],
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
    await db.execute(sql`update orgs set env_kind = 'production' where id = ${orgId}`);
    return { wideId, baseId, extraId, leafSubId, leafBaseId };
  });
  state.authz = {
    user: { orgId, id: actorId, isSuperAdmin: false },
    permissions: new Set(["admin.users.manage"]),
    allowedSubsidiaryIds: new Set([subA.toLowerCase()]),
  };
  state.deliveries.length = 0;
  return { orgId, subA: subA.toLowerCase(), subB: subB.toLowerCase(), actorId, leafActorId, targetId, ...ids };
}

async function teardown(f: Fixture): Promise<void> {
  state.authz = null;
  state.deliveries.length = 0;
  await withBypass(() => dropScratchOrg(f.orgId));
}

async function assignmentsOf(f: Fixture, userId: string): Promise<string[]> {
  const inner = await withBypass(async () => {
    const rows = await db.execute<{ role_id: string }>(
      sql`select role_id from role_assignments where org_id = ${f.orgId} and user_id = ${userId} order by role_id`,
    );
    return rows;
  });
  return inner.rows.map((row) => row.role_id);
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

async function targetLens(f: Fixture): Promise<Set<string> | null> {
  return withBypass(() => actorAllowedSubsidiaryIds(db, f.orgId, f.targetId));
}

async function isActive(f: Fixture, userId: string): Promise<boolean> {
  const inner = await withBypass(async () => {
    const rows = await db.execute<{ is_active: boolean }>(
      sql`select is_active from users where id = ${userId} and org_id = ${f.orgId}`,
    );
    return rows;
  });
  return inner.rows[0]!.is_active;
}

test("assign refuses a distinct unrestricted empty-permission role and the target lens stays scoped", { skip }, async () => {
  const f = await seed();
  try {
    const before = await targetLens(f);
    assert.notEqual(before, null, "target starts subsidiary-scoped on its distinct base role");
    const auditsBefore = await auditCount(f);
    const res = await post({ action: "assign", userId: f.targetId, roleId: f.wideId });
    assert.equal(res.status, 403, await res.text());
    assert.deepEqual(await assignmentsOf(f, f.targetId), [f.baseId], "no assignment was written");
    assert.equal(await auditCount(f), auditsBefore, "refusal wrote no audit");
    assert.deepEqual(await targetLens(f), before, "real derived target lens is unchanged");
  } finally { await teardown(f); }
});

test("assign inside the lens succeeds", { skip }, async () => {
  const f = await seed();
  try {
    const res = await post({ action: "assign", userId: f.targetId, roleId: f.extraId });
    assert.equal(res.status, 200, await res.text());
    assert.ok((await assignmentsOf(f, f.targetId)).includes(f.extraId));
  } finally { await teardown(f); }
});

test("assign refuses an open subtree matching today's enumeration", { skip }, async () => {
  // The leaf actor holds list[subB]: assigning subtree(subB) enumerates
  // identically today but grants subB's future children, so it refuses —
  // while the closed list assigns as a control.
  const f = await seed();
  try {
    state.authz = {
      user: { orgId: f.orgId, id: f.leafActorId, isSuperAdmin: false },
      permissions: new Set(["admin.users.manage"]),
      allowedSubsidiaryIds: new Set([f.subB]),
    };
    const auditsBefore = await auditCount(f);
    const refused = await post({ action: "assign", userId: f.targetId, roleId: f.leafSubId });
    assert.equal(refused.status, 403, await refused.text());
    assert.deepEqual(await assignmentsOf(f, f.targetId), [f.baseId], "no assignment was written");
    assert.equal(await auditCount(f), auditsBefore, "refusal wrote no audit");
    const control = await post({ action: "assign", userId: f.targetId, roleId: f.leafBaseId });
    assert.equal(control.status, 200, await control.text());
  } finally { await teardown(f); }
});

test("invite with an all-scope role refuses before any user or issuance exists", { skip }, async () => {
  const f = await seed();
  try {
    const email = `wide-${randomUUID().slice(0, 8)}@scratch.test`;
    const auditsBefore = await auditCount(f);
    const res = await post({ action: "invite", email, roleId: f.wideId });
    assert.equal(res.status, 403, await res.text());
    const row = await withBypass(() => db.execute(
      sql`select id from users where org_id = ${f.orgId} and lower(email) = ${email}`,
    ));
    assert.equal(row.rows.length, 0, "no user was created");
    assert.equal(await auditCount(f), auditsBefore, "refusal wrote no audit");
    assert.equal(state.deliveries.length, 0, "no delivery was issued");
  } finally { await teardown(f); }
});

test("invite with an in-lens role succeeds", { skip }, async () => {
  const f = await seed();
  try {
    const email = `narrow-${randomUUID().slice(0, 8)}@scratch.test`;
    const res = await post({ action: "invite", email, roleId: f.extraId });
    assert.equal(res.status, 200, await res.text());
    const row = await withBypass(async () => {
      const rows = await db.execute<{ id: string }>(
        sql`select id from users where org_id = ${f.orgId} and lower(email) = ${email}`,
      );
      return rows;
    });
    assert.ok(row.rows[0], "invited user exists");
    assert.deepEqual(await assignmentsOf(f, row.rows[0]!.id), [f.extraId]);
  } finally { await teardown(f); }
});

async function seedPending(f: Fixture, tag: string, roleId: string): Promise<string> {
  const userId = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into users (id, org_id, email, name, password_hash, is_active)
      values (${userId}, ${f.orgId}, ${`${tag}-${userId.slice(0, 8)}@scratch.test`}, ${tag}, ${UNUSABLE_PASSWORD_HASH}, true)
    `);
    await db.execute(sql`
      insert into role_assignments (org_id, user_id, role_id)
      values (${f.orgId}, ${userId}, ${roleId})
    `);
  });
  return userId;
}

test("resend-invite refuses for a target whose stored roles exceed the lens", { skip }, async () => {
  const f = await seed();
  const pending = await seedPending(f, "widepending", f.wideId);
  try {
    const auditsBefore = await auditCount(f);
    const res = await post({ action: "resend-invite", userId: pending });
    assert.equal(res.status, 403, await res.text());
    assert.equal(await auditCount(f), auditsBefore, "refusal wrote no audit");
    assert.equal(state.deliveries.length, 0, "no delivery was issued");
  } finally { await teardown(f); }
});

test("resend-invite inside the lens succeeds", { skip }, async () => {
  const f = await seed();
  const pending = await seedPending(f, "narrowpending", f.baseId);
  try {
    const res = await post({ action: "resend-invite", userId: pending });
    assert.equal(res.status, 200, await res.text());
  } finally { await teardown(f); }
});

test("resend-invite refuses a grant override above the ceiling before issuance", { skip }, async () => {
  const f = await seed();
  const pending = await seedPending(f, "overridepending", f.baseId);
  try {
    await withBypass(() => db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${f.orgId}, ${pending}, 'gl.post', 'grant')
    `));
    const auditsBefore = await auditCount(f);
    const res = await post({ action: "resend-invite", userId: pending });
    assert.equal(res.status, 403, await res.text());
    assert.equal(await auditCount(f), auditsBefore, "refusal wrote no audit");
    assert.equal(state.deliveries.length, 0, "no delivery was issued");
  } finally { await teardown(f); }
});

test("resend-invite does not treat a deny override as a grant", { skip }, async () => {
  const f = await seed();
  const pending = await seedPending(f, "denypending", f.baseId);
  try {
    await withBypass(() => db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${f.orgId}, ${pending}, 'gl.post', 'deny')
    `));
    const res = await post({ action: "resend-invite", userId: pending });
    assert.equal(res.status, 200, await res.text());
  } finally { await teardown(f); }
});

async function seedInactive(f: Fixture, tag: string, roleId: string): Promise<string> {
  const userId = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into users (id, org_id, email, name, password_hash, is_active)
      values (${userId}, ${f.orgId}, ${`${tag}-${userId.slice(0, 8)}@scratch.test`}, ${tag}, 'x', false)
    `);
    await db.execute(sql`
      insert into role_assignments (org_id, user_id, role_id)
      values (${f.orgId}, ${userId}, ${roleId})
    `);
  });
  return userId;
}

test("reactivation refuses a stored all-scope union and stays inactive without audit", { skip }, async () => {
  const f = await seed();
  const inactive = await seedInactive(f, "wideinactive", f.wideId);
  try {
    const auditsBefore = await auditCount(f);
    const res = await post({ action: "set-active", userId: inactive, isActive: true });
    assert.equal(res.status, 403, await res.text());
    assert.equal(await isActive(f, inactive), false, "account stays inactive");
    assert.deepEqual(await assignmentsOf(f, inactive), [f.wideId], "assignments untouched");
    assert.equal(await auditCount(f), auditsBefore, "refusal wrote no audit");
  } finally { await teardown(f); }
});

test("reactivation inside the lens succeeds", { skip }, async () => {
  const f = await seed();
  const inactive = await seedInactive(f, "narrowinactive", f.baseId);
  try {
    const res = await post({ action: "set-active", userId: inactive, isActive: true });
    assert.equal(res.status, 200, await res.text());
    assert.equal(await isActive(f, inactive), true);
  } finally { await teardown(f); }
});

test("reactivation refuses a grant override above the ceiling but honours a deny", { skip }, async () => {
  const f = await seed();
  const granted = await seedInactive(f, "grantoverride", f.baseId);
  const denied = await seedInactive(f, "denyoverride", f.baseId);
  try {
    await withBypass(async () => {
      await db.execute(sql`
        insert into user_permission_overrides (org_id, user_id, permission, effect)
        values (${f.orgId}, ${granted}, 'gl.post', 'grant')
      `);
      await db.execute(sql`
        insert into user_permission_overrides (org_id, user_id, permission, effect)
        values (${f.orgId}, ${denied}, 'gl.post', 'deny')
      `);
    });
    const refused = await post({ action: "set-active", userId: granted, isActive: true });
    assert.equal(refused.status, 403, await refused.text());
    assert.equal(await isActive(f, granted), false, "grant-override account stays inactive");
    const ok = await post({ action: "set-active", userId: denied, isActive: true });
    assert.equal(ok.status, 200, await ok.text());
    assert.equal(await isActive(f, denied), true, "deny override causes no false refusal");
  } finally { await teardown(f); }
});

test("reactivation unions every assignment: a wide role past fifty still refuses", { skip }, async () => {
  const f = await seed();
  const tag = randomUUID().slice(0, 8);
  const inactive = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into users (id, org_id, email, name, password_hash, is_active)
      values (${inactive}, ${f.orgId}, ${`many-${tag}@scratch.test`}, 'many', 'x', false)
    `);
    for (let i = 0; i < 55; i++) {
      const roleId = (await db.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions, subsidiary_restriction)
        values (${f.orgId}, ${`many_${tag}_${i}`}, ${`many ${i}`}, false, '[]'::jsonb,
                ${JSON.stringify({ mode: "list", subsidiaryIds: [f.subA] })}::jsonb)
        returning id
      `)).rows[0]!.id;
      await db.execute(sql`
        insert into role_assignments (org_id, user_id, role_id)
        values (${f.orgId}, ${inactive}, ${roleId})
      `);
    }
    await db.execute(sql`
      insert into role_assignments (org_id, user_id, role_id)
      values (${f.orgId}, ${inactive}, ${f.wideId})
    `);
  });
  try {
    const res = await post({ action: "set-active", userId: inactive, isActive: true });
    assert.equal(res.status, 403, await res.text());
    assert.equal(await isActive(f, inactive), false);
  } finally { await teardown(f); }
});

test("re-affirming an active wider user and deactivating need no new authority", { skip }, async () => {
  const f = await seed();
  const pending = await seedPending(f, "affirm", f.wideId);
  try {
    const affirm = await post({ action: "set-active", userId: pending, isActive: true });
    assert.equal(affirm.status, 200, await affirm.text());
    const off = await post({ action: "set-active", userId: pending, isActive: false });
    assert.equal(off.status, 200, await off.text());
    assert.equal(await isActive(f, pending), false);
  } finally { await teardown(f); }
});

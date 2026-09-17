import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "@openbooks/engine/src/test-fixtures.ts";

// Invite-user vertical slice: POST action=invite → user row with an
// unusable credential + role assignment + audit evidence → set-password link
// through the real password-reset path → pending state in the real Users
// loader until the mailbox owner signs in.

const stateKey = Symbol.for("openbooks.admin-invite-integration");
const state: {
  authz: {
    user: { orgId: string; id: string; isSuperAdmin: boolean };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  deliveries: { to: string; subject: string; html: string; text: string }[];
  emailLogs: { recipients: string[]; subject: string; categoryKey: string | null }[];
  sentMarks: string[];
} = { authz: null, deliveries: [], emailLogs: [], sentMarks: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const hooks = registerHooks({
  resolve(specifier, context, next) {
    const virtual = (source: string) => ({
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(source),
    });
    if (specifier === "server-only") return virtual("export {}");
    const parent = String(context.parentURL ?? "");
    if (
      specifier === "../../../../lib/authz"
      && (parent.includes("/api/admin/users/route.ts") || parent.includes("/admin/users/view.ts"))
    ) {
      return virtual(`
        const state = globalThis[Symbol.for('openbooks.admin-invite-integration')];
        export async function guardPermission() { return state.authz; }
        export async function requirePermission() { return state.authz; }
      `);
    }
    if (specifier === "next-intl/server") {
      return virtual(`
        export async function getTranslations() { return (key) => key; }
        export async function getLocale() { return 'en'; }
      `);
    }
    if (specifier === "./request-org" && parent.includes("/web/lib/auth.ts")) {
      // web/lib/auth.ts registers the production request-org resolver as an
      // import side effect, which would replace the runner's ambient
      // test-database bypass for every later query in this process
      // (fixtures included). Nothing under test here resolves a request
      // scope — the route and the loader run behind stubbed authz and
      // auth-reset's explicit bypass — so the request scope is a no-op seam.
      return virtual("export function setRequestOrg() {}");
    }
    if (parent.includes("auth-reset.ts") && specifier === "@openbooks/emails") {
      return virtual(`
        const state = globalThis[Symbol.for('openbooks.admin-invite-integration')];
        export const deriveEmailDeliveryKey = () => 'isolated-delivery';
        export const passwordResetEmail = ({ resetUrl }) => ({ subject: 'Set your password', text: resetUrl, html: resetUrl });
        export async function sendVia(transport, message) {
          state.deliveries.push({ to: message.to, subject: message.subject, html: message.html, text: message.text });
          return { kind: 'sent', providerMessageId: 'isolated' };
        }
      `);
    }
    if (parent.includes("auth-reset.ts") && specifier === "@openbooks/engine/src/email-config.ts") {
      return virtual(`
        const state = globalThis[Symbol.for('openbooks.admin-invite-integration')];
        export async function resolveOrgEmailTransport() { return { provider: 'isolated' }; }
        export async function insertEmailLog(row) {
          state.emailLogs.push({ recipients: row.recipients, subject: row.subject, categoryKey: row.categoryKey ?? null });
          return 'isolated-log';
        }
        export async function markEmailSent(orgId, logId) { state.sentMarks.push(logId); }
        export async function markEmailUncertain() {}
        export async function markEmailFailed() {}
      `);
    }
    return next(specifier, context);
  },
});
const { POST } = await import("./route");
const { loadAdminUsers } = await import("../../../(app)/admin/users/view");
const { completePasswordReset } = await import("../../../../lib/auth-reset");
hooks.deregister();
const skip = !process.env.OPENBOOKS_DB_URL;

const NEW_EMAIL = "new.member@scratch.test";

async function seed(rolePermissions: string[] = []) {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Invite actor", "invite_actor");
  const roleId = (
    await db.execute<{ id: string }>(sql`insert into app_roles(org_id, key, name, is_built_in, permissions)
      values (${org.orgId}, 'invitable', 'Invitable', false, ${JSON.stringify(rolePermissions)}::jsonb) returning id`)
  ).rows[0]!.id;
  await db.execute(sql`update orgs set env_kind = 'production' where id = ${org.orgId}`);
  state.authz = {
    user: { orgId: org.orgId, id: actorId, isSuperAdmin: false },
    permissions: new Set(["admin.users.manage"]),
    allowedSubsidiaryIds: null,
  };
  state.deliveries.length = 0;
  state.emailLogs.length = 0;
  state.sentMarks.length = 0;
  return { orgId: org.orgId, actorId, roleId };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

const invite = (body: object) =>
  POST(
    new Request("http://localhost/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

async function userRow(f: Fixture, email: string = NEW_EMAIL) {
  return (
    await db.execute<{
      id: string;
      name: string;
      email: string;
      password_hash: string;
      is_active: boolean;
      last_login_at: string | null;
    }>(sql`select id, name, email, password_hash, is_active, last_login_at
      from users where org_id = ${f.orgId} and lower(email) = ${email}`)
  ).rows[0];
}

test("invite creates the user, assigns the role, and issues a working set-password link", { skip }, async () => {
  const f = await seed();
  try {
    const response = await invite({ action: "invite", email: NEW_EMAIL, roleId: f.roleId });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { ok: boolean; userId: string; emailQueued: boolean };
    assert.equal(payload.ok, true);
    assert.equal(payload.emailQueued, true);

    const user = await userRow(f);
    assert.ok(user, "the invited user row exists");
    assert.equal(user.email, NEW_EMAIL);
    assert.equal(user.name, "New Member");
    assert.equal(user.is_active, true);
    assert.equal(user.last_login_at, null);
    assert.equal(user.password_hash, "unusable");

    const assignment = (
      await db.execute<{ n: number }>(sql`select count(*)::int as n from role_assignments
        where org_id = ${f.orgId} and user_id = ${user!.id} and role_id = ${f.roleId}`)
    ).rows[0]!.n;
    assert.equal(assignment, 1);
    const userAudit = (
      await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log
        where org_id = ${f.orgId} and table_name = 'users' and row_id = ${user!.id} and action = 'insert'`)
    ).rows[0]!.n;
    const assignmentAudit = (
      await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log
        where org_id = ${f.orgId} and table_name = 'role_assignments' and action = 'insert'
          and row_id in (select id from role_assignments where org_id = ${f.orgId} and user_id = ${user!.id})`)
    ).rows[0]!.n;
    assert.equal(userAudit, 1, "user creation is audited");
    assert.equal(assignmentAudit, 1, "role assignment is audited");

    const resets = (
      await db.execute<{ n: number }>(sql`select count(*)::int as n from auth_password_resets
        where user_id = ${user!.id} and used_at is null and expires_at > now()`)
    ).rows[0]!.n;
    assert.equal(resets, 1);
    assert.equal(state.deliveries.length, 1);
    assert.equal(state.deliveries[0]!.to, NEW_EMAIL);
    assert.match(state.deliveries[0]!.text, /\/login\/reset\?token=/);
    assert.deepEqual(
      state.emailLogs.map((log) => [log.recipients, log.categoryKey]),
      [[[NEW_EMAIL], "password_reset"]],
    );

    // The real Users loader shows the invite as pending while the
    // set-password link is outstanding.
    const pending = await loadAdminUsers({});
    const pendingRow = pending.users.find((row) => row.email === NEW_EMAIL);
    assert.ok(pendingRow, "the invited user is listed");
    assert.equal(pendingRow.isPending, true);
    assert.equal(pendingRow.statusLabel, "statusPending");

    // The emailed link genuinely sets a password: the full circle closes.
    // Consuming the link ends the pending state even before first sign-in.
    const token = new URL(state.deliveries[0]!.text, "https://books.example.test").searchParams.get("token")!;
    assert.deepEqual(await completePasswordReset(token, "A brand new password 1042"), { ok: true });

    await db.execute(sql`update users set last_login_at = now() where id = ${user!.id}`);
    const settled = await loadAdminUsers({});
    const settledRow = settled.users.find((row) => row.email === NEW_EMAIL);
    assert.equal(settledRow!.isPending, false);
    assert.equal(settledRow!.statusLabel, "statusActive");
    // The sign-in timestamp flows through the locale-aware formatter.
    assert.notEqual(settledRow!.lastSignIn, "—");
    assert.match(settledRow!.lastSignIn, /202\d/);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("invite rejects a malformed address, an unknown role, and a grant above the inviter's ceiling", { skip }, async () => {
  const f = await seed(["gl.post"]);
  try {
    assert.equal((await invite({ action: "invite", email: "not-an-address", roleId: f.roleId })).status, 400);
    assert.equal(
      (
        await invite({
          action: "invite",
          email: NEW_EMAIL,
          roleId: "00000000-0000-4000-8000-ffffffffffff",
        })
      ).status,
      404,
    );
    assert.equal((await invite({ action: "invite", email: NEW_EMAIL })).status, 400);
    // The seeded role carries gl.post, which the inviter does not hold.
    assert.equal((await invite({ action: "invite", email: NEW_EMAIL, roleId: f.roleId })).status, 403);
    assert.equal(await userRow(f), undefined);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("a second invite for the same address conflicts without duplicating the user", { skip }, async () => {
  const f = await seed();
  try {
    assert.equal((await invite({ action: "invite", email: NEW_EMAIL, roleId: f.roleId })).status, 200);
    const retry = await invite({ action: "invite", email: "New.Member@scratch.test", roleId: f.roleId });
    assert.equal(retry.status, 409);
    const count = (
      await db.execute<{ n: number }>(sql`select count(*)::int as n from users
        where org_id = ${f.orgId} and lower(email) = ${NEW_EMAIL}`)
    ).rows[0]!.n;
    assert.equal(count, 1);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("concurrent invites for one address create a single user", { skip }, async () => {
  const f = await seed();
  try {
    const [first, second] = await Promise.all([
      invite({ action: "invite", email: NEW_EMAIL, roleId: f.roleId }),
      invite({ action: "invite", email: NEW_EMAIL, roleId: f.roleId }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const count = (
      await db.execute<{ n: number }>(sql`select count(*)::int as n from users
        where org_id = ${f.orgId} and lower(email) = ${NEW_EMAIL}`)
    ).rows[0]!.n;
    assert.equal(count, 1);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

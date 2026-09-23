import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";

// Invite follow-up (F-t01-013): when email delivery is not configured the
// invite must still hand the admin a copyable set-password link (one-time,
// same token the email would carry), and a pending invite must be
// re-issuable through a Resend action. The link must NEVER be exposed when
// the email path worked.

const stateKey = Symbol.for("openbooks.admin-invite-link-integration");
const state: {
  authz: {
    user: { orgId: string; id: string; isSuperAdmin: boolean };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  transport: boolean;
  deliveries: { to: string; subject: string; html: string; text: string }[];
  emailLogs: { recipients: string[]; subject: string; categoryKey: string | null }[];
  sentMarks: string[];
} = { authz: null, transport: false, deliveries: [], emailLogs: [], sentMarks: [] };
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
        const state = globalThis[Symbol.for('openbooks.admin-invite-link-integration')];
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
      return virtual("export function setRequestOrg() {}");
    }
    if (parent.includes("auth-reset.ts") && specifier === "@openbooks/emails") {
      return virtual(`
        const state = globalThis[Symbol.for('openbooks.admin-invite-link-integration')];
        export const deriveEmailDeliveryKey = () => 'isolated-delivery';
        export const passwordResetEmail = ({ resetUrl }) => ({ subject: 'Set your password', text: resetUrl, html: resetUrl });
        export async function sendVia(transport, message) {
          state.deliveries.push({ to: message.to, subject: message.subject, html: message.html, text: message.text });
          return { kind: 'sent', providerMessageId: 'isolated' };
        }
      `);
    }
    if (parent.includes("auth-reset.ts") && specifier === "@openbooks/engine/src/delivery/email-config.ts") {
      return virtual(`
        const state = globalThis[Symbol.for('openbooks.admin-invite-link-integration')];
        export async function resolveOrgEmailTransport() { return state.transport ? { provider: 'isolated' } : null; }
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

const FIRST_EMAIL = "link.member@scratch.test";

async function seed(rolePermissions: string[] = []) {
  // Scratch-org seeding runs under the bypass context (shared cluster has no
  // request tenant here); the route under test authenticates via stubbed
  // authz and auth-reset's own explicit bypass, exactly like production.
  const seeded = await withBypassContext(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Invite actor", "invite_actor");
    const roleId = (
      await db.execute<{ id: string }>(sql`insert into app_roles(org_id, key, name, is_built_in, permissions)
        values (${org.orgId}, 'invitable', 'Invitable', false, ${JSON.stringify(rolePermissions)}::jsonb) returning id`)
    ).rows[0]!.id;
    await db.execute(sql`update orgs set env_kind = 'production' where id = ${org.orgId}`);
    return { org, actorId, roleId };
  });
  const { org, actorId, roleId } = seeded;
  state.authz = {
    user: { orgId: org.orgId, id: actorId, isSuperAdmin: false },
    permissions: new Set(["admin.users.manage"]),
    allowedSubsidiaryIds: null,
  };
  state.transport = false;
  state.deliveries.length = 0;
  state.emailLogs.length = 0;
  state.sentMarks.length = 0;
  return { orgId: org.orgId, actorId, roleId };
}
const post = (body: object) =>
  POST(
    new Request("http://localhost/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const tokenFromUrl = (url: string): string =>
  new URL(url, "https://books.example.test").searchParams.get("token")!;

async function liveTokenCount(userId: string): Promise<number> {
  return withBypassContext(async () => (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from auth_password_resets
      where user_id = ${userId} and used_at is null and expires_at > now()`)
  ).rows[0]!.n);
}

/** Direct test-body reads/writes run under bypass; the route under test sets its own org scope. */
const asBypass = <T>(fn: () => Promise<T>): Promise<T> => withBypassContext(fn);

test("invite without email delivery returns a one-time set-password link", { skip }, async () => {
  const f = await seed();
  try {
    const response = await post({ action: "invite", email: FIRST_EMAIL, roleId: f.roleId });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok: boolean;
      userId: string;
      emailQueued: boolean;
      setPasswordUrl?: string;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.emailQueued, false);
    assert.equal(state.deliveries.length, 0);
    assert.ok(
      typeof payload.setPasswordUrl === "string" && payload.setPasswordUrl.includes("/login/reset?token="),
      "the invite response carries a copyable set-password link",
    );

    // The real Users loader shows the invite as pending while the
    // set-password link is outstanding.
    const pending = await withOrgContext(f.orgId, () => loadAdminUsers({}));
    assert.equal(pending.users.find((row) => row.email === FIRST_EMAIL)?.isPending, true);

    // The handed-out link genuinely activates the account: full circle.
    // Consuming the link ends the pending state even before first sign-in.
    assert.deepEqual(
      await completePasswordReset(tokenFromUrl(payload.setPasswordUrl!), "A brand new password 1042"),
      { ok: true },
    );
    const settled = await withOrgContext(f.orgId, () => loadAdminUsers({}));
    assert.equal(settled.users.find((row) => row.email === FIRST_EMAIL)?.isPending, false);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("invite with working email never exposes the link in the response", { skip }, async () => {
  const f = await seed();
  try {
    state.transport = true;
    const response = await post({ action: "invite", email: FIRST_EMAIL, roleId: f.roleId });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok: boolean;
      emailQueued: boolean;
      setPasswordUrl?: string;
    };
    assert.equal(payload.emailQueued, true);
    assert.equal("setPasswordUrl" in payload, false);
    assert.equal(state.deliveries.length, 1);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("resend-invite mints a fresh link and supersedes the outstanding one", { skip }, async () => {
  const f = await seed();
  try {
    const first = (await (
      await post({ action: "invite", email: FIRST_EMAIL, roleId: f.roleId })
    ).json()) as { userId: string; setPasswordUrl: string };
    const oldToken = tokenFromUrl(first.setPasswordUrl);

    const response = await post({ action: "resend-invite", userId: first.userId });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok: boolean;
      emailQueued: boolean;
      setPasswordUrl?: string;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.emailQueued, false);
    assert.ok(payload.setPasswordUrl && payload.setPasswordUrl !== first.setPasswordUrl);

    // The superseded link is dead; the fresh one works.
    assert.deepEqual(
      await completePasswordReset(oldToken, "A brand new password 1042"),
      { ok: false, reason: "invalid_token" },
    );
    assert.deepEqual(
      await completePasswordReset(tokenFromUrl(payload.setPasswordUrl!), "A brand new password 1042"),
      { ok: true },
    );
    assert.equal(await liveTokenCount(first.userId), 0);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("resend-invite refuses unknown, activated, and deactivated users", { skip }, async () => {
  const f = await seed();
  try {
    assert.equal(
      (await post({ action: "resend-invite", userId: "00000000-0000-4000-8000-ffffffffffff" })).status,
      404,
    );
    assert.equal((await post({ action: "resend-invite", userId: "not-a-uuid" })).status, 400);

    const invited = (await (
      await post({ action: "invite", email: FIRST_EMAIL, roleId: f.roleId })
    ).json()) as { userId: string };
    await asBypass(() => db.execute(sql`update users set password_hash = 'scrypt:activated' where id = ${invited.userId}`));
    assert.equal((await post({ action: "resend-invite", userId: invited.userId })).status, 409);

    const second = (await (
      await post({ action: "invite", email: "second.member@scratch.test", roleId: f.roleId })
    ).json()) as { userId: string };
    await asBypass(() => db.execute(sql`update users set is_active = false where id = ${second.userId}`));
    assert.equal((await post({ action: "resend-invite", userId: second.userId })).status, 409);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("a repeat invite for a pending user re-issues a fresh link and supersedes the old one", { skip }, async () => {
  const f = await seed();
  try {
    const first = (await (
      await post({ action: "invite", email: FIRST_EMAIL, roleId: f.roleId })
    ).json()) as { userId: string; setPasswordUrl: string };
    const retry = await post({ action: "invite", email: FIRST_EMAIL, roleId: f.roleId });
    assert.equal(retry.status, 200);
    const payload = (await retry.json()) as {
      ok: boolean;
      userId: string;
      emailQueued: boolean;
      setPasswordUrl?: string;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.userId, first.userId);
    assert.equal(payload.emailQueued, false);
    assert.ok(payload.setPasswordUrl && payload.setPasswordUrl !== first.setPasswordUrl);
    // The superseded link is dead; the fresh one works.
    assert.deepEqual(
      await completePasswordReset(tokenFromUrl(first.setPasswordUrl), "A brand new password 1042"),
      { ok: false, reason: "invalid_token" },
    );
    assert.deepEqual(
      await completePasswordReset(tokenFromUrl(payload.setPasswordUrl!), "A brand new password 1042"),
      { ok: true },
    );
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("a refused re-issue never exposes a link, even with no mail transport", { skip }, async () => {
  const f = await seed();
  try {
    const invited = (await (
      await post({ action: "invite", email: FIRST_EMAIL, roleId: f.roleId })
    ).json()) as { userId: string; setPasswordUrl: string };
    // A different administrator grants a permission this actor does not hold.
    const highRoleId = await asBypass(async () => (
      await db.execute<{ id: string }>(sql`insert into app_roles(org_id, key, name, is_built_in, permissions)
        values (${f.orgId}, 'elevated', 'Elevated', false, '["gl.post"]'::jsonb) returning id`)
    ).rows[0]!.id);
    await asBypass(() => db.execute(sql`insert into role_assignments (org_id, user_id, role_id, created_by, updated_by)
      values (${f.orgId}, ${invited.userId}, ${highRoleId}, ${f.actorId}, ${f.actorId})`));
    // No mail transport here, so a leaked raw link would be a takeover URL.
    const response = await post({ action: "resend-invite", userId: invited.userId });
    assert.equal(response.status, 403);
    const payload = (await response.json()) as { setPasswordUrl?: string };
    assert.equal("setPasswordUrl" in payload, false, "no takeover link is handed out");
    assert.equal(await liveTokenCount(invited.userId), 1, "no new token was minted");
    // The same elevation reached through a repeat invite is refused the same
    // way: the retry resumes the pending row but the issuance gate stops it.
    const retry = await post({ action: "invite", email: FIRST_EMAIL, roleId: f.roleId });
    assert.equal(retry.status, 403);
    assert.equal("setPasswordUrl" in (await retry.json()), false);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("resend-invite enforces the inviter's role ceiling", { skip }, async () => {
  const f = await seed();
  try {
    const invited = (await (
      await post({ action: "invite", email: FIRST_EMAIL, roleId: f.roleId })
    ).json()) as { userId: string };
    // A different administrator grants a permission this actor does not hold.
    const highRoleId = await asBypass(async () => (
      await db.execute<{ id: string }>(sql`insert into app_roles(org_id, key, name, is_built_in, permissions)
        values (${f.orgId}, 'elevated', 'Elevated', false, '["gl.post"]'::jsonb) returning id`)
    ).rows[0]!.id);
    await asBypass(() => db.execute(sql`insert into role_assignments (org_id, user_id, role_id, created_by, updated_by)
      values (${f.orgId}, ${invited.userId}, ${highRoleId}, ${f.actorId}, ${f.actorId})`));
    const response = await post({ action: "resend-invite", userId: invited.userId });
    assert.equal(response.status, 403);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("resend-invite is rate-capped like the self-service path", { skip }, async () => {
  const f = await seed();
  try {
    const invited = (await (
      await post({ action: "invite", email: FIRST_EMAIL, roleId: f.roleId })
    ).json()) as { userId: string };
    assert.equal((await post({ action: "resend-invite", userId: invited.userId })).status, 200);
    assert.equal((await post({ action: "resend-invite", userId: invited.userId })).status, 200);
    assert.equal((await post({ action: "resend-invite", userId: invited.userId })).status, 429);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

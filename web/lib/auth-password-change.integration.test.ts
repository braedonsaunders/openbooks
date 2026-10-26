import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "@openbooks/engine/testing/fixtures";

test(
  "changing a password keeps the caller signed in, signs out other sessions and spends reset links",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    // web/lib/auth.ts reads the session secret live from process.env.
    const priorSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = randomBytes(32).toString("hex");
    try {
      const auth = await import("./auth");
      const { changeOwnPassword } = await import("./auth-password-change");
      const { MIN_PASSWORD_LENGTH } = await import("./auth-reset");
      const currentPassword = "Current isolated account password 4410";
      const newPassword = "Replacement isolated account password 9127";
      const context = { networkAddress: "127.0.0.1", userAgent: "isolated password change" };
      const { userId, email } = await withBypassContext(async () => {
        const userId = (await seedFlowActors(org.orgId)).adminId;
        const email = (
          await db.execute<{ email: string }>(
            sql`select email from users where id=${userId}`,
            "objects",
          )
        )[0]!.email;
        await db.execute(sql`update orgs set env_kind='production' where id=${org.orgId}`);
        await db.execute(
          sql`update users set password_hash=${await auth.hashPassword(currentPassword)} where id=${userId}`,
        );
        return { userId, email };
      });
      const signIn = async (password: string) => {
        const result = await auth.login(email, password, context);
        assert.ok(result.kind === "success");
        return {
          token: result.token,
          sessionId: (await auth.validateSessionToken(result.token))!.sessionId,
        };
      };
      const caller = await signIn(currentPassword);
      const other = await signIn(currentPassword);
      const rawToken = randomBytes(32).toString("base64url");
      await withBypassContext(async () => {
        await db.execute(
          sql`insert into auth_password_resets (user_id,token_hash,expires_at) values (${userId},${createHash("sha256").update(rawToken).digest("hex")},now()+interval '30 minutes')`,
        );
      });
      const change = (current: string, next: string, sessionId = caller.sessionId) =>
        changeOwnPassword({
          userId,
          sessionId,
          currentPassword: current,
          newPassword: next,
          context,
        });

      assert.deepEqual(await change(currentPassword, "x".repeat(MIN_PASSWORD_LENGTH - 1)), {
        ok: false,
        reason: "weak_password",
      });
      assert.deepEqual(await change(currentPassword, currentPassword), {
        ok: false,
        reason: "unchanged_password",
      });
      assert.deepEqual(await change("Not the current password 0000", newPassword), {
        ok: false,
        reason: "invalid_credentials",
      });
      // Refusals change nothing: the current password still signs in.
      assert.equal((await auth.login(email, currentPassword, context)).kind, "success");

      assert.deepEqual(await change(currentPassword, newPassword), {
        ok: true,
        revokedSessions: 2,
      });
      assert.ok(
        await auth.validateSessionToken(caller.token),
        "the caller session stays signed in",
      );
      assert.equal(
        await auth.validateSessionToken(other.token),
        null,
        "other sessions are signed out",
      );
      assert.equal((await auth.login(email, currentPassword, context)).kind, "invalid");
      assert.equal((await auth.login(email, newPassword, context)).kind, "success");

      const evidence = await withBypassContext(async () => ({
        openResets: (
          await db.execute<{ n: number }>(
            sql`select count(*)::int as n from auth_password_resets where user_id=${userId} and used_at is null`,
            "objects",
          )
        )[0]!.n,
        audit: await db.execute<{ changes: Record<string, unknown>; actor_id: string }>(
          sql`
        select changes, actor_id from audit_log
         where org_id=${org.orgId} and table_name='users' and row_id=${userId} and changes ? 'passwordChanged'`,
          "objects",
        ),
        hashExposed: (
          await db.execute<{ n: number }>(
            sql`
        select count(*)::int as n from audit_log
         where org_id=${org.orgId} and row_id=${userId} and changes::text ilike '%s2:%'`,
            "objects",
          )
        )[0]!.n,
      }));
      assert.equal(evidence.openResets, 0, "reset links issued before the change are spent");
      assert.equal(evidence.audit.length, 1);
      assert.equal(evidence.audit[0]!.actor_id, userId);
      assert.deepEqual(evidence.audit[0]!.changes, {
        passwordChanged: true,
        otherSessionsSignedOut: 2,
      });
      assert.equal(evidence.hashExposed, 0, "audit evidence never carries the credential");

      // A session revoked before the change cannot authorize one.
      assert.deepEqual(await auth.revokeUserSession(userId, caller.sessionId, caller.sessionId), {
        ok: true,
        revoked: true,
      });
      assert.deepEqual(await change(newPassword, "Another isolated account password 5531"), {
        ok: false,
        reason: "caller_session_revoked",
      });
      assert.equal((await auth.login(email, newPassword, context)).kind, "success");
    } finally {
      if (priorSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = priorSecret;
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

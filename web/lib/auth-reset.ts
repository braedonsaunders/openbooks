import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/src/db.ts";
import { passwordResetEmail, sendVia } from "@openbooks/emails";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  resolveOrgEmailTransport,
} from "@openbooks/engine/src/email-config.ts";
import { appBaseUrl } from "@openbooks/engine/src/flows/email-tokens.ts";
import { authContextHashes, hashPassword } from "./auth";
import { normalizeLoginEmail, type AuthRequestContext } from "./auth-policy";

/**
 * Self-service password reset. Request → email a one-use link; confirm →
 * set the new password and revoke every session. Anti-enumeration: the
 * request path resolves identically whether or not the address matches an
 * account, and per-user issuance is capped so the mailbox can't be flooded.
 *
 * Only the SHA-256 of the raw token is stored (auth_password_resets); the raw
 * token exists in the email link alone. Same doctrine as session tokens.
 */

export const RESET_TOKEN_TTL_MIN = 30;
export const MIN_PASSWORD_LENGTH = 10;
/** New tokens per user per hour — a mailbox-flood cap, not a security control. */
const REQUESTS_PER_HOUR = 3;

function tokenHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function requestPasswordReset(
  rawEmail: string,
  context: AuthRequestContext,
): Promise<void> {
  const email = normalizeLoginEmail(rawEmail);
  if (!email) return;
  const { networkHash, userAgentHash } = authContextHashes(context);

  await withBypass(async () => {
    // Same single-identity rule as login: never guess between two active
    // home identities for one address.
    const users = (await db.execute(sql`
      select u.id, u.org_id, u.name, u.email
        from users u
        join orgs o on o.id = u.org_id and o.env_kind = 'production'
       where lower(u.email) = ${email} and u.is_active
       order by u.created_at
       limit 2
    `)) as unknown as { rows: { id: string; org_id: string; name: string | null; email: string }[] };
    const user = users.rows.length === 1 ? users.rows[0]! : null;
    if (!user) return;

    const recent = (await db.execute(sql`
      select count(*)::int as n from auth_password_resets
       where user_id = ${user.id} and created_at > now() - interval '1 hour'
    `)) as unknown as { rows: { n: number }[] };
    if (recent.rows[0]!.n >= REQUESTS_PER_HOUR) return;

    // A fresh request supersedes outstanding links.
    await db.execute(sql`
      update auth_password_resets set expires_at = now()
       where user_id = ${user.id} and used_at is null and expires_at > now()
    `);

    const raw = randomBytes(32).toString("base64url");
    await db.execute(sql`
      insert into auth_password_resets (user_id, token_hash, network_hash, user_agent_hash, expires_at)
      values (${user.id}, ${tokenHash(raw)}, ${networkHash}, ${userAgentHash},
              now() + make_interval(mins => ${RESET_TOKEN_TTL_MIN}))
    `);

    const resetUrl = `${appBaseUrl()}/login/reset?token=${raw}`;
    const message = passwordResetEmail({
      recipientName: user.name,
      resetUrl,
      expiresMinutes: RESET_TOKEN_TTL_MIN,
    });

    const transport = await resolveOrgEmailTransport(user.org_id);
    if (!transport) {
      // Self-hosted deployments without outbound email would otherwise
      // dead-end here; the server operator can hand the link over. The raw
      // link in server logs is as sensitive as the mailbox it would land in.
      console.warn(`[password-reset] no email transport for org ${user.org_id}; reset link: ${resetUrl}`);
      return;
    }
    const logId = await insertEmailLog({
      orgId: user.org_id,
      recipients: [user.email],
      subject: message.subject,
      status: "queued",
      categoryKey: "password_reset",
    });
    try {
      const sent = await sendVia(transport, {
        to: user.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      await markEmailSent(logId, sent.id);
    } catch (error) {
      await markEmailFailed(logId, error instanceof Error ? error.message : String(error));
    }
  });
}

export type ResetOutcome = { ok: true } | { ok: false; reason: "invalid_token" | "weak_password" };

export async function completePasswordReset(
  rawToken: string,
  newPassword: string,
): Promise<ResetOutcome> {
  if (
    typeof newPassword !== "string"
    || newPassword.length < MIN_PASSWORD_LENGTH
    || newPassword.length > 1024
  ) {
    return { ok: false, reason: "weak_password" };
  }
  if (typeof rawToken !== "string" || rawToken.length < 20 || rawToken.length > 128) {
    return { ok: false, reason: "invalid_token" };
  }

  // Scrypt before the row lock — never hold a lock across the KDF.
  const newHash = await hashPassword(newPassword);

  return withBypass(async () => {
    const rows = (await db.execute(sql`
      select r.id, r.user_id
        from auth_password_resets r
        join users u on u.id = r.user_id and u.is_active
       where r.token_hash = ${tokenHash(rawToken)}
         and r.used_at is null and r.expires_at > now()
       for update of r
    `)) as unknown as { rows: { id: string; user_id: string }[] };
    const reset = rows.rows[0];
    if (!reset) return { ok: false, reason: "invalid_token" as const };

    await db.execute(sql`
      update auth_password_resets set used_at = now() where id = ${reset.id}
    `);
    await db.execute(sql`
      update users set password_hash = ${newHash}, updated_at = now()
       where id = ${reset.user_id}
    `);
    // The reset proves mailbox control, not device control: sign out every
    // existing session (a stolen session can no longer keep the account).
    await db.execute(sql`
      update auth_sessions set revoked_at = now(), revocation_reason = 'password_reset'
       where user_id = ${reset.user_id} and revoked_at is null
    `);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      select org_id, 'users', id, 'update', '{"passwordReset": true}'::jsonb, id
        from users where id = ${reset.user_id}
    `);
    return { ok: true as const };
  });
}

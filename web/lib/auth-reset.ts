import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/src/db.ts";
import { deriveEmailDeliveryKey, passwordResetEmail, sendVia } from "@openbooks/emails";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailUncertain,
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

  const delivery = await withBypass(async () => {
    // Same single-identity rule as login: never guess between two active
    // home identities for one address.
    const users = (await db.execute<{ id: string; org_id: string; name: string | null; email: string }>(sql`
      select u.id, u.org_id, u.name, u.email
        from users u
        join orgs o on o.id = u.org_id and o.env_kind = 'production'
       where lower(u.email) = ${email} and u.is_active
       order by u.created_at, u.id
       limit 2
       for update of u
    `));
    const user = users.rows.length === 1 ? users.rows[0]! : null;
    if (!user) return;

    const recent = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from auth_password_resets
       where user_id = ${user.id} and created_at > now() - interval '1 hour'
    `));
    if (recent.rows[0]!.n >= REQUESTS_PER_HOUR) return;

    // Fail closed before superseding an existing link or minting a new bearer
    // credential. Without a controlled delivery path, there is nothing safe
    // to hand to either the requester or the server logs.
    const transport = await resolveOrgEmailTransport(user.org_id);
    if (!transport) {
      console.warn(`[password-reset] no email transport for org ${user.org_id}; request not issued`);
      return;
    }

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

    const logId = await insertEmailLog({
      orgId: user.org_id,
      recipients: [user.email],
      subject: message.subject,
      status: "queued",
      categoryKey: "password_reset",
    });
    return { user, transport, message, logId };
  });
  if (!delivery) return;

  // Commit the credential and release the user lock before provider I/O. A
  // slow mail server must not hold password login or reset completion hostage.
  const { user, transport, message, logId } = delivery;
  await withBypass(async () => {
    try {
      const outcome = await sendVia(transport, {
        to: user.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }, { deliveryKey: deriveEmailDeliveryKey({ orgId: user.org_id, scope: `direct:${logId}`, to: user.email }) });
      if (outcome.kind === "sent") {
        await markEmailSent(user.org_id, logId, outcome.providerMessageId);
      } else {
        // Acceptance state unknown: the reset link may or may not be in the
        // mailbox. Record uncertainty instead of inventing an outcome; the
        // issued token's own expiry bounds any attacker window.
        await markEmailUncertain(user.org_id, logId, outcome.reason);
        console.warn(`[password-reset] delivery outcome unresolved for org ${user.org_id}: ${outcome.reason}`);
      }
    } catch (error) {
      await markEmailFailed(user.org_id, logId, error instanceof Error ? error.message : String(error));
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

  // Reject unrecognized, spent or inactive credentials before competing with
  // login for the shared KDF capacity. This read grants no reset authority:
  // the credential and active identity are rechecked under locks below.
  const hashedToken = tokenHash(rawToken);
  const candidate = await withBypass(async () => (await db.execute<{ user_id: string }>(sql`
    select r.user_id from auth_password_resets r
      join users u on u.id = r.user_id and u.is_active
     where r.token_hash = ${hashedToken} and r.used_at is null and r.expires_at > now()
  `)).rows[0]);
  if (!candidate) return { ok: false, reason: "invalid_token" };

  // Scrypt outside the transaction — never hold a lock across the KDF.
  const newHash = await hashPassword(newPassword);

  return withBypass(async () => {
    // Keep the user → credential lock order shared by issuance and login.
    const user = (await db.execute<{ id: string }>(sql`
      select id from users where id = ${candidate.user_id} and is_active for update
    `)).rows[0];
    if (!user) return { ok: false, reason: "invalid_token" as const };
    const rows = (await db.execute<{ id: string; user_id: string }>(sql`
      select r.id, r.user_id
        from auth_password_resets r
        join users u on u.id = r.user_id and u.is_active
       where r.token_hash = ${hashedToken}
         and r.user_id = ${user.id}
         and r.used_at is null and r.expires_at > now()
       for update of r
    `));
    const reset = rows.rows[0];
    if (!reset) return { ok: false, reason: "invalid_token" as const };

    // now() is the transaction start, which may precede a long lock wait.
    // Claim the locked credential against the live database clock before
    // invalidating its siblings or changing any account state.
    const claimed = await db.execute<{ id: string }>(sql`
      update auth_password_resets set used_at = clock_timestamp()
       where id = ${reset.id} and used_at is null and expires_at > clock_timestamp()
       returning id
    `);
    if (!claimed.rows[0]) return { ok: false, reason: "invalid_token" as const };

    await db.execute(sql`
      update auth_password_resets set used_at = now()
       where user_id = ${reset.user_id} and used_at is null
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
    // A pending MFA challenge has already accepted the previous password.
    // Invalidate it with the sessions, and discard enrollments authorized by
    // those sessions. Established MFA factors remain required after reset.
    await db.execute(sql`
      update auth_login_challenges set consumed_at = now()
       where user_id = ${reset.user_id} and consumed_at is null
    `);
    await db.execute(sql`
      delete from auth_mfa_factors where user_id = ${reset.user_id} and enabled_at is null
    `);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      select org_id, 'users', id, 'update', '{"passwordReset": true}'::jsonb, id
        from users where id = ${reset.user_id}
    `);
    return { ok: true as const };
  });
}

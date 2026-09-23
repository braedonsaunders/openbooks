import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/src/platform/db.ts";
import { deriveEmailDeliveryKey, passwordResetEmail, sendVia, type EmailTransport } from "@openbooks/emails";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailUncertain,
  markEmailSent,
  resolveOrgEmailTransport,
} from "@openbooks/engine/src/delivery/email-config.ts";
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
/**
 * Per-network hourly cap on anonymous reset REQUESTS, mirroring login's
 * network window: without it an unauthenticated caller can force cheap DB
 * lookups plus 500ms-held connections per request, against any address,
 * while the per-user cap only limits mail to one mailbox. When the network
 * is unknown (no trusted proxy) the cap cannot apply — the per-user cap and
 * the uniform delay remain. Over the cap the request is silently not
 * issued: the response is already uniform, so refusing by name here would
 * tell a rate-limit prober exactly where the boundary sits.
 */
const NETWORK_REQUESTS_PER_HOUR = 20;

async function networkOverCap(networkHash: string | null): Promise<boolean> {
  if (!networkHash) return false;
  const recent = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from auth_password_resets
     where network_hash = ${networkHash} and created_at > now() - interval '1 hour'
  `));
  return recent.rows[0]!.n >= NETWORK_REQUESTS_PER_HOUR;
}

function tokenHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Absolute set-password URL for a raw token — the same link the email carries. */
export function setPasswordUrl(rawToken: string): string {
  return `${appBaseUrl()}/login/reset?token=${rawToken}`;
}

/**
 * Mint a fresh single-use reset token, superseding outstanding links.
 * Returns null when the per-user hourly cap is reached. Callers must run
 * this under bypass (withBypass): issuance is authorized by the caller (the
 * self-service lookup or an authenticated admin), never by row visibility.
 */
async function mintResetToken(
  userId: string,
  networkHash: string | null,
  userAgentHash: string | null,
): Promise<string | null> {
  const recent = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from auth_password_resets
     where user_id = ${userId} and created_at > now() - interval '1 hour'
  `));
  if (recent.rows[0]!.n >= REQUESTS_PER_HOUR) return null;

  // A fresh issuance supersedes outstanding links.
  await db.execute(sql`
    update auth_password_resets set expires_at = now()
     where user_id = ${userId} and used_at is null and expires_at > now()
  `);

  const raw = randomBytes(32).toString("base64url");
  await db.execute(sql`
    insert into auth_password_resets (user_id, token_hash, network_hash, user_agent_hash, expires_at)
    values (${userId}, ${tokenHash(raw)}, ${networkHash}, ${userAgentHash},
            now() + make_interval(mins => ${RESET_TOKEN_TTL_MIN}))
  `);
  return raw;
}

type ResetRecipient = { id: string; org_id: string; name: string | null; email: string };

/**
 * Whether a minted token is still the credential to send: unused,
 * unexpired, and not superseded by a newer issuance for the same user.
 * Newness compares (created_at, id) so two mints in one instant still
 * order deterministically (ids are time-ordered v7).
 */
async function isResetTokenCurrent(userId: string, raw: string): Promise<boolean> {
  const row = (await db.execute<{ id: string }>(sql`
    select cur.id from auth_password_resets cur
     where cur.user_id = ${userId}
       and cur.token_hash = ${tokenHash(raw)}
       and cur.used_at is null
       and cur.expires_at > clock_timestamp()
       and not exists (
         select 1 from auth_password_resets newer
          where newer.user_id = cur.user_id
            and (newer.created_at, newer.id) > (cur.created_at, cur.id)
       )
  `)).rows[0];
  return !!row;
}

/**
 * Deliver a minted token through the org's email transport. Returns true
 * when the message reached a transport (the email_log row records the
 * eventual provider outcome); false when the token was superseded, consumed,
 * or expired before delivery and nothing was sent.
 *
 * One transaction holds a per-user advisory delivery lock across the
 * currency check and the provider send, so concurrent requests resolve in
 * mint order: without this, a first request stalled in provider delivery can
 * land after a newer link, and the most recent email holds a dead link while
 * the request status says sent. An advisory lock (not a row lock) keeps slow
 * provider I/O from blocking password login or reset completion, which take
 * row locks elsewhere. Minting already committed before this runs, so the
 * credential itself is never held across provider I/O.
 */
export async function deliverResetEmail(
  user: ResetRecipient,
  transport: EmailTransport,
  raw: string,
): Promise<boolean> {
  return withBypass(async () => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"password-reset-delivery:" + user.id}, 0))`);
    if (!(await isResetTokenCurrent(user.id, raw))) return false;
    const message = passwordResetEmail({
      recipientName: user.name,
      resetUrl: setPasswordUrl(raw),
      expiresMinutes: RESET_TOKEN_TTL_MIN,
    });
    const logId = await insertEmailLog({
      orgId: user.org_id,
      recipients: [user.email],
      subject: message.subject,
      status: "queued",
      categoryKey: "password_reset",
    });
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
    return true;
  });
}

export async function requestPasswordReset(
  rawEmail: string,
  context: AuthRequestContext,
): Promise<void> {
  const email = normalizeLoginEmail(rawEmail);
  if (!email) return;
  const { networkHash, userAgentHash } = authContextHashes(context);

  const delivery = await withBypass(async () => {
    // The network cap first: an anonymous prober rotating addresses must not
    // reach the user lookup at all once its window is spent.
    if (await networkOverCap(networkHash)) return;
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

    // Fail closed before superseding an existing link or minting a new bearer
    // credential. Without a controlled delivery path, there is nothing safe
    // to hand to either the requester or the server logs.
    const transport = await resolveOrgEmailTransport(user.org_id);
    if (!transport) {
      console.warn(`[password-reset] no email transport for org ${user.org_id}; request not issued`);
      return;
    }

    const raw = await mintResetToken(user.id, networkHash, userAgentHash);
    if (!raw) return;
    return { user, transport, raw };
  });
  if (!delivery) return;
  await deliverResetEmail(delivery.user, delivery.transport, delivery.raw);
}

export type InviteLinkIssuance = { raw: string; emailQueued: boolean };

/**
 * Refusal thrown by an `issueInviteSetPasswordLink` authorize hook to stop
 * issuance before anything is minted or delivered. The mint transaction
 * rolls back, so no token exists and no email carries one — the caller maps
 * this to a 403/409 response and never hands out a link.
 */
export class InviteIssuanceRefusedError extends Error {
  readonly refusal: { error: string; missing?: string[]; status: 403 | 409 };
  constructor(refusal: { error: string; missing?: string[]; status?: 403 | 409 }) {
    super(refusal.error);
    this.name = "InviteIssuanceRefusedError";
    this.refusal = { ...refusal, status: refusal.status ?? 403 };
  }
}

/**
 * Admin-issued set-password link for an invited (pending) user. Unlike the
 * anonymous self-service path this ALWAYS mints: the authenticated admin is
 * a controlled delivery path — when email is unconfigured they copy the
 * one-time link to the person out of band. The raw token is returned to the
 * admin caller only, never persisted; only its SHA-256 is stored.
 *
 * The optional `authorize` hook runs INSIDE the mint transaction before
 * anything is minted: it must lock the target user row (`for update`) and
 * re-verify the caller's authority over the target's CURRENT stored access,
 * throwing InviteIssuanceRefusedError to stop. Checking in the same
 * transaction that mints closes the grant-between-check-and-mint window in
 * which a concurrent elevation could hand a lower-privilege caller a
 * takeover link for a now-privileged account.
 */
export async function issueInviteSetPasswordLink(input: {
  user: ResetRecipient;
  context: AuthRequestContext;
  authorize?: () => Promise<void>;
}): Promise<InviteLinkIssuance | null> {
  const { networkHash, userAgentHash } = authContextHashes(input.context);
  // Mint first and commit: delivery re-checks currency in its own
  // transaction, which can only see this token once it is committed.
  const minted = await withBypass(async () => {
    // The authoritative ceiling re-check runs inside the mint transaction:
    // throwing rolls the mint back (no token, no email).
    if (input.authorize) await input.authorize();
    const raw = await mintResetToken(input.user.id, networkHash, userAgentHash);
    if (!raw) return null;
    const transport = await resolveOrgEmailTransport(input.user.org_id);
    return { raw, transport };
  });
  if (!minted) return null;
  if (!minted.transport) return { raw: minted.raw, emailQueued: false };
  // A superseded invite link is never emailed: the admin holds the raw
  // token from this same call, and sending a dead link would only confuse.
  const delivered = await deliverResetEmail(input.user, minted.transport, minted.raw);
  return { raw: minted.raw, emailQueued: delivered };
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

import "server-only";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import {
  db,
  env,
  withBypass,
  withBypassContext,
} from "@openbooks/engine/src/db.ts";
import { resolveActiveEnv } from "./org-access";
import { setRequestOrg } from "./request-org";
import { sealSecret, unsealSecret } from "./secrets";
import {
  AUTH_EVENT_RETENTION_DAYS,
  EMAIL_ATTEMPT_LIMIT,
  LOGIN_CHALLENGE_TTL_S,
  LOGIN_WINDOW_S,
  MFA_ATTEMPT_LIMIT,
  NETWORK_ATTEMPT_LIMIT,
  nextLockoutState,
  normalizeLoginEmail,
  retryAfterSeconds,
  slidingWindowRetryAfter,
  type AuthRequestContext,
} from "./auth-policy";
import {
  challengeSigningInput,
  parseChallengeTokenFormat,
  parseSessionTokenFormat,
  sessionSigningInput,
  type ParsedSessionToken,
} from "./auth-token-format";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  totpProvisioningUri,
  verifyTotpCode,
} from "./auth-totp";

/**
 * Passwords use scrypt. Browser sessions and MFA challenges are signed cookies
 * backed by server-side rows, providing selective revocation and one-use MFA.
 * Login limits and temporary lockouts live in PostgreSQL so every web replica
 * observes the same state.
 */

const COOKIE = "ob_session";
const ACTIVE_ENV_COOKIE = "ob_active_env";
export const LOGIN_CHALLENGE_COOKIE = "ob_login_challenge";
const TTL_S = 14 * 24 * 3600;
const DUMMY_PASSWORD_HASH = "01010101010101010101010101010101:105ba60fca19c5323503bb2f317fc26b63fdfaf6575712e44694fcb0917fa196192bea677d6ff71b01e784e576b631d15a931a4ae569446f7f7f37917dd2d25f";

export type AuthMethod = "password" | "oidc";

export type LoginResult =
  | { kind: "success"; token: string }
  | { kind: "mfa_required"; challengeToken: string }
  | { kind: "invalid"; retryAfter: number }
  | { kind: "rate_limited"; retryAfter: number };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex, extra] = stored.split(":");
  if (extra || !saltHex || !hashHex || !/^[0-9a-f]{32}$/i.test(saltHex) || !/^[0-9a-f]{128}$/i.test(hashHex)) {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

function sign(value: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(value).digest("base64url");
}

function signaturesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function privacyHash(kind: string, value: string | null): string | null {
  if (!value) return null;
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`openbooks:${kind}:${value}`)
    .digest("hex");
}

function contextHashes(context: AuthRequestContext) {
  return {
    networkHash: privacyHash("network", context.networkAddress),
    userAgentHash: privacyHash("user-agent", context.userAgent),
  };
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function makeSessionTokenFor(userId: string, sessionId: string, expiresEpoch: number): string {
  const payload = `v2.${sessionId}.${userId}.${expiresEpoch}`;
  return `${payload}.${sign(sessionSigningInput(payload))}`;
}

export function verifySessionTokenParts(token: string | undefined): ParsedSessionToken | null {
  const parsed = parseSessionTokenFormat(token);
  if (!parsed || parsed.expiresEpoch < Date.now() / 1000) return null;
  const expected = sign(sessionSigningInput(parsed.payload));
  return signaturesEqual(parsed.signature, expected) ? parsed : null;
}

/** Signature-only compatibility helper. Authorization must use validateSessionToken/currentUser. */
export function verifySessionToken(token: string | undefined): string | null {
  return verifySessionTokenParts(token)?.userId ?? null;
}

function makeChallengeToken(userId: string, challengeId: string, expiresEpoch: number): string {
  const payload = `m1.${challengeId}.${userId}.${expiresEpoch}`;
  return `${payload}.${sign(challengeSigningInput(payload))}`;
}

function verifyChallengeToken(token: string | undefined) {
  const parsed = parseChallengeTokenFormat(token);
  if (!parsed || parsed.expiresEpoch < Date.now() / 1000) return null;
  const expected = sign(challengeSigningInput(parsed.payload));
  return signaturesEqual(parsed.signature, expected) ? parsed : null;
}

/** Environment switch token (separate signed-token domain). */
export function makeEnvToken(sandboxOrgId: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_S;
  const payload = `${sandboxOrgId}.${exp}`;
  return `${payload}.${sign(`openbooks:environment:${payload}`)}`;
}

export function verifyEnvToken(token: string | undefined): string | null {
  if (!token || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [orgId, rawExpires, signature] = parts;
  const expires = Number(rawExpires);
  if (!Number.isSafeInteger(expires) || expires < Date.now() / 1000) return null;
  const payload = `${orgId}.${rawExpires}`;
  const expected = sign(`openbooks:environment:${payload}`);
  return signaturesEqual(signature, expected) ? orgId : null;
}

export type ValidatedSession = {
  userId: string;
  sessionId: string;
  expiresAt: Date;
  authMethod: AuthMethod;
};

/** Cryptographic and server-side revocation check. */
export async function validateSessionToken(token: string | undefined): Promise<ValidatedSession | null> {
  const parsed = verifySessionTokenParts(token);
  if (!parsed) return null;
  const hash = tokenHash(token!);
  return withBypassContext(async () => {
    const result = (await db.execute(sql`
      select s.user_id as "userId", s.id as "sessionId", s.expires_at as "expiresAt",
             s.auth_method as "authMethod"
        from auth_sessions s
        join users u on u.id = s.user_id and u.is_active
       where s.id = ${parsed.sessionId}
         and s.user_id = ${parsed.userId}
         and s.token_hash = ${hash}
         and s.revoked_at is null
         and s.expires_at > now()
       limit 1
    `)) as unknown as { rows: ValidatedSession[] };
    const row = result.rows[0];
    if (!row) return null;
    await db.execute(sql`
      update auth_sessions set last_seen_at = now()
       where id = ${row.sessionId} and last_seen_at < now() - interval '5 minutes'
    `);
    return row;
  });
}

async function createSessionRecord(
  userId: string,
  authMethod: AuthMethod,
  context: AuthRequestContext,
): Promise<string> {
  const sessionId = randomUUID();
  const expiresEpoch = Math.floor(Date.now() / 1000) + TTL_S;
  const token = makeSessionTokenFor(userId, sessionId, expiresEpoch);
  const { networkHash, userAgentHash } = contextHashes(context);
  await db.execute(sql`
    insert into auth_sessions
      (id, user_id, token_hash, auth_method, network_hash, user_agent_hash, expires_at)
    values
      (${sessionId}, ${userId}, ${tokenHash(token)}, ${authMethod}, ${networkHash},
       ${userAgentHash}, ${new Date(expiresEpoch * 1000)})
  `);
  // Bound active-session growth if a credential or automation repeatedly logs
  // in. The newest 25 remain available for ordinary multi-device use.
  await db.execute(sql`
    update auth_sessions set revoked_at = now(), revocation_reason = 'session_limit'
     where id in (
       select id from auth_sessions
        where user_id = ${userId} and revoked_at is null and expires_at > now()
        order by created_at desc offset 25
     )
  `);
  return token;
}

type LoginStateRow = {
  userId: string | null;
  failureCount: number;
  lastFailedAt: Date | null;
  lockedUntil: Date | null;
};

type LoginEventOutcome =
  | "success"
  | "failure"
  | "locked"
  | "rate_limited"
  | "mfa_required"
  | "mfa_failure"
  | "oidc_failure";

async function acquireAuthLocks(emailHash: string, networkHash: string | null): Promise<void> {
  const keys = [`email:${emailHash}`, ...(networkHash ? [`network:${networkHash}`] : [])].sort();
  for (const key of keys) {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

async function ensureLoginState(emailHash: string, userId: string | null = null): Promise<LoginStateRow> {
  await db.execute(sql`
    insert into auth_login_state (email_hash, user_id)
    values (${emailHash}, ${userId})
    on conflict (email_hash) do update
      set user_id = coalesce(auth_login_state.user_id, excluded.user_id), updated_at = now()
  `);
  const result = (await db.execute(sql`
    select user_id as "userId", failure_count as "failureCount",
           last_failed_at as "lastFailedAt", locked_until as "lockedUntil"
      from auth_login_state where email_hash = ${emailHash} for update
  `)) as unknown as { rows: LoginStateRow[] };
  const row = result.rows[0]!;
  return {
    ...row,
    lastFailedAt: dateValue(row.lastFailedAt),
    lockedUntil: dateValue(row.lockedUntil),
  };
}

async function recordLoginEvent(input: {
  userId: string | null;
  emailHash: string;
  outcome: LoginEventOutcome;
  authMethod: AuthMethod;
  networkHash: string | null;
  userAgentHash: string | null;
}): Promise<void> {
  await db.execute(sql`
    insert into auth_login_events
      (user_id, email_hash, network_hash, user_agent_hash, outcome, auth_method)
    values
      (${input.userId}, ${input.emailHash}, ${input.networkHash}, ${input.userAgentHash},
       ${input.outcome}, ${input.authMethod})
  `);
}

async function recentAttemptCounts(emailHash: string, networkHash: string | null, userId?: string) {
  const result = (await db.execute(sql`
    select
      count(*) filter (where email_hash = ${emailHash})::int as "emailCount",
      count(*) filter (where ${networkHash}::text is not null and network_hash = ${networkHash})::int as "networkCount",
      count(*) filter (where ${userId ?? null}::uuid is not null and user_id = ${userId ?? null})::int as "userCount",
      min(occurred_at) filter (where email_hash = ${emailHash}) as "oldestEmailAttempt",
      min(occurred_at) filter (where ${networkHash}::text is not null and network_hash = ${networkHash}) as "oldestNetworkAttempt",
      min(occurred_at) filter (where ${userId ?? null}::uuid is not null and user_id = ${userId ?? null}) as "oldestUserAttempt"
      from auth_login_events
     where occurred_at > now() - (${LOGIN_WINDOW_S} * interval '1 second')
       and outcome in ('failure', 'mfa_failure')
  `)) as unknown as { rows: {
    emailCount: number;
    networkCount: number;
    userCount: number;
    oldestEmailAttempt: Date | null;
    oldestNetworkAttempt: Date | null;
    oldestUserAttempt: Date | null;
  }[] };
  const row = result.rows[0];
  return row ? {
    ...row,
    oldestEmailAttempt: dateValue(row.oldestEmailAttempt),
    oldestNetworkAttempt: dateValue(row.oldestNetworkAttempt),
    oldestUserAttempt: dateValue(row.oldestUserAttempt),
  } : {
    emailCount: 0,
    networkCount: 0,
    userCount: 0,
    oldestEmailAttempt: null,
    oldestNetworkAttempt: null,
    oldestUserAttempt: null,
  };
}

function attemptRateLimit(input: Awaited<ReturnType<typeof recentAttemptCounts>>, includeUser = false) {
  const emailLimited = input.emailCount >= EMAIL_ATTEMPT_LIMIT;
  const networkLimited = input.networkCount >= NETWORK_ATTEMPT_LIMIT;
  const userLimited = includeUser && input.userCount >= MFA_ATTEMPT_LIMIT;
  const retryAfter = Math.max(
    emailLimited ? slidingWindowRetryAfter(input.oldestEmailAttempt) : 0,
    networkLimited ? slidingWindowRetryAfter(input.oldestNetworkAttempt) : 0,
    userLimited ? slidingWindowRetryAfter(input.oldestUserAttempt) : 0,
  );
  return { limited: emailLimited || networkLimited || userLimited, retryAfter };
}

async function registerFailure(emailHash: string, state: LoginStateRow, userId: string | null) {
  const next = nextLockoutState(state);
  await db.execute(sql`
    update auth_login_state
       set user_id = coalesce(user_id, ${userId}), failure_count = ${next.failureCount},
           last_failed_at = ${next.lastFailedAt}, locked_until = ${next.lockedUntil}, updated_at = now()
     where email_hash = ${emailHash}
  `);
  return next;
}

async function resetFailures(emailHash: string, userId: string): Promise<void> {
  await db.execute(sql`
    update auth_login_state
       set user_id = ${userId}, failure_count = 0, last_failed_at = null,
           locked_until = null, updated_at = now()
     where email_hash = ${emailHash}
  `);
}

async function createLoginChallenge(input: {
  userId: string;
  emailHash: string;
  authMethod: AuthMethod;
  context: AuthRequestContext;
}): Promise<string> {
  const challengeId = randomUUID();
  const expiresEpoch = Math.floor(Date.now() / 1000) + LOGIN_CHALLENGE_TTL_S;
  const { networkHash, userAgentHash } = contextHashes(input.context);
  await db.execute(sql`
    insert into auth_login_challenges
      (id, user_id, email_hash, auth_method, network_hash, user_agent_hash, expires_at)
    values
      (${challengeId}, ${input.userId}, ${input.emailHash}, ${input.authMethod},
       ${networkHash}, ${userAgentHash}, ${new Date(expiresEpoch * 1000)})
  `);
  return makeChallengeToken(input.userId, challengeId, expiresEpoch);
}

function maybePruneAuthData(): void {
  if (randomBytes(1)[0] !== 0) return;
  void withBypassContext(async () => {
    await db.execute(sql`delete from auth_login_events where occurred_at < now() - (${AUTH_EVENT_RETENTION_DAYS} * interval '1 day')`);
    await db.execute(sql`delete from auth_login_challenges where expires_at < now() - interval '1 day'`);
    await db.execute(sql`delete from auth_sessions where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days'`);
    await db.execute(sql`
      delete from auth_login_state
       where user_id is null and updated_at < now() - interval '7 days'
         and (locked_until is null or locked_until < now())
    `);
  }).catch((error) => console.error("[auth] retention cleanup failed:", (error as Error).message));
}

/** Password primary authentication with distributed limits and lockout. */
export async function login(
  rawEmail: string,
  password: string,
  context: AuthRequestContext,
): Promise<LoginResult> {
  maybePruneAuthData();
  const email = normalizeLoginEmail(rawEmail);
  const usablePassword = typeof password === "string" && password.length > 0 && password.length <= 1024;
  const emailHash = privacyHash("email", email ?? rawEmail.slice(0, 320).toLowerCase())!;
  const { networkHash, userAgentHash } = contextHashes(context);

  return withBypass(async () => {
    await acquireAuthLocks(emailHash, networkHash);
    const userResult = email ? (await db.execute(sql`
      select u.id, u.password_hash as "passwordHash", f.enabled_at as "mfaEnabledAt"
        from users u
        join orgs o on o.id = u.org_id and o.env_kind = 'production'
        left join auth_mfa_factors f on f.user_id = u.id
       where lower(u.email) = ${email} and u.is_active
       order by u.created_at
       limit 2
       for update of u
    `)) as unknown as { rows: { id: string; passwordHash: string; mfaEnabledAt: Date | null }[] }
      : { rows: [] };
    // A login identity is global even though users rows are tenant-scoped.
    // Never guess when configuration has produced two active home identities.
    const user = userResult.rows.length === 1 ? userResult.rows[0] : null;
    const state = await ensureLoginState(emailHash, user?.id ?? null);
    const counts = await recentAttemptCounts(emailHash, networkHash);
    const limit = attemptRateLimit(counts);

    if (limit.limited) {
      await recordLoginEvent({ userId: user?.id ?? null, emailHash, outcome: "rate_limited", authMethod: "password", networkHash, userAgentHash });
      return { kind: "rate_limited", retryAfter: limit.retryAfter };
    }
    if (state.lockedUntil && state.lockedUntil.getTime() > Date.now()) {
      await recordLoginEvent({ userId: user?.id ?? null, emailHash, outcome: "locked", authMethod: "password", networkHash, userAgentHash });
      return { kind: "invalid", retryAfter: retryAfterSeconds(state.lockedUntil) };
    }
    // Active known and unknown identities both perform exactly one scrypt.
    // Already-limited requests skip that expensive work; the route-level delay
    // keeps their public response timing uniform without enabling CPU abuse.
    const passwordMatches = verifyPassword(
      usablePassword ? password : "invalid-password-shape",
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !usablePassword || !passwordMatches) {
      const next = await registerFailure(emailHash, state, user?.id ?? null);
      await recordLoginEvent({ userId: user?.id ?? null, emailHash, outcome: "failure", authMethod: "password", networkHash, userAgentHash });
      return { kind: "invalid", retryAfter: retryAfterSeconds(next.lockedUntil) };
    }

    if (user.mfaEnabledAt) {
      const challengeToken = await createLoginChallenge({ userId: user.id, emailHash, authMethod: "password", context });
      await recordLoginEvent({ userId: user.id, emailHash, outcome: "mfa_required", authMethod: "password", networkHash, userAgentHash });
      return { kind: "mfa_required", challengeToken };
    }

    await resetFailures(emailHash, user.id);
    await db.execute(sql`update users set last_login_at = now(), updated_at = now() where id = ${user.id}`);
    const token = await createSessionRecord(user.id, "password", context);
    await recordLoginEvent({ userId: user.id, emailHash, outcome: "success", authMethod: "password", networkHash, userAgentHash });
    return { kind: "success", token };
  });
}

function recoveryCodeHash(userId: string, normalized: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`openbooks:mfa-recovery:${userId}:${normalized}`)
    .digest("hex");
}

function consumeMfaCredential(input: {
  userId: string;
  secret: string;
  recoveryCodeHashes: string[];
  lastUsedStep: number | null;
  supplied: string;
}): { lastUsedStep: number | null; recoveryCodeHashes: string[] } | null {
  const totpStep = verifyTotpCode(input.secret, input.supplied, Date.now(), input.lastUsedStep);
  if (totpStep !== null) return { lastUsedStep: totpStep, recoveryCodeHashes: input.recoveryCodeHashes };
  const normalized = normalizeRecoveryCode(input.supplied);
  if (!normalized) return null;
  const expected = recoveryCodeHash(input.userId, normalized);
  const index = input.recoveryCodeHashes.findIndex((value) => signaturesEqual(value, expected));
  if (index < 0) return null;
  return {
    lastUsedStep: input.lastUsedStep,
    recoveryCodeHashes: input.recoveryCodeHashes.filter((_, candidate) => candidate !== index),
  };
}

/** Complete a password/OIDC login after TOTP or one-time recovery verification. */
export async function completeMfaLogin(
  rawChallengeToken: string | undefined,
  suppliedCode: string,
  context: AuthRequestContext,
): Promise<LoginResult> {
  const challengeToken = verifyChallengeToken(rawChallengeToken);
  if (!challengeToken || !suppliedCode || suppliedCode.length > 64) return { kind: "invalid", retryAfter: 0 };
  const { networkHash, userAgentHash } = contextHashes(context);

  return withBypass(async () => {
    const challengeResult = (await db.execute(sql`
      select c.user_id as "userId", c.email_hash as "emailHash", c.auth_method as "authMethod",
             c.expires_at as "expiresAt", c.consumed_at as "consumedAt"
        from auth_login_challenges c
       where c.id = ${challengeToken.challengeId} and c.user_id = ${challengeToken.userId}
       for update
    `)) as unknown as { rows: { userId: string; emailHash: string; authMethod: AuthMethod; expiresAt: Date; consumedAt: Date | null }[] };
    const challenge = challengeResult.rows[0];
    if (!challenge || challenge.consumedAt || (dateValue(challenge.expiresAt)?.getTime() ?? 0) <= Date.now()) {
      return { kind: "invalid", retryAfter: 0 };
    }
    await acquireAuthLocks(challenge.emailHash, networkHash);
    const state = await ensureLoginState(challenge.emailHash, challenge.userId);
    const counts = await recentAttemptCounts(challenge.emailHash, networkHash, challenge.userId);
    const limit = attemptRateLimit(counts, true);
    if (limit.limited) {
      await recordLoginEvent({ userId: challenge.userId, emailHash: challenge.emailHash, outcome: "rate_limited", authMethod: challenge.authMethod, networkHash, userAgentHash });
      return { kind: "rate_limited", retryAfter: limit.retryAfter };
    }
    if (state.lockedUntil && state.lockedUntil.getTime() > Date.now()) {
      await recordLoginEvent({ userId: challenge.userId, emailHash: challenge.emailHash, outcome: "locked", authMethod: challenge.authMethod, networkHash, userAgentHash });
      return { kind: "invalid", retryAfter: retryAfterSeconds(state.lockedUntil) };
    }

    const factorResult = (await db.execute(sql`
      select secret_encrypted as "secretEncrypted", recovery_code_hashes as "recoveryCodeHashes",
             last_used_step as "lastUsedStep"
        from auth_mfa_factors
       where user_id = ${challenge.userId} and enabled_at is not null
       for update
    `)) as unknown as { rows: { secretEncrypted: string; recoveryCodeHashes: string[]; lastUsedStep: number | null }[] };
    const factor = factorResult.rows[0];
    const secret = factor ? unsealSecret(factor.secretEncrypted) : null;
    const consumed = factor && secret ? consumeMfaCredential({
      userId: challenge.userId,
      secret,
      recoveryCodeHashes: Array.isArray(factor.recoveryCodeHashes) ? factor.recoveryCodeHashes : [],
      lastUsedStep: factor.lastUsedStep,
      supplied: suppliedCode,
    }) : null;

    if (!consumed) {
      const next = await registerFailure(challenge.emailHash, state, challenge.userId);
      await recordLoginEvent({ userId: challenge.userId, emailHash: challenge.emailHash, outcome: "mfa_failure", authMethod: challenge.authMethod, networkHash, userAgentHash });
      return { kind: "invalid", retryAfter: retryAfterSeconds(next.lockedUntil) };
    }

    await db.execute(sql`
      update auth_mfa_factors
         set last_used_step = ${consumed.lastUsedStep},
             recovery_code_hashes = ${JSON.stringify(consumed.recoveryCodeHashes)}::jsonb,
             updated_at = now()
       where user_id = ${challenge.userId}
    `);
    await db.execute(sql`update auth_login_challenges set consumed_at = now() where id = ${challengeToken.challengeId}`);
    await resetFailures(challenge.emailHash, challenge.userId);
    await db.execute(sql`update users set last_login_at = now(), updated_at = now() where id = ${challenge.userId}`);
    const token = await createSessionRecord(challenge.userId, challenge.authMethod, context);
    await recordLoginEvent({ userId: challenge.userId, emailHash: challenge.emailHash, outcome: "success", authMethod: challenge.authMethod, networkHash, userAgentHash });
    return { kind: "success", token };
  });
}

export async function getMfaStatus(userId: string): Promise<{ enabled: boolean; recoveryCodesRemaining: number }> {
  return withBypassContext(async () => {
    const result = (await db.execute(sql`
      select enabled_at as "enabledAt", jsonb_array_length(recovery_code_hashes) as "recoveryCodesRemaining"
        from auth_mfa_factors where user_id = ${userId}
    `)) as unknown as { rows: { enabledAt: Date | null; recoveryCodesRemaining: number }[] };
    const row = result.rows[0];
    return { enabled: !!row?.enabledAt, recoveryCodesRemaining: row?.recoveryCodesRemaining ?? 0 };
  });
}

export async function beginMfaSetup(userId: string): Promise<{ secret: string; provisioningUri: string }> {
  return withBypass(async () => {
    const userResult = (await db.execute(sql`select email from users where id = ${userId} and is_active for update`)) as unknown as { rows: { email: string }[] };
    const user = userResult.rows[0];
    if (!user) throw new Error("user not found");
    const existing = (await db.execute(sql`select enabled_at as "enabledAt" from auth_mfa_factors where user_id = ${userId} for update`)) as unknown as { rows: { enabledAt: Date | null }[] };
    if (existing.rows[0]?.enabledAt) throw new Error("MFA is already enabled");
    const secret = generateTotpSecret();
    await db.execute(sql`
      insert into auth_mfa_factors (user_id, secret_encrypted)
      values (${userId}, ${sealSecret(secret)})
      on conflict (user_id) do update
        set secret_encrypted = excluded.secret_encrypted, recovery_code_hashes = '[]'::jsonb,
            last_used_step = null, enabled_at = null, updated_at = now()
    `);
    return { secret, provisioningUri: totpProvisioningUri({ secret, email: user.email }) };
  });
}

export async function confirmMfaSetup(userId: string, suppliedCode: string): Promise<string[] | null> {
  return withBypass(async () => {
    const result = (await db.execute(sql`
      select secret_encrypted as "secretEncrypted", enabled_at as "enabledAt"
        from auth_mfa_factors where user_id = ${userId} for update
    `)) as unknown as { rows: { secretEncrypted: string; enabledAt: Date | null }[] };
    const factor = result.rows[0];
    if (!factor || factor.enabledAt) return null;
    const secret = unsealSecret(factor.secretEncrypted);
    if (!secret) return null;
    const step = verifyTotpCode(secret, suppliedCode);
    if (step === null) return null;
    const recoveryCodes = generateRecoveryCodes();
    const hashes = recoveryCodes.map((code) => recoveryCodeHash(userId, normalizeRecoveryCode(code)!));
    await db.execute(sql`
      update auth_mfa_factors
         set enabled_at = now(), last_used_step = ${step},
             recovery_code_hashes = ${JSON.stringify(hashes)}::jsonb, updated_at = now()
       where user_id = ${userId}
    `);
    return recoveryCodes;
  });
}

async function verifyEnabledMfaFactor(userId: string, suppliedCode: string) {
  const result = (await db.execute(sql`
    select secret_encrypted as "secretEncrypted", recovery_code_hashes as "recoveryCodeHashes",
           last_used_step as "lastUsedStep"
      from auth_mfa_factors where user_id = ${userId} and enabled_at is not null for update
  `)) as unknown as { rows: { secretEncrypted: string; recoveryCodeHashes: string[]; lastUsedStep: number | null }[] };
  const factor = result.rows[0];
  const secret = factor ? unsealSecret(factor.secretEncrypted) : null;
  if (!factor || !secret) return null;
  return consumeMfaCredential({
    userId,
    secret,
    recoveryCodeHashes: Array.isArray(factor.recoveryCodeHashes) ? factor.recoveryCodeHashes : [],
    lastUsedStep: factor.lastUsedStep,
    supplied: suppliedCode,
  });
}

async function reauthenticateMfaSecurityChange(
  userId: string,
  password: string,
  suppliedCode: string,
  context: AuthRequestContext,
) {
  const identityResult = (await db.execute(sql`
    select email from users where id = ${userId} and is_active
  `)) as unknown as { rows: { email: string }[] };
  const email = normalizeLoginEmail(identityResult.rows[0]?.email ?? "");
  if (!email) return null;
  const emailHash = privacyHash("email", email)!;
  const { networkHash, userAgentHash } = contextHashes(context);
  await acquireAuthLocks(emailHash, networkHash);
  const userResult = (await db.execute(sql`
    select email, password_hash as "passwordHash"
      from users where id = ${userId} and is_active for update
  `)) as unknown as { rows: { email: string; passwordHash: string }[] };
  const user = userResult.rows[0];
  if (!user || normalizeLoginEmail(user.email) !== email) return null;
  const state = await ensureLoginState(emailHash, userId);
  const counts = await recentAttemptCounts(emailHash, networkHash, userId);
  const limit = attemptRateLimit(counts, true);
  if (limit.limited) {
    await recordLoginEvent({ userId, emailHash, outcome: "rate_limited", authMethod: "password", networkHash, userAgentHash });
    return null;
  }
  if (state.lockedUntil && state.lockedUntil.getTime() > Date.now()) {
    await recordLoginEvent({ userId, emailHash, outcome: "locked", authMethod: "password", networkHash, userAgentHash });
    return null;
  }
  const passwordMatches = password.length > 0
    && password.length <= 1024
    && verifyPassword(password, user.passwordHash);
  const verified = passwordMatches
    ? await verifyEnabledMfaFactor(userId, suppliedCode)
    : null;
  if (!verified) {
    await registerFailure(emailHash, state, userId);
    await recordLoginEvent({ userId, emailHash, outcome: "mfa_failure", authMethod: "password", networkHash, userAgentHash });
    return null;
  }
  await resetFailures(emailHash, userId);
  await recordLoginEvent({ userId, emailHash, outcome: "success", authMethod: "password", networkHash, userAgentHash });
  return verified;
}

export async function disableMfa(
  userId: string,
  password: string,
  suppliedCode: string,
  keepSessionId: string,
  context: AuthRequestContext,
): Promise<boolean> {
  return withBypass(async () => {
    const verified = await reauthenticateMfaSecurityChange(userId, password, suppliedCode, context);
    if (!verified) return false;
    await db.execute(sql`delete from auth_mfa_factors where user_id = ${userId}`);
    await db.execute(sql`
      update auth_sessions set revoked_at = now(), revocation_reason = 'mfa_disabled'
       where user_id = ${userId} and id <> ${keepSessionId} and revoked_at is null
    `);
    return true;
  });
}

export async function rotateRecoveryCodes(
  userId: string,
  password: string,
  suppliedCode: string,
  context: AuthRequestContext,
): Promise<string[] | null> {
  return withBypass(async () => {
    const verified = await reauthenticateMfaSecurityChange(userId, password, suppliedCode, context);
    if (!verified) return null;
    const recoveryCodes = generateRecoveryCodes();
    const hashes = recoveryCodes.map((code) => recoveryCodeHash(userId, normalizeRecoveryCode(code)!));
    await db.execute(sql`
      update auth_mfa_factors
         set last_used_step = ${verified.lastUsedStep},
             recovery_code_hashes = ${JSON.stringify(hashes)}::jsonb, updated_at = now()
       where user_id = ${userId}
    `);
    return recoveryCodes;
  });
}

export async function revokeSessionToken(token: string | undefined, reason = "logout"): Promise<void> {
  const parsed = verifySessionTokenParts(token);
  if (!parsed) return;
  await withBypassContext(async () => {
    await db.execute(sql`
      update auth_sessions set revoked_at = now(), revocation_reason = ${reason}
       where id = ${parsed.sessionId} and user_id = ${parsed.userId}
         and token_hash = ${tokenHash(token!)} and revoked_at is null
    `);
  });
}

export async function listUserSessions(userId: string, currentSessionId: string) {
  return withBypassContext(async () => {
    const result = (await db.execute(sql`
      select id, auth_method as "authMethod", created_at as "createdAt",
             last_seen_at as "lastSeenAt", expires_at as "expiresAt",
             id = ${currentSessionId} as "current"
        from auth_sessions
       where user_id = ${userId} and revoked_at is null and expires_at > now()
       order by last_seen_at desc
    `)) as unknown as { rows: { id: string; authMethod: AuthMethod; createdAt: Date; lastSeenAt: Date; expiresAt: Date; current: boolean }[] };
    return result.rows;
  });
}

export async function revokeUserSession(userId: string, sessionId: string, reason = "user_revoked"): Promise<boolean> {
  return withBypassContext(async () => {
    const result = await db.execute(sql`
      update auth_sessions set revoked_at = now(), revocation_reason = ${reason}
       where id = ${sessionId} and user_id = ${userId} and revoked_at is null
    `);
    return Number((result as unknown as { rowCount?: number }).rowCount ?? 0) > 0;
  });
}

export async function revokeOtherUserSessions(userId: string, keepSessionId: string): Promise<number> {
  return withBypassContext(async () => {
    const result = await db.execute(sql`
      update auth_sessions set revoked_at = now(), revocation_reason = 'user_revoked_others'
       where user_id = ${userId} and id <> ${keepSessionId} and revoked_at is null
    `);
    return Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
  });
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  roles: ReadonlyArray<{ key: string; name: string }>;
  orgId: string;
  envKind: "production" | "sandbox" | "preview";
  productionOrgId: string;
  sandboxName?: string;
  isSuperAdmin: boolean;
  homeUserId: string;
  homeOrgId: string;
  /** Present for browser sessions; absent for API-key synthesized principals. */
  sessionId?: string;
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const session = await validateSessionToken(jar.get(COOKIE)?.value);
  if (!session) return null;
  const home = await withBypassContext(async () => {
    const result = (await db.execute(sql`
      select id, email, name, org_id as "orgId", is_super_admin as "isSuperAdmin"
        from users where id = ${session.userId} and is_active
    `)) as unknown as { rows: { id: string; email: string; name: string; orgId: string; isSuperAdmin: boolean }[] };
    return result.rows[0];
  });
  if (!home) return null;

  const homeUser = { id: home.id, orgId: home.orgId, isSuperAdmin: !!home.isSuperAdmin };
  const activeOrgId = verifyEnvToken(jar.get(ACTIVE_ENV_COOKIE)?.value);
  const activeEnvironment = (await resolveActiveEnv(homeUser, activeOrgId))
    ?? (await resolveActiveEnv(homeUser, null))!;
  setRequestOrg(activeEnvironment.orgId);
  const roles = await withBypassContext(async () => {
    const result = (await db.execute(sql`
      select r.key, r.name
        from role_assignments assignment
        join app_roles r on r.id = assignment.role_id and r.org_id = assignment.org_id
       where assignment.org_id = ${activeEnvironment.orgId}
         and assignment.user_id = ${activeEnvironment.actingUserId}
       order by r.is_built_in desc, r.name, r.key
    `)) as unknown as { rows: { key: string; name: string }[] };
    return result.rows;
  });
  if (!homeUser.isSuperAdmin && roles.length === 0) return null;
  return {
    id: activeEnvironment.actingUserId,
    email: home.email,
    name: home.name,
    roles,
    orgId: activeEnvironment.orgId,
    envKind: activeEnvironment.envKind,
    productionOrgId: activeEnvironment.productionOrgId,
    sandboxName: activeEnvironment.sandboxName,
    isSuperAdmin: homeUser.isSuperAdmin,
    homeUserId: homeUser.id,
    homeOrgId: homeUser.orgId,
    sessionId: session.sessionId,
  };
}

/** Called only after a fully verified OIDC identity has been resolved. */
export async function finishOidcLogin(input: {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  context: AuthRequestContext;
}): Promise<LoginResult> {
  const normalizedEmail = normalizeLoginEmail(input.email);
  if (!normalizedEmail || !input.emailVerified) return { kind: "invalid", retryAfter: 0 };
  const emailHash = privacyHash("email", normalizedEmail)!;
  const { networkHash, userAgentHash } = contextHashes(input.context);
  return withBypass(async () => {
    await acquireAuthLocks(emailHash, networkHash);
    const mapped = (await db.execute(sql`
      select u.id, f.enabled_at as "mfaEnabledAt"
        from auth_oidc_identities identity
        join users u on u.id = identity.user_id and u.is_active
        join orgs o on o.id = u.org_id and o.env_kind = 'production'
        left join auth_mfa_factors f on f.user_id = u.id
       where identity.issuer = ${input.issuer} and identity.subject = ${input.subject}
       for update of u
    `)) as unknown as { rows: { id: string; mfaEnabledAt: Date | null }[] };
    let user = mapped.rows[0] ?? null;
    if (!user) {
      const candidates = (await db.execute(sql`
        select u.id, f.enabled_at as "mfaEnabledAt"
          from users u
          join orgs o on o.id = u.org_id and o.env_kind = 'production'
          left join auth_mfa_factors f on f.user_id = u.id
         where lower(u.email) = ${normalizedEmail} and u.is_active
         order by u.created_at
         limit 2
         for update of u
      `)) as unknown as { rows: { id: string; mfaEnabledAt: Date | null }[] };
      // Ambiguous emails must be linked administratively, never guessed.
      if (candidates.rows.length !== 1) {
        await recordLoginEvent({ userId: null, emailHash, outcome: "oidc_failure", authMethod: "oidc", networkHash, userAgentHash });
        return { kind: "invalid", retryAfter: 0 };
      }
      user = candidates.rows[0];
      const linked = (await db.execute(sql`
        insert into auth_oidc_identities (issuer, subject, user_id, email_at_link, last_login_at)
        values (${input.issuer}, ${input.subject}, ${user.id}, ${normalizedEmail}, now())
        on conflict (issuer, subject) do update set last_login_at = now()
        returning user_id as "userId"
      `)) as unknown as { rows: { userId: string }[] };
      if (linked.rows[0]?.userId !== user.id) {
        await recordLoginEvent({ userId: null, emailHash, outcome: "oidc_failure", authMethod: "oidc", networkHash, userAgentHash });
        return { kind: "invalid", retryAfter: 0 };
      }
    } else {
      await db.execute(sql`
        update auth_oidc_identities set last_login_at = now()
         where issuer = ${input.issuer} and subject = ${input.subject}
      `);
    }
    await ensureLoginState(emailHash, user.id);
    if (user.mfaEnabledAt) {
      const challengeToken = await createLoginChallenge({ userId: user.id, emailHash, authMethod: "oidc", context: input.context });
      await recordLoginEvent({ userId: user.id, emailHash, outcome: "mfa_required", authMethod: "oidc", networkHash, userAgentHash });
      return { kind: "mfa_required", challengeToken };
    }
    await resetFailures(emailHash, user.id);
    await db.execute(sql`update users set last_login_at = now(), updated_at = now() where id = ${user.id}`);
    const token = await createSessionRecord(user.id, "oidc", input.context);
    await recordLoginEvent({ userId: user.id, emailHash, outcome: "success", authMethod: "oidc", networkHash, userAgentHash });
    return { kind: "success", token };
  });
}

export const ACTIVE_ENV_COOKIE_NAME = ACTIVE_ENV_COOKIE;
export const SESSION_COOKIE = COOKIE;
export const SESSION_TTL_S = TTL_S;

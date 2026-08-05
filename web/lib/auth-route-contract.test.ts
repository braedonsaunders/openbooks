import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("login cookies use the environment-aware production-secure policy", () => {
  const route = readFileSync("web/app/api/login/route.ts", "utf8");
  assert.match(route, /secure: useSecureCookies\(\)/);
  assert.doesNotMatch(route, /secure:\s*false/);
  assert.match(route, /revokeSessionToken/);
  assert.match(route, /publicLoginFailure/);
  assert.doesNotMatch(route, /kind === "invalid"[\s\S]{0,300}retryAfter:\s*result\.retryAfter/);
});

test("the request proxy checks server-side session revocation", () => {
  const proxy = readFileSync("web/proxy.ts", "utf8");
  assert.match(proxy, /isSessionRecordActive/);
  assert.match(proxy, /parseSessionTokenFormat/);
  assert.match(proxy, /requireSessionSecret/);
});

test("only real credential failures advance the distributed attempt window", () => {
  const auth = readFileSync("web/lib/auth.ts", "utf8");
  assert.match(auth, /outcome in \('failure', 'mfa_failure'\)/);
  const limiterQuery = auth.match(/async function recentAttemptCounts[\s\S]*?return result\.rows\[0\]/)?.[0] ?? "";
  assert.doesNotMatch(limiterQuery, /'rate_limited'/);
  assert.doesNotMatch(limiterQuery, /'locked'/);
  assert.doesNotMatch(limiterQuery, /'mfa_required'/);
  assert.match(limiterQuery, /where email_hash = \$\{emailHash\}/);
  assert.match(limiterQuery, /where \$\{networkHash\}::text is not null[\s\S]*network_hash = \$\{networkHash\}/);
  assert.match(limiterQuery, /where \$\{userId \?\? null\}::uuid is not null[\s\S]*user_id = \$\{userId \?\? null\}/);
});

test("recovery-code rotation requires password plus MFA reauthentication", () => {
  const route = readFileSync("web/app/api/auth/mfa/recovery/route.ts", "utf8");
  assert.match(route, /typeof body\?\.password !== "string"/);
  assert.match(route, /rotateRecoveryCodes\([\s\S]*body\.password,[\s\S]*body\.code/);
  assert.match(route, /authRequestContext\(request\)/);
});

test("MFA enrollment requires primary reauthentication and is bound to the active session", () => {
  const route = readFileSync("web/app/api/auth/mfa/route.ts", "utf8");
  assert.match(route, /typeof body\?\.password !== "string"/);
  assert.match(route, /beginMfaSetup\([\s\S]*user\.sessionId,[\s\S]*body\.password,[\s\S]*authRequestContext\(request\)/);
  assert.match(route, /confirmMfaSetup\(user\.homeUserId, user\.sessionId, body\.code\)/);

  const auth = readFileSync("web/lib/auth.ts", "utf8");
  assert.match(auth, /MFA_SETUP_TTL_S/);
  assert.match(auth, /MFA_SETUP_ATTEMPT_LIMIT/);
  assert.match(auth, /revocation_reason = 'mfa_enabled'/);
  assert.match(auth, /global:password-primary/);
  assert.match(auth, /if \(!user && deploymentLimit\.limited\)/);
  assert.match(auth, /ensureLoginState\(emailHash, user\?\.id \?\? null\)/);
  assert.match(auth, /if \(passwordVerification\.capacityLimited\)[\s\S]{0,120}kind: "invalid"/);
});

test("auth migration supports bounded setup and indexed login resolution", () => {
  const migration = readFileSync("schema/migrations/generated/0129_auth_security.sql", "utf8");
  assert.match(migration, /setup_session_id uuid references public\.auth_sessions\(id\) on delete cascade/i);
  assert.match(migration, /setup_expires_at timestamptz/i);
  assert.match(migration, /setup_attempt_count integer/i);
  assert.match(migration, /create table public\.auth_rate_limit_buckets/i);
  assert.match(migration, /create index users_login_email_ci on public\.users\(lower\(email\)\) where is_active/i);
  assert.match(migration, /auth_login_events_email_failure_time/i);
});

test("recovery hashes are salted and independent of the session key", () => {
  const auth = readFileSync("web/lib/auth.ts", "utf8");
  assert.match(auth, /hashRecoveryCode/);
  assert.match(auth, /verifyRecoveryCodeHash/);
  assert.doesNotMatch(auth, /mfa-recovery:[^\n]*SESSION_SECRET/);
});

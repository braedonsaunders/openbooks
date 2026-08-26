import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isPublicPath } from "./proxy-policy";

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

test("authentication secrets are required at runtime without blocking secret-free image builds", () => {
  const auth = readFileSync("web/lib/auth.ts", "utf8");
  const oidc = readFileSync("web/lib/auth-oidc.ts", "utf8");
  for (const source of [auth, oidc]) {
    assert.doesNotMatch(source, /const SESSION_SECRET = requireSessionSecret/);
    assert.match(source, /function sessionSecret\(\): string \{[\s\S]{0,100}return requireSessionSecret\(env\)/);
  }
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

test("canonical baseline supports bounded setup and indexed login resolution", () => {
  const migration = readFileSync("schema/migrations/generated/0001_baseline.sql", "utf8");
  assert.match(migration, /setup_session_id uuid/i);
  assert.match(migration, /setup_expires_at timestamp with time zone/i);
  assert.match(migration, /setup_attempt_count integer/i);
  assert.match(migration, /create table public\.auth_rate_limit_buckets/i);
  assert.match(migration, /auth_mfa_factors_setup_session_id_fkey foreign key \(setup_session_id\) references public\.auth_sessions\(id\) on delete cascade/i);
  assert.match(migration, /create index users_login_email_ci on public\.users using btree \(lower\(email\)\) where is_active/i);
  assert.match(migration, /auth_login_events_email_failure_time/i);
});

test("recovery hashes are salted and independent of the session key", () => {
  const auth = readFileSync("web/lib/auth.ts", "utf8");
  assert.match(auth, /hashRecoveryCode/);
  assert.match(auth, /verifyRecoveryCodeHash/);
  assert.doesNotMatch(auth, /mfa-recovery:[^\n]*SESSION_SECRET/);
});

test("external field-ticket signing is publicly reachable but possession-authenticated", () => {
  for (const pathname of [
    "/sign",
    "/sign/field-tickets/b3JnLnRpY2tldA.aGVsbG8.sig",
    "/api/sign",
    "/api/sign/field-tickets",
  ]) {
    assert.equal(isPublicPath(pathname), true, pathname);
  }
  // Segment matching keeps lookalike prefixes behind the session gate.
  for (const pathname of ["/sign-in", "/signature", "/api/signature", "/api/signing"]) {
    assert.equal(isPublicPath(pathname), false, pathname);
  }

  // Public never means unauthenticated: both surfaces verify the HMAC token
  // and the persisted request inside the route, so invalid, expired, revoked,
  // or tampered links fail closed instead of rendering or accepting a
  // signature.
  const page = readFileSync("web/app/sign/field-tickets/[token]/page.tsx", "utf8");
  const api = readFileSync("web/app/api/sign/field-tickets/route.ts", "utf8");
  for (const source of [page, api]) {
    assert.match(source, /verifySigningToken\(/);
    assert.match(source, /validateSigningRequest\(/);
  }
  assert.match(page, /if \(!verified\) notFound\(\)/);
  assert.match(page, /catch \{[\s\S]*?notFound\(\)/);
  assert.match(api, /This signing link is invalid or expired/, "tampered tokens must be refused");
  assert.match(api, /status: 401/);
});

test("public reachability stays an explicit allowlist decision in the proxy policy", () => {
  const policy = readFileSync("web/lib/proxy-policy.ts", "utf8");
  // Any change to these lists — a new public page or segment root — must land
  // as a reviewed edit to this contract, so a sessionless surface can never
  // ship silently.
  const listedPaths = (listName: string): string[] => {
    const block = policy.match(new RegExp(`const ${listName}[^\\[]*\\[([\\s\\S]*?)\\]`))?.[1] ?? "";
    return [...block.matchAll(/"(\/[^"]*)"/g)].map((entry) => entry[1]!);
  };
  assert.deepEqual(listedPaths("EXACT_PUBLIC_PATHS").sort(), [
    "/api/auth/methods",
    "/api/flows/email-action",
    "/api/login",
    "/api/password-reset",
    "/api/v1/health",
    "/api/v1/openapi",
    "/api/v1/schema",
    "/favicon.ico",
    "/icon.svg",
    "/login",
    "/login/reset",
    "/mcp",
    "/socialmedia.png",
  ]);
  assert.deepEqual(listedPaths("PUBLIC_SEGMENT_ROOTS").sort(), [
    "/api/auth/oidc",
    "/api/internal",
    "/api/pay",
    "/api/payments/webhooks",
    "/api/sign",
    "/api/v1/records",
    "/pay",
    "/sign",
  ]);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("login cookies use the environment-aware production-secure policy", () => {
  const route = readFileSync("web/app/api/login/route.ts", "utf8");
  assert.match(route, /secure: useSecureCookies\(\)/);
  assert.doesNotMatch(route, /secure:\s*false/);
  assert.match(route, /revokeSessionToken/);
});

test("the request proxy checks server-side session revocation", () => {
  const proxy = readFileSync("web/proxy.ts", "utf8");
  assert.match(proxy, /isSessionRecordActive/);
  assert.match(proxy, /parseSessionTokenFormat/);
});

test("only real credential failures advance the distributed attempt window", () => {
  const auth = readFileSync("web/lib/auth.ts", "utf8");
  assert.match(auth, /outcome in \('failure', 'mfa_failure'\)/);
  const limiterQuery = auth.match(/async function recentAttemptCounts[\s\S]*?return result\.rows\[0\]/)?.[0] ?? "";
  assert.doesNotMatch(limiterQuery, /'rate_limited'/);
  assert.doesNotMatch(limiterQuery, /'locked'/);
  assert.doesNotMatch(limiterQuery, /'mfa_required'/);
});

test("recovery-code rotation requires password plus MFA reauthentication", () => {
  const route = readFileSync("web/app/api/auth/mfa/recovery/route.ts", "utf8");
  assert.match(route, /typeof body\?\.password !== "string"/);
  assert.match(route, /rotateRecoveryCodes\([\s\S]*body\.password,[\s\S]*body\.code/);
  assert.match(route, /authRequestContext\(request\)/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./e2e-production-server.mjs", import.meta.url), "utf8");

test("the production e2e server names its public origin and its TLS proxy", () => {
  // NODE_ENV=test on the workflow job cannot reach the Next process:
  // this script overwrites NODE_ENV to production so the suite keeps
  // production Secure cookies. CSRF after f5ce3563c needs the public
  // HTTPS origin named, or TRUST_PROXY so the proxy's forwarded pair
  // is the deployment. Unnamed, POST /api/login is 403 forbidden.
  assert.match(source, /NODE_ENV: 'production'/);
  assert.match(source, /OPENBOOKS_APP_URL: publicOrigin/);
  assert.match(source, /https:\/\/localhost:4780/);
  assert.match(source, /OPENBOOKS_TRUST_PROXY: process\.env\.OPENBOOKS_TRUST_PROXY \?\? '1'/);
  assert.doesNotMatch(source, /NODE_ENV: 'test'/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { requireSessionSecret } from "./auth-secret-policy";

test("production authentication rejects missing, short, placeholder, and repetitive signing keys", () => {
  assert.throws(() => requireSessionSecret({ NODE_ENV: "production" }), /required/);
  assert.throws(
    () => requireSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "short" }),
    /32 random bytes/,
  );
  assert.throws(
    () => requireSessionSecret({
      NODE_ENV: "production",
      SESSION_SECRET: "replace-with-this-session-secret-1234567890",
    }),
    /32 random bytes/,
  );
  assert.throws(
    () => requireSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "abcd".repeat(16) }),
    /32 random bytes/,
  );
});

test("production accepts a sufficiently diverse 32-byte-or-longer signing key", () => {
  const secret = Array.from({ length: 40 }, (_, index) => String.fromCharCode(33 + index)).join("");
  assert.equal(requireSessionSecret({ NODE_ENV: "production", SESSION_SECRET: secret }), secret);
});

test("development retains a low-friction key while still requiring one", () => {
  assert.equal(requireSessionSecret({ NODE_ENV: "development", SESSION_SECRET: "dev" }), "dev");
});

test("unset or misspelled NODE_ENV refuses a weak session signing key", () => {
  const weak = { SESSION_SECRET: "dev" };
  assert.throws(() => requireSessionSecret(weak), /32 random bytes/);
  assert.throws(() => requireSessionSecret({ NODE_ENV: "", ...weak }), /32 random bytes/);
  assert.throws(() => requireSessionSecret({ NODE_ENV: "prodction", ...weak }), /32 random bytes/);
  assert.throws(() => requireSessionSecret({ NODE_ENV: "Production", ...weak }), /32 random bytes/);
  assert.equal(requireSessionSecret({ NODE_ENV: "test", ...weak }), "dev");
});

test("unset NODE_ENV still accepts a sufficiently diverse signing key", () => {
  const secret = Array.from({ length: 40 }, (_, index) => String.fromCharCode(33 + index)).join("");
  assert.equal(requireSessionSecret({ SESSION_SECRET: secret }), secret);
});

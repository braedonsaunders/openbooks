import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import test from "node:test";
import { hashPassword, verifyPassword } from "./auth-password";

test("new password hashes are versioned and verified asynchronously", async () => {
  const pending = hashPassword("correct horse battery staple");
  assert.ok(pending instanceof Promise);
  const stored = await pending;
  assert.match(stored, /^s2:16384:8:1:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.deepEqual(await verifyPassword("correct horse battery staple", stored), {
    valid: true,
    needsRehash: false,
  });
  assert.deepEqual(await verifyPassword("wrong", stored), {
    valid: false,
    needsRehash: false,
  });
});

test("legacy salt:hash credentials remain valid and request opportunistic upgrade", async () => {
  const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const hash = scryptSync("legacy password", salt, 64).toString("hex");
  assert.deepEqual(await verifyPassword("legacy password", `${salt.toString("hex")}:${hash}`), {
    valid: true,
    needsRehash: true,
  });
});

test("malformed or excessive work factors fail without invoking scrypt", async () => {
  assert.deepEqual(await verifyPassword("password", "malformed"), {
    valid: false,
    needsRehash: false,
  });
  const excessive = `s2:1048576:8:1:${"00".repeat(16)}:${"00".repeat(64)}`;
  assert.deepEqual(await verifyPassword("password", excessive), {
    valid: false,
    needsRehash: false,
  });
});

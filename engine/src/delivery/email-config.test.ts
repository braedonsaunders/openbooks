import assert from "node:assert/strict";
import test from "node:test";
import {
  emailSecretChange,
  OrgEmailConfigConflictError,
  redactEmailConfig,
  saveOrgEmailConfig,
  type SaveOrgEmailInput,
} from "./email-config.ts";

/**
 * Unit contract for the pieces of provider-configuration evidence that need
 * no database: secret redaction, the credential change marker derivation, and
 * the fail-closed attribution gate that runs before any database work. The
 * live-PostgreSQL transaction/audit/OCC behavior is proven in
 * email-config.integration.test.ts.
 */

const SEALED = { keyCiphertext: "c2VhbGVkLWNpcGhlcnRleHQ", keyNonce: "c2VhbGVkLW5vbmNl" };

test("redactEmailConfig strips the sealed secret and reports whether one exists", () => {
  const withSecret = redactEmailConfig({ provider: "resend", fromEmail: "billing@example.test", ...SEALED });
  assert.equal(withSecret.hasSecret, true);
  assert.equal("keyCiphertext" in withSecret, false, "the seal ciphertext must never leave the store");
  assert.equal("keyNonce" in withSecret, false, "the seal nonce must never leave the store");
  assert.equal(withSecret.provider, "resend");

  assert.equal(redactEmailConfig({ provider: "smtp", smtpHost: "smtp.example.test" }).hasSecret, false);
  assert.equal(redactEmailConfig(null).hasSecret, false);
  // A half-written seal is no secret: both halves are required.
  assert.equal(redactEmailConfig({ keyCiphertext: SEALED.keyCiphertext }).hasSecret, false);
});

test("emailSecretChange derives the audit credential marker without secret material", () => {
  const without = redactEmailConfig({ provider: "resend" });
  const withSecret = redactEmailConfig({ provider: "resend", ...SEALED });

  assert.equal(emailSecretChange({ secret: "sk_live_one" }, without, withSecret), "added");
  assert.equal(emailSecretChange({ secret: "sk_live_two" }, withSecret, withSecret), "rotated");
  assert.equal(emailSecretChange({ secret: null }, withSecret, without), "cleared");
  // Keep-as-is (undefined) and a blank supplied secret both preserve the stored credential.
  assert.equal(emailSecretChange({}, withSecret, withSecret), "unchanged");
  assert.equal(emailSecretChange({ secret: "   " }, withSecret, withSecret), "unchanged");
  assert.equal(emailSecretChange({}, without, without), "unchanged");
});

test("a user-actor save without a usable id is rejected before any database work", async () => {
  await assert.rejects(
    saveOrgEmailConfig("00000000-0000-0000-0000-000000000000", { enabled: false } satisfies SaveOrgEmailInput, {
      kind: "user",
      userId: "   ",
    }),
    /non-empty acting user id/u,
  );
  await assert.rejects(
    saveOrgEmailConfig("00000000-0000-0000-0000-000000000000", { enabled: false }, { kind: "user", userId: "" }),
    /non-empty acting user id/u,
  );
});

test("the conflict error names both revisions so a caller can reload deterministically", () => {
  const error = new OrgEmailConfigConflictError("2026-08-27T00:00:00.000Z", "2026-08-27T00:01:00.000Z");
  assert.equal(error.name, "OrgEmailConfigConflictError");
  assert.equal(error.expectedUpdatedAt, "2026-08-27T00:00:00.000Z");
  assert.equal(error.persistedUpdatedAt, "2026-08-27T00:01:00.000Z");
  assert.match(error.message, /reload the settings view and retry/u);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The Admin Users -> linked person workflow renders its drawer, reason and
// attestation copy from the shared en/admin labels. Every locale must carry
// them: a missing key renders the raw path mid-workflow. (The audited save
// path itself — attestation, active scope, self-refusal, stale 409s, exact
// audit — is proved through the real route in
// web/app/api/admin/users/route-party.test.ts.)
const MESSAGES = join(import.meta.dirname, "..", "..", "..", "..", "messages");
const LOCALES = ["en", "fr", "de", "es", "pt-BR", "ja", "zh"];
const KEYS = [
  "linkPersonButton",
  "linkPersonTitle",
  "linkPersonDescription",
  "linkAttestationLabel",
  "linkSelfRefused",
] as const;

const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(MESSAGES, locale, "admin.json"), "utf8")) as Record<string, unknown>;

test("every locale labels the linked-person workflow", () => {
  for (const locale of LOCALES) {
    const users = (catalog(locale).users ?? {}) as Record<string, unknown>;
    for (const key of KEYS) {
      const value = users[key];
      assert.equal(typeof value, "string", `${locale} users.${key} must exist`);
      assert.ok((value as string).length > 0, `${locale} users.${key} must not be empty`);
    }
  }
  const en = catalog("en").users as Record<string, unknown>;
  for (const locale of LOCALES.slice(1)) {
    const users = catalog(locale).users as Record<string, unknown>;
    for (const key of KEYS) {
      assert.notEqual(users[key], en[key], `${locale} users.${key} must not paste the English copy`);
    }
  }
});

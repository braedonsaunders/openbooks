import assert from "node:assert/strict";
import { registerHooks } from "node:module";
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
 * no live database: secret redaction, the credential change marker
 * derivation, the fail-closed attribution gate that runs before any database
 * work, and the email_log sent/failed/uncertain write-effect refusals. The
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

const writeEffectHarness = {
  responses: [] as Array<{ rows: unknown[] }>,
  queries: [] as Array<{ text: string }>,
  execute(query: { text?: string }) {
    const text = String(query.text ?? "");
    this.queries.push({ text });
    return this.responses.shift() ?? { rows: [] };
  },
  reset() {
    this.responses.length = 0;
    this.queries.length = 0;
  },
};

(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.email-log-write-effect-test")] =
  writeEffectHarness;

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Scope the mock to the cache-busted graph only so other files in this
    // process still load the real email-config database binding.
    if (!context.parentURL?.includes("write-effect-audit")) return nextResolve(specifier, context);
    if (specifier === "drizzle-orm") return { url: "mock:email-log-write-effect-drizzle", shortCircuit: true };
    if (specifier === "../platform/db.ts") return { url: "mock:email-log-write-effect-db", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:email-log-write-effect-drizzle") {
      return {
        format: "module",
        source: `
          export function sql(strings, ...values) {
            return { text: strings.join("?"), values };
          }
        `,
        shortCircuit: true,
      };
    }
    if (url === "mock:email-log-write-effect-db") {
      return {
        format: "module",
        source: `
          const harness = globalThis[Symbol.for("openbooks.email-log-write-effect-test")];
          export const db = { execute: (query) => harness.execute(query) };
          export async function withOrgTransaction(_orgId, work) { return work(); }
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const writeEffectModuleUrl = "./email-config.ts?write-effect-audit";
const {
  appendEmailAttemptEvent: appendEmailAttemptEventUnderTest,
  markEmailFailed: markEmailFailedUnderTest,
  markEmailSent: markEmailSentUnderTest,
  markEmailSuppressed: markEmailSuppressedUnderTest,
  markEmailUncertain: markEmailUncertainUnderTest,
  markPaymentRemittanceAttempt: markPaymentRemittanceAttemptUnderTest,
  markPaymentRemittanceFailed: markPaymentRemittanceFailedUnderTest,
} = (await import(writeEffectModuleUrl)) as typeof import("./email-config.ts");

function lastWriteEffectSql(): string {
  const query = writeEffectHarness.queries.at(-1);
  assert.ok(query, "expected an email_log write to reach the database");
  return query.text;
}

test("markEmailSent refuses when the sent-state audit update writes zero rows", async () => {
  writeEffectHarness.reset();
  await assert.rejects(
    () => markEmailSentUnderTest("org-1", "log-missing", "provider-message-1"),
    /email_log log-missing was not marked sent[\s\S]*matched no row/u,
  );
  assert.match(lastWriteEffectSql(), /returning/u);
});

test("markEmailFailed refuses when the failed-state audit update writes zero rows and no row is visible", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [] }, { rows: [] });
  await assert.rejects(
    () => markEmailFailedUnderTest("org-1", "log-missing", "smtp down"),
    /email_log log-missing was not marked failed[\s\S]*matched no row/u,
  );
  assert.match(writeEffectHarness.queries[0]!.text, /returning/u);
});

test("markEmailUncertain refuses when the uncertainty fence writes zero rows and the log remains queued", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [] }, { rows: [{ status: "queued" }] });
  await assert.rejects(
    () => markEmailUncertainUnderTest("org-1", "log-queued", "provider acceptance could not be confirmed"),
    /email_log log-queued was not marked uncertain[\s\S]*matched no row/u,
  );
  assert.match(writeEffectHarness.queries[0]!.text, /returning/u);
});

test("markEmailFailed refuses when the failed-state update writes zero rows even if a follow-up read would see uncertain", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [] }, { rows: [{ status: "uncertain" }] });
  await assert.rejects(
    () => markEmailFailedUnderTest("org-1", "log-uncertain", "retry also failed"),
    /email_log log-uncertain was not marked failed[\s\S]*matched no row/u,
  );
  assert.match(writeEffectHarness.queries[0]!.text, /returning/u);
  assert.equal(writeEffectHarness.queries.length, 1, "a zero-row write must refuse without a follow-up success read");
});

test("markEmailUncertain refuses when the uncertainty update writes zero rows even if a follow-up read would see uncertain", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [] }, { rows: [{ status: "uncertain" }] });
  await assert.rejects(
    () => markEmailUncertainUnderTest("org-1", "log-uncertain", "already parked"),
    /email_log log-uncertain was not marked uncertain[\s\S]*matched no row/u,
  );
  assert.match(writeEffectHarness.queries[0]!.text, /returning/u);
  assert.equal(writeEffectHarness.queries.length, 1, "a zero-row write must refuse without a follow-up success read");
});

test("markEmailSent resolves when the sent-state update returns the log id", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [{ id: "log-1" }] });
  await markEmailSentUnderTest("org-1", "log-1", "provider-message-1");
  assert.match(lastWriteEffectSql(), /returning/u);
});

test("markEmailSuppressed refuses when the suppression update writes zero rows and no row is visible", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [] }, { rows: [] });
  await assert.rejects(
    () => markEmailSuppressedUnderTest("org-1", "log-missing", "sandbox environment — email egress blocked"),
    /email_log log-missing was not marked suppressed[\s\S]*matched no row/u,
  );
  assert.match(writeEffectHarness.queries[0]!.text, /returning/u);
});

test("markEmailSuppressed refuses when the suppression update writes zero rows even if a follow-up read would see suppressed", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [] }, { rows: [{ status: "suppressed" }] });
  await assert.rejects(
    () => markEmailSuppressedUnderTest("org-1", "log-suppressed", "sandbox environment — email egress blocked"),
    /email_log log-suppressed was not marked suppressed[\s\S]*matched no row/u,
  );
  assert.match(writeEffectHarness.queries[0]!.text, /returning/u);
  assert.equal(writeEffectHarness.queries.length, 1, "a zero-row write must refuse without a follow-up success read");
});

test("appendEmailAttemptEvent refuses when the lineage update writes zero rows", async () => {
  writeEffectHarness.reset();
  await assert.rejects(
    () => appendEmailAttemptEventUnderTest("org-1", "log-missing", { outcome: "started", attempt: 1 }),
    /email_log log-missing attempt lineage was not appended[\s\S]*matched no row/u,
  );
  assert.match(lastWriteEffectSql(), /returning/u);
});

test("markPaymentRemittanceAttempt refuses when the pending stamp writes zero rows and no row is visible", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [] }, { rows: [] });
  await assert.rejects(
    () => markPaymentRemittanceAttemptUnderTest("org-1", "remit-missing", 1),
    /payment remittance remit-missing was not marked attempted[\s\S]*matched no row/u,
  );
  assert.match(writeEffectHarness.queries[0]!.text, /returning/u);
});

test("markPaymentRemittanceAttempt refuses when the pending stamp writes zero rows even if a follow-up read would see sent", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [] }, { rows: [{ status: "sent" }] });
  await assert.rejects(
    () => markPaymentRemittanceAttemptUnderTest("org-1", "remit-sent", 2),
    /payment remittance remit-sent was not marked attempted[\s\S]*matched no row/u,
  );
  assert.match(writeEffectHarness.queries[0]!.text, /returning/u);
  assert.equal(writeEffectHarness.queries.length, 1, "a zero-row write must refuse without a follow-up success read");
});

test("markPaymentRemittanceFailed refuses when the pending update writes zero rows and the remittance is still pending", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [] }, { rows: [{ status: "pending" }] });
  await assert.rejects(
    () => markPaymentRemittanceFailedUnderTest("org-1", "remit-pending", "smtp down", 1, true),
    /payment remittance remit-pending was not marked failed[\s\S]*matched no row/u,
  );
  assert.match(writeEffectHarness.queries[0]!.text, /returning/u);
});

test("markPaymentRemittanceFailed refuses when the pending update writes zero rows even if a follow-up read would see sent", async () => {
  writeEffectHarness.reset();
  writeEffectHarness.responses.push({ rows: [] }, { rows: [{ status: "sent" }] });
  await assert.rejects(
    () => markPaymentRemittanceFailedUnderTest("org-1", "remit-sent", "smtp down", 1, true),
    /payment remittance remit-sent was not marked failed[\s\S]*matched no row/u,
  );
  assert.match(writeEffectHarness.queries[0]!.text, /returning/u);
  assert.equal(writeEffectHarness.queries.length, 1, "a zero-row write must refuse without a follow-up success read");
});

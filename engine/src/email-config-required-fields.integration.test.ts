import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withBypassContext } from "./db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "./test-fixtures.ts";
import { readOrgEmailConfigView, saveOrgEmailConfig } from "./email-config.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const USER = randomUUID();
const actor = { kind: "user" as const, userId: USER };

// F-t12-002: saving a provider selection with missing fields must fail with
// a typed reason instead of silently persisting an incomplete config. A
// provider that is selected is staged to send, even while disabled — only a
// fully cleared provider (unconfigured) may be incomplete.
async function scratchOrg(): Promise<string> {
  // Cluster row-level security rejects fixture writes outside a bypass
  // context; the saves under test run unwrapped, as in production.
  const org = await withBypassContext(() => createScratchOrg());
  return org.orgId;
}

test("a disabled SMTP selection without a host is refused with a typed reason", { skip: !DB }, async () => {
  const orgId = await scratchOrg();
  try {
    await assert.rejects(
      saveOrgEmailConfig(orgId, { enabled: false, provider: "smtp", fromEmail: "billing@example.test" }, actor),
      /SMTP host/u,
    );
    const view = await withBypassContext(() => readOrgEmailConfigView(orgId));
    assert.equal(view.provider, undefined, "refused save must persist nothing");
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(orgId));
  }
});

test("a disabled SMTP selection without a sender is refused with a typed reason", { skip: !DB }, async () => {
  const orgId = await scratchOrg();
  try {
    await assert.rejects(
      saveOrgEmailConfig(orgId, { enabled: false, provider: "smtp", smtpHost: "smtp.example.test" }, actor),
      /From email/u,
    );
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(orgId));
  }
});

test("a complete disabled SMTP selection still saves (credential only at enable)", { skip: !DB }, async () => {
  const orgId = await scratchOrg();
  try {
    const saved = await saveOrgEmailConfig(
      orgId,
      { enabled: false, provider: "smtp", fromEmail: "billing@example.test", smtpHost: "smtp.example.test" },
      actor,
    );
    assert.equal(saved.provider, "smtp");
    assert.equal(saved.hasSecret, false);
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(orgId));
  }
});

test("clearing the provider still unconfigures delivery", { skip: !DB }, async () => {
  const orgId = await scratchOrg();
  try {
    await saveOrgEmailConfig(
      orgId,
      { enabled: false, provider: "smtp", fromEmail: "billing@example.test", smtpHost: "smtp.example.test" },
      actor,
    );
    const cleared = await saveOrgEmailConfig(orgId, { enabled: false, provider: undefined }, actor);
    assert.equal(cleared.provider, undefined);
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(orgId));
  }
});

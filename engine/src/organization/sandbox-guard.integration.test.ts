import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withBypass } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { assertNotSandbox, getEnvKind, isSandboxOrg } from "./sandbox-guard.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("guarded egress fails closed on an unknown org", { skip: !DB }, async () => {
  // B3-ORG-01: an org with no row (deleted or forged id) used to default to
  // env_kind 'production', so assertNotSandbox passed and email, payment
  // files, SFTP or webhooks proceeded for an org nobody can vouch for.
  const missing = randomUUID();
  await assert.rejects(getEnvKind(missing), /unknown organization/);
  await assert.rejects(isSandboxOrg(missing), /unknown organization/);
  await assert.rejects(assertNotSandbox(missing, "send email"), /unknown organization/);
  // ...and the refusal is not cached as a pass: it fires on every attempt.
  await assert.rejects(assertNotSandbox(missing, "send email"), /unknown organization/);
});

test("known orgs keep their kind and sandboxes stay blocked", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    assert.equal(await getEnvKind(org.orgId), "production");
    assert.equal(await isSandboxOrg(org.orgId), false);
    await assertNotSandbox(org.orgId, "send email");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

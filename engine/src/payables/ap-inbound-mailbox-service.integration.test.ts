import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import {
  beginInboundMessage,
  consumeMailboxDelivery,
  createMailbox,
  finishInboundMessage,
  listMailboxes,
  MailboxConfigurationError,
  resolveMailboxByToken,
  updateMailbox,
} from "./ap-inbound-mailbox-service.ts";

/**
 * Inbound AP addresses against the real schema: token issue and lookup,
 * sealed secrets kept out of configuration rows, audited changes, the
 * idempotent message log and its write-once outcome, the per-address rate
 * limit, and legal-entity scope on configuration.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedAdmin(org: ScratchOrg): Promise<string> {
  return createScratchUser(org.orgId, 'AP Admin', 'admin');
}

const BASE = {
  label: "Bills",
  emailAddress: "bills@inbound.example",
  provider: "mailgun",
  allowedSenders: ["@vendor.example", " AP@Other.example "],
  isActive: true,
  signingSecret: "mailgun-signing-key-0001",
};

test("an address resolves by its token, with the secret sealed apart from the configuration row", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const admin = await seedAdmin(org);
    const created = await createMailbox({ ...BASE, orgId: org.orgId, actorId: admin, subsidiaryId: org.subsidiaryId, allowedSubsidiaryIds: null });
    assert.match(created.token, /^[a-z2-7]{32}$/);
    const row = (await db.execute<Record<string, unknown>>(sql`select * from ap_capture_mailboxes where id = ${created.id}`)).rows[0]!;
    assert.equal(Object.values(row).some((value) => value === BASE.signingSecret), false, "the configuration row never holds the secret");
    assert.deepEqual(row.allowed_senders, ["@vendor.example", "ap@other.example"]);
    const sealed = (await db.execute<{ sealed: string }>(sql`
      select sealed_secret as sealed from ap_capture_mailbox_credentials where mailbox_id = ${created.id}
    `)).rows[0]!;
    assert.notEqual(sealed.sealed, BASE.signingSecret);
    const resolved = await resolveMailboxByToken(created.token);
    assert.equal(resolved?.orgId, org.orgId);
    assert.equal(resolved?.signingSecret, BASE.signingSecret);
    assert.equal(resolved?.ownerId, admin);
    assert.equal(await resolveMailboxByToken("a".repeat(32)), null, "an unknown token resolves nothing");
    assert.equal(await resolveMailboxByToken("not-a-token"), null);
    const audit = (await db.execute<{ action: string; changes: { after: { hasSigningSecret: boolean } } }>(sql`
      select action, changes from audit_log where org_id = ${org.orgId} and table_name = 'ap_capture_mailboxes' and row_id = ${created.id}
    `)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.changes.after.hasSigningSecret, true);
    assert.equal(JSON.stringify(audit).includes(BASE.signingSecret), false, "the audit trail never carries the secret");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("rotating the token retires the old webhook URL; deactivation is visible to the webhook", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const admin = await seedAdmin(org);
    const created = await createMailbox({ ...BASE, orgId: org.orgId, actorId: admin, subsidiaryId: org.subsidiaryId, allowedSubsidiaryIds: null });
    await updateMailbox({ ...BASE, signingSecret: null, isActive: false, id: created.id, orgId: org.orgId, actorId: admin, clearSigningSecret: true, rotateToken: true, allowedSubsidiaryIds: null });
    assert.equal(await resolveMailboxByToken(created.token), null, "the old token no longer resolves");
    const [listed] = await listMailboxes(org.orgId, null);
    const rotated = await resolveMailboxByToken(listed!.token);
    assert.equal(rotated?.isActive, false);
    assert.equal(rotated?.signingSecret, null, "clearing the secret removes it");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("configuration refuses unusable senders, inactive entities and out-of-scope callers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const admin = await seedAdmin(org);
    await assert.rejects(
      createMailbox({ ...BASE, allowedSenders: ["vendor.example"], orgId: org.orgId, actorId: admin, subsidiaryId: org.subsidiaryId, allowedSubsidiaryIds: null }),
      (error: unknown) => error instanceof MailboxConfigurationError && /@domain/.test(error.message),
    );
    await assert.rejects(
      createMailbox({ ...BASE, orgId: org.orgId, actorId: admin, subsidiaryId: org.subsidiaryId, allowedSubsidiaryIds: new Set([randomUUID()]) }),
      (error: unknown) => error instanceof MailboxConfigurationError && error.status === 404,
    );
    await assert.rejects(
      createMailbox({ ...BASE, orgId: org.orgId, actorId: admin, subsidiaryId: randomUUID(), allowedSubsidiaryIds: null }),
      (error: unknown) => error instanceof MailboxConfigurationError,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a message id is logged once, its outcome is written once, and its facts are immutable", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const admin = await seedAdmin(org);
    const created = await createMailbox({ ...BASE, signingSecret: null, orgId: org.orgId, actorId: admin, subsidiaryId: org.subsidiaryId, allowedSubsidiaryIds: null });
    const email = { provider: "mailgun" as const, from: "ap@vendor.example", subject: "Invoice 9", messageId: "<9@vendor.example>" };
    const first = await beginInboundMessage({ orgId: org.orgId, mailboxId: created.id, email, attachmentCount: 1 });
    assert.equal(first.status, "new");
    const captureId = randomUUID();
    await finishInboundMessage({ orgId: org.orgId, id: first.id, outcome: "captured", captureItemIds: [captureId] });
    const again = await beginInboundMessage({ orgId: org.orgId, mailboxId: created.id, email, attachmentCount: 1 });
    assert.deepEqual(again, { status: "repeat", id: first.id, outcome: "captured", captureItemIds: [captureId] });
    await assert.rejects(finishInboundMessage({ orgId: org.orgId, id: first.id, outcome: "error", reason: "late" }));
    await assert.rejects(db.execute(sql`update ap_capture_inbound_messages set from_address = 'forged@example.test' where id = ${first.id}`));
    const count = (await db.execute<{ n: number }>(sql`select count(*)::int as n from ap_capture_inbound_messages where mailbox_id = ${created.id}`)).rows[0]!.n;
    assert.equal(count, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("each address accepts a bounded number of deliveries per minute", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const admin = await seedAdmin(org);
    const created = await createMailbox({ ...BASE, signingSecret: null, orgId: org.orgId, actorId: admin, subsidiaryId: org.subsidiaryId, allowedSubsidiaryIds: null });
    const verdicts: boolean[] = [];
    for (let index = 0; index < 4; index += 1) verdicts.push(await consumeMailboxDelivery(org.orgId, created.id, 3));
    assert.deepEqual(verdicts, [true, true, true, false]);
    await assert.rejects(consumeMailboxDelivery(org.orgId, randomUUID(), 3), MailboxConfigurationError);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

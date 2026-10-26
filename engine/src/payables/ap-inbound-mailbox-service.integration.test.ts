import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { InboundEmailError } from "./ap-inbound-email.ts";
import {
  beginInboundMessage,
  consumeMailboxDelivery,
  createMailbox,
  finishInboundMessage,
  listMailboxes,
  MailboxConfigurationError,
  mailboxOwnerAuthority,
  resolveMailboxByToken,
  takeMailboxOwnership,
  updateMailbox,
} from "./ap-inbound-mailbox-service.ts";

/**
 * Inbound AP addresses against the real schema: token issue and lookup,
 * sealed secrets kept out of configuration rows, audited changes, the
 * idempotent message log and its write-once outcome, signed-token replay,
 * delivery leases, the owner's standing and ownership transfer, the
 * per-address rate limit, and legal-entity scope on configuration.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

const UNSIGNED = { verified: false, nonce: null };

async function seedAdmin(org: ScratchOrg): Promise<string> {
  return createScratchUser(org.orgId, "AP Admin", "admin");
}

const BASE = {
  label: "Bills",
  emailAddress: "bills@inbound.example",
  provider: "mailgun",
  allowedSenders: ["@vendor.example", " AP@Other.example "],
  isActive: true,
  signingSecret: "mailgun-signing-key-0001",
};

test(
  "an address resolves by its token, with the secret sealed apart from the configuration row",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const admin = await seedAdmin(org);
      const created = await createMailbox({
        ...BASE,
        orgId: org.orgId,
        actorId: admin,
        subsidiaryId: org.subsidiaryId,
        allowedSubsidiaryIds: null,
      });
      assert.match(created.token, /^[a-z2-7]{32}$/);
      const row = (
        await db.execute<Record<string, unknown>>(
          sql`select * from ap_capture_mailboxes where id = ${created.id}`,
          "objects",
        )
      )[0]!;
      assert.equal(
        Object.values(row).some((value) => value === BASE.signingSecret),
        false,
        "the configuration row never holds the secret",
      );
      assert.deepEqual(row.allowed_senders, ["@vendor.example", "ap@other.example"]);
      const sealed = (
        await db.execute<{ sealed: string }>(
          sql`
      select sealed_secret as sealed from ap_capture_mailbox_credentials where mailbox_id = ${created.id}
    `,
          "objects",
        )
      )[0]!;
      assert.notEqual(sealed.sealed, BASE.signingSecret);
      const resolved = await resolveMailboxByToken(created.token);
      assert.equal(resolved?.orgId, org.orgId);
      assert.equal(resolved?.signingSecret, BASE.signingSecret);
      assert.equal(resolved?.ownerId, admin);
      assert.equal(
        await resolveMailboxByToken("a".repeat(32)),
        null,
        "an unknown token resolves nothing",
      );
      assert.equal(await resolveMailboxByToken("not-a-token"), null);
      const audit = await db.execute<{
        action: string;
        changes: { after: { hasSigningSecret: boolean } };
      }>(
        sql`
      select action, changes from audit_log where org_id = ${org.orgId} and table_name = 'ap_capture_mailboxes' and row_id = ${created.id}
    `,
        "objects",
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.changes.after.hasSigningSecret, true);
      assert.equal(
        JSON.stringify(audit).includes(BASE.signingSecret),
        false,
        "the audit trail never carries the secret",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "rotating the token retires the old webhook URL; deactivation is visible to the webhook",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const admin = await seedAdmin(org);
      const created = await createMailbox({
        ...BASE,
        orgId: org.orgId,
        actorId: admin,
        subsidiaryId: org.subsidiaryId,
        allowedSubsidiaryIds: null,
      });
      await updateMailbox({
        ...BASE,
        signingSecret: null,
        isActive: false,
        id: created.id,
        orgId: org.orgId,
        actorId: admin,
        clearSigningSecret: true,
        rotateToken: true,
        allowedSubsidiaryIds: null,
      });
      assert.equal(
        await resolveMailboxByToken(created.token),
        null,
        "the old token no longer resolves",
      );
      const [unprivileged] = await listMailboxes(org.orgId, null);
      assert.equal(
        unprivileged!.token,
        null,
        "the token is a credential and is not listed unless asked for",
      );
      const [listed] = await listMailboxes(org.orgId, null, { includeTokens: true });
      const rotated = await resolveMailboxByToken(listed!.token!);
      assert.equal(rotated?.isActive, false);
      assert.equal(rotated?.signingSecret, null, "clearing the secret removes it");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "configuration refuses unusable senders, inactive entities and out-of-scope callers",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const admin = await seedAdmin(org);
      await assert.rejects(
        createMailbox({
          ...BASE,
          allowedSenders: ["vendor.example"],
          orgId: org.orgId,
          actorId: admin,
          subsidiaryId: org.subsidiaryId,
          allowedSubsidiaryIds: null,
        }),
        (error: unknown) =>
          error instanceof MailboxConfigurationError && /@domain/.test(error.message),
      );
      await assert.rejects(
        createMailbox({
          ...BASE,
          orgId: org.orgId,
          actorId: admin,
          subsidiaryId: org.subsidiaryId,
          allowedSubsidiaryIds: new Set([randomUUID()]),
        }),
        (error: unknown) => error instanceof MailboxConfigurationError && error.status === 404,
      );
      await assert.rejects(
        createMailbox({
          ...BASE,
          orgId: org.orgId,
          actorId: admin,
          subsidiaryId: randomUUID(),
          allowedSubsidiaryIds: null,
        }),
        (error: unknown) => error instanceof MailboxConfigurationError,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a message id is logged once, its outcome is written once, and its facts are immutable",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const admin = await seedAdmin(org);
      const created = await createMailbox({
        ...BASE,
        signingSecret: null,
        orgId: org.orgId,
        actorId: admin,
        subsidiaryId: org.subsidiaryId,
        allowedSubsidiaryIds: null,
      });
      const email = {
        provider: "mailgun" as const,
        from: "ap@vendor.example",
        subject: "Invoice 9",
        messageId: "<9@vendor.example>",
      };
      const first = await beginInboundMessage({
        orgId: org.orgId,
        mailboxId: created.id,
        email,
        attachmentCount: 1,
        contentDigest: "a".repeat(64),
        signature: UNSIGNED,
      });
      assert.equal(first.status, "new");
      assert.equal(first.status === "new" && first.attempt, 1);
      const captureId = randomUUID();
      await finishInboundMessage({
        orgId: org.orgId,
        id: first.id,
        attempt: 1,
        outcome: "captured",
        captureItemIds: [captureId],
      });
      const again = await beginInboundMessage({
        orgId: org.orgId,
        mailboxId: created.id,
        email,
        attachmentCount: 1,
        contentDigest: "a".repeat(64),
        signature: UNSIGNED,
      });
      assert.deepEqual(again, {
        status: "repeat",
        id: first.id,
        outcome: "captured",
        captureItemIds: [captureId],
      });
      await assert.rejects(
        finishInboundMessage({
          orgId: org.orgId,
          id: first.id,
          attempt: 1,
          outcome: "error",
          reason: "late",
        }),
      );
      await assert.rejects(
        db.execute(
          sql`update ap_capture_inbound_messages set from_address = 'forged@example.test' where id = ${first.id}`,
        ),
      );
      const count = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from ap_capture_inbound_messages where mailbox_id = ${created.id}`,
          "objects",
        )
      )[0]!.n;
      assert.equal(count, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("each address accepts a bounded number of deliveries per minute", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const admin = await seedAdmin(org);
    const created = await createMailbox({
      ...BASE,
      signingSecret: null,
      orgId: org.orgId,
      actorId: admin,
      subsidiaryId: org.subsidiaryId,
      allowedSubsidiaryIds: null,
    });
    const verdicts: boolean[] = [];
    for (let index = 0; index < 4; index += 1)
      verdicts.push(await consumeMailboxDelivery(org.orgId, created.id, 3));
    assert.deepEqual(verdicts, [true, true, true, false]);
    await assert.rejects(
      consumeMailboxDelivery(org.orgId, randomUUID(), 3),
      MailboxConfigurationError,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "a signed one-time token authenticates one message; reusing it for another message is a replay",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const admin = await seedAdmin(org);
      const created = await createMailbox({
        ...BASE,
        orgId: org.orgId,
        actorId: admin,
        subsidiaryId: org.subsidiaryId,
        allowedSubsidiaryIds: null,
      });
      const signed = { verified: true, nonce: "mailgun-token-0001" };
      const original = {
        provider: "mailgun" as const,
        from: "ap@vendor.example",
        subject: "Invoice 10",
        messageId: "<10@vendor.example>",
      };
      const first = await beginInboundMessage({
        orgId: org.orgId,
        mailboxId: created.id,
        email: original,
        attachmentCount: 1,
        contentDigest: "a".repeat(64),
        signature: signed,
      });
      assert.equal(first.status, "new");
      const stored = (
        await db.execute<{ verified: boolean; nonce: string }>(
          sql`
      select signature_verified as verified, provider_nonce as nonce from ap_capture_inbound_messages where id = ${first.id}
    `,
          "objects",
        )
      )[0]!;
      assert.deepEqual(stored, { verified: true, nonce: "mailgun-token-0001" });
      const forged = {
        ...original,
        subject: "Pay this instead",
        messageId: "<forged@attacker.example>",
      };
      await assert.rejects(
        beginInboundMessage({
          orgId: org.orgId,
          mailboxId: created.id,
          email: forged,
          attachmentCount: 1,
          contentDigest: "a".repeat(64),
          signature: signed,
        }),
        (error: unknown) =>
          error instanceof InboundEmailError && error.code === "signature_replayed",
      );
      await assert.rejects(
        beginInboundMessage({
          orgId: org.orgId,
          mailboxId: created.id,
          email: original,
          attachmentCount: 1,
          contentDigest: "b".repeat(64),
          signature: signed,
        }),
        (error: unknown) =>
          error instanceof InboundEmailError && error.code === "signature_replayed",
        "a reused signature cannot authenticate changed attachments under the same message id",
      );
      const retry = await beginInboundMessage({
        orgId: org.orgId,
        mailboxId: created.id,
        email: original,
        attachmentCount: 1,
        contentDigest: "a".repeat(64),
        signature: signed,
      });
      assert.equal(
        retry.status,
        "repeat",
        "the same message retried with its own token is answered from the log, not refused",
      );
      const unverified = await beginInboundMessage({
        orgId: org.orgId,
        mailboxId: created.id,
        email: { ...forged, messageId: "<11@vendor.example>" },
        attachmentCount: 1,
        contentDigest: "a".repeat(64),
        signature: { verified: false, nonce: "mailgun-token-0001" },
      });
      assert.equal(
        unverified.status,
        "new",
        "an unverified token is not recorded and claims nothing",
      );
      const count = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from ap_capture_inbound_messages where mailbox_id = ${created.id}`,
          "objects",
        )
      )[0]!.n;
      assert.equal(count, 2, "the replay logged nothing");
      await assert.rejects(
        db.execute(
          sql`update ap_capture_inbound_messages set signature_verified = false where id = ${first.id}`,
        ),
        "signature evidence is an immutable fact",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a message whose delivery stopped mid-processing is claimed again after its lease, and only the claim holder records the outcome",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const admin = await seedAdmin(org);
      const created = await createMailbox({
        ...BASE,
        signingSecret: null,
        orgId: org.orgId,
        actorId: admin,
        subsidiaryId: org.subsidiaryId,
        allowedSubsidiaryIds: null,
      });
      const email = {
        provider: "mailgun" as const,
        from: "ap@vendor.example",
        subject: "Invoice 12",
        messageId: "<12@vendor.example>",
      };
      const begin = (overrides: Partial<typeof email> = {}) =>
        beginInboundMessage({
          orgId: org.orgId,
          mailboxId: created.id,
          email: { ...email, ...overrides },
          attachmentCount: 1,
          contentDigest: "a".repeat(64),
          signature: UNSIGNED,
        });
      const first = await begin();
      assert.equal(first.status, "new");
      const inFlight = await begin();
      assert.deepEqual(
        inFlight,
        { status: "repeat", id: first.id, outcome: "received", captureItemIds: [] },
        "within the lease a retry is told the message is still processing",
      );
      await db.execute(
        sql`update ap_capture_inbound_messages set claimed_at = now() - interval '11 minutes' where id = ${first.id}`,
      );
      assert.equal(
        (await begin({ subject: "Different subject" })).status,
        "repeat",
        "a delivery with different facts cannot take the claim",
      );
      const reclaimed = await begin();
      assert.deepEqual(reclaimed, { status: "new", id: first.id, attempt: 2, reclaimed: true });
      assert.equal((await begin()).status, "repeat", "the fresh claim holds a new lease");
      await assert.rejects(
        finishInboundMessage({
          orgId: org.orgId,
          id: first.id,
          attempt: 1,
          outcome: "error",
          reason: "late",
        }),
        "the stopped attempt cannot overwrite the retry's outcome",
      );
      await finishInboundMessage({
        orgId: org.orgId,
        id: first.id,
        attempt: 2,
        outcome: "captured",
        captureItemIds: [],
      });
      const done = await begin();
      assert.deepEqual(
        done,
        { status: "repeat", id: first.id, outcome: "captured", captureItemIds: [] },
        "a finished message is never claimed again",
      );
      await assert.rejects(
        db.execute(
          sql`update ap_capture_inbound_messages set claimed_at = now() - interval '1 day', claim_attempt = 3 where id = ${first.id}`,
        ),
        "a processed message is retained as recorded",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the owner's standing is re-checked: inactive, unpermitted and out-of-scope owners refuse with the remedy",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const owner = await createScratchUser(org.orgId, "AP Owner", "clerk");
      const roleId = (
        await db.execute<{ id: string }>(
          sql`
      select role_id as id from role_assignments where org_id = ${org.orgId} and user_id = ${owner}`,
          "objects",
        )
      )[0]!.id;
      await db.execute(sql`update app_roles set permissions = '["ap.read","ap.create","admin.setup.manage"]'::jsonb,
      subsidiary_restriction = '{"mode":"all"}'::jsonb where org_id = ${org.orgId} and id = ${roleId}`);
      const standing = () => mailboxOwnerAuthority(db, org.orgId, owner, org.subsidiaryId);
      const ready = await standing();
      assert.equal(ready.ok, true);
      assert.deepEqual(
        ready.ok && [...ready.allowedSubsidiaryIds],
        [org.subsidiaryId],
        "the capture scope is the address entity only",
      );

      const otherEntity = randomUUID();
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${otherEntity}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await db.execute(sql`update app_roles set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [otherEntity] })}::jsonb
      where org_id = ${org.orgId} and id = ${roleId}`);
      const outOfScope = await standing();
      assert.equal(!outOfScope.ok && outOfScope.problem, "owner_out_of_scope");
      await db.execute(
        sql`update app_roles set subsidiary_restriction = '{"mode":"all"}'::jsonb where org_id = ${org.orgId} and id = ${roleId}`,
      );

      await db.execute(
        sql`insert into user_permission_overrides (org_id, user_id, permission, effect) values (${org.orgId}, ${owner}, 'ap.create', 'deny')`,
      );
      const unpermitted = await standing();
      assert.equal(!unpermitted.ok && unpermitted.problem, "owner_not_permitted");
      await db.execute(
        sql`delete from user_permission_overrides where org_id = ${org.orgId} and user_id = ${owner}`,
      );

      await db.execute(
        sql`update users set is_active = false where org_id = ${org.orgId} and id = ${owner}`,
      );
      const inactive = await standing();
      assert.equal(!inactive.ok && inactive.problem, "owner_inactive");
      assert.match(
        !inactive.ok ? inactive.message : "",
        /take ownership of the address on the Bill capture page, or re-create the address/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an administrator takes ownership of an address with a reason, audited before and after",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const creator = await seedAdmin(org);
      const successor = await createScratchUser(org.orgId, "Successor", "clerk");
      await grantScratchPermissions(org.orgId, successor, [
        "ap.read",
        "ap.create",
        "admin.setup.manage",
      ]);
      const created = await createMailbox({
        ...BASE,
        orgId: org.orgId,
        actorId: creator,
        subsidiaryId: org.subsidiaryId,
        allowedSubsidiaryIds: null,
      });
      assert.equal(
        (await resolveMailboxByToken(created.token))?.ownerId,
        creator,
        "the creator owns a new address",
      );
      const take = (actorId: string, reason = "Previous owner left the company") =>
        takeMailboxOwnership({
          orgId: org.orgId,
          actorId,
          id: created.id,
          reason,
          allowedSubsidiaryIds: null,
        });

      await assert.rejects(take(successor, "x"), MailboxConfigurationError, "a reason is required");
      await assert.rejects(
        take(creator),
        (error: unknown) => error instanceof MailboxConfigurationError && error.status === 409,
      );
      await assert.rejects(
        takeMailboxOwnership({
          orgId: org.orgId,
          actorId: successor,
          id: created.id,
          reason: "Out of scope attempt",
          allowedSubsidiaryIds: new Set([randomUUID()]),
        }),
        (error: unknown) => error instanceof MailboxConfigurationError && error.status === 404,
      );
      const bystander = await createScratchUser(org.orgId, "Bystander", "clerk");
      await grantScratchPermissions(org.orgId, bystander, ["admin.setup.manage"]);
      await db.execute(
        sql`insert into user_permission_overrides (org_id, user_id, permission, effect) values (${org.orgId}, ${bystander}, 'ap.create', 'deny')`,
      );
      await assert.rejects(
        take(bystander),
        /permission to create bills/,
        "an owner who could not receive bills is refused",
      );

      assert.deepEqual(await take(successor), { id: created.id, ownerId: successor });
      assert.equal(
        (await resolveMailboxByToken(created.token))?.ownerId,
        successor,
        "deliveries are now attributed to the new owner",
      );
      const [listed] = await listMailboxes(org.orgId, null);
      assert.equal(listed!.ownerId, successor);
      assert.equal(listed!.ownerName, "Successor");
      const audit = await db.execute<{
        actorId: string;
        changes: { before: { ownerId: string }; after: { ownerId: string }; reason: string };
      }>(
        sql`
      select actor_id as "actorId", changes from audit_log
       where org_id = ${org.orgId} and table_name = 'ap_capture_mailboxes' and row_id = ${created.id} and action = 'take_ownership'
    `,
        "objects",
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.actorId, successor);
      assert.equal(audit[0]!.changes.before.ownerId, creator);
      assert.equal(audit[0]!.changes.after.ownerId, successor);
      assert.equal(audit[0]!.changes.reason, "Previous owner left the company");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

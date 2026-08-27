import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  OrgEmailConfigConflictError,
  readOrgEmailConfigView,
  saveOrgEmailConfig,
} from "./email-config.ts";
import { db, pool } from "./db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Live-PostgreSQL proof for the two provider-configuration defects: a material
 * email config write must be attributable with redacted before/after audit
 * evidence (fnd_mt989v9y_emu0nl), and the locked read/merge/write with the
 * revision fence must make concurrent credential/settings edits either merge
 * over the committed result or conflict — never silently overwrite
 * (fnd_mt989vhl_v87x56).
 */

type AuditEnvelope = {
  area: string;
  actor: { kind: string; userId?: string; reason?: string };
  reason?: string;
  secret: string;
  before: Record<string, unknown> & { hasSecret: boolean };
  after: Record<string, unknown> & { hasSecret: boolean };
};

async function readEmailAuditRows(orgId: string): Promise<{ actorId: string | null; at: Date; changes: AuditEnvelope }[]> {
  const r = await db.execute<{ actorId: string | null; at: string | Date; changes: AuditEnvelope }>(sql`
    select actor_id as "actorId", at, changes from audit_log
     where org_id = ${orgId} and table_name = 'orgs' and row_id = ${orgId}
     order by at, id
  `);
  return r.rows.map((row) => ({ ...row, at: new Date(row.at) }));
}

async function storedEmail(orgId: string): Promise<Record<string, unknown> | null> {
  const r = await db.execute<{ email: Record<string, unknown> | null }>(sql`
    select settings -> 'email' as email from orgs where id = ${orgId}
  `);
  return r.rows[0]?.email ?? null;
}

const USER = randomUUID();
const OTHER_USER = randomUUID();
const userActor = { kind: "user" as const, userId: USER };

test("provider configuration writes carry attributable redacted before/after audit evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const beforeAny = (await readEmailAuditRows(org.orgId)).length;

    // Initial save: enabling configuration plus a first credential.
    await saveOrgEmailConfig(
      org.orgId,
      {
        enabled: true,
        provider: "resend",
        fromName: "Billing",
        fromEmail: "billing@example.test",
        secret: "sk_live_email_secret_one",
      },
      userActor,
    );

    const rows = await readEmailAuditRows(org.orgId);
    assert.equal(rows.length, beforeAny + 1, "exactly one audit row per configuration write");
    const created = rows.at(-1)!;
    assert.equal(created.actorId, USER, "the audit row is attributed to the acting user");
    assert.ok(!Number.isNaN(created.at.getTime()), "the audit row is timestamped");

    const envelope = created.changes;
    assert.equal(envelope.area, "email");
    assert.deepEqual(envelope.actor, { kind: "user", userId: USER });
    assert.equal(envelope.secret, "added");
    assert.equal(envelope.before.hasSecret, false);
    assert.equal(envelope.after.hasSecret, true);
    assert.equal(envelope.after.provider, "resend");
    assert.equal(envelope.after.fromEmail, "billing@example.test");

    // The evidence must not disclose the credential in any form.
    const evidenceText = JSON.stringify(created.changes);
    assert.equal(evidenceText.includes("sk_live_email_secret_one"), false, "no plaintext secret in the audit evidence");
    assert.equal(evidenceText.includes("keyCiphertext"), false, "no sealed material in the audit evidence");
    assert.equal(evidenceText.includes("keyNonce"), false, "no seal nonce in the audit evidence");

    // The stored config keeps the sealed secret; the view exposes only its existence.
    const stored = await storedEmail(org.orgId);
    assert.ok(stored?.keyCiphertext && stored.keyCiphertext !== "sk_live_email_secret_one");
    const view = await readOrgEmailConfigView(org.orgId);
    assert.equal(view.hasSecret, true);
    assert.equal("keyCiphertext" in view, false);
    assert.equal("keyNonce" in view, false);
    assert.ok(view.updatedAt, "the view exposes the revision token");

    // The org metadata is stamped with the acting user.
    const stamped = await db.execute<{ updated_by: string | null }>(sql`
      select updated_by from orgs where id = ${org.orgId}
    `);
    assert.equal(stamped.rows[0]?.updated_by, USER);

    // Rotation: same shape, marker changes, before/after both show a credential.
    await saveOrgEmailConfig(org.orgId, { secret: "sk_live_email_secret_two" }, userActor);
    const rotated = (await readEmailAuditRows(org.orgId)).at(-1)!;
    assert.equal(rotated.changes.secret, "rotated");
    assert.equal(rotated.changes.before.hasSecret, true);
    assert.equal(rotated.changes.after.hasSecret, true);
    assert.equal(JSON.stringify(rotated.changes).includes("sk_live_email_secret_two"), false);

    // A disjoint settings edit keeps the credential untouched and says so.
    await saveOrgEmailConfig(org.orgId, { replyTo: "support@example.test" }, { kind: "user", userId: OTHER_USER });
    const edited = (await readEmailAuditRows(org.orgId)).at(-1)!;
    assert.equal(edited.actorId, OTHER_USER);
    assert.equal(edited.changes.secret, "unchanged");
    assert.equal(edited.changes.after.replyTo, "support@example.test");
    assert.equal(edited.changes.after.hasSecret, true);

    // Clearing the credential (an enabled config cannot be left credential-less,
    // so the clear disables delivery too) records removal.
    await saveOrgEmailConfig(
      org.orgId,
      { secret: null, enabled: false },
      userActor,
      { reason: "offboarding provider" },
    );
    const cleared = (await readEmailAuditRows(org.orgId)).at(-1)!;
    assert.equal(cleared.changes.secret, "cleared");
    assert.equal(cleared.changes.before.hasSecret, true);
    assert.equal(cleared.changes.after.hasSecret, false);
    assert.equal(cleared.changes.reason, "offboarding provider");

    // A trusted automation write leaves the user column null and carries its
    // explicit reason — null never means "nobody recorded who changed this".
    await saveOrgEmailConfig(org.orgId, { fromName: "Billing Operations" }, { kind: "system", reason: "provisioning sync" });
    const system = (await readEmailAuditRows(org.orgId)).at(-1)!;
    assert.equal(system.actorId, null);
    assert.deepEqual(system.changes.actor, { kind: "system", reason: "provisioning sync" });
    const afterSystem = await db.execute<{ updated_by: string | null }>(sql`
      select updated_by from orgs where id = ${org.orgId}
    `);
    assert.equal(afterSystem.rows[0]?.updated_by, null);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a stale revision is rejected with zero partial write and a fresh retry succeeds", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await saveOrgEmailConfig(
      org.orgId,
      { enabled: true, provider: "resend", fromEmail: "billing@example.test", secret: "sk_live_initial" },
      userActor,
    );
    const stale = await readOrgEmailConfigView(org.orgId);

    // A concurrent admin commits while the stale caller is composing an edit.
    const committed = await saveOrgEmailConfig(org.orgId, { fromEmail: "notices@example.test" }, userActor);
    assert.notEqual(committed.updatedAt, stale.updatedAt);

    const auditsBefore = (await readEmailAuditRows(org.orgId)).length;
    await assert.rejects(
      saveOrgEmailConfig(
        org.orgId,
        { replyTo: "stale-editor@example.test" },
        userActor,
        { expectedUpdatedAt: stale.updatedAt! },
      ),
      (error: unknown) => {
        assert.ok(error instanceof OrgEmailConfigConflictError);
        assert.equal(error.expectedUpdatedAt, stale.updatedAt);
        assert.equal(error.persistedUpdatedAt, committed.updatedAt);
        return true;
      },
    );

    // Zero partial write: the rejected edit left no setting and no evidence.
    const afterConflict = await readOrgEmailConfigView(org.orgId);
    assert.equal(afterConflict.replyTo, undefined);
    assert.equal(afterConflict.fromEmail, "notices@example.test");
    assert.equal(afterConflict.updatedAt, committed.updatedAt);
    assert.equal((await readEmailAuditRows(org.orgId)).length, auditsBefore);

    // The deterministic retry with the fresh revision succeeds.
    const retried = await saveOrgEmailConfig(
      org.orgId,
      { replyTo: "stale-editor@example.test" },
      userActor,
      { expectedUpdatedAt: committed.updatedAt! },
    );
    assert.equal(retried.replyTo, "stale-editor@example.test");
    assert.equal(retried.fromEmail, "notices@example.test", "the committed admin edit survived the retry");

    // Unknown org: fail closed, write nothing.
    const missing = randomUUID();
    await assert.rejects(
      saveOrgEmailConfig(missing, { enabled: false }, userActor),
      /does not exist/u,
    );
    assert.equal((await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log where org_id = ${missing}
    `)).rows[0]?.n, 0);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a forced audit failure rolls the configuration write back entirely", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await saveOrgEmailConfig(
      org.orgId,
      { enabled: true, provider: "resend", fromEmail: "billing@example.test", secret: "sk_live_locked" },
      userActor,
    );
    const emailBefore = (await db.execute<{ email: unknown }>(sql`
      select settings -> 'email' as email from orgs where id = ${org.orgId}
    `)).rows[0]?.email;
    const metaBefore = await db.execute<{ updated_at: string | Date; updated_by: string | null }>(sql`
      select updated_at, updated_by from orgs where id = ${org.orgId}
    `);
    const auditsBefore = (await readEmailAuditRows(org.orgId)).length;

    await db.execute(sql`
      create function email_config_audit_blocker() returns trigger language plpgsql as $f$
      begin raise exception 'audit destination unavailable'; end
      $f$`);
    await db.execute(sql`
      create trigger block_email_config_audit before insert on audit_log
        for each row execute function email_config_audit_blocker()`);
    try {
      await assert.rejects(
        saveOrgEmailConfig(org.orgId, { fromEmail: "never-committed@example.test" }, userActor),
        (error: unknown) => {
          // Drizzle wraps driver failures, so match the whole cause chain.
          const messages: string[] = [];
          for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
            messages.push(cause.message);
          }
          assert.match(messages.join(" | "), /audit destination unavailable/u);
          return true;
        },
      );
    } finally {
      await db.execute(sql`drop trigger if exists block_email_config_audit on audit_log`);
      await db.execute(sql`drop function if exists email_config_audit_blocker()`);
    }

    // The configuration write, its metadata stamp, and the evidence row all
    // rolled back as one unit.
    const emailAfter = (await db.execute<{ email: unknown }>(sql`
      select settings -> 'email' as email from orgs where id = ${org.orgId}
    `)).rows[0]?.email;
    assert.deepEqual(emailAfter, emailBefore);
    const metaAfter = await db.execute<{ updated_at: string | Date; updated_by: string | null }>(sql`
      select updated_at, updated_by from orgs where id = ${org.orgId}
    `);
    assert.deepEqual(metaAfter.rows[0]?.updated_at, metaBefore.rows[0]?.updated_at);
    assert.equal(metaAfter.rows[0]?.updated_by, metaBefore.rows[0]?.updated_by);
    assert.equal((await readEmailAuditRows(org.orgId)).length, auditsBefore);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("concurrent configuration edits serialize on the org row and cannot lose disjoint updates", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const client = await pool.connect();
  try {
    await saveOrgEmailConfig(
      org.orgId,
      { enabled: true, provider: "resend", fromEmail: "billing@example.test", secret: "sk_live_shared" },
      userActor,
    );

    // Session one locks the org row mid-write, exactly where a slow admin save
    // sits while a second admin commits their own edit.
    await client.query("begin");
    await client.query("select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)", [org.orgId]);
    await client.query("select id from orgs where id = $1 for update", [org.orgId]);

    // Session two (the function under test) must park on that row lock, not
    // read past it.
    const second = saveOrgEmailConfig(
      org.orgId,
      { replyTo: "second-admin@example.test", secret: "sk_live_rotated_by_second" },
      { kind: "user", userId: OTHER_USER },
    );
    second.catch(() => {}); // surfaced by the await below; never an unhandled rejection

    const parkedAt = Date.now();
    for (;;) {
      const r = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
      `);
      if ((r.rows[0]?.n ?? 0) > 0) break;
      if (Date.now() - parkedAt > 15_000) {
        throw new Error("the second configuration save never parked on the org row lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // While session two is parked, session one commits a disjoint settings edit.
    await client.query(
      "update orgs set settings = jsonb_set(settings, '{email,fromEmail}', '\"first-admin@example.test\"'::jsonb), updated_at = now() where id = $1",
      [org.orgId],
    );
    await client.query("commit");

    const result = await second;

    // No lost update: BOTH disjoint edits are in the committed configuration,
    // and the second admin's credential rotation happened on top of the first
    // admin's settings, not over them.
    const merged = await storedEmail(org.orgId);
    assert.equal(merged?.fromEmail, "first-admin@example.test", "the first admin's edit survived");
    assert.equal(merged?.replyTo, "second-admin@example.test", "the second admin's edit survived");
    assert.ok(merged?.keyCiphertext && merged.keyCiphertext !== "sk_live_rotated_by_second");
    assert.ok(result, "the parked save completed after the lock holder committed");

    // The loser's audit evidence is authoritative: its BEFORE side shows the
    // first admin's committed state, proving the merge read post-lock state.
    const last = (await readEmailAuditRows(org.orgId)).at(-1)!;
    assert.equal(last.actorId, OTHER_USER);
    assert.equal(last.changes.before.fromEmail, "first-admin@example.test");
    assert.equal(last.changes.after.fromEmail, "first-admin@example.test");
    assert.equal(last.changes.after.replyTo, "second-admin@example.test");
    assert.equal(last.changes.secret, "rotated");
    assert.equal(JSON.stringify(last.changes).includes("sk_live_rotated_by_second"), false);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
    await dropScratchOrgReporting(org.orgId);
  }
});

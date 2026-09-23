import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { seedUser } from "./seed-user.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * seed-user.ts must never infer its tenant: it used to seed whatever
 * production org happened to be oldest, silently resetting credentials in
 * the wrong tenant once a second production org existed. The target org is
 * now an explicit first argument, sandboxes refuse, and every seeding
 * writes an audit_log row.
 */

// The decoy is created FIRST so it is the oldest production org: seeding
// the newer org proves the target comes from the argument, not the
// created_at ordering the old query relied on.
async function fixture() {
  const older = await createScratchOrg();
  const newer = await createScratchOrg();
  await createScratchUser(older.orgId, "Decoy", "admin");
  await createScratchUser(newer.orgId, "Admin", "admin");
  return { older, newer };
}

async function usersWithEmail(orgId: string, email: string) {
  return (await db.execute<{ id: string; is_active: boolean; password_hash: string }>(sql`
    select id, is_active, password_hash from users where org_id = ${orgId} and email = ${email}`)).rows;
}

test("seeding names the newer org and leaves the oldest production org alone", { skip: !DB }, async () => {
  const { older, newer } = await fixture();
  try {
    const email = `seeded-${newer.orgId.slice(0, 8)}@example.com`;
    // A deactivated previous login with the same email is reactivated with
    // a rotated credential, not duplicated.
    await db.execute(sql`
      insert into users (org_id, email, name, password_hash, is_active)
      values (${newer.orgId}, ${email}, 'Old Name', 'old-hash', false)`);
    const seeded = await seedUser({
      orgId: newer.orgId,
      email: email.toUpperCase(),
      name: "Seeded User",
      role: "admin",
      password: "correct horse battery staple",
    });
    assert.equal(seeded.orgId, newer.orgId);
    const target = await usersWithEmail(newer.orgId, email);
    assert.equal(target.length, 1);
    assert.equal(target[0]!.is_active, true);
    assert.notEqual(target[0]!.password_hash, "old-hash");
    assert.ok(target[0]!.password_hash.includes(":"));
    assert.deepEqual(await usersWithEmail(older.orgId, email), []);
    const grants = (await db.execute<{ key: string }>(sql`
      select r.key from role_assignments a join app_roles r on r.id = a.role_id
       where a.org_id = ${newer.orgId} and a.user_id = ${target[0]!.id}`)).rows;
    assert.deepEqual(grants.map((grant) => grant.key), ["admin"]);
    const audit = (await db.execute<{ row_id: string; action: string; actor_id: string | null; changes: { email: string; role: string } }>(sql`
      select row_id, action, actor_id, changes from audit_log
       where org_id = ${newer.orgId} and table_name = 'users' and row_id = ${target[0]!.id}`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.action, "seed_user");
    assert.equal(audit[0]!.actor_id, null);
    assert.equal(audit[0]!.changes.email, email);
    assert.equal(audit[0]!.changes.role, "admin");
    const decoyAudit = (await db.execute(sql`
      select id from audit_log where org_id = ${older.orgId} and table_name = 'users'`)).rows;
    assert.deepEqual(decoyAudit, []);
  } finally {
    await dropScratchOrgReporting(newer.orgId);
    await dropScratchOrgReporting(older.orgId);
  }
});

test("seeding refuses unknown and malformed org ids by name", { skip: !DB }, async () => {
  const { older, newer } = await fixture();
  try {
    const missing = randomUUID();
    await assert.rejects(
      () => seedUser({ orgId: missing, email: "x@example.com", name: "X", password: "secret-value" }),
      /no organization with id /,
    );
    await assert.rejects(
      () => seedUser({ orgId: "not-a-uuid", email: "x@example.com", name: "X", password: "secret-value" }),
      /pass the production org id/,
    );
  } finally {
    await dropScratchOrgReporting(newer.orgId);
    await dropScratchOrgReporting(older.orgId);
  }
});

test("seeding refuses a sandbox org even when it exists", { skip: !DB }, async () => {
  const { older, newer } = await fixture();
  try {
    await db.execute(sql`update orgs set env_kind = 'sandbox' where id = ${older.orgId}`);
    await assert.rejects(
      () => seedUser({ orgId: older.orgId, email: "x@example.com", name: "X", password: "secret-value" }),
      /refusing to seed a user into sandbox organization/,
    );
    assert.deepEqual(await usersWithEmail(older.orgId, "x@example.com"), []);
  } finally {
    await dropScratchOrgReporting(newer.orgId);
    await dropScratchOrgReporting(older.orgId);
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { dbResolver, encryptSecret } from "./manager.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  serverId: string;
  username: string;
}

async function seed(): Promise<Fixture> {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    const serverId = randomUUID();
    const username = `revoke-probe-${randomUUID().slice(0, 8)}`;
    await db.execute(sql`
      insert into sftp_servers
        (id, org_id, name, username, password_encrypted, backend, root_prefix)
      values
        (${serverId}, ${org.orgId}, 'Revocation Probe', ${username},
         ${encryptSecret("first-password")}, 'local', ${`sftp/${org.orgId}/probe`})`);
    return { orgId: org.orgId, serverId, username };
  });
}

async function setActive(fixture: Fixture, active: boolean): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update sftp_servers set is_active = ${active}, updated_at = now()
       where id = ${fixture.serverId} and org_id = ${fixture.orgId}`));
}

async function rotatePassword(fixture: Fixture, password: string): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update sftp_servers set password_encrypted = ${encryptSecret(password)}, updated_at = now()
       where id = ${fixture.serverId} and org_id = ${fixture.orgId}`));
}

async function deleteServer(fixture: Fixture): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`delete from sftp_servers where id = ${fixture.serverId} and org_id = ${fixture.orgId}`));
}

async function setBankFeeds(orgId: string, on: boolean): Promise<void> {
  const flag = on ? "true" : "false";
  await withBypassContext(() =>
    db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,bankFeeds}', ${flag}::jsonb)
       where id = ${orgId}`));
}

test(
  "a held SFTP session dies across disable, rotation, and delete — and only then",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      // Bank Feeds on: the daemon gates every login on the owning org's
      // feature, and a scratch org defaults it off.
      await setBankFeeds(fixture.orgId, true);
      // Authenticated before any change: the fence sees the live row.
      const before = await dbResolver.password(fixture.username, "first-password");
      assert.ok(before, "password auth must succeed while the login is active");
      assert.deepEqual(await dbResolver.checkSession!(before!), { alive: true });

      // Disable: new logins refuse AND the held session's next op is dead.
      await setActive(fixture, false);
      assert.equal(await dbResolver.password(fixture.username, "first-password"), null);
      assert.deepEqual(await dbResolver.checkSession!(before!), {
        alive: false,
        reason: `sftp login '${fixture.username}' is disabled — ask your administrator to re-enable it, then reconnect`,
      });

      // Rotation: the pre-rotation session is dead even after re-enabling,
      // while the fresh login from the new password is alive.
      await setActive(fixture, true);
      await rotatePassword(fixture, "second-password");
      assert.equal(await dbResolver.password(fixture.username, "first-password"), null);
      const after = await dbResolver.password(fixture.username, "second-password");
      assert.ok(after, "the rotated password must authenticate");
      assert.deepEqual(await dbResolver.checkSession!(before!), {
        alive: false,
        reason: `sftp login '${fixture.username}' credentials changed — reconnect with the current password or key`,
      });
      assert.deepEqual(await dbResolver.checkSession!(after!), { alive: true });

      // Delete: the session names the missing row.
      await deleteServer(fixture);
      assert.deepEqual(await dbResolver.checkSession!(after!), {
        alive: false,
        reason: `sftp login '${fixture.username}' no longer exists — ask your administrator to recreate it, then reconnect`,
      });
    } finally {
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "turning Bank Feeds off refuses new logins and ends held sessions, keeping the data",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      // A scratch org defaults Bank Feeds off: even correct credentials
      // authenticate nothing while the feature is off.
      assert.equal(await dbResolver.password(fixture.username, "first-password"), null);

      await setBankFeeds(fixture.orgId, true);
      const live = await dbResolver.password(fixture.username, "first-password");
      assert.ok(live, "the same credentials authenticate once the feature is on");
      assert.deepEqual(await dbResolver.checkSession!(live!), { alive: true });

      // Feature off mid-session: new logins refuse and the held session's
      // next operation is dead — the same revocation a disable performs.
      await setBankFeeds(fixture.orgId, false);
      assert.equal(await dbResolver.password(fixture.username, "first-password"), null);
      assert.deepEqual(await dbResolver.checkSession!(live!), {
        alive: false,
        reason: `sftp login '${fixture.username}' is unavailable: bank feeds is turned off for this organization — turn Bank Feeds back on under Company Settings → Features, then reconnect`,
      });

      // Data is kept: the row and its active flag survive the feature-off.
      const kept = await withBypassContext(async () => {
        const r = await db.execute<{ count: number; active: boolean }>(sql`
          select count(*)::int as count, bool_and(is_active) as active
            from sftp_servers where id = ${fixture.serverId} and org_id = ${fixture.orgId}`);
        return r.rows[0]!;
      });
      assert.equal(kept.count, 1);
      assert.equal(kept.active, true);

      // Re-enabling revives the SAME session: feature-off burns no
      // credential version, so there is nothing to re-issue.
      await setBankFeeds(fixture.orgId, true);
      assert.deepEqual(await dbResolver.checkSession!(live!), { alive: true });
    } finally {
      await dropScratchOrg(fixture.orgId);
    }
  },
);

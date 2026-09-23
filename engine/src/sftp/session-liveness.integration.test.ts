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

test(
  "a held SFTP session dies across disable, rotation, and delete — and only then",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
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

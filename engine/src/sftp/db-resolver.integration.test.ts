import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import ssh2 from "ssh2";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  currentRequestOrgResolver,
  db,
  registerRequestOrgResolver,
  withBypass,
  withBypassContext,
  withOrgContext,
} from "../platform/db.ts";
import { dbResolver, encryptSecret } from "./manager.ts";
import { generateHostKey, startSftpServer, type SftpServerConfig } from "./server.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function parsePrivate(pem: string): ssh2.ParsedKey {
  const parsed = ssh2.utils.parseKey(pem);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

function openSshLine(pub: ssh2.ParsedKey): string {
  return `${pub.type} ${pub.getPublicSSH().toString("base64")} m42-f1-key`;
}

interface LoginSeed {
  orgA: ScratchOrg;
  orgB: ScratchOrg;
  usernameA: string;
  passwordA: string;
  serverA: string;
  usernameB: string;
  serverB: string;
  keyB: ssh2.ParsedKey;
  keyBPem: string;
}

async function seedTwoTenants(): Promise<LoginSeed> {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  const usernameA = `m42-f1-a-${randomUUID().slice(0, 8)}`;
  const usernameB = `m42-f1-b-${randomUUID().slice(0, 8)}`;
  const passwordA = `pw-${randomUUID()}`;
  const serverA = randomUUID();
  const serverB = randomUUID();
  const keyBPem = generateHostKey();
  const keyB = parsePrivate(keyBPem);
  await withBypass(async () => {
    await db.execute(sql`
      insert into sftp_servers (id, org_id, name, username, password_encrypted, backend, bucket, root_prefix, is_active)
      values (${serverA}, ${orgA.orgId}, 'M42 F1 password login', ${usernameA}, ${encryptSecret(passwordA)}, 'local', null, ${`sftp/${orgA.orgId}/m42-f1`}, true)
    `);
    await db.execute(sql`
      insert into sftp_servers (id, org_id, name, username, authorized_keys, backend, bucket, root_prefix, is_active)
      values (${serverB}, ${orgB.orgId}, 'M42 F1 key login', ${usernameB}, ${openSshLine(keyB)}, 'local', null, ${`sftp/${orgB.orgId}/m42-f1`}, true)
    `);
    // The daemon gates every login on the owning org's Bank Feeds feature
    // (F11) — a scratch org defaults it off, so the seed enables it for
    // both tenants, exactly like the banking/sftp route seed does.
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,bankFeeds}', 'true'::jsonb)
       where id in (${orgA.orgId}, ${orgB.orgId})
    `);
  });
  return { orgA, orgB, usernameA, passwordA, serverA, usernameB, serverB, keyB, keyBPem };
}

async function lastConnectedAt(serverId: string): Promise<string | null> {
  const r = await withBypassContext(async () => {
    const res = await db.execute<{ at: string | null }>(
      sql`select last_connected_at as at from sftp_servers where id = ${serverId}`,
    );
    return res;
  });
  return r.rows[0]?.at ?? null;
}

/**
 * Run with NO ambient request scope at all — the boot-started daemon holds no
 * request identity, so the test-bypass resolver the harness installs must be
 * removed for the duration. Restored afterwards.
 */
async function withoutAmbientScope<T>(fn: () => Promise<T>): Promise<T> {
  const previous = currentRequestOrgResolver();
  registerRequestOrgResolver(() => undefined);
  try {
    return await fn();
  } finally {
    if (previous) registerRequestOrgResolver(previous);
  }
}

test(
  "SFTP password and key logins succeed with no ambient scope, per tenant",
  { skip: !DB },
  async () => {
    const s = await seedTwoTenants();
    try {
      await withoutAmbientScope(async () => {
        assert.equal(await lastConnectedAt(s.serverA), null);
        assert.equal(await lastConnectedAt(s.serverB), null);

        // RED before the fix: the unscoped lookup saw zero rows under FORCE
        // RLS, so every valid login was rejected on a boot-started daemon.
        const byPassword = await dbResolver.password(s.usernameA, s.passwordA);
        assert.ok(byPassword, "valid password login must succeed with no ambient org");
        assert.equal(byPassword.orgId, s.orgA.orgId);
        assert.equal(byPassword.id, s.serverA);
        assert.equal(
          await lastConnectedAt(s.serverA),
          null,
          "matching alone must not record a connection (F13: side-effect-free resolver)",
        );
        await dbResolver.loginSucceeded!(byPassword);
        assert.ok(await lastConnectedAt(s.serverA), "a verified login records last_connected_at");
        assert.equal(
          await lastConnectedAt(s.serverB),
          null,
          "touching one login must not mark the other tenant's row",
        );

        const byKey = await dbResolver.publicKey?.(s.usernameB, s.keyB.type, s.keyB.getPublicSSH());
        assert.ok(byKey, "valid key login must succeed with no ambient org");
        assert.equal(byKey.orgId, s.orgB.orgId);
        assert.equal(byKey.id, s.serverB);
        assert.equal(
          await lastConnectedAt(s.serverB),
          null,
          "a matched-but-unverified key must not record a connection",
        );
        await dbResolver.loginSucceeded!(byKey);
        assert.ok(await lastConnectedAt(s.serverB), "a verified key login records last_connected_at");

        const touchedA = await lastConnectedAt(s.serverA);
        const touchedB = await lastConnectedAt(s.serverB);
        assert.equal(
          await dbResolver.password(s.usernameA, `wrong-${s.passwordA}`),
          null,
          "a wrong password still fails",
        );
        assert.equal(
          await dbResolver.password(`nobody-${s.usernameA}`, s.passwordA),
          null,
          "an unknown username still fails",
        );
        const otherKey = parsePrivate(generateHostKey());
        assert.equal(
          await dbResolver.publicKey?.(s.usernameB, otherKey.type, otherKey.getPublicSSH()),
          null,
          "an unauthorized key still fails",
        );
        assert.equal(
          await lastConnectedAt(s.serverA),
          touchedA,
          "a failed login must not refresh last_connected_at",
        );
        assert.equal(
          await lastConnectedAt(s.serverB),
          touchedB,
          "a failed login must not refresh last_connected_at",
        );
      });
    } finally {
      await dropScratchOrg(s.orgA.orgId);
      await dropScratchOrg(s.orgB.orgId);
    }
  },
);

test(
  "SFTP logins do not inherit an ambient request org from the listener starter",
  { skip: !DB },
  async () => {
    const s = await seedTwoTenants();
    try {
      // A listener started from a platform-admin PATCH runs inside that
      // request's org. The login must resolve under its own row's org, not
      // the inherited one: tenant B's key login succeeds while scoped to A.
      await withOrgContext(s.orgA.orgId, async () => {
        // RED before the fix: the unscoped lookup inherited org A and saw
        // zero rows for tenant B's username.
        const byKey = await dbResolver.publicKey?.(s.usernameB, s.keyB.type, s.keyB.getPublicSSH());
        assert.ok(byKey, "tenant B key login must succeed inside tenant A's ambient scope");
        assert.equal(byKey.orgId, s.orgB.orgId);
        await dbResolver.loginSucceeded!(byKey);
        const byPassword = await dbResolver.password(s.usernameA, s.passwordA);
        assert.ok(byPassword, "tenant A password login must succeed inside its own ambient scope");
        await dbResolver.loginSucceeded!(byPassword);
      });
      await withoutAmbientScope(async () => {
        assert.ok(await lastConnectedAt(s.serverA), "tenant A touch landed on exactly its row");
        assert.ok(await lastConnectedAt(s.serverB), "tenant B touch landed on exactly its row");
      });
    } finally {
      await dropScratchOrg(s.orgA.orgId);
      await dropScratchOrg(s.orgB.orgId);
    }
  },
);

test(
  "a valid login is refused while Bank Feeds is off for its own org",
  { skip: !DB },
  async () => {
    const s = await seedTwoTenants();
    try {
      // The seed enables the feature for both tenants; switching org A off
      // refuses even its correct password — while org B's key login, whose
      // own org still has the feature, keeps working. The gate follows the
      // login's org, never the ambient scope.
      await withBypassContext(() =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,bankFeeds}', 'false'::jsonb)
           where id = ${s.orgA.orgId}`),
      );
      assert.equal(
        await dbResolver.password(s.usernameA, s.passwordA),
        null,
        "a correct password refuses while its org's Bank Feeds is off (F11)",
      );
      const byKey = await dbResolver.publicKey?.(s.usernameB, s.keyB.type, s.keyB.getPublicSSH());
      assert.ok(byKey, "the other tenant's login is unaffected by org A's feature");
      assert.equal(byKey.orgId, s.orgB.orgId);
    } finally {
      await dropScratchOrg(s.orgA.orgId);
      await dropScratchOrg(s.orgB.orgId);
    }
  },
);

test(
  "recording a login for a vanished server row fails instead of reporting success",
  { skip: !DB },
  async () => {
    const s = await seedTwoTenants();
    try {
      const byPassword = await dbResolver.password(s.usernameA, s.passwordA);
      assert.ok(byPassword);
      const stale: SftpServerConfig = { ...byPassword, id: randomUUID() };
      // A write matching zero rows is a failure, not a success: the row was
      // deleted or deactivated (or RLS denies it) between match and record.
      await assert.rejects(
        () => dbResolver.loginSucceeded!(stale),
        /no longer present in its organization/,
      );
      assert.equal(await lastConnectedAt(s.serverA), null);
    } finally {
      await dropScratchOrg(s.orgA.orgId);
      await dropScratchOrg(s.orgB.orgId);
    }
  },
);

function sshConnect(port: number, auth: Record<string, unknown>): Promise<import("ssh2").Client> {
  return new Promise((resolveClient, reject) => {
    const client = new ssh2.Client();
    let settled = false;
    client.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    client.once("ready", () => {
      settled = true;
      resolveClient(client);
    });
    client.connect({ host: "127.0.0.1", port, hostVerifier: () => true, ...auth });
  });
}

test(
  "a boot-started server accepts verified credentials and records only verified logins",
  { skip: !DB },
  async () => {
    const s = await seedTwoTenants();
    const server = await startSftpServer({ port: 0, hostKey: generateHostKey(), resolve: dbResolver });
    try {
      await withoutAmbientScope(async () => {
        // Invalid password: rejected, nothing recorded.
        await assert.rejects(
          sshConnect(server.port, { username: s.usernameA, password: `wrong-${s.passwordA}` }),
          /All configured authentication methods failed|authentication/i,
        );
        assert.equal(await lastConnectedAt(s.serverA), null);

        // Valid password: accepted and exactly its row recorded.
        const passwordClient = await sshConnect(server.port, { username: s.usernameA, password: s.passwordA });
        passwordClient.end();
        assert.ok(await lastConnectedAt(s.serverA), "a verified password login updates exactly its row");
        assert.equal(await lastConnectedAt(s.serverB), null);

        // Bad signature: the unsigned probe is accepted but the signed
        // attempt is rejected — and neither records a connection. The
        // presented key is the registered one; only its signature is forged
        // (same shape as the server unit test's invalid-signature case).
        const badKey = parsePrivate(s.keyBPem);
        badKey.sign = () => Buffer.alloc(64);
        await assert.rejects(
          sshConnect(server.port, {
            username: s.usernameB,
            authHandler: [{ type: "publickey", username: s.usernameB, key: badKey }],
          }),
          /All configured authentication methods failed|authentication/i,
        );
        assert.equal(
          await lastConnectedAt(s.serverB),
          null,
          "an unsigned probe and a bad signature leave last_connected_at unchanged",
        );

        // Valid signature: accepted and exactly its row recorded.
        const keyClient = await sshConnect(server.port, {
          username: s.usernameB,
          authHandler: [{ type: "publickey", username: s.usernameB, key: s.keyB }],
        });
        keyClient.end();
        assert.ok(await lastConnectedAt(s.serverB), "a verified signature updates exactly its row");
      });
    } finally {
      await server.close();
      await dropScratchOrg(s.orgA.orgId);
      await dropScratchOrg(s.orgB.orgId);
    }
  },
);

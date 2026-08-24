import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { streamOrgBackup } from "./backup.ts";
import { restoreOrgBackup } from "./backup-restore.ts";
import { db } from "./db.ts";
import { sealSecret, unsealSecret } from "./secrets.ts";
import {
  sealSecret as sealEmailSecret,
  unsealSecret as unsealEmailSecret,
} from "@openbooks/emails";
import { createScratchOrg, createScratchUser, dropScratchOrg, dropScratchOrgReporting } from "./test-fixtures.ts";

const ENABLED = !!process.env.OPENBOOKS_DB_URL && !!process.env.OPENBOOKS_DATA_KEY && process.env.OPENBOOKS_RESTORE_DRILL === "1";

test("offline drill exports, removes, restores, and revalidates an organization", { skip: !ENABLED, timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openbooks-restore-drill-"));
  const archive = join(root, "org.json.gz");
  const wrongSchemaArchive = join(root, "org-wrong-schema.json.gz");
  const wrongDataKeyArchive = join(root, "org-wrong-data-key.json.gz");
  const source = await createScratchOrg();
  const external = await createScratchOrg();
  try {
    const authUserId = await createScratchUser(source.orgId, "Restore Auth User", "restore_auth_user");
    const externalUserId = await createScratchUser(external.orgId, "External Grant User", "external_grant_user");
    const factorId = randomUUID();
    const oidcId = randomUUID();
    const issuer = `https://restore-drill-${randomUUID()}.example.test`;
    const subject = `subject-${randomUUID()}`;
    const mfaSecret = "JBSWY3DPEHPK3PXP";
    const emailCredential = `restore-email-${randomUUID()}`;
    const sealedEmailCredential = sealEmailSecret(emailCredential);
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{email}', ${JSON.stringify({
           enabled: true,
           provider: "resend",
           fromEmail: "restore@scratch.test",
           keyCiphertext: sealedEmailCredential.ciphertext,
           keyNonce: sealedEmailCredential.nonce,
         })}::jsonb)
       where id = ${source.orgId}`);
    await db.execute(sql`
      insert into auth_mfa_factors
        (id, user_id, secret_encrypted, recovery_code_hashes, enabled_at)
      values
        (${factorId}, ${authUserId}, ${sealSecret(mfaSecret)},
         ${JSON.stringify([`s1:${"a".repeat(32)}:${"b".repeat(64)}`])}::jsonb, now())`);
    await db.execute(sql`
      insert into auth_oidc_identities
        (id, issuer, subject, user_id, email_at_link, last_login_at)
      values
        (${oidcId}, ${issuer}, ${subject}, ${authUserId}, 'restore-auth@scratch.test', now())`);
    // These rows are security state, not durable account configuration. The
    // archive must never revive them after the source organization is removed.
    await db.execute(sql`
      insert into auth_sessions
        (user_id, token_hash, auth_method, expires_at)
      values
        (${authUserId}, ${createHash("sha256").update(randomUUID()).digest("hex")}, 'password', now() + interval '30 minutes')`);
    await db.execute(sql`
      insert into auth_login_state
        (email_hash, user_id, failure_count, last_failed_at, locked_until)
      values
        (${createHash("sha256").update(`state-${randomUUID()}`).digest("hex")}, ${authUserId}, 4, now(), now() + interval '30 minutes')`);
    await db.execute(sql`
      insert into auth_login_challenges
        (user_id, email_hash, auth_method, expires_at)
      values
        (${authUserId}, ${createHash("sha256").update(`challenge-${randomUUID()}`).digest("hex")}, 'password', now() + interval '10 minutes')`);
    // Incoming access is owned jointly with another tenant and cannot be made
    // self-contained without copying that tenant's login identity.
    await db.execute(sql`
      insert into user_org_access (member_user_id, org_id, acting_user_id, is_active)
      values (${externalUserId}, ${source.orgId}, ${authUserId}, true)`);

    const gzip = createGzip({ level: 6 });
    const completed = pipeline(gzip, createWriteStream(archive, { mode: 0o600 }));
    const exported = await streamOrgBackup(source.orgId, gzip);
    await completed;
    assert.ok(exported.tables.some((table) => table.name === "auth_mfa_factors" && table.rows === 1));
    assert.ok(exported.tables.some((table) => table.name === "auth_oidc_identities" && table.rows === 1));
    for (const excluded of ["auth_sessions", "auth_login_state", "auth_login_challenges", "auth_login_events", "user_org_access"]) {
      assert.equal(exported.tables.some((table) => table.name === excluded), false, `${excluded} must not enter an org archive`);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const sha256 = hash.digest("hex");

    const wrongSchemaBytes = gzipSync(
      gunzipSync(await readFile(archive))
        .toString("utf8")
        .replace(/"schemaSha256":"[0-9a-f]{64}"/, `"schemaSha256":"${"0".repeat(64)}"`),
    );
    await writeFile(wrongSchemaArchive, wrongSchemaBytes, { mode: 0o600 });
    const wrongSchemaSha256 = createHash("sha256").update(wrongSchemaBytes).digest("hex");

    const archiveLines = gunzipSync(await readFile(archive)).toString("utf8").split("\n");
    const tamperedHeader = JSON.parse(archiveLines[0]!) as { dataKeyCheck: string };
    // Flip the first IV character: the canary ends in the base64 auth tag,
    // whose trailing '=' padding Node's lenient decoder ignores — flipping THE
    // LAST char was a no-op tamper that decoded to the same bytes.
    const canaryBody = tamperedHeader.dataKeyCheck.slice("enc:v1:".length);
    tamperedHeader.dataKeyCheck = `enc:v1:${canaryBody[0] === "A" ? "B" : "A"}${canaryBody.slice(1)}`;
    archiveLines[0] = JSON.stringify(tamperedHeader);
    const wrongDataKeyBytes = gzipSync(archiveLines.join("\n"));
    await writeFile(wrongDataKeyArchive, wrongDataKeyBytes, { mode: 0o600 });
    const wrongDataKeySha256 = createHash("sha256").update(wrongDataKeyBytes).digest("hex");

    await dropScratchOrg(source.orgId);
    const absent = (await db.execute<{ count: number }>(sql`select count(*)::int as count from orgs where id = ${source.orgId}`));
    assert.equal(absent.rows[0]?.count, 0);

    await assert.rejects(
      restoreOrgBackup({
        archivePath: wrongDataKeyArchive,
        expectedSha256: wrongDataKeySha256,
        expectedOrgId: source.orgId,
        connectionString: process.env.OPENBOOKS_DB_URL!,
        testOnlyAllowNonemptyTarget: true,
      }),
      /backup data-key verification failed/,
    );

    await assert.rejects(
      restoreOrgBackup({
        archivePath: wrongSchemaArchive,
        expectedSha256: wrongSchemaSha256,
        expectedOrgId: source.orgId,
        connectionString: process.env.OPENBOOKS_DB_URL!,
        testOnlyAllowNonemptyTarget: true,
      }),
      /schema fingerprint .* does not match target/,
    );
    await assert.rejects(
      restoreOrgBackup({
        archivePath: archive,
        expectedSha256: sha256,
        expectedOrgId: source.orgId,
        connectionString: process.env.OPENBOOKS_DB_URL!,
      }),
      /restore target is not empty/,
    );

    const report = await restoreOrgBackup({
      archivePath: archive,
      expectedSha256: sha256,
      expectedOrgId: source.orgId,
      connectionString: process.env.OPENBOOKS_DB_URL!,
      testOnlyAllowNonemptyTarget: true,
    });
    assert.equal(report.rowsRestored, exported.totalRows);
    assert.equal(report.validation.databaseConstraints, "passed");
    assert.equal(report.validation.mfaCiphertexts, "passed");
    assert.equal(report.validation.mfaRecoveryHashes, "passed");
    assert.equal(report.validation.sessionSecretEmailConfig, "passed");
    assert.equal(report.validation.postedLedgerBalance, "passed");

    const restored = (await db.execute<{
        name: string;
        email: { keyCiphertext: string; keyNonce: string };
        account_count: number;
        party_count: number;
      }>(sql`
      select o.name, o.settings -> 'email' as email,
             (select count(*)::int from accounts where org_id = ${source.orgId}) account_count,
             (select count(*)::int from parties where org_id = ${source.orgId}) party_count
        from orgs o where o.id = ${source.orgId}
    `));
    assert.match(restored.rows[0]?.name ?? "", /^Scratch /);
    assert.ok(restored.rows[0]!.account_count >= 15);
    assert.equal(restored.rows[0]!.party_count, 2);
    assert.equal(
      unsealEmailSecret({
        ciphertext: restored.rows[0]!.email.keyCiphertext,
        nonce: restored.rows[0]!.email.keyNonce,
      }),
      emailCredential,
    );

    const restoredAuth = (await db.execute<{
      mfa_count: number; mfa_ciphertext: string; oidc_count: number; session_count: number;
      login_state_count: number; challenge_count: number; access_count: number;
    }>(sql`
      select
        (select count(*)::int from auth_mfa_factors where user_id = ${authUserId}) mfa_count,
        (select min(secret_encrypted) from auth_mfa_factors where user_id = ${authUserId}) mfa_ciphertext,
        (select count(*)::int from auth_oidc_identities
          where user_id = ${authUserId} and issuer = ${issuer} and subject = ${subject}) oidc_count,
        (select count(*)::int from auth_sessions where user_id = ${authUserId}) session_count,
        (select count(*)::int from auth_login_state where user_id = ${authUserId}) login_state_count,
        (select count(*)::int from auth_login_challenges where user_id = ${authUserId}) challenge_count,
        (select count(*)::int from user_org_access
          where org_id = ${source.orgId} and acting_user_id = ${authUserId}) access_count
    `));
    const authRow = restoredAuth.rows[0]!;
    assert.equal(authRow.mfa_count, 1);
    assert.equal(unsealSecret(authRow.mfa_ciphertext), mfaSecret);
    assert.equal(authRow.oidc_count, 1);
    assert.equal(authRow.session_count, 0);
    assert.equal(authRow.login_state_count, 0);
    assert.equal(authRow.challenge_count, 0);
    assert.equal(authRow.access_count, 0);

    // Prove the explicit lost-key recovery path keeps the OIDC identity but
    // drops MFA factors for supervised user re-enrollment.
    await dropScratchOrg(source.orgId);
    const resetReport = await restoreOrgBackup({
      archivePath: archive,
      expectedSha256: sha256,
      expectedOrgId: source.orgId,
      connectionString: process.env.OPENBOOKS_DB_URL!,
      testOnlyAllowNonemptyTarget: true,
      resetMfaFactors: true,
    });
    assert.equal(resetReport.validation.mfaCiphertexts, "reset");
    assert.equal(resetReport.mfaFactorsReset, 1);
    const resetAuth = (await db.execute<{ mfa_count: number; oidc_count: number }>(sql`
      select
        (select count(*)::int from auth_mfa_factors where user_id = ${authUserId}) mfa_count,
        (select count(*)::int from auth_oidc_identities where user_id = ${authUserId}) oidc_count
    `));
    const resetAuthRow = resetAuth.rows[0]!;
    assert.equal(resetAuthRow.mfa_count, 0);
    assert.equal(resetAuthRow.oidc_count, 1);
  } finally {
    await dropScratchOrgReporting(source.orgId);
    await dropScratchOrgReporting(external.orgId);
    await rm(root, { recursive: true, force: true });
  }
});

test("one-org export rejects outbound cross-organization foreign keys", { skip: !ENABLED, timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openbooks-restore-closure-"));
  const production = await createScratchOrg();
  const sandbox = await createScratchOrg();
  const expectRejectedExport = async (orgId: string, fileName: string, constraint: RegExp) => {
    const gzip = createGzip({ level: 1 });
    const completed = pipeline(gzip, createWriteStream(join(root, fileName), { mode: 0o600 })).then(
      () => null,
      (error: unknown) => error,
    );
    await assert.rejects(streamOrgBackup(orgId, gzip), constraint);
    assert.ok((await completed) instanceof Error);
  };
  try {
    await db.execute(sql`
      update orgs
         set env_kind = 'sandbox', sandbox_of = ${production.orgId}, sandbox_seed = ${randomUUID()}
       where id = ${sandbox.orgId}`);
    await expectRejectedExport(sandbox.orgId, "sandbox.json.gz", /orgs_sandbox_of_fkey/);

    await db.execute(sql`
      insert into change_sets (org_id, sandbox_org_id, name, status)
      values (${production.orgId}, ${sandbox.orgId}, 'External sandbox dependency', 'draft')`);
    await expectRejectedExport(production.orgId, "production.json.gz", /change_sets_sandbox_org_id_fkey/);
  } finally {
    await dropScratchOrgReporting(sandbox.orgId);
    await dropScratchOrgReporting(production.orgId);
    await rm(root, { recursive: true, force: true });
  }
});

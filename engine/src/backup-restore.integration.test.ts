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
import { postDocument } from "./posting.ts";
import {
  createPaymentDocument,
  postPaymentWithApplications,
  reversePaymentForReturn,
  updateDraftPayment,
} from "./payments.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, dropScratchOrgReporting, orgRowCounts } from "./test-fixtures.ts";

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

test("populated ledger exports, restores, and revalidates with nonzero fidelity", { skip: !ENABLED, timeout: 300_000 }, async () => {
  // The offline drill above restores an org whose ledger is EMPTY: its
  // posted-ledger balance check passes vacuously and proves nothing about
  // restore fidelity. This drill posts a real ledger first — invoice,
  // payment with application, reversal, secondary-book pair, dimensions,
  // source links, custom fields, attachments with bytes — then demands the
  // restored tenant match independent totals with NONZERO counts per table.
  const root = await mkdtemp(join(tmpdir(), "openbooks-restore-ledger-"));
  const archive = join(root, "org.json.gz");
  const source = await createScratchOrg();
  const actorId = await createScratchUser(source.orgId, "Ledger Seed User", "ledger_seed_user");
  try {
    // Dimensions live on real registry rows, not free text.
    const departmentId = randomUUID();
    const locationId = randomUUID();
    const classId = randomUUID();
    await db.execute(sql`insert into departments (id, org_id, name) values (${departmentId}, ${source.orgId}, 'Drill department')`);
    await db.execute(sql`insert into locations (id, org_id, name) values (${locationId}, ${source.orgId}, 'Drill location')`);
    await db.execute(sql`insert into classes (id, org_id, name) values (${classId}, ${source.orgId}, 'Drill class')`);

    // Custom-field definitions for the header and the line.
    await db.execute(sql`insert into custom_field_defs (org_id, target_table, key, label, field_type)
      values (${source.orgId}, 'documents', 'drill_origin', 'Drill origin', 'text'),
             (${source.orgId}, 'document_lines', 'drill_note', 'Drill note', 'text')`);

    // Kernel-posted customer invoice with dimensions + custom values.
    const invoiceId = randomUUID();
    const invoiceLineId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, party_id, subsidiary_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total,
         custom, created_by)
      values (${invoiceId}, ${source.orgId}, 'customer_invoice', 'draft', 'INV-DRILL-1',
              ${source.customerId}, ${source.subsidiaryId}, ${source.date}, ${source.date},
              'CAD', '1', '500.0000', '0', '500.0000',
              '{"drill_origin": "restore-drill"}'::jsonb, ${actorId})`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount,
         tax_input_amount, tax_amount, quantity, unit_price,
         department_id, location_id, class_id, custom)
      values (${invoiceLineId}, ${source.orgId}, ${invoiceId}, 1, ${source.accounts.revenue}, '500.0000',
              '500.0000', '0', '1', '500.0000',
              ${departmentId}, ${locationId}, ${classId}, '{"drill_note": "Drill scope"}'::jsonb)`);
    await db.execute(sql`update documents set status = 'approved' where id = ${invoiceId} and org_id = ${source.orgId}`);
    const invoiceEntryId = await postDocument(invoiceId, {
      control: { ar: source.accounts.ar, ap: source.accounts.ap, bank: source.accounts.bank },
    });

    // Kernel payment applied to the invoice's AR line, then reversed.
    const invoiceArLine = (await db.execute<{ id: string }>(sql`
      select id from journal_lines where entry_id = ${invoiceEntryId} and account_id = ${source.accounts.ar}`)).rows[0]!.id;
    const payment = await createPaymentDocument({
      orgId: source.orgId,
      kind: "customer_payment",
      createdBy: actorId,
      partyId: source.customerId,
      bankAccountId: source.accounts.bank,
      subsidiaryId: source.subsidiaryId,
      documentDate: source.date,
      currency: "CAD",
      fxRate: "1",
    });
    await updateDraftPayment(payment.id, {
      allocations: [{
        openLineId: invoiceArLine,
        sourceTransactionAmount: "500",
        targetTransactionAmount: "500",
        settlementRate: "1",
        settlementRateSource: "same_currency",
        settlementRateReference: "DRILL",
      }],
      bankAccountId: source.accounts.bank,
    }, actorId, source.orgId);
    await db.execute(sql`update documents set status = 'approved' where id = ${payment.id} and org_id = ${source.orgId}`);
    await postPaymentWithApplications(payment.id, undefined, actorId);
    // The kernel records the payment-settles-invoice source link itself as
    // part of posting — assert it rather than inserting a duplicate.
    const paysLinks = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from document_links
       where org_id = ${source.orgId} and from_document_id = ${payment.id}
         and to_document_id = ${invoiceId} and link_type = 'pays'`)).rows[0]!.n;
    assert.ok(paysLinks >= 1, "posting the payment must record the pays source link");
    await reversePaymentForReturn(payment.id, source.orgId, "Drill return", actorId, source.date);

    // Secondary book with its own balanced posted pair.
    const secondaryBookId = randomUUID();
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${secondaryBookId}, ${source.orgId}, 'DRILL-SEC', 'Drill secondary', false, true, true)`);
    const secondaryEntryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${secondaryEntryId}, ${source.orgId}, ${secondaryBookId}, ${source.subsidiaryId},
              'DRILL-SEC-1', ${source.date}, ${source.periodId}, 'DRILL-SEC-1', 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values
        (${source.orgId}, ${secondaryEntryId}, 1, ${source.accounts.ar}, ${source.subsidiaryId}, '250.0000', 'CAD', '250.0000', '1'),
        (${source.orgId}, ${secondaryEntryId}, 2, ${source.accounts.ap}, ${source.subsidiaryId}, '-250.0000', 'CAD', '-250.0000', '1')`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${secondaryEntryId}`);

    // Attachment with real bytes on the invoice.
    const folderId = randomUUID();
    const fileId = randomUUID();
    const versionId = randomUUID();
    const blobBytes = Buffer.from("drill-attachment-bytes", "utf8");
    await db.execute(sql`insert into folders (id, org_id, name) values (${folderId}, ${source.orgId}, 'Drill evidence')`);
    await db.execute(sql`
      insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${source.orgId}, ${folderId}, 'drill.txt', 'text/plain', ${blobBytes.length})`);
    await db.execute(sql`
      insert into file_versions (id, file_id, version_number, size_bytes, content_type)
      values (${versionId}, ${fileId}, 1, ${blobBytes.length}, 'text/plain')`);
    await db.execute(sql`insert into file_blobs (version_id, bytes) values (${versionId}, ${blobBytes})`);
    await db.execute(sql`update files set current_version_id = ${versionId} where id = ${fileId}`);
    await db.execute(sql`
      insert into file_attachments (org_id, file_id, target_table, target_id, created_by)
      values (${source.orgId}, ${fileId}, 'documents', ${invoiceId}, ${actorId})`);

    // Independent totals BEFORE export: every org-table count plus the
    // per-book trial balance and the raw blob bytes. The rebuilt aggregates
    // (gl_month_activity, party_payment_stats) are deliberately excluded from
    // archives and rebuilt on restore, so they compare by their verify
    // functions instead of byte counts — the n=0 tombstones the live
    // triggers leave behind are contract-equivalent to absent rows.
    const derivedAggregates = new Set(["gl_month_activity", "party_payment_stats"]);
    const comparableCounts = (counts: Record<string, number>): Record<string, number> =>
      Object.fromEntries(Object.entries(counts).filter(([name]) => !derivedAggregates.has(name)));
    const beforeCounts = await orgRowCounts(source.orgId);
    const trialBalance = async () => (await db.execute<{ book: string; entries: number; balance: string; lines: number }>(sql`
      select e.book_id as book, count(distinct e.id)::int as entries,
             coalesce(sum(l.amount), 0)::text as balance, count(l.*)::int as lines
        from journal_entries e left join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
       where e.org_id = ${source.orgId} and e.status in ('posted', 'reversed')
       group by e.book_id order by e.book_id`)).rows;
    const blobBytesHex = async () => (await db.execute<{ version_id: string; hex: string }>(sql`
      select v.id as version_id, encode(b.bytes, 'hex') as hex
        from file_blobs b join file_versions v on v.id = b.version_id
        join files f on f.id = v.file_id
       where f.org_id = ${source.orgId} order by v.id`)).rows;
    const reversedBefore = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${source.orgId} and status = 'reversed'`)).rows[0]!.n;
    const beforeTrial = await trialBalance();
    const beforeBlobs = await blobBytesHex();
    assert.ok(reversedBefore >= 1, "the seeded ledger must contain a reversed entry");
    assert.ok(beforeBlobs.length === 1, "the seeded ledger must contain the attachment bytes");

    const gzip = createGzip({ level: 6 });
    const completed = pipeline(gzip, createWriteStream(archive, { mode: 0o600 }));
    const exported = await streamOrgBackup(source.orgId, gzip);
    await completed;
    for (const name of ["journal_entries", "journal_lines", "documents", "document_lines", "applications",
      "accounting_books", "document_links", "custom_field_defs", "folders", "files", "file_versions",
      "file_blobs", "file_attachments"]) {
      const table = exported.tables.find((t) => t.name === name);
      assert.ok((table?.rows ?? 0) > 0, `the archive must carry nonzero ${name} rows`);
    }
    for (const name of derivedAggregates) {
      assert.ok(!exported.tables.some((t) => t.name === name), `${name} travels via rebuild, not archive bytes`);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);

    await dropScratchOrg(source.orgId);
    const report = await restoreOrgBackup({
      archivePath: archive,
      expectedSha256: hash.digest("hex"),
      expectedOrgId: source.orgId,
      connectionString: process.env.OPENBOOKS_DB_URL!,
      // The bootstrap's own org row always remains, so the strict
      // empty-target gate cannot pass in a bootstrapped database.
      testOnlyAllowNonemptyTarget: true,
    });
    assert.equal(report.validation.postedLedgerBalance, "passed");

    // The restored tenant must match the independent totals exactly, with
    // nonzero counts everywhere the seeded ledger wrote. Rebuilt aggregates
    // verify by their own invariant functions.
    assert.deepEqual(comparableCounts(await orgRowCounts(source.orgId)), comparableCounts(beforeCounts));
    assert.deepEqual(await trialBalance(), beforeTrial);
    assert.deepEqual(await blobBytesHex(), beforeBlobs);
    const statsVerify = (await db.execute(sql`select * from openbooks_party_payment_stats_verify(${source.orgId})`)).rows;
    assert.deepEqual(statsVerify, [], "rebuilt payment stats must verify against the restored applications");
    const glVerify = (await db.execute(sql`select * from openbooks_gl_activity_verify(${source.orgId})`)).rows;
    assert.deepEqual(glVerify, [], "rebuilt GL activity must verify against the restored ledger");
    for (const name of ["journal_entries", "journal_lines", "documents", "document_lines", "applications",
      "accounting_books", "document_links", "custom_field_defs", "folders", "files", "file_attachments"]) {
      assert.ok((beforeCounts[name] ?? 0) > 0, `the seeded ledger must hold nonzero ${name} rows`);
    }
    const reversedAfter = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${source.orgId} and status = 'reversed'`)).rows[0]!.n;
    assert.ok(reversedAfter >= 1, "the reversal must survive the restore");
  } finally {
    await dropScratchOrgReporting(source.orgId);
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

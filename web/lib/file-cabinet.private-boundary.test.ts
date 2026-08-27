import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

/**
 * Regression coverage for the nested private-folder boundary defect in
 * web/lib/file-cabinet.ts: owning a private folder anywhere on the ancestor
 * chain used to waive a FOREIGN private folder elsewhere on the same chain —
 * folderAccessLevel returned Manager (and unsuppressed baseline) for subtrees
 * that resolveReadScope hides from the very same viewers, opening every
 * mutation gate (rename/move/delete/purge, bulk ops) on read-invisible rows.
 *
 * The scenario runs against the real exported functions on a real database,
 * asserting exact access levels plus a mechanical read/write parity invariant
 * (folderAccessLevel ≠ 'none' ⇔ the folder is visible via the read paths),
 * and that explicit resource_grants are the only way past the boundary.
 */
test(
  "nested private-folder ownership cannot bypass a foreign private boundary",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    // A bare OPENBOOKS_DB_URL (throwaway container) gets the published schema
    // through the canonical idempotent bootstrap; an already-migrated host is
    // left untouched apart from a catalog existence probe.
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import pg from "pg";
        const client = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
        await client.connect();
        const r = await client.query("select to_regclass('public.folders') is not null as ok");
        console.log("BOOTSTRAP_NEEDED=" + (!r.rows[0].ok));
        await client.end();
        `,
      ],
      { cwd: process.cwd(), env: process.env, encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    if (/BOOTSTRAP_NEEDED=true/.test(probe.stdout)) {
      const bootstrapped = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/bootstrap.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: "test",
            ORG_NAME: "OpenBooks Test",
            ORG_CURRENCY: "CAD",
            ORG_COUNTRY: "CA",
          },
          encoding: "utf8",
        },
      );
      assert.equal(bootstrapped.status, 0, bootstrapped.stderr || bootstrapped.stdout);
    }

    // The spawned scenario source stays plain JavaScript: node parses `-e`
    // modules itself; only imported .ts files go through the tsx transform.
    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
      import {
        fileAccessLevel,
        folderAccessLevel,
        getFolderTree,
        listFiles,
        setGrant,
      } from "./web/lib/file-cabinet.ts";

      installTrustedTestDatabaseBypass();

      // Fixture tree (one org):
      //   rootA (private, alice)
      //     workA                  – plain folder inside alice's private subtree
      //       innerA (private, alice)
      //         leafA              – deep leaf of alice's OWN private chain
      //       orphanPrivate (private, owner NULL)
      //     secB (private, bob)    – bob's own private folder nested behind
      //                              alice's foreign private boundary
      //         leafB              – invisible to BOTH viewers via the read path
      const org = await createScratchOrg();
      const orgId = org.orgId;
      try {
        const alice = randomUUID();
        const bob = randomUUID();
        const ids = Array.from({ length: 7 }, () => randomUUID());
        const rootA = ids[0];
        const workA = ids[1];
        const innerA = ids[2];
        const leafA = ids[3];
        const orphanPrivate = ids[4];
        const secB = ids[5];
        const leafB = ids[6];

        const roleId = (await db.execute(sql\`
          insert into app_roles (org_id, key, name, description, is_built_in, permissions)
          values (\${orgId}, 'member', 'Member', 'boundary fixture', false, '[]'::jsonb)
          returning id
        \`)).rows[0].id;
        for (const pair of [[alice, "alice@boundary.fixture"], [bob, "bob@boundary.fixture"]]) {
          const userId = pair[0];
          const email = pair[1];
          await db.execute(sql\`
            insert into users (id, org_id, email, name, password_hash, is_active)
            values (\${userId}, \${orgId}, \${email}, \${email.split("@")[0]}, 'x', false)
          \`);
          await db.execute(sql\`
            insert into role_assignments (org_id, user_id, role_id)
            values (\${orgId}, \${userId}, \${roleId})
          \`);
          await db.execute(sql\`update users set is_active = true where id = \${userId}\`);
        }
        const folders = [
          [rootA, null, "rootA", true, alice],
          [workA, rootA, "workA", false, null],
          [innerA, workA, "innerA", true, alice],
          [leafA, innerA, "leafA", false, null],
          [orphanPrivate, workA, "orphanPrivate", true, null],
          [secB, rootA, "secB", true, bob],
          [leafB, secB, "leafB", false, null],
        ];
        for (const f of folders) {
          await db.execute(sql\`
            insert into folders (id, org_id, parent_folder_id, name, is_private, owner_id)
            values (\${f[0]}, \${orgId}, \${f[1]}, \${f[2]}, \${f[3]}, \${f[4]})
          \`);
        }
        const fileIds = {};
        for (const folder of [leafA, leafB]) {
          const fileId = randomUUID();
          fileIds[folder] = fileId;
          await db.execute(sql\`
            insert into files (id, org_id, folder_id, name, content_type, size_bytes)
            values (\${fileId}, \${orgId}, \${folder}, \${"f-" + fileId.slice(0, 8) + ".txt"}, \${"text/plain"}, 3)
          \`);
        }

        const aliceViewer = { userId: alice, isAdmin: false, baseline: "viewer" };
        const bobViewer = { userId: bob, isAdmin: false, baseline: "viewer" };
        const adminViewer = { userId: "no-such-user", isAdmin: true };

        const level = async (viewer, folderId) => folderAccessLevel(orgId, viewer, folderId);

        // Ownership intact inside one's own private subtree (no crossing).
        assert.equal(await level(aliceViewer, rootA), "manager", "alice owns her private root");
        assert.equal(await level(aliceViewer, workA), "manager", "alice manages her own subtree");
        assert.equal(await level(aliceViewer, innerA), "manager", "alice manages her nested private folder");
        assert.equal(await level(aliceViewer, leafA), "manager", "ownership reaches deep leaves");

        // THE DEFECT: ownership of a private folder on the chain must not
        // waive a foreign private boundary elsewhere on the chain.
        assert.equal(await level(aliceViewer, secB), "none", "foreign private boundary seals bob's folder from alice");
        assert.equal(await level(aliceViewer, leafB), "none", "alice gets nothing under bob's nested private folder");
        assert.equal(await level(bobViewer, secB), "none", "bob's own ownership does not pierce alice's boundary above him");
        assert.equal(await level(bobViewer, leafB), "none", "bob gets nothing in his subtree behind the boundary");
        assert.equal(await level(bobViewer, rootA), "none", "foreign private root hides from bob");
        assert.equal(await level(bobViewer, workA), "none");
        assert.equal(await level(bobViewer, innerA), "none");
        assert.equal(await level(bobViewer, leafA), "none");
        assert.equal(await level(aliceViewer, orphanPrivate), "none", "NULL-owner private folder counts as foreign");
        assert.equal(await level(adminViewer, leafB), "manager", "admins keep Manager everywhere");
        assert.equal(await fileAccessLevel(orgId, aliceViewer, fileIds[leafB]), "none", "files inherit the boundary rule (alice)");
        assert.equal(await fileAccessLevel(orgId, bobViewer, fileIds[leafB]), "none", "files inherit the boundary rule (bob)");

        // Grants are the only path past a foreign boundary, and confer exactly
        // their own tier — never the spurious Manager the defect produced.
        await setGrant({
          orgId, resourceType: "folder", resourceId: secB,
          principalType: "user", principalId: alice, access: "editor", actorId: alice,
        });
        await setGrant({
          orgId, resourceType: "folder", resourceId: orphanPrivate,
          principalType: "user", principalId: bob, access: "viewer", actorId: alice,
        });
        assert.equal(await level(aliceViewer, leafB), "editor", "editor grant re-opens the subtree at editor tier");
        assert.equal(await level(bobViewer, leafB), "none", "alice's grant does not leak to bob");
        assert.equal(await level(bobViewer, orphanPrivate), "viewer", "viewer grant re-opens the NULL-owner boundary");
        assert.equal(await fileAccessLevel(orgId, aliceViewer, fileIds[leafB]), "editor", "granted folder lifts contained files");

        // Read/write parity invariant: the write-path tier agrees with the
        // read-path scope for every viewer/folder pair — a folder the lists
        // hide must not be actionable, and anything listed stays actionable.
        const targets = [
          [rootA, "rootA"], [workA, "workA"], [innerA, "innerA"], [leafA, "leafA"],
          [orphanPrivate, "orphanPrivate"], [secB, "secB"], [leafB, "leafB"],
        ];
        for (const entry of [["alice", aliceViewer], ["bob", bobViewer]]) {
          const viewerName = entry[0];
          const viewer = entry[1];
          const tree = new Set((await getFolderTree(orgId, viewer)).map((f) => f.id));
          for (const target of targets) {
            const folderId = target[0];
            const name = target[1];
            const visible = tree.has(folderId);
            const tier = await level(viewer, folderId);
            const listed = (await listFiles(orgId, viewer, { folderId })).total;
            const wantListed = visible && (folderId === leafA || folderId === leafB) ? 1 : 0;
            assert.equal(tier !== "none", visible, \`parity \${viewerName}/\${name}: access=\${tier} treeVisible=\${visible}\`);
            assert.equal(listed, wantListed, \`parity \${viewerName}/\${name}: fileListings\`);
          }
        }
      } finally {
        await dropScratchOrg(orgId);
      }
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--import",
        "./engine/src/test-database-bypass.ts",
        "--input-type=module",
        "-e",
        source,
      ],
      { cwd: process.cwd(), env: process.env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
);

/**
 * Regression coverage for the mutation/audit atomicity defect in
 * web/lib/file-cabinet.ts: mutations and their audit evidence used to be two
 * independent autocommit statements issued by the route, so a failed audit
 * insert returned an error AFTER the file had already changed — irreversible
 * for purgeFile (files, versions, blobs, attachment links already gone).
 *
 * The verbs now own mutation + attributable before/after evidence in ONE
 * inDbTransaction unit (recordFileEvent executes on the caller-provided
 * executor seam), and the external S3 deletion stays strictly post-commit.
 *
 * These cases run against a real database in a scratch org. Deferred live-PG
 * execution command (schema-ready throwaway database):
 *   eval "$(scripts/testdb.sh new)" && NODE_ENV=test node --import tsx --test --test-force-exit web/lib/file-audit.test.ts web/lib/cabinet.private-boundary.test.ts
 * (with OPENBOOKS_TRUSTED_TEST_BYPASS=1 exported for the trusted test boundary;
 * npm test supplies it).
 */

/** Probe + (if needed) bootstrap the schema, then run one scenario child. Same
 *  environment contract as the boundary test above. */
function runCabinetAtomicityScenario(source: string): void {
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import pg from "pg";
      const client = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
      await client.connect();
      const r = await client.query("select to_regclass('public.folders') is not null as ok");
      console.log("BOOTSTRAP_NEEDED=" + (!r.rows[0].ok));
      await client.end();
      `,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  if (/BOOTSTRAP_NEEDED=true/.test(probe.stdout)) {
    const bootstrapped = spawnSync(process.execPath, ["--import", "tsx", "scripts/bootstrap.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        ORG_NAME: "OpenBooks Test",
        ORG_CURRENCY: "CAD",
        ORG_COUNTRY: "CA",
      },
      encoding: "utf8",
    });
    assert.equal(bootstrapped.status, 0, bootstrapped.stderr || bootstrapped.stdout);
  }
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--import",
      "./engine/src/test-database-bypass.ts",
      "--input-type=module",
      "-e",
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

/** Shared fixture: a folder holding a file with two DB-stored versions —
 *  everything a purge must account for before any links are added. */
const FILE_FIXTURE = `
  const actor = randomUUID();
  const folderId = randomUUID();
  const fileId = randomUUID();
  await db.execute(sql\`
    insert into folders (id, org_id, parent_folder_id, name)
    values (\${folderId}, \${orgId}, null, 'atomicity')
  \`);
  await db.execute(sql\`
    insert into files (id, org_id, folder_id, name, content_type, size_bytes)
    values (\${fileId}, \${orgId}, \${folderId}, \${fileName}, 'text/plain', 9)
  \`);
  for (let v = 1; v <= 2; v++) {
    const versionId = randomUUID();
    await db.execute(sql\`
      insert into file_versions (id, file_id, version_number, size_bytes, content_type, content_hash)
      values (\${versionId}, \${fileId}, \${v}, 9, 'text/plain', \${"hash-" + v})
    \`);
    await db.execute(sql\`insert into file_blobs (version_id, bytes) values (\${versionId}, 'payload')\`);
  }
  await db.execute(sql\`
    update files set current_version_id = (
      select id from file_versions where file_id = \${fileId} and version_number = 2
    ) where id = \${fileId}
  \`);
`;

/** Shared fixture: a folder holding a file with two DB-stored versions and an
 *  attachment link — everything a purge must account for. */
const PURGE_FIXTURE = `${FILE_FIXTURE}
  await db.execute(sql\`
    insert into file_attachments (org_id, file_id, target_table, target_id)
    values (\${orgId}, \${fileId}, 'documents', \${linkTarget})
  \`);
`;

const COUNTS_QUERY = `
  const counts = (await db.execute(sql\`
    select
      (select count(*)::int from files where id = \${fileId}) as files,
      (select count(*)::int from file_versions where file_id = \${fileId}) as versions,
      (select count(*)::int from file_blobs where version_id in (
        select id from file_versions where file_id = \${fileId}
      )) as blobs,
      (select count(*)::int from file_attachments where file_id = \${fileId}) as links
  \`)).rows[0];
`;

test(
  "forced purge-audit failure leaves every purged row intact (fail-closed atomicity)",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runCabinetAtomicityScenario(`
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
      import { purgeFile } from "./web/lib/file-cabinet.ts";

      installTrustedTestDatabaseBypass();

      const org = await createScratchOrg();
      const orgId = org.orgId;
      try {
        const fileName = "doomed.txt";
        const linkTarget = randomUUID();
        ${PURGE_FIXTURE}

        // Force the audit insert to fail for THIS org's purge events. Utility
        // statements cannot take bind parameters, so the org scope is inlined
        // after asserting its shape.
        assert.match(orgId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        await db.execute(sql.raw(\`
          create function openbooks_test_block_purge_audit() returns trigger
          language plpgsql as $fn$ begin raise exception 'forced audit failure'; end $fn$
        \`));
        await db.execute(sql.raw(\`
          create trigger block_purge_audit before insert on audit_log for each row
          when (new.org_id = '\${orgId}'::uuid and new.table_name = 'files'
                and new.changes->>'event' = 'purge')
          execute function openbooks_test_block_purge_audit()
        \`));

        // THE DEFECT: pre-fix, the deletes committed first and only the route's
        // second autocommit audit failed afterwards — rows gone forever while
        // the caller saw an error. The combined verb must abort the WHOLE unit.
        await assert.rejects(
          () => purgeFile(orgId, fileId, { actorId: actor }),
          (error) => /forced audit failure/.test(String((error && error.cause) || error)),
        );

        // Committed state after the rejected purge: nothing deleted anywhere.
        ${COUNTS_QUERY}
        assert.equal(counts.files, 1, "mutation rolled back: the file row survives");
        assert.equal(counts.versions, 2, "both versions survive the aborted purge");
        assert.equal(counts.blobs, 2, "both blobs survive the aborted purge");
        assert.equal(counts.links, 1, "the attachment link survives the aborted purge");
        const evidence = (await db.execute(sql\`
          select count(*)::int as n from audit_log
           where table_name = 'files' and row_id = \${fileId}
        \`)).rows[0].n;
        assert.equal(evidence, 0, "the failed audit left no partial evidence");
      } finally {
        await db.execute(sql\`drop trigger if exists block_purge_audit on audit_log\`);
        await db.execute(sql\`drop function if exists openbooks_test_block_purge_audit()\`);
        await dropScratchOrg(orgId);
      }
    `);
  },
);

test(
  "successful purge commits redacted before/link/version evidence atomically",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runCabinetAtomicityScenario(`
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
      import { purgeFile } from "./web/lib/file-cabinet.ts";

      installTrustedTestDatabaseBypass();

      const org = await createScratchOrg();
      const orgId = org.orgId;
      try {
        const fileName = "kept-evidence.txt";
        const linkTarget = randomUUID();
        ${PURGE_FIXTURE}

        assert.equal(await purgeFile(orgId, fileId, { actorId: actor }), true);

        // Committed state after the successful purge: all rows gone.
        ${COUNTS_QUERY}
        assert.equal(counts.files, 0, "the file row is gone");
        assert.equal(counts.versions, 0, "all versions are gone");
        assert.equal(counts.blobs, 0, "all blobs are gone");
        assert.equal(counts.links, 0, "attachment links are gone");

        // Exactly one durable evidence row retains the redacted before-state.
        const rows = (await db.execute(sql\`
          select action, actor_id as "actorId", changes
            from audit_log where table_name = 'files' and row_id = \${fileId}
        \`)).rows;
        assert.equal(rows.length, 1, "exactly one durable purge evidence row");
        const evidence = rows[0];
        assert.equal(evidence.action, "delete");
        assert.equal(evidence.changes.event, "purge");
        assert.equal(evidence.changes.permanent, true);
        assert.equal(String(evidence.actorId), actor, "evidence names the actor");
        assert.equal(evidence.changes.before.file.name, fileName);
        assert.equal(evidence.changes.before.file.contentType, "text/plain");
        assert.equal(evidence.changes.before.file.sizeBytes, 9);
        assert.deepEqual(
          evidence.changes.before.versions.map((v) => [v.versionNumber, v.contentHash]),
          [[1, "hash-1"], [2, "hash-2"]],
          "version inventory survives the purge",
        );
        assert.deepEqual(
          evidence.changes.before.attachments,
          [{ targetTable: "documents", targetId: linkTarget }],
          "attachment links survive the purge as evidence",
        );
        // Redacted: metadata only — no blob payload key anywhere in the evidence.
        assert.ok(!/"bytes"/.test(JSON.stringify(evidence)), "evidence carries no blob bytes");
      } finally {
        await dropScratchOrg(orgId);
      }
    `);
  },
);

/**
 * Regression coverage for the permanent-purge retention defect in
 * web/lib/file-cabinet.ts: purgeFile used to permit any file not referenced by
 * ap_capture_items and then delete all file_attachments, versions, blobs, and
 * the file — so evidence attached to a POSTED document (or a live compliance
 * record or fixed asset) could be permanently destroyed from the ?purge=1
 * route. The purge now refuses, before any delete, while any attachment
 * targets a posted document, a non-superseded compliance record, or a fixed
 * asset; superseded compliance records do not block (controlled renewal), and
 * unbound files stay purgeable.
 */
test(
  "purge refuses while any attachment targets a posted document (zero deletion)",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runCabinetAtomicityScenario(`
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
      import { purgeFile } from "./web/lib/file-cabinet.ts";

      installTrustedTestDatabaseBypass();

      const org = await createScratchOrg();
      const orgId = org.orgId;
      try {
        // A real POSTED document. Its posting period must belong to the
        // scratch org now that document posting references are tenant-coherent.
        const documentId = randomUUID();
        const postedEntryId = randomUUID();
        await db.execute(sql\`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
             period_id, memo, status, origin)
          values (\${postedEntryId}, \${orgId}, \${org.bookId}, \${org.subsidiaryId},
                  'RETAIN-ENTRY', current_date, \${org.periodId}, 'retention fixture',
                  'draft', 'manual')
        \`);
        await db.execute(sql\`
          insert into documents (id, org_id, kind, document_number, document_date,
                                 currency, status, posted_entry_id, posting_period_id)
          values (\${documentId}, \${orgId}, 'vendor_bill', 'RETAIN-1', current_date,
                  'USD', 'posted', \${postedEntryId}, \${org.periodId})
        \`);
        const fileName = "posted-evidence.txt";
        const linkTarget = documentId;
        ${PURGE_FIXTURE}

        // THE DEFECT: pre-fix this returned true with every row destroyed.
        // The guard must refuse BEFORE any delete runs — through the same
        // audited verb the ?purge=1 route exposes.
        assert.equal(await purgeFile(orgId, fileId, { actorId: actor }), false);

        // Committed state after the refused purge: file, versions, blobs, and
        // the attachment link all survive intact.
        ${COUNTS_QUERY}
        assert.equal(counts.files, 1, "the file row survives");
        assert.equal(counts.versions, 2, "both versions survive");
        assert.equal(counts.blobs, 2, "both blobs survive");
        assert.equal(counts.links, 1, "the attachment link survives");
        const evidence = (await db.execute(sql\`
          select count(*)::int as n from audit_log
           where table_name = 'files' and row_id = \${fileId}
        \`)).rows[0].n;
        assert.equal(evidence, 0, "a refused purge writes no purge evidence");
      } finally {
        await dropScratchOrg(orgId);
      }
    `);
  },
);

test(
  "unbound files stay purgeable",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runCabinetAtomicityScenario(`
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
      import { purgeFile } from "./web/lib/file-cabinet.ts";

      installTrustedTestDatabaseBypass();

      const org = await createScratchOrg();
      const orgId = org.orgId;
      try {
        const fileName = "disposable.txt";
        ${FILE_FIXTURE}

        // Control: with no attachment links at all the guard does not fire and
        // the disposable file purges cleanly.
        assert.equal(await purgeFile(orgId, fileId), true);

        ${COUNTS_QUERY}
        assert.equal(counts.files, 0, "the unbound file is gone");
        assert.equal(counts.versions, 0, "all versions are gone");
        assert.equal(counts.blobs, 0, "all blobs are gone");
        assert.equal(counts.links, 0, "there were never any links to lose");
      } finally {
        await dropScratchOrg(orgId);
      }
    `);
  },
);

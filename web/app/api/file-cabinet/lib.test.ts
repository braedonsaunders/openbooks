import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { env } from '@openbooks/engine/src/db.ts'
import { ATTACHABLE_TARGET_TABLES, isAttachableTargetTable } from './target-tables.ts'

test('allowlist covers exactly the tables the app attaches files to', () => {
  assert.deepEqual(
    [...ATTACHABLE_TARGET_TABLES].sort(),
    ['compliance_records', 'documents', 'fixed_assets', 'item_rate_versions', 'lien_waivers', 'parties'],
  )
})

test('every real attachment target is accepted', () => {
  for (const t of ['documents', 'parties', 'item_rate_versions', 'fixed_assets', 'compliance_records', 'lien_waivers']) {
    assert.equal(isAttachableTargetTable(t), true, t)
  }
})

test('arbitrary or lookalike target tables are refused', () => {
  for (const t of ['', 'users', 'orgs', 'journal_entries', 'audit_log', 'pg_catalog.pg_tables', 'documents;', 'documents ', 'Documents', 'file_attachments']) {
    assert.equal(isAttachableTargetTable(t), false, t)
  }
})

/**
 * Regression coverage for the private-folder metadata ACL defect in
 * web/lib/file-cabinet.ts + the folder [id] API route: getFolder() and
 * getFolderPath() (the breadcrumb source on /documents) used to bypass
 * private-folder visibility entirely — any documents.read caller could read a
 * hidden folder's name/owner/counts by id, crumbs leaked hidden ancestor
 * names, parentId exposed hidden ancestor ids, and childCount counted private
 * children the viewer cannot open. An earlier partial fix was rejected by
 * verification for exactly those residual leaks.
 *
 * The scenario runs against the real exported functions on a real database,
 * asserting denied/allowed metadata, descendant counts, breadcrumbs, and the
 * mechanical parity invariant (folderAccessLevel ≠ 'none' ⇔ getFolder returns
 * the row) for every viewer/folder pair.
 */
test(
  "folder metadata and breadcrumbs enforce private-folder visibility",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    // Same canonical bootstrap as file-cabinet.private-boundary.test.ts: a bare
    // OPENBOOKS_DB_URL gets the published schema; an already-migrated host is
    // only probed.
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

    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
      import {
        folderAccessLevel,
        getFolder,
        getFolderPath,
        setGrant,
      } from "./web/lib/file-cabinet.ts";

      installTrustedTestDatabaseBypass();

      // Fixture tree (one org):
      //   pub       (plain)              – world-visible root
      //     kidPrivate (private, mallory) – hidden from sam
      //     pubKid     (plain)            – visible child of pub
      //   privRoot  (private, mallory)
      //     hub       (plain)            – viewer-granted to sam; parent hidden
      //       hubKid  (plain)            – visible via the grant's subtree
      const org = await createScratchOrg();
      const orgId = org.orgId;
      try {
        const mallory = randomUUID();
        const sam = randomUUID();
        const ids = Array.from({ length: 6 }, () => randomUUID());
        const [pub, kidPrivate, pubKid, privRoot, hub, hubKid] = ids;

        for (const who of [[mallory, "mallory@meta.fixture"], [sam, "sam@meta.fixture"]]) {
          await db.execute(sql\`
            insert into users (id, org_id, email, name, password_hash, is_active)
            values (\${who[0]}, \${orgId}, \${who[1]}, \${String(who[1]).split("@")[0]}, 'x', false)
          \`);
        }
        const folders = [
          [pub, null, "pub", false, null],
          [kidPrivate, pub, "kidPrivate", true, mallory],
          [pubKid, pub, "pubKid", false, null],
          [privRoot, null, "privRoot", true, mallory],
          [hub, privRoot, "hub", false, null],
          [hubKid, hub, "hubKid", false, null],
        ];
        for (const f of folders) {
          await db.execute(sql\`
            insert into folders (id, org_id, parent_folder_id, name, is_private, owner_id)
            values (\${f[0]}, \${orgId}, \${f[1]}, \${f[2]}, \${f[3]}, \${f[4]})
          \`);
        }
        await db.execute(sql\`
          insert into files (id, org_id, folder_id, name, content_type, size_bytes)
          values (\${randomUUID()}, \${orgId}, \${hub}, 'in-hub.txt', 'text/plain', 3)
        \`);

        const viewerOf = (userId, baseline) => ({ userId, isAdmin: false, baseline });
        const samViewer = viewerOf(sam, "viewer");
        const malloryViewer = viewerOf(mallory, "manager");
        const adminViewer = { userId: randomUUID(), isAdmin: true };

        await setGrant({
          orgId, resourceType: "folder", resourceId: hub,
          principalType: "user", principalId: sam, access: "viewer", actorId: mallory,
        });

        // Denied: hidden metadata never leaves the cabinet.
        assert.equal(await getFolder(orgId, kidPrivate, samViewer), null, "hidden private folder metadata is not found");
        assert.deepEqual(await getFolderPath(orgId, samViewer, kidPrivate), [], "breadcrumb of a hidden folder is empty");

        // Allowed: visible metadata, with descendants and ancestry scoped.
        const pubRow = await getFolder(orgId, pub, samViewer);
        assert.ok(pubRow, "public root stays readable");
        assert.equal(pubRow.parentId, null);
        assert.equal(pubRow.childCount, 1, "hidden private child is not counted");
        assert.equal(pubRow.fileCount, 0);

        const hubRow = await getFolder(orgId, hub, samViewer);
        assert.ok(hubRow, "granted folder inside a foreign private subtree is readable");
        assert.equal(hubRow.parentId, null, "hidden ancestor id is masked, not leaked through parentId");
        assert.equal(hubRow.childCount, 1, "only children the viewer can open are counted");
        assert.equal(hubRow.fileCount, 1);

        const hubPath = await getFolderPath(orgId, samViewer, hubKid);
        assert.deepEqual(hubPath.map((n) => n.id), [hub, hubKid], "crumbs stop at the hidden boundary");

        // Owners keep their own subtree; admins see everything unmasked.
        const malloryPath = await getFolderPath(orgId, malloryViewer, kidPrivate);
        assert.deepEqual(malloryPath.map((n) => n.id), [pub, kidPrivate]);
        const adminHub = await getFolder(orgId, hub, adminViewer);
        assert.equal(adminHub?.parentId, privRoot, "admins keep the real parent id");
        assert.equal(adminHub?.childCount, 1);

        // Read/write parity across every viewer × folder pair: exactly the
        // folders the access tier can act on expose metadata.
        for (const viewer of [samViewer, malloryViewer, adminViewer]) {
          for (const folderId of ids) {
            const tier = await folderAccessLevel(orgId, viewer, folderId);
            const meta = await getFolder(orgId, folderId, viewer);
            assert.equal(
              tier !== "none", meta !== null,
              \`parity \${viewer.userId.slice(0, 8)}/\${folderId.slice(0, 8)}: tier=\${tier} meta=\${meta !== null}\`,
            );
          }
        }
        assert.equal(await folderAccessLevel(orgId, samViewer, hub), "viewer", "grant confers exactly its tier");
        assert.equal(await folderAccessLevel(orgId, samViewer, pub), "viewer", "baseline applies outside private subtrees");
        assert.equal(await folderAccessLevel(orgId, samViewer, privRoot), "none");
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

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

// Exercise upload_file's shared cabinet write, grants, scope, and replay.
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { removeGrant } = await import("../file-cabinet/index.ts");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
const applicationFiles = await import("./files.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Test",
        orgId,
        roles: [],
        envKind: "production",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

const contentBase64 = Buffer.from("cabinet probe").toString("base64");

test(
  "upload_file writes through cabinet storage, replays idempotently, and enforces folder grants",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const userId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Upload prober", "upload_prober"),
    );
    const viewerId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Upload viewer", "upload_viewer"),
    );
    const folderId = randomUUID();
    const definition = applicationTool("upload_file");
    assert.ok(definition, "upload_file must be registered");
    try {
      await withOrgContext(org.orgId, async () => {
        await db.execute(
          sql`insert into folders (id, org_id, name) values (${folderId}, ${org.orgId}, 'Probe Cabinet')`,
        );
        const manager = ctxFor(org.orgId, userId, ["documents.manage", "documents.read"]);
        const input = {
          folderId,
          filename: "probe.txt",
          contentType: "text/plain",
          contentBase64,
          idempotencyKey: `probe-${randomUUID()}`,
        };
        const first = await executeApplicationTool(definition, manager, input);
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.equal(first.replayed, false);
        assert.ok(typeof first.id === "string", JSON.stringify(first));
        const stored = await db.execute<{ name: string; content_type: string; size_bytes: number }>(
          sql`
        select name, content_type, size_bytes from files where id = ${String(first.id)} and org_id = ${org.orgId}`,
          "objects",
        );
        assert.equal(stored.length, 1);
        assert.equal(stored[0]!.name, "probe.txt");

        const file = await applicationFiles.getApplicationFile(manager, String(first.id));
        assert.deepEqual(
          [file.id, file.name, file.contentType, file.sizeBytes, file.versionCount],
          [first.id, "probe.txt", "text/plain", Buffer.byteLength("cabinet probe"), 1],
        );
        assert.equal(Object.hasOwn(file, "contentBase64"), false);
        assert.equal(Object.hasOwn(file, "content"), false);
        assert.equal(JSON.stringify(file).includes(contentBase64), false);
        const listed = await applicationFiles.listApplicationFiles(manager, { folderId });
        assert.equal(listed.total, 1);
        assert.deepEqual(
          listed.files.map((item) => [item.id, item.name]),
          [[first.id, "probe.txt"]],
        );
        assert.equal(Object.hasOwn(listed.files[0]!, "contentBase64"), false);
        const folders = await applicationFiles.listApplicationFolders(manager);
        assert.ok(
          folders.folders.some(
            (folder) => folder.id === folderId && folder.name === "Probe Cabinet",
          ),
        );

        const replay = await executeApplicationTool(definition, manager, input);
        assert.deepEqual([replay.ok, replay.replayed, replay.id], [true, true, first.id]);
        const count = await db.execute<{ n: string }>(
          sql`
        select count(*) as n from files where folder_id = ${folderId} and org_id = ${org.orgId}`,
          "objects",
        );
        assert.equal(Number(count[0]!.n), 1, "idempotent replay must not store a second file");

        const viewer = ctxFor(org.orgId, viewerId, ["documents.read"]);
        await assert.rejects(
          () =>
            executeApplicationTool(definition, viewer, {
              ...input,
              filename: "viewer.txt",
              idempotencyKey: `probe-${randomUUID()}`,
            }),
          /forbidden/,
        );
        const grantId = randomUUID();
        await db.execute(sql`insert into resource_grants(id, org_id, resource_type, resource_id, principal_type, principal_id, access, created_by)
        values (${grantId}, ${org.orgId}, 'folder', ${folderId}, 'user', ${viewerId}, 'editor', ${userId})`);
        await executeApplicationTool(definition, viewer, input);
        const client = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
        await client.connect();
        const lockKey = `file-cabinet-auth:${org.orgId}`;
        try {
          await client.query("begin");
          await client.query(
            "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)",
            [org.orgId],
          );
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
          let uploaded = false;
          const pendingUpload = applicationFiles
            .uploadCabinetFile(viewer.authz, {
              folderId,
              filename: "race.txt",
              contentType: "text/plain",
              contentBase64,
            })
            .then((file) => {
              uploaded = true;
              return file;
            });
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal(uploaded, false);
          await client.query("commit");
          assert.equal((await pendingUpload).name, "race.txt");
          await client.query("begin");
          await client.query(
            "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)",
            [org.orgId],
          );
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
          let revoked = false;
          const pendingRevoke = removeGrant(org.orgId, grantId, "folder", folderId).then(
            (removed) => {
              revoked = true;
              return removed;
            },
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal(revoked, false);
          await client.query("commit");
          assert.equal(await pendingRevoke, true);
          await assert.rejects(
            () => executeApplicationTool(definition, viewer, input),
            /forbidden/,
          );
        } finally {
          await client.query("rollback").catch(() => undefined);
          await client.end();
        }
      });
      const orgB = await withBypassContext(() => createScratchOrg());
      try {
        const userB = await withBypassContext(() =>
          createScratchUser(orgB.orgId, "Upload outsider", "upload_outsider"),
        );
        await withOrgContext(orgB.orgId, async () => {
          const outsider = ctxFor(orgB.orgId, userB, ["documents.manage"]);
          await assert.rejects(
            executeApplicationTool(definition, outsider, {
              folderId,
              filename: "cross.txt",
              contentType: "text/plain",
              contentBase64,
              idempotencyKey: `probe-${randomUUID()}`,
            }),
            /folder/,
            "a folder id from another org must not resolve",
          );
        });
      } finally {
        await dropScratchOrg(orgB.orgId);
      }
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "source uploads retain native identity, bytes and audit reason; retries and competing source claims remain unique",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actor = await withBypassContext(() =>
        createScratchUser(org.orgId, "Source uploader", "source_uploader"),
      );
      await withOrgContext(org.orgId, async () => {
        const folderId = randomUUID();
        await db.execute(
          sql`insert into folders(id,org_id,name) values(${folderId},${org.orgId},'Sources')`,
        );
        const context = ctxFor(org.orgId, actor, ["documents.read", "documents.manage"]);
        const definition = applicationTool("upload_file")!;
        const input = {
          folderId,
          filename: "source.txt",
          contentType: "text/plain",
          contentBase64,
          sourceSystem: "payroll-source",
          sourceId: randomUUID(),
          auditReason: "Retain reviewed source evidence",
          idempotencyKey: randomUUID(),
        };
        const first = await executeApplicationTool(definition, context, input);
        const read = await applicationFiles.getApplicationFile(context, String(first.id));
        assert.deepEqual(
          [read.sourceSystem, read.sourceId, read.currentVersionId, read.contentHash],
          [input.sourceSystem, input.sourceId, first.currentVersionId, first.contentHash],
        );
        assert.equal(read.versions[0]!.id, first.currentVersionId);
        assert.equal(read.versions[0]!.contentHash, first.contentHash);
        const stored = await db.execute<{ bytes: Buffer }>(
          sql`select b.bytes from file_blobs b join file_versions v on v.id=b.version_id join files f on f.id=v.file_id where f.org_id=${org.orgId} and v.id=${String(first.currentVersionId)}`,
          "objects",
        );
        assert.equal(stored[0]!.bytes.toString("base64"), contentBase64);
        const audits = await db.execute<{
          actor_id: string;
          changes: { reason: string; after: { sourceId: string; contentHash: string } };
        }>(
          sql`select actor_id,changes from audit_log where org_id=${org.orgId} and table_name='files' and row_id=${String(first.id)} and changes->>'event'='upload'`,
          "objects",
        );
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.actor_id, actor);
        assert.equal(audits[0]!.changes.reason, input.auditReason);
        assert.equal(audits[0]!.changes.after.sourceId, input.sourceId);
        assert.equal(audits[0]!.changes.after.contentHash, first.contentHash);
        const replay = await executeApplicationTool(definition, context, input);
        assert.deepEqual([replay.id, replay.replayed], [first.id, true]);
        await assert.rejects(
          () =>
            executeApplicationTool(definition, context, {
              ...input,
              auditReason: "Changed adoption basis",
            }),
          /idempotency|different|conflict/i,
        );
        await assert.rejects(
          () =>
            executeApplicationTool(definition, context, { ...input, idempotencyKey: randomUUID() }),
          (error) => {
            assert.equal((error as { status: number; code: string }).status, 409);
            assert.equal((error as { code: string }).code, "conflict");
            assert.equal(String(error).includes(String(first.id)), false);
            return true;
          },
        );
        await assert.rejects(
          () =>
            executeApplicationTool(definition, context, {
              ...input,
              sourceId: undefined,
              idempotencyKey: randomUUID(),
            }),
          /sourceSystem|sourceId/,
        );
        await assert.rejects(() =>
          executeApplicationTool(definition, context, {
            ...input,
            auditReason: " ",
            idempotencyKey: randomUUID(),
          }),
        );
        const concurrent = { ...input, sourceId: randomUUID() };
        const race = await Promise.allSettled(
          [1, 2].map(() =>
            executeApplicationTool(
              definition,
              { ...context, requestId: randomUUID() },
              { ...concurrent, idempotencyKey: randomUUID() },
            ),
          ),
        );
        assert.equal(race.filter((item) => item.status === "fulfilled").length, 1);
        const count = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from files where org_id=${org.orgId} and source_system=${input.sourceSystem}`,
          "objects",
        );
        assert.equal(count[0]!.n, 2);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

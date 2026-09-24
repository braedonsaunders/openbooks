import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";

interface StorageState {
  actor: { id: string; orgId: string } | null;
  deletedKeys: string[];
}

const storageState: StorageState = { actor: null, deletedKeys: [] };
const storageStateKey = Symbol.for("openbooks.backup-delete-route-test");
(globalThis as Record<symbol, unknown>)[storageStateKey] = storageState;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../../../../lib/authz") {
      return {
        url: "mock:backup-delete-route-authz",
        shortCircuit: true,
      };
    }
    if (specifier === "../platform/file-storage.ts" && context.parentURL?.endsWith("/backup/backup.ts")) {
      return { url: "mock:backup-delete-route-storage", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:backup-delete-route-authz") {
      return {
        format: "module",
        source: `
          const state = globalThis[Symbol.for('openbooks.backup-delete-route-test')]
          export async function guardPermission() { return { user: state.actor } }
        `,
        shortCircuit: true,
      };
    }
    if (url === "mock:backup-delete-route-storage") {
      return {
        format: "module",
        source: `
          const state = globalThis[Symbol.for('openbooks.backup-delete-route-test')]
          export const s3Enabled = true
          export const s3Bucket = () => "test-backups"
          export const getS3Client = () => ({
            async send(command) {
              if (command.constructor.name !== "DeleteObjectCommand") throw new Error("unexpected storage request")
              state.deletedKeys.push(command.input.Key)
              return {}
            },
          })
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?backup-delete-integration";
const { DELETE } = await import(routeUrl) as typeof import("./route.ts");
const { backupObjectKey } = await import("@openbooks/engine/src/backup/backup.ts");
hooks.deregister();


test("manual deletion purges the stored object and retains actor-attributed ledger evidence", async () => {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Backup Administrator", "admin");
  storageState.actor = { id: actorId, orgId: org.orgId };
  storageState.deletedKeys = [];
  try {
    const inserted = await db.execute<{ id: string }>(sql`
      insert into backup_runs (org_id, kind, status, file_name, byte_size, sha256, completed_at)
      values (${org.orgId}, 'manual', 'completed', 'acme-backup.json.gz', 20, ${"c".repeat(64)}, now())
      returning id`);
    const runId = inserted.rows[0]!.id;
    const objectKey = backupObjectKey(org.orgId, runId);
    await db.execute(sql`update backup_runs set object_key = ${objectKey} where org_id = ${org.orgId} and id = ${runId}`);

    const response = await withOrgContext(org.orgId, () => DELETE(
      new Request(`http://openbooks.test/api/admin/backups/${runId}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: runId }) },
    ));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(storageState.deletedKeys, [objectKey]);
    const row = (await db.execute<{ status: string; purged_at: Date | null; purge_reason: string | null }>(sql`
      select status, purged_at, purge_reason from backup_runs where org_id = ${org.orgId} and id = ${runId}`)).rows[0]!;
    assert.equal(row.status, "completed");
    assert.ok(row.purged_at);
    assert.equal(row.purge_reason, "deleted");
    assert.deepEqual(
      (await db.execute<{ event: string; actor_id: string | null }>(sql`
        select changes->>'event' as event, actor_id from audit_log
         where org_id = ${org.orgId} and row_id = ${runId} order by id`)).rows,
      [
        { event: "backup_purge_requested", actor_id: actorId },
        { event: "backup_deleted", actor_id: actorId },
      ],
    );
  } finally {
    storageState.actor = null;
    await db.execute(sql`delete from backup_runs where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

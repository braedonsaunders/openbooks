import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Manual backup creation relies on the database in-flight invariant: two
// concurrent requests must yield one queued run and one 409, never two
// runs. Only the permission gate and the Redis-backed job queue are
// seammed (external services); the route, the partial unique index, and
// the database are real.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.endsWith("/lib/authz")) {
      return { shortCircuit: true, url: "mock:backup-run-gate" };
    }
    if (specifier === "@openbooks/jobs") {
      return { shortCircuit: true, url: "mock:backup-run-queue" };
    }
    if (specifier === "@openbooks/engine/src/platform/file-storage.ts") {
      return { shortCircuit: true, url: "mock:backup-run-storage" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:backup-run-gate") {
      return {
        format: "module",
        shortCircuit: true,
        source: `const key = Symbol.for('openbooks.backup-run-gate')
          export async function guardPermission() { return globalThis[key] }`,
      };
    }
    if (url === "mock:backup-run-queue") {
      return {
        format: "module",
        shortCircuit: true,
        source: `export async function enqueueBackupRun() {}`,
      };
    }
    if (url === "mock:backup-run-storage") {
      // The deployment flag snapshots process env at preload, before any
      // test file runs, so tests cannot flip it with env vars. The flag
      // reports external object-storage wiring, not app state.
      return {
        format: "module",
        shortCircuit: true,
        source: `export const s3Enabled = true`,
      };
    }
    return nextLoad(url, context);
  },
});

const gateKey = Symbol.for("openbooks.backup-run-gate");
const { db, env, withBypassContext: withBypass } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { POST } = await import("../app/api/admin/backups/run/route.ts");

async function gateFor(orgId: string, actorId: string): Promise<void> {
  (globalThis as typeof globalThis & Record<symbol, unknown>)[gateKey] = {
    user: { id: actorId, orgId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
}

test("concurrent backup requests queue one run and refuse the other with 409", async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    const actorId = (await withBypass(() => seedFlowActors(scratch.orgId))).adminId;
    await gateFor(scratch.orgId, actorId);

    const [first, second] = await Promise.all([POST(), POST()]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], "one request queues, the other is refused");
    const refused = first.status === 409 ? first : second;
    assert.deepEqual(await refused.json(), { error: "a backup is already in progress" });

    const queued = await withBypass(() =>
      db.execute<{ count: string }>(sql`
        select count(*)::text as count from backup_runs
         where org_id = ${scratch.orgId} and status in ('queued', 'running')
      `),
    );
    assert.equal(queued.rows[0]?.count, "1", "exactly one run stays in flight");
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});

test("the in-flight guard is per organization and names its constraint", async () => {
  const first = await withBypass(() => createScratchOrg());
  const second = await withBypass(() => createScratchOrg());
  try {
    const actorId = (await withBypass(() => seedFlowActors(first.orgId))).adminId;
    const otherActorId = (await withBypass(() => seedFlowActors(second.orgId))).adminId;
    const queue = (orgId: string, actor: string) => withBypass(() =>
      db.execute(sql`
        insert into backup_runs (org_id, kind, status, actor_id)
        values (${orgId}, 'manual', 'queued', ${actor})
      `),
    );
    await queue(first.orgId, actorId);
    const duplicate = await queue(first.orgId, actorId).then(
      () => null,
      (error: { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } }) => error,
    );
    // db.execute rejects with a DrizzleQueryError wrapper; the Postgres
    // identity lives on its cause — the same shape the route unwraps.
    assert.equal(duplicate?.code ?? duplicate?.cause?.code, "23505");
    assert.equal(duplicate?.constraint ?? duplicate?.cause?.constraint, "backup_runs_one_inflight_per_org");
    await queue(second.orgId, otherActorId);
    const queued = await withBypass(() =>
      db.execute<{ count: string }>(sql`
        select count(*)::text as count from backup_runs where status = 'queued'
      `),
    );
    assert.equal(queued.rows[0]?.count, "2", "two orgs each hold one queued run");
  } finally {
    await withBypass(() => dropScratchOrg(first.orgId));
    await withBypass(() => dropScratchOrg(second.orgId));
  }
});

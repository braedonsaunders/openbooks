import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The backups page loader normalizes raw SQL timestamps to ISO strings
// before serialization, so no Date object crosses into client props. Only
// the page gate and the translation framework are seammed; the loader, the
// timestamp normalization, and the database are real.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.endsWith("/lib/authz")) {
      return { shortCircuit: true, url: "mock:backups-gate" };
    }
    if (specifier === "next-intl/server") {
      return { shortCircuit: true, url: "mock:backups-intl" };
    }
    if (specifier === "@openbooks/jobs") {
      return { shortCircuit: true, url: "mock:backups-jobs" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:backups-gate") {
      return {
        format: "module",
        shortCircuit: true,
        source: `const key = Symbol.for('openbooks.backups-gate')
          export async function requirePermission() { return globalThis[key] }`,
      };
    }
    if (url === "mock:backups-intl") {
      return {
        format: "module",
        shortCircuit: true,
        source: `export async function getTranslations() { return (key) => key }`,
      };
    }
    if (url === "mock:backups-jobs") {
      // No Redis in the test process; the loader treats a missing heartbeat
      // as worker-offline, which is exactly the surface under test.
      return {
        format: "module",
        shortCircuit: true,
        source: `export async function getWorkerHeartbeat() { return null }`,
      };
    }
    return nextLoad(url, context);
  },
});

const gateKey = Symbol.for("openbooks.backups-gate");
const { db, withBypassContext: withBypass } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { loadAdminBackups } = await import("../app/(app)/admin/backups/view.ts");

test("the backups page serializes run timestamps as ISO strings", async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    const actorId = (await withBypass(() => seedFlowActors(scratch.orgId))).adminId;
    (globalThis as typeof globalThis & Record<symbol, unknown>)[gateKey] = {
      user: { id: actorId, orgId: scratch.orgId },
      permissions: new Set(["*"]),
      allowedSubsidiaryIds: null,
    };
    await withBypass(() =>
      db.execute(sql`
        insert into backup_runs (org_id, kind, status, actor_id, error, completed_at)
        values (${scratch.orgId}, 'manual', 'failed', ${actorId}, 'simulated failure', now())
      `),
    );

    const data = await loadAdminBackups();
    assert.equal(data.manager.runs.length, 1);
    const run = data.manager.runs[0]!;
    assert.equal(typeof run.createdAt, "string", "createdAt must already be text, not a Date");
    assert.match(run.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.ok(Number.isFinite(Date.parse(run.createdAt)), "createdAt parses back to a time");
    assert.equal(typeof run.completedAt, "string");
    assert.equal(run.purgedAt, null, "an unpurged run serializes a null purge timestamp");
    assert.equal(run.error, "simulated failure");
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});

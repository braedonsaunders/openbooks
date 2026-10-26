/**
 * A report run's authorization snapshot is evidence of what the run was
 * allowed to read. Storage admits exactly one write-once recording of the
 * content-derived permission key; every other key, and the recorded key
 * itself, is immutable, while the run's lifecycle columns still move.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";

const DB = !!process.env.OPENBOOKS_DB_URL;

const BASE_SNAPSHOT = {
  version: 1,
  userId: randomUUID(),
  allowedSubsidiaryIds: null,
  definition: {
    report_type: "statement",
    query: null,
    statement: { kind: "trial-balance" },
    name: "Trial Balance",
    slug: "trial-balance",
    kind: "built_in",
  },
};

async function seedRun(
  orgId: string,
  definitionId: string,
  snapshot: Record<string, unknown> | null,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into report_runs (id, org_id, definition_id, trigger, status, recipient_emails, filters, authorization_snapshot)
    values (${id}, ${orgId}, ${definitionId}, 'scheduled', 'running', '[]'::jsonb, '{}'::jsonb,
            ${snapshot === null ? null : JSON.stringify(snapshot)}::jsonb)`);
  return id;
}

/** The trigger refusal surfaces nested in the driver's cause, so match the whole chain. */
function isEvidenceRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && /evidence is immutable/.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function snapshotOf(id: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute<{ snapshot: Record<string, unknown> | null }>(
    sql`
    select authorization_snapshot as snapshot from report_runs where id = ${id}`,
    "objects",
  );
  return rows[0]?.snapshot ?? null;
}

/** The render route's stamp: record the content-derived key, merging onto the stored snapshot. */
async function stamp(id: string, permissions: string[]): Promise<void> {
  await db.execute(sql`
    update report_runs
       set authorization_snapshot = coalesce(authorization_snapshot, '{}'::jsonb)
                                  || ${JSON.stringify({ requiredPermissions: permissions })}::jsonb
     where id = ${id}`);
}

test(
  "report run evidence admits exactly one write-once content-key recording",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const definitionId = randomUUID();
      await db.execute(sql`
      insert into report_definitions (id, org_id, kind, report_type, slug, name, query, statement)
      values (${definitionId}, ${org.orgId}, 'built_in', 'statement', 'trial-balance', 'Trial Balance',
              null, '{"kind":"trial-balance"}'::jsonb)`);

      // A scheduled-shaped snapshot without a recorded key accepts the stamp once.
      const runId = await seedRun(org.orgId, definitionId, BASE_SNAPSHOT);
      await stamp(runId, []);
      assert.deepEqual((await snapshotOf(runId))?.requiredPermissions, []);

      // The recorded key never moves: not to a wider set, not back.
      await assert.rejects(stamp(runId, ["payroll.read"]), isEvidenceRefusal);
      await assert.rejects(
        db.execute(sql`
        update report_runs
           set authorization_snapshot = authorization_snapshot || '{"version":2}'::jsonb
         where id = ${runId}`),
        isEvidenceRefusal,
      );
      // Any other key is evidence too: renaming the pinned definition refuses.
      await assert.rejects(
        db.execute(sql`
        update report_runs
           set authorization_snapshot = jsonb_set(authorization_snapshot, '{definition,name}', '"Renamed"')
         where id = ${runId}`),
        isEvidenceRefusal,
      );
      // Ordinary lifecycle columns still move: the trigger guards the
      // evidence column, never the run.
      await db.execute(sql`update report_runs set status = 'succeeded' where id = ${runId}`);
      const [run] = await db.execute<{ status: string }>(
        sql`
      select status from report_runs where id = ${runId}`,
        "objects",
      );
      assert.equal(run?.status, "succeeded");

      // A missing snapshot may gain exactly the single recorded key.
      const nullId = await seedRun(org.orgId, definitionId, null);
      await stamp(nullId, []);
      assert.deepEqual((await snapshotOf(nullId))?.requiredPermissions, []);
      const nullWideId = await seedRun(org.orgId, definitionId, null);
      await assert.rejects(
        db.execute(sql`
        update report_runs
           set authorization_snapshot = '{"requiredPermissions":[],"definition":{"forged":true}}'::jsonb
         where id = ${nullWideId}`),
        isEvidenceRefusal,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

/**
 * 0328 carries the per-obligation legacy-reconciliation attestation
 * (actor, timestamp and reason) that lifts the 0326 rebuild refusal.
 *
 * The guard must exist, end validated, and enforce the shape at storage:
 * an all-NULL attestation (every pre-existing row) and a full attestation
 * write, while a half attestation is refused under the guard's own name.
 * The engine covers the reconcile path itself
 * (recognition-legacy-provenance); this covers the storage guard the
 * upgrade installs. Replays the real migration bytes through the real
 * attempt executor under a probe ledger name, twice: the body is
 * idempotent, so the second run is exactly what a runner retry does.
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently. The
 * teardown asserts the table still matches its pre-test snapshot.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";
import { sql } from "drizzle-orm";
import {
  connectMigrationClient,
  executeMigrationAttempt,
  executeMigrationBody,
  migrationLockConfig,
  releaseMigrationClient,
  sanitizeMigrationContent,
} from "../../../scripts/bootstrap-migration-client.ts";
import {
  assertTableCatalogMatches,
  snapshotTableCatalog,
  type CatalogQuery,
  type TableCatalogSnapshot,
} from "../../../engine/src/testing/migration-catalog.ts";
import { db } from "../../../engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";

const PROBE_FILENAME = "generated/0999_g54_0328_probe.sql";
const PROBE_DIGEST = "g54-0328-probe";

const migrationSql = readFileSync(
  new URL("./0328_obligation_legacy_reconciliation.sql", import.meta.url),
  "utf8",
);

async function runStagedFile(): Promise<void> {
  const client = await connectMigrationClient();
  try {
    await executeMigrationAttempt(client, {
      filename: PROBE_FILENAME,
      body: sanitizeMigrationContent(migrationSql),
      transactional: true,
      lock: migrationLockConfig({}),
      digest: PROBE_DIGEST,
      executeBody: (migrationClient, body, step) =>
        executeMigrationBody(migrationClient, body, step),
    });
  } finally {
    await releaseMigrationClient(client);
  }
}

async function clearProbeLedger(): Promise<void> {
  const client = await connectMigrationClient();
  try {
    await client.query("delete from public._applied_migrations where filename = $1", [PROBE_FILENAME]);
  } finally {
    await releaseMigrationClient(client);
  }
}

async function catalogQuery(text: string): Promise<Array<Record<string, unknown>>> {
  const client = await connectMigrationClient();
  try {
    return (await client.query(text)).rows as Array<Record<string, unknown>>;
  } finally {
    await releaseMigrationClient(client);
  }
}

const snapshotQuery: CatalogQuery = (text) => catalogQuery(text);

let catalogBefore: TableCatalogSnapshot | null = null;

beforeEach(async () => {
  catalogBefore = await snapshotTableCatalog(snapshotQuery, "public.performance_obligations");
});

afterEach(async () => {
  assert.ok(catalogBefore, "the pre-test catalog snapshot is missing");
  await assertTableCatalogMatches(
    snapshotQuery,
    catalogBefore,
    "0328 replay test must leave performance_obligations exactly as found",
  );
});

test("replaying the staged file keeps the guard validated and enforcing", async () => {
  const org = await createScratchOrg();
  const actor = randomUUID();
  try {
    await clearProbeLedger();
    await runStagedFile();
    await clearProbeLedger();
    await runStagedFile();

    const guard = await db.execute<{ validated: boolean; definition: string }>(sql`
      select convalidated as validated, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid = 'public.performance_obligations'::regclass
         and conname = 'performance_obligations_legacy_reconciliation_shape'
    `);
    assert.equal(guard.rows.length, 1);
    assert.equal(guard.rows[0]!.validated, true, "the staged guard ends validated");
    assert.match(guard.rows[0]!.definition, /legacy_reconciled_at IS NULL/);
    assert.match(guard.rows[0]!.definition, /legacy_reconciliation_reason/);

    const contract = randomUUID();
    await db.execute(
      sql`insert into revenue_contracts(id,org_id,customer_id,contract_number,status,starts_on,currency,total_transaction_price,created_by,updated_by) values(${contract},${org.orgId},${org.customerId},'G54-0328','active',${org.date},'CAD',1200,${actor},${actor})`,
    );

    // All-NULL attestation (the pre-existing shape) still writes.
    const unreconciled = randomUUID();
    await db.execute(
      sql`insert into performance_obligations(id,org_id,contract_id,description,recognition_rule_id,allocated_price,status,created_by,updated_by) values(${unreconciled},${org.orgId},${contract},'Unreconciled obligation',${org.recognitionRuleId},1200,'open',${actor},${actor})`,
    );

    // A half attestation (stamped but reasonless) is refused under the
    // guard's own name.
    await assert.rejects(
      db.execute(sql`
        insert into performance_obligations
          (id, org_id, contract_id, description, recognition_rule_id, allocated_price, status,
           legacy_reconciled_at, legacy_reconciled_by, created_by, updated_by)
        values (${randomUUID()}, ${org.orgId}, ${contract}, 'Half attested', ${org.recognitionRuleId}, 1200, 'open',
                now(), ${actor}, ${actor}, ${actor})
      `),
      (error: unknown) => {
        const cause = (error as { cause?: unknown }).cause as Error | undefined;
        assert.match(
          String(cause?.message ?? error),
          /performance_obligations_legacy_reconciliation_shape/i,
        );
        return true;
      },
      "a half attestation still violates the staged guard",
    );

    // A full attestation (actor, timestamp and reason) writes.
    const reconciled = randomUUID();
    await db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, description, recognition_rule_id, allocated_price, status,
         legacy_reconciled_at, legacy_reconciled_by, legacy_reconciliation_reason, created_by, updated_by)
      values (${reconciled}, ${org.orgId}, ${contract}, 'Reconciled obligation', ${org.recognitionRuleId}, 1200, 'open',
              now(), ${actor}, 'verified against the signed January policy memo', ${actor}, ${actor})
    `);
  } finally {
    await clearProbeLedger().catch(() => {});
    await dropScratchOrg(org.orgId);
  }
});

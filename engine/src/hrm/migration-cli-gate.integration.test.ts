import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db, withBypassContext, withOrg } from "../db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../test-fixtures.ts";
import { executeEmploymentMigration } from "./migration-execute.ts";
import type { SourcePersonRow } from "./migration-preflight.ts";
import { runHrmMigrationCli } from "../../../scripts/hrm-migrate-employments.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

/**
 * Production-interlock proofs (integration partition): every refusal path is
 * asserted against the DATABASE — worker_employments / employment_changes
 * row counts unchanged — not against the return value. A refusal that
 * reports correctly but writes anyway is the house defect class.
 */

const NS = "legacy-extract";

function readyRow(orgId: string, subId: string, partyId: string, sourceId: string): SourcePersonRow {
  return {
    orgId,
    sourceNamespace: NS,
    sourceId,
    nativePartyId: partyId,
    sourceVersion: "extract-2026-09-01",
    party: {
      kind: "employee",
      isActive: true,
      subsidiaryId: subId,
      sourceIsNew: false,
      evidenceIds: [`party-ev-${sourceId}`],
    },
    employer: {
      assertedSubsidiaryId: subId,
      subsidiaryFacts: [
        { id: subId, orgId, isActive: true, isEliminated: false },
      ],
      historicSubsidiaryIds: [],
    },
    role: {
      present: true,
      isActive: true,
      hiredOn: "2022-03-14",
      terminatedOn: null,
      dateProvenance: `role-ev-${sourceId}`,
      countryContext: null,
      evidenceIds: [`role-ev-${sourceId}`],
    },
    payroll: {
      present: true,
      isActive: true,
      subsidiaryId: subId,
      countryContext: null,
      evidenceIds: [`pay-ev-${sourceId}`],
    },
    observation: {
      status: "active",
      observedAt: "2026-09-10T12:00:00Z",
      provenance: `collector-${sourceId}`,
    },
    resolution: null,
    existingBinding: null,
  };
}

interface SeededInput {
  readonly dir: string;
  readonly path: string;
}

async function seedInput(org: ScratchOrg, sourceId: string): Promise<SeededInput> {
  const partyId = await withOrg(org.orgId, async () => {
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name)
      values (${org.orgId}, 'person', ${`Gate ${sourceId}`}) returning id::text as id`)) as unknown as {
      rows: Array<{ id: string }>;
    };
    const id = inserted.rows[0]?.id;
    assert.ok(id, "party insert must return exactly one row");
    return id;
  });
  const dir = mkdtempSync(join(tmpdir(), "hrm-gate-"));
  const path = join(dir, "rows.json");
  writeFileSync(path, `${JSON.stringify([readyRow(org.orgId, org.subsidiaryId, partyId, sourceId)])}\n`);
  return { dir, path };
}

interface TableCounts {
  employments: number;
  changes: number;
}

async function tableCounts(orgId: string): Promise<TableCounts> {
  return withBypassContext(async () => {
    const result = (await db.execute<{ employments: string; changes: string }>(
      sql`select (select count(*)::text from worker_employments where org_id = ${orgId}) as employments,
                  (select count(*)::text from employment_changes where org_id = ${orgId}) as changes`,
    )) as unknown as { rows: Array<{ employments: string; changes: string }> };
    const row = result.rows[0]!;
    return { employments: Number(row.employments), changes: Number(row.changes) };
  });
}

interface CliRun {
  exit: number;
  output: string;
}

/**
 * Run the CLI in-process with a patched environment; capture its output.
 * A patch value of undefined DELETES the key, so tests can simulate a hand
 * run with NODE_ENV unset. The CLI call runs inside an explicit org scope;
 * every flow below is also asserted against database row counts, never the
 * return value alone.
 */
async function runCli(
  orgId: string,
  inputPath: string,
  argv: string[],
  envPatch: Record<string, string | undefined>,
): Promise<CliRun> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  try {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const [key, value] of Object.entries(envPatch)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const exit = await withOrg(orgId, () =>
      runHrmMigrationCli({
        argv: [`--org=${orgId}`, `--input=${inputPath}`, ...argv],
        env,
      }),
    );
    return { exit, output: lines.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("production apply without --allow-production refuses and writes nothing", { skip }, async () => {
  const org = await createScratchOrg();
  const input = await seedInput(org, "gate-001");
  try {
    const before = await tableCounts(org.orgId);
    assert.deepEqual(before, { employments: 0, changes: 0 });
    const run = await runCli(org.orgId, input.path, ["--apply"], { NODE_ENV: "production" });
    assert.equal(run.exit, 1);
    assert.match(run.output, /\[production_apply_not_acknowledged\]/);
    // The refusal embeds the evaluated report hash, which can only exist if
    // the dry-run evaluate ran: no write path exists before the gate.
    assert.match(run.output, /dry-run report hash is [0-9a-f]{64}/);
    assert.deepEqual(await tableCounts(org.orgId), before);
  } finally {
    rmSync(input.dir, { recursive: true, force: true });
    await dropScratchOrg(org.orgId);
  }
});

test("production apply with the flag but no hash refuses and writes nothing", { skip }, async () => {
  const org = await createScratchOrg();
  const input = await seedInput(org, "gate-002");
  try {
    const before = await tableCounts(org.orgId);
    const run = await runCli(
      org.orgId,
      input.path,
      ["--apply", "--allow-production"],
      { NODE_ENV: "production" },
    );
    assert.equal(run.exit, 1);
    assert.match(run.output, /\[dry_run_hash_missing\]/);
    assert.match(run.output, /dry-run report hash is [0-9a-f]{64}/);
    assert.deepEqual(await tableCounts(org.orgId), before);
  } finally {
    rmSync(input.dir, { recursive: true, force: true });
    await dropScratchOrg(org.orgId);
  }
});

test("apply with NODE_ENV unset refuses and writes nothing", { skip }, async () => {
  const org = await createScratchOrg();
  const input = await seedInput(org, "gate-005");
  try {
    const before = await tableCounts(org.orgId);
    // A hand run with NODE_ENV unset is the normal one-off-script case: it
    // must refuse, never treat the absence of evidence as safe.
    const run = await runCli(org.orgId, input.path, ["--apply"], { NODE_ENV: undefined });
    assert.equal(run.exit, 1);
    assert.match(run.output, /\[environment_unknown\]/);
    assert.match(run.output, /dry-run report hash is [0-9a-f]{64}/);
    assert.deepEqual(await tableCounts(org.orgId), before);
  } finally {
    rmSync(input.dir, { recursive: true, force: true });
    await dropScratchOrg(org.orgId);
  }
});

test("misspelled NODE_ENV refuses and writes nothing", { skip }, async () => {
  const org = await createScratchOrg();
  const input = await seedInput(org, "gate-006");
  try {
    const before = await tableCounts(org.orgId);
    const run = await runCli(org.orgId, input.path, ["--apply"], { NODE_ENV: "prodction" });
    assert.equal(run.exit, 1);
    assert.match(run.output, /\[environment_unknown\]/);
    assert.match(run.output, /dry-run report hash is [0-9a-f]{64}/);
    assert.deepEqual(await tableCounts(org.orgId), before);
  } finally {
    rmSync(input.dir, { recursive: true, force: true });
    await dropScratchOrg(org.orgId);
  }
});

test("known-safe development run against the ephemeral database proceeds", { skip }, async () => {
  const org = await createScratchOrg();
  const input = await seedInput(org, "gate-007");
  try {
    // Safe harbor needs no controls: the environment is affirmatively
    // development AND this database carries the ephemeral marker (the
    // marker read runs under the runtime role here, proving the permission).
    const run = await runCli(org.orgId, input.path, ["--apply"], { NODE_ENV: "development" });
    assert.equal(run.exit, 0);
    assert.match(run.output, /1 migrated/);
    assert.deepEqual(await tableCounts(org.orgId), { employments: 1, changes: 1 });
  } finally {
    rmSync(input.dir, { recursive: true, force: true });
    await dropScratchOrg(org.orgId);
  }
});

test("mismatched hash refuses, names the mismatch, and writes nothing", { skip }, async () => {
  const org = await createScratchOrg();
  const input = await seedInput(org, "gate-003");
  try {
    // Pre-migrate outside production so the refusal must preserve live rows.
    const partyAndRow = JSON.parse(
      readFileSync(input.path, "utf8"),
    ) as SourcePersonRow[];
    await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: partyAndRow }),
    );
    const before = await tableCounts(org.orgId);
    assert.deepEqual(before, { employments: 1, changes: 1 });
    const run = await runCli(
      org.orgId,
      input.path,
      ["--apply", "--allow-production", `--dry-run-hash=${"0".repeat(64)}`],
      { NODE_ENV: "production" },
    );
    assert.equal(run.exit, 1);
    assert.match(run.output, /\[dry_run_hash_mismatch\]/);
    assert.match(run.output, /received 0{64}/);
    assert.match(run.output, /expected [0-9a-f]{64}/);
    assert.deepEqual(await tableCounts(org.orgId), before);
  } finally {
    rmSync(input.dir, { recursive: true, force: true });
    await dropScratchOrg(org.orgId);
  }
});

interface ProvisionedDatabase {
  readonly name: string;
  readonly dbUrl: string;
}

/**
 * Provision a throwaway database with the privileged test-cluster
 * connection CI exposes (.github/workflows/test.yml,
 * OPENBOOKS_TEST_ADMIN_DB_URL — the only suite allowed to CREATE DATABASE).
 * The name is generated per run: no literal database outside the tree is
 * ever a prerequisite. Without the privileged variable the test FAILS
 * naming it — never skips, never passes.
 */
async function provisionUnmarkedDatabase(): Promise<ProvisionedDatabase> {
  const adminBase = process.env.OPENBOOKS_TEST_ADMIN_DB_URL;
  assert.ok(
    adminBase,
    "this test provisions its own database and requires OPENBOOKS_TEST_ADMIN_DB_URL " +
      "(the privileged test-cluster connection from .github/workflows/test.yml)",
  );
  const runtimeBase = process.env.OPENBOOKS_RUNTIME_DB_URL;
  assert.ok(runtimeBase, "this test requires OPENBOOKS_RUNTIME_DB_URL to derive the runtime login");
  const name = `hrm_gate_unmarked_${process.pid}_${Date.now().toString(36)}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  const admin = new pg.Client({ connectionString: adminBase });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
    // template0 is always connection-free, so this never blocks on the
    // suite's own sessions the way copying the live database would.
    await admin.query(`create database "${name}" template template0`);
  } finally {
    await admin.end();
  }
  const dbUrl = new URL(adminBase);
  dbUrl.pathname = `/${name}`;
  const runtimeUrl = new URL(runtimeBase);
  runtimeUrl.pathname = `/${name}`;
  // The authoritative provisioner (the same Load-schema step CI runs), as
  // the superuser. It writes no marker comment, so the database stays
  // unmarked — exactly the negative case under test.
  execFileSync("npx", ["tsx", "scripts/bootstrap.ts"], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 600_000,
    env: {
      ...process.env,
      OPENBOOKS_DB_URL: dbUrl.toString(),
      OPENBOOKS_RUNTIME_DB_URL: runtimeUrl.toString(),
    },
  });
  return { name, dbUrl: runtimeUrl.toString() };
}

async function dropProvisionedDatabase(name: string): Promise<void> {
  const adminBase = process.env.OPENBOOKS_TEST_ADMIN_DB_URL;
  if (!adminBase) return;
  const admin = new pg.Client({ connectionString: adminBase });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}

/** Bypass-scoped row counts on a database outside the test process pool. */
async function externalCounts(dbUrl: string, orgId: string): Promise<TableCounts> {
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const client = await pool.connect();
    try {
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const result = await client.query(
        "select (select count(*)::int from worker_employments where org_id = $1) as employments," +
          " (select count(*)::int from employment_changes where org_id = $1) as changes",
        [orgId],
      );
      const row = result.rows[0] as { employments: number; changes: number };
      return { employments: row.employments, changes: row.changes };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function runSubprocessCli(dbUrl: string, orgId: string, path: string): { exit: number; output: string } {
  try {
    const output = execFileSync(
      "npx",
      ["tsx", "scripts/hrm-migrate-employments.ts", `--org=${orgId}`, `--input=${path}`, "--apply"],
      {
        encoding: "utf8",
        timeout: 180_000,
        env: {
          ...process.env,
          NODE_ENV: "development",
          OPENBOOKS_DB_URL: dbUrl,
          OPENBOOKS_RUNTIME_DB_URL: dbUrl,
        },
      },
    );
    return { exit: 0, output };
  } catch (error) {
    const failure = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      exit: typeof failure.status === "number" ? failure.status : -1,
      output: `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`,
    };
  }
}

test("unmarked database refuses even with NODE_ENV=development", { skip }, async () => {
  // True subprocess through the isEntrypoint path against a self-provisioned
  // database whose comment was never set: the CLI's OWN marker read returns
  // null (no stub anywhere in this path) and the gate refuses before any
  // write, even though the environment claims development. The input
  // references synthetic ids only — the classifier evaluates purely from
  // its inputs, so the refusal provably comes from the gate, and the row
  // counts below prove no write path executed.
  const provisioned = await provisionUnmarkedDatabase();
  const orgId = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), "hrm-gate-"));
  const path = join(dir, "rows.json");
  writeFileSync(
    path,
    `${JSON.stringify([readyRow(orgId, randomUUID(), randomUUID(), "unmarked-001")])}\n`,
  );
  try {
    const run = runSubprocessCli(provisioned.dbUrl, orgId, path);
    assert.equal(run.exit, 1);
    assert.match(run.output, /\[database_not_ephemeral\]/);
    assert.match(run.output, /dry-run report hash is [0-9a-f]{64}/);
    assert.deepEqual(await externalCounts(provisioned.dbUrl, orgId), {
      employments: 0,
      changes: 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await dropProvisionedDatabase(provisioned.name);
  }
});

test("a refused apply issues no writes: table write counters do not move", { skip }, async () => {
  // "No write before gate" as a TEST, not an argument: pg_stat write
  // counters are non-transactional, so unchanged counters prove no write was
  // even attempted (a rolled-back write would still move them). The input is
  // a ready person — had the gate passed, a write WOULD have landed — with
  // a mismatched hash forcing the refusal.
  const org = await createScratchOrg();
  const input = await seedInput(org, "gate-008");
  try {
    const counters = async (): Promise<Record<string, number>> =>
      withBypassContext(async () => {
        const result = (await db.execute<{ table: string; ins: string; upd: string; del: string }>(sql`
          select relname as table, n_tup_ins::text as ins, n_tup_upd::text as upd, n_tup_del::text as del
            from pg_stat_user_tables
           where schemaname = 'public'
             and relname in ('worker_employments', 'worker_employment_versions',
                             'employment_assignments', 'employment_changes')`)) as unknown as {
          rows: Array<{ table: string; ins: string; upd: string; del: string }>;
        };
        return Object.fromEntries(
          result.rows.map((row) => [
            row.table,
            Number(row.ins) + Number(row.upd) + Number(row.del),
          ]),
        );
      });
    const before = await counters();
    assert.equal(Object.keys(before).length, 4);
    const run = await runCli(
      org.orgId,
      input.path,
      ["--apply", "--allow-production", `--dry-run-hash=${"0".repeat(64)}`],
      { NODE_ENV: "production" },
    );
    assert.equal(run.exit, 1);
    assert.match(run.output, /\[dry_run_hash_mismatch\]/);
    assert.deepEqual(await counters(), before);
    assert.deepEqual(await tableCounts(org.orgId), { employments: 0, changes: 0 });
  } finally {
    rmSync(input.dir, { recursive: true, force: true });
    await dropScratchOrg(org.orgId);
  }
});

test("matching hash proceeds and migrates", { skip }, async () => {
  const org = await createScratchOrg();
  const input = await seedInput(org, "gate-004");
  try {
    const rows = JSON.parse(readFileSync(input.path, "utf8")) as SourcePersonRow[];
    const planned = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows, dryRun: true }),
    );
    const run = await runCli(
      org.orgId,
      input.path,
      ["--apply", "--allow-production", `--dry-run-hash=${planned.reportHash}`],
      { NODE_ENV: "production" },
    );
    assert.equal(run.exit, 0);
    assert.match(run.output, /1 migrated/);
    assert.deepEqual(await tableCounts(org.orgId), { employments: 1, changes: 1 });
  } finally {
    rmSync(input.dir, { recursive: true, force: true });
    await dropScratchOrg(org.orgId);
  }
});

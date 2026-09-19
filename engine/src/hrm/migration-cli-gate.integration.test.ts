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

test("unmarked database refuses even with NODE_ENV=development", { skip }, async () => {
  // True subprocess through the isEntrypoint path against a database whose
  // comment was never set: the marker read returns null and the gate refuses
  // before any write, even though the environment claims development. The
  // input references synthetic ids only — the classifier evaluates purely
  // from its inputs, so the refusal provably comes from the gate, and the
  // row counts below prove no write path executed.
  const configuredUrl = process.env.OPENBOOKS_DB_URL;
  assert.ok(configuredUrl, "integration run requires OPENBOOKS_DB_URL");
  const base = new URL(configuredUrl);
  base.pathname = "/hrm_slice_b4";
  const orgId = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), "hrm-gate-"));
  const path = join(dir, "rows.json");
  writeFileSync(
    path,
    `${JSON.stringify([readyRow(orgId, randomUUID(), randomUUID(), "unmarked-001")])}\n`,
  );
  try {
    let exit = -1;
    let output = "";
    try {
      output = execFileSync(
        "npx",
        ["tsx", "scripts/hrm-migrate-employments.ts", `--org=${orgId}`, `--input=${path}`, "--apply"],
        {
          encoding: "utf8",
          timeout: 180_000,
          env: {
            ...process.env,
            NODE_ENV: "development",
            OPENBOOKS_DB_URL: base.toString(),
            OPENBOOKS_RUNTIME_DB_URL: base.toString(),
          },
        },
      );
    } catch (error) {
      const failure = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
      exit = typeof failure.status === "number" ? failure.status : -1;
      output = `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`;
    }
    assert.equal(exit, 1);
    assert.match(output, /\[database_not_ephemeral\]/);
    assert.match(output, /dry-run report hash is [0-9a-f]{64}/);
    const counts = await unmarkedCounts(base.toString(), orgId);
    assert.deepEqual(counts, { employments: 0, changes: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Bypass-scoped row counts on a database outside the test process pool. */
async function unmarkedCounts(dbUrl: string, orgId: string): Promise<TableCounts> {
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

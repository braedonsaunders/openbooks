import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "drizzle-orm";
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

function readyRow(org: ScratchOrg, partyId: string, sourceId: string): SourcePersonRow {
  return {
    orgId: org.orgId,
    sourceNamespace: NS,
    sourceId,
    nativePartyId: partyId,
    sourceVersion: "extract-2026-09-01",
    party: {
      kind: "employee",
      isActive: true,
      subsidiaryId: org.subsidiaryId,
      sourceIsNew: false,
      evidenceIds: [`party-ev-${sourceId}`],
    },
    employer: {
      assertedSubsidiaryId: org.subsidiaryId,
      subsidiaryFacts: [
        { id: org.subsidiaryId, orgId: org.orgId, isActive: true, isEliminated: false },
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
      subsidiaryId: org.subsidiaryId,
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
  writeFileSync(path, `${JSON.stringify([readyRow(org, partyId, sourceId)])}\n`);
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

/** Run the CLI in-process with an injected environment; capture its output. */
async function runCli(
  org: ScratchOrg,
  inputPath: string,
  argv: string[],
  nodeEnv: string,
): Promise<CliRun> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  try {
    const exit = await withOrg(org.orgId, () =>
      runHrmMigrationCli({
        argv: [`--org=${org.orgId}`, `--input=${inputPath}`, ...argv],
        env: { ...process.env, NODE_ENV: nodeEnv },
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
    const run = await runCli(org, input.path, ["--apply"], "production");
    assert.equal(run.exit, 1);
    assert.match(run.output, /--allow-production/);
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
    const run = await runCli(org, input.path, ["--apply", "--allow-production"], "production");
    assert.equal(run.exit, 1);
    assert.match(run.output, /--dry-run-hash/);
    assert.deepEqual(await tableCounts(org.orgId), before);
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
      org,
      input.path,
      ["--apply", "--allow-production", `--dry-run-hash=${"0".repeat(64)}`],
      "production",
    );
    assert.equal(run.exit, 1);
    assert.match(run.output, /does not match/);
    assert.match(run.output, /received 0{64}/);
    assert.deepEqual(await tableCounts(org.orgId), before);
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
      org,
      input.path,
      ["--apply", "--allow-production", `--dry-run-hash=${planned.reportHash}`],
      "production",
    );
    assert.equal(run.exit, 0);
    assert.match(run.output, /1 migrated/);
    assert.deepEqual(await tableCounts(org.orgId), { employments: 1, changes: 1 });
  } finally {
    rmSync(input.dir, { recursive: true, force: true });
    await dropScratchOrg(org.orgId);
  }
});

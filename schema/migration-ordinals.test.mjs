import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const migrationsDirectory = "schema/migrations";
const generatedDirectory = `${migrationsDirectory}/generated`;
const bootstrapSource = readFileSync("scripts/bootstrap.ts", "utf8");

function publishedMigrationFiles() {
  return readdirSync(generatedDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function assertUniqueMigrationOrdinals(files) {
  const seen = new Map();
  let previousOrdinal = -1;
  for (const file of files) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
    assert.ok(match, `${file} must start with a four-digit migration ordinal`);
    const ordinal = Number(match[1]);
    assert.ok(
      !seen.has(ordinal),
      `${seen.get(ordinal)} and ${file} share migration ordinal ${match[1]}`,
    );
    assert.ok(
      ordinal > previousOrdinal,
      `${file} must follow strictly increasing migration ordinals`,
    );
    seen.set(ordinal, file);
    previousOrdinal = ordinal;
  }
}

async function bootstrapTransitionModule() {
  const transitionTable = bootstrapSource.match(
    /export const APPROVED_MIGRATION_FILENAME_TRANSITIONS:[\s\S]*?\n\];/,
  )?.[0];
  const convergence = bootstrapSource.match(
    /\/\/ BEGIN migration-filename-convergence-test-surface\n([\s\S]*?)\/\/ END migration-filename-convergence-test-surface/,
  )?.[1];
  const targetValidation = bootstrapSource.match(
    /function assertMigrationFilenameTransitionTargets\([\s\S]*?\n}\n/,
  )?.[0];
  assert.ok(transitionTable, "bootstrap must publish exact migration filename transitions");
  assert.ok(convergence, "bootstrap must expose its ledger convergence implementation");
  assert.ok(targetValidation, "bootstrap must expose its transition target validation");
  const javascript = `
    import { createHash } from "node:crypto";
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    const repoRoot = ${JSON.stringify(process.cwd())};
    const migrationsDir = join(repoRoot, "schema", "migrations");
    function sha256(value) {
      return createHash("sha256").update(value).digest("hex");
    }
    ${transitionTable}
    export ${targetValidation}
    ${convergence}
  `
    .replace(
      /: ReadonlyArray<MigrationFilenameTransition>/g,
      "",
    )
    .replace(/generated: readonly string\[\]/, "generated")
    .replace(/\): void \{/, ") {")
    .replace(/client: MigrationLedgerClient/, "client")
    .replace(/\): Promise<void> \{/, ") {")
    .replace(
      /client\.query<\{ filename: string; sha256: string \}>\(/,
      "client.query(",
    );
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

class MemoryMigrationLedger {
  constructor(rows) {
    this.rows = new Map(rows.map((row) => [row.filename, { ...row }]));
    this.updateCount = 0;
    this.migrationBodyExecutions = 0;
  }

  async query(statement, values = []) {
    const normalized = statement.replaceAll(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("select filename, sha256")) {
      const [legacyFilename, canonicalFilename] = values;
      return {
        rows: [legacyFilename, canonicalFilename]
          .map((filename) => this.rows.get(filename))
          .filter(Boolean)
          .map((row) => ({ ...row })),
        rowCount: 0,
      };
    }
    if (normalized.startsWith("update public._applied_migrations")) {
      const [canonicalFilename, legacyFilename, digest] = values;
      const legacy = this.rows.get(legacyFilename);
      if (!legacy || legacy.sha256 !== digest || this.rows.has(canonicalFilename)) {
        return { rows: [], rowCount: 0 };
      }
      this.rows.delete(legacyFilename);
      this.rows.set(canonicalFilename, {
        filename: canonicalFilename,
        sha256: legacy.sha256,
      });
      this.updateCount += 1;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected ledger query: ${normalized}`);
  }

  snapshot() {
    return [...this.rows.values()].sort((left, right) =>
      left.filename.localeCompare(right.filename));
  }
}

test("published migrations have unique, strictly increasing numeric ordinals", () => {
  const files = publishedMigrationFiles();
  assertUniqueMigrationOrdinals(files);
  assert.throws(
    () => assertUniqueMigrationOrdinals([
      "0001_baseline.sql",
      "0002_first.sql",
      "0002_second.sql",
    ]),
    /share migration ordinal 0002/,
    "the build contract must reject a future duplicate prefix",
  );
});

test("bootstrap resolves renamed migrations to their published bodies and digests", async () => {
  const files = new Set(publishedMigrationFiles());
  const {
    APPROVED_MIGRATION_FILENAME_TRANSITIONS: transitions,
    assertMigrationFilenameTransitionTargets,
  } = await bootstrapTransitionModule();
  assert.equal(transitions.length, 4);
  assert.deepEqual(
    transitions.map((transition) => transition.to.filename),
    [
      "generated/0035_terminal_failure_surfacing.sql",
      "generated/0036_bank_statement_source_idempotency.sql",
      "generated/0052_durable_work_lease_fencing.sql",
      "generated/0063_email_delivery_idempotency.sql",
    ],
  );
  assert.doesNotThrow(() =>
    assertMigrationFilenameTransitionTargets(publishedMigrationFiles()));

  for (const transition of transitions) {
    assert.equal(
      transition.from.sha256,
      transition.to.sha256,
      `${transition.from.filename} must be a filename-only transition`,
    );
    assert.ok(!files.has(transition.from.filename.replace("generated/", "")));
    const target = transition.to.filename.replace("generated/", "");
    assert.ok(files.has(target), `${target} must be published`);
    const digest = createHash("sha256")
      .update(readFileSync(`${migrationsDirectory}/${transition.to.filename}`, "utf8"))
      .digest("hex");
    assert.equal(digest, transition.to.sha256);
  }
});

test("old applied history converges once without replaying migration bodies", async (context) => {
  context.mock.method(console, "log", () => {});
  const {
    APPROVED_MIGRATION_FILENAME_TRANSITIONS: transitions,
    reconcileMigrationFilenameTransitions,
  } = await bootstrapTransitionModule();
  const unrelated = {
    filename: "generated/0005_posting_effects.sql",
    sha256: "unrelated-digest",
  };
  const ledger = new MemoryMigrationLedger([
    unrelated,
    ...transitions.map((transition) => ({ ...transition.from })),
  ]);

  await reconcileMigrationFilenameTransitions(ledger, transitions);
  assert.deepEqual(
    ledger.snapshot(),
    [
      unrelated,
      ...transitions.map((transition) => ({ ...transition.to })),
    ].sort((left, right) => left.filename.localeCompare(right.filename)),
  );
  assert.equal(ledger.updateCount, transitions.length);
  assert.equal(ledger.migrationBodyExecutions, 0);

  const converged = ledger.snapshot();
  await reconcileMigrationFilenameTransitions(ledger, transitions);
  assert.deepEqual(ledger.snapshot(), converged, "a second bootstrap is a no-op");
  assert.equal(ledger.updateCount, transitions.length, "canonical history must not be rewritten");
  assert.equal(ledger.migrationBodyExecutions, 0);
});

test("digest mismatches and ambiguous old/new history fail closed", async () => {
  const {
    APPROVED_MIGRATION_FILENAME_TRANSITIONS: transitions,
    reconcileMigrationFilenameTransitions,
  } = await bootstrapTransitionModule();
  const [transition] = transitions;
  const mismatched = new MemoryMigrationLedger([
    { ...transition.from, sha256: "changed-published-bytes" },
  ]);
  await assert.rejects(
    reconcileMigrationFilenameTransitions(mismatched, transitions),
    /changed after it was applied; refusing migration filename convergence/,
  );
  assert.deepEqual(mismatched.snapshot(), [
    { ...transition.from, sha256: "changed-published-bytes" },
  ]);

  const ambiguous = new MemoryMigrationLedger([
    { ...transition.from },
    { ...transition.to },
  ]);
  await assert.rejects(
    reconcileMigrationFilenameTransitions(ambiguous, [transition]),
    /migration history contains both/,
  );
  assert.equal(ambiguous.updateCount, 0);
});

// Header comments must name their own file. Renamed migrations keep their
// original header until a digest transition ships (their bytes are pinned by
// APPROVED_MIGRATION_FILENAME_TRANSITIONS); their stale headers are mapped to
// the current filename here. Every other migration must match exactly.
test("migration header comments name their own file", () => {
  const renamedTo = new Map([
    ["0006_terminal_failure_surfacing", "0035_terminal_failure_surfacing.sql"],
    ["0010_bank_statement_source_idempotency", "0036_bank_statement_source_idempotency.sql"],
    ["0008_durable_work_lease_fencing", "0052_durable_work_lease_fencing.sql"],
    ["0028_email_delivery_idempotency", "0063_email_delivery_idempotency.sql"],
  ]);
  const mismatches = [];
  for (const file of publishedMigrationFiles()) {
    if (file === "0001_baseline.sql") continue; // canonical baseline carries its own header prose
    const header = readFileSync(`${generatedDirectory}/${file}`, "utf8")
      .split("\n", 1)[0]
      .replace(/^-- OpenBooks forward migration /, "")
      .replace(/\.$/, "");
    if (header === file.replace(/\.sql$/, "")) continue;
    if (renamedTo.get(header) === file) continue;
    mismatches.push(`${file}: header says ${header}`);
  }
  assert.deepEqual(mismatches, []);
});

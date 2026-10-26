import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generatedMigrationFiles } from "../scripts/bootstrap/migration-files.ts";

// The bootstrap discovers forward migrations by filename and records each in
// the applied ledger under that name, so the ordinal is the apply order. The
// rule is exercised against scratch directories because the published forward
// set is whatever the current release carries above its baseline, and may be
// empty.
function forwardDirectory(context, files) {
  const directory = mkdtempSync(join(tmpdir(), "openbooks-forward-migrations-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of files) writeFileSync(join(directory, file), "select 1;\n");
  return directory;
}

test("forward migrations are discovered in ordinal order and non-SQL files are ignored", (context) => {
  const directory = forwardDirectory(context, [
    "0010_later.sql",
    "0002_second.sql",
    "0001_first.sql",
    "README.md",
    "0003_storage.integration.test.ts",
  ]);
  assert.deepEqual(generatedMigrationFiles(directory), [
    "0001_first.sql",
    "0002_second.sql",
    "0010_later.sql",
  ]);
  assert.deepEqual(generatedMigrationFiles(forwardDirectory(context, ["README.md"])), []);
});

test("a forward migration without a four-digit snake_case ordinal is refused", (context) => {
  for (const malformed of [
    "001_short.sql",
    "00001_long.sql",
    "0004-dashes.sql",
    "0004_Upper.sql",
    "baseline.sql",
  ]) {
    const directory = forwardDirectory(context, ["0001_first.sql", malformed]);
    assert.throws(
      () => generatedMigrationFiles(directory),
      (error) =>
        error instanceof Error &&
        error.message.includes(`${malformed} does not have a four-digit ordinal`),
      `${malformed} must be refused`,
    );
  }
});

test("two forward migrations sharing an ordinal are refused", (context) => {
  const directory = forwardDirectory(context, [
    "0001_first.sql",
    "0002_first_claim.sql",
    "0002_second_claim.sql",
  ]);
  assert.throws(
    () => generatedMigrationFiles(directory),
    /0002_first_claim\.sql and 0002_second_claim\.sql share ordinal 0002/,
  );
});

test("the published forward migration set satisfies the ordinal rule", () => {
  for (const file of generatedMigrationFiles()) {
    assert.match(file, /^\d{4}_[a-z0-9_]+\.sql$/);
  }
});

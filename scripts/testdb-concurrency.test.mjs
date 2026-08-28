import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/testdb.sh");

async function writeExecutable(path, source) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "openbooks-testdb-concurrency-"));
  const bin = join(root, "bin");
  const fixtureContents = "-- test fixture\\n";
  const fixtureDigest = createHash("sha256").update(fixtureContents).digest("hex");
  const fingerprint = createHash("sha256")
    .update(`0001_fixture.sql:${fixtureDigest}\\n`)
    .digest("hex");
  await mkdir(bin);

  await writeExecutable(
    join(bin, "docker"),
    `#!/bin/sh
case "$1" in
  info) exit 0 ;;
  inspect) printf 'true\\n' ;;
  *) exit 0 ;;
esac
`,
  );
  await writeExecutable(
    join(bin, "git"),
    `#!/bin/sh
case "$*" in
  *"rev-parse --show-toplevel"*) printf '%s\\n' "$FAKE_REPO_ROOT" ;;
  *"rev-parse --short HEAD"*) printf 'abc1234\\n' ;;
  *) exit 1 ;;
esac
`,
  );
  await writeExecutable(
    join(bin, "psql"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_PSQL_LOG"
case "$*" in
  *"select 1 from pg_database"*) printf '1\\n' ;;
  *"select fingerprint from openbooks_testdb_meta"*) printf '%s\\n' "$FAKE_FINGERPRINT" ;;
  *) exit 0 ;;
esac
`,
  );
  const worktrees = await Promise.all(
    ["env_alpha", "env_bravo"].map(async (identity) => {
      const worktree = join(root, identity, "openbooks");
      await mkdir(join(worktree, "schema", "migrations", "generated"), { recursive: true });
      await writeFile(
        join(worktree, "schema", "migrations", "generated", "0001_fixture.sql"),
        fixtureContents,
      );
      return { identity, worktree, tmp: await mkdtemp(join(root, `${identity}-tmp-`)) };
    }),
  );

  return {
    root,
    bin,
    fingerprint,
    log: join(root, "psql.log"),
    worktrees,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runNew(harness, { worktree, tmp }, name) {
  let result;
  try {
    const env = {
      ...process.env,
      PATH: `${harness.bin}:${process.env.PATH}`,
      TMPDIR: tmp,
      FAKE_REPO_ROOT: worktree,
      FAKE_PSQL_LOG: harness.log,
      FAKE_FINGERPRINT: harness.fingerprint,
      OPENBOOKS_TESTDB_TEMPLATE: "test_template",
    };
    delete env.BB_ENVIRONMENT_ID;
    result = await execFileAsync("bash", [script, "new", ...(name ? [name] : [])], {
      cwd: worktree,
      env,
    });
  } catch (error) {
    throw new Error(`${error.message}\n${error.stderr ?? ""}`);
  }
  const { stdout } = result;
  const match = stdout.match(/^export OPENBOOKS_DB_URL='[^']+\/([^/']+)'$/m);
  assert.ok(match, `testdb.sh did not print a database URL:\n${stdout}`);
  return match[1];
}

test("parallel same-commit worktrees receive distinct default test databases", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.cleanup());

  const names = await Promise.all(harness.worktrees.map((worktree) => runNew(harness, worktree)));

  assert.notEqual(names[0], names[1]);
  assert.match(names[0], /^ob_openbooks_abc1234_[a-f0-9]{16}$/);
  assert.match(names[1], /^ob_openbooks_abc1234_[a-f0-9]{16}$/);

  const psqlLog = await readFile(harness.log, "utf8");
  for (const name of names) {
    assert.match(psqlLog, new RegExp(`create database ${name} template test_template`));
  }

  const explicitName = await runNew(harness, harness.worktrees[0], "custom_fixture");
  assert.equal(explicitName, "ob_custom_fixture");
});

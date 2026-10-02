// Contract tests for the database `new` hands back, run against a fake psql
// that records every statement.
//
// `CREATE DATABASE ... TEMPLATE t` assigns the copy to the role that RUNS it,
// the superuser here; ownership is NOT inherited from the template. So a copy
// created without an OWNER clause left the runtime role without CREATE on it,
// and the first fixture to build a scratch schema died with "permission denied
// for database ob_<name>", which reads like a missing GRANT, not a wrong owner.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/testdb.sh");

// The same fingerprint testdb.sh computes, so template_matches_checkout agrees
// and `new` reaches the copy instead of refusing. Deriving it rather than
// hardcoding keeps this test from going stale on every new migration.
async function schemaFingerprint() {
  const source = await readFile(script, "utf8");
  const implementation = source.match(/^schema_fingerprint\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(implementation, "the test database fingerprint implementation must exist");
  const { stdout } = await execFileAsync("bash", [
    "-c",
    implementation + "\nschema_fingerprint",
  ]);
  return stdout.trim();
}

async function writeExecutable(path, source) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function harness(fingerprint, templateMigrations = 1) {
  const root = await mkdtemp(join(tmpdir(), "openbooks-testdb-newowner-"));
  const bin = join(root, "bin");
  const log = join(root, "psql.log");
  await mkdir(bin);
  await writeExecutable(join(bin, "docker"), `#!/bin/sh\ncase "$1" in info) exit 0 ;; inspect) printf 'true\\n' ;; *) exit 0 ;; esac\n`);
  await writeExecutable(
    join(bin, "psql"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *"datname='openbooks_template"*) printf '1\\n' ;;
  *"select fingerprint from openbooks_testdb_meta"*) printf '%s\\n' '${fingerprint}' ;;
  *"select migration_count from openbooks_testdb_meta"*) printf '${templateMigrations}\\n' ;;
  *) exit 0 ;;
esac
`,
  );
  const run = async (args, env = {}) => {
    try {
      const { stdout, stderr } = await execFileAsync("bash", [script, ...args], {
        env: { ...process.env, OPENBOOKS_TESTDB_ALLOW_STALE: "", OPENBOOKS_TESTDB_TEMPLATE: "", ...env, PATH: `${bin}:${process.env.PATH}` },
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };
  const statements = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { run, statements, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("new hands back a database owned by the runtime role the suite connects as", async (t) => {
  const h = await harness(await schemaFingerprint());
  t.after(h.cleanup);

  const result = await h.run(["new", "ownercheck"]);
  assert.equal(result.code, 0, result.stderr);

  const creates = (await h.statements()).filter((line) => /create database/i.test(line));
  assert.equal(creates.length, 1, "exactly one database is created");
  assert.match(creates[0], /create database ob_ownercheck template openbooks_template owner openbooks_app/);

  // The property worth guarding is that the OWNER is the role the suite
  // CONNECTS as: a copy the runtime role cannot extend is unusable for any
  // fixture that builds a scratch schema, and two drifting names break it again.
  const owner = creates[0].match(/owner (\S+)/)?.[1];
  const url = result.stdout.match(/OPENBOOKS_DB_URL='postgres:\/\/([^:]+):/)?.[1];
  assert.equal(owner, url, "the owning role and the connecting role must be the same role");
});

// A copy of a template built from another schema produced a refusal that was
// reported as a product defect; on a fresh template at the same commit the
// test was green. Refuse the copy by default; under --allow-stale mark every
// diagnostic line so no result can be read without seeing it. The remedies
// run safest first: `reset` rebuilds the template every worktree on the machine
// copies from, so it is named last, and itself refuses the shared name unless
// the operator acknowledges owning it.
test("new refuses a template built from a different schema unless --allow-stale, which marks every line", async (t) => {
  const h = await harness("0".repeat(64));
  t.after(h.cleanup);

  const refused = await h.run(["new", "stalecheck"]);
  assert.equal(refused.code, 1, `a copy of a mismatched template was handed out:\n${refused.stderr}`);
  assert.equal(refused.stdout, "", "no exports are handed out");
  assert.deepEqual((await h.statements()).filter((line) => /create database/i.test(line)), []);
  assert.match(refused.stderr, /template openbooks_template: 1 migrations {3}this checkout: \d+ migrations/);
  assert.match(refused.stderr, /your migrations are NOT in the template\.$/m);
  assert.match(refused.stderr, /pass --allow-stale \(or OPENBOOKS_TESTDB_ALLOW_STALE=1\)/);
  assert.match(refused.stderr, /reset rebuilds the SHARED template openbooks_template from this checkout, for every worktree on this machine/);
  const remedies = ["OPENBOOKS_TESTDB_TEMPLATE=openbooks_template_<suffix> scripts/testdb.sh new", "--allow-stale", "scripts/bootstrap.ts", "scripts/testdb.sh reset"];
  const at = remedies.map((remedy) => refused.stderr.indexOf(remedy));
  assert.ok(at.every((pos, i) => pos >= 0 && (i === 0 || pos > at[i - 1])), `remedies must run ${remedies.join(" < ")}:\n${refused.stderr}`);

  const logged = (await h.statements()).length;
  const reset = await h.run(["reset"]);
  assert.equal(reset.code, 1, `reset rebuilt the shared template without an acknowledgement:\n${reset.stderr}`);
  assert.match(reset.stderr, /no terminal to confirm on\. If you own this machine's template, pass --i-own-this-template/);
  assert.equal((await h.statements()).length, logged, "a refused reset touches no database");
  const ahead = await harness("0".repeat(64), 99999);
  t.after(ahead.cleanup);
  for (const [args, env] of [[["reset", "--i-own-this-template"]], [["reset"], { OPENBOOKS_TESTDB_TEMPLATE: "openbooks_template_mine" }]]) {
    const passed = await ahead.run(args, env);
    assert.match(passed.stderr, /refusing to rebuild backwards/, `the acknowledgement or a private template must pass the guard:\n${passed.stderr}`);
  }
  const behind = await ahead.run(["new", "behindcheck"]);
  assert.doesNotMatch(behind.stderr, /scripts\/testdb\.sh reset/, `a checkout behind the shared template must not be told to reset it:\n${behind.stderr}`);
  const mine = await ahead.run(["new", "behindcheck"], { OPENBOOKS_TESTDB_TEMPLATE: "openbooks_template_mine" });
  assert.match(mine.stderr, /OPENBOOKS_TESTDB_TEMPLATE=openbooks_template_mine scripts\/testdb\.sh reset --force$/m, mine.stderr);

  for (const [args, env] of [
    [["new", "--allow-stale", "stalecheck"]],
    [["new", "stalecheck", "--allow-stale"]],
    [["new", "stalecheck"], { OPENBOOKS_TESTDB_ALLOW_STALE: "1" }],
  ]) {
    const allowed = await h.run(args, env);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(allowed.stdout, /^export OPENBOOKS_DB_URL='[^']+\/ob_stalecheck'$/m, "the exports stay eval-able");
    const lines = allowed.stderr.split("\n").filter(Boolean);
    assert.ok(lines.some((line) => /ob_stalecheck ready/.test(line)), allowed.stderr);
    for (const line of lines) assert.match(line, /^stale-template: /);
  }
});

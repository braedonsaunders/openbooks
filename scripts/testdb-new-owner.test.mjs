// Contract test for the ownership of the database `new` hands back, run against
// a fake psql that records every statement.
//
// The defect this pins was silent in the worst way. `build_template` transfers
// the TEMPLATE to the runtime role, and print_env's own comment explains that
// tests connect as that constrained role so RLS assertions are not vacuous. But
// `CREATE DATABASE ... TEMPLATE t` assigns the copy to the role that RUNS it —
// the superuser here — and ownership is NOT inherited from the template. So
// every database `new` published was superuser-owned, the runtime role had no
// CREATE on it, and the first fixture to build a scratch schema died with
// "permission denied for database ob_<name>".
//
// That message names the DATABASE, so it reads like a missing GRANT on a
// database that was somehow set up wrong, rather than the copy having the wrong
// owner. Measured on the live container before the fix:
//
//   ob_integ           owner=openbooks      create=false
//   openbooks_template owner=openbooks_app  create=true
//
// The template being correct is precisely what kept this invisible: anyone who
// checked the template found it right and stopped looking.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/testdb.sh");

// The same fingerprint testdb.sh computes, so check_template_freshness agrees
// and `new` reaches the copy instead of refusing. Deriving it rather than
// hardcoding keeps this test from going stale on every new migration.
async function schemaFingerprint() {
  const { stdout } = await execFileAsync("bash", [
    "-c",
    'cd schema/migrations/generated && ls -1 *.sql | sort | while read -r f; do printf "%s:%s\\n" "$f" "$(shasum -a 256 "$f" | cut -d" " -f1)"; done | shasum -a 256 | cut -d" " -f1',
  ]);
  return stdout.trim();
}

async function writeExecutable(path, source) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function harness(fingerprint) {
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
  *"datname='openbooks_template'"*) printf '1\\n' ;;
  *"select fingerprint from openbooks_testdb_meta"*) printf '%s\\n' '${fingerprint}' ;;
  *"select migration_count from openbooks_testdb_meta"*) printf '1\\n' ;;
  *) exit 0 ;;
esac
`,
  );
  const run = async (...args) => {
    try {
      const { stdout, stderr } = await execFileAsync("bash", [script, ...args], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };
  const statements = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { run, statements, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("new hands back a database the runtime role owns, not one only the superuser can extend", async (t) => {
  const h = await harness(await schemaFingerprint());
  t.after(h.cleanup);

  const result = await h.run("new", "ownercheck");
  assert.equal(result.code, 0, result.stderr);

  const creates = (await h.statements()).filter((line) => /create database/i.test(line));
  assert.equal(creates.length, 1, "exactly one database is created");

  // The property worth guarding is the OWNER, not the presence of the clause:
  // a copy the runtime role cannot extend is unusable for any fixture that
  // builds a scratch schema, which is most of the integration partition.
  assert.match(
    creates[0],
    /create database ob_ownercheck template openbooks_template owner openbooks_app/,
    "the copy must be owned by the runtime role the suite actually connects as",
  );

  // print_env promises a runtime-role URL; the owner above is what makes that
  // promise usable rather than merely true.
  assert.match(result.stdout, /OPENBOOKS_DB_URL='postgres:\/\/openbooks_app:/);
});

test("the owner is the runtime role print_env hands out, not a second hardcoded name", async (t) => {
  const h = await harness(await schemaFingerprint());
  t.after(h.cleanup);

  const result = await h.run("new", "ownermatch");
  assert.equal(result.code, 0, result.stderr);

  const create = (await h.statements()).find((line) => /create database/i.test(line));
  const owner = create.match(/owner (\S+)/)?.[1];
  const url = result.stdout.match(/OPENBOOKS_DB_URL='postgres:\/\/([^:]+):/)?.[1];

  // Two names drifting apart is how this breaks again: the fix is only correct
  // while the role that OWNS the copy is the role the suite CONNECTS as.
  assert.ok(owner, "the create statement names an owner");
  assert.ok(url, "print_env emits a runtime URL");
  assert.equal(owner, url, "the owning role and the connecting role must be the same role");
});

// Contract tests for the destructive ends of scripts/testdb.sh, run against a
// fake psql that records every statement. The two defects these pin were
// SILENT: `drop <name>` took the raw name while `new` prefixed it with ob_, and
// `if exists` turned the miss into a printed success; `gc` aged databases with
// greatest(stats_reset, now() - 999 days) and PostgreSQL's GREATEST ignores
// NULLs, so every idle database was "999 days old" and the comment described
// nothing. A destructive command's dry run is the only evidence its policy
// matches its comment, so the dry runs are asserted to issue no DROP at all.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/testdb.sh");

async function writeExecutable(path, source) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

/**
 * A fake psql. `existing` names the ob_* databases the catalogue "contains";
 * `stamps` maps a database to its copied_at answer ("" = unstamped) and to
 * whether it is older than the requested interval.
 */
async function harness({ existing = [], stamps = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "openbooks-testdb-dropgc-"));
  const bin = join(root, "bin");
  const log = join(root, "psql.log");
  await mkdir(bin);
  await writeExecutable(join(bin, "docker"), `#!/bin/sh\ncase "$1" in info) exit 0 ;; inspect) printf 'true\\n' ;; *) exit 0 ;; esac\n`);
  const stampLines = Object.entries(stamps)
    .map(([db, { stamp, old }]) => `  *"-d ${db} "*"copied_at at time zone"*) printf '%s\\n' '${stamp}' ;;\n  *"-d ${db} "*"copied_at < now()"*) printf '%s\\n' '${old ? "true" : "false"}' ;;`)
    .join("\n");
  await writeExecutable(
    join(bin, "psql"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *"select 1 from pg_database where datname = '"*)
    name=$(printf '%s' "$*" | sed "s/.*datname = '\\([^']*\\)'.*/\\1/")
    for e in ${existing.join(" ")}; do [ "$e" = "$name" ] && { printf '1\\n'; exit 0; }; done
    exit 0 ;;
  *"select interval '"*) printf '1 day\\n' ;;
  *"select d.datname from pg_database d"*) printf '%s\\n' ${existing.map((e) => `'${e}'`).join(" ")} ;;
${stampLines}
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
  const drops = async () => (await statements()).filter((line) => /drop database/i.test(line));
  return { run, statements, drops, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("drop resolves the caller's name exactly as new does, and a miss is an error, not a success", async (t) => {
  const h = await harness({ existing: ["ob_alpha"] });
  t.after(h.cleanup);
  const miss = await h.run("drop", "missing_db");
  assert.equal(miss.code, 1);
  assert.match(miss.stderr, /ob_missing_db does not exist — nothing dropped \(asked for 'missing_db'\)/);
  assert.deepEqual(await h.drops(), [], "a miss issues no DROP");
  assert.doesNotMatch(miss.stderr, /dropped ob_/, "a miss never prints a drop");

  const hit = await h.run("drop", "alpha");
  assert.equal(hit.code, 1, "the fake catalogue still lists ob_alpha after the drop, so the claim is refused");
  assert.match(hit.stderr, /still exists after drop/);
  const issued = await h.drops();
  assert.equal(issued.length, 1);
  assert.match(issued[0], /drop database ob_alpha with \(force\)/, "the prefixed name, not the raw argument");
  assert.doesNotMatch(issued[0], /if exists/, "no IF EXISTS: a miss must be visible");
});

test("drop accepts the ob_-prefixed form without doubling it and refuses non-test names", async (t) => {
  const h = await harness({ existing: ["ob_beta"] });
  t.after(h.cleanup);
  const dry = await h.run("drop", "--dry-run", "ob_beta");
  assert.equal(dry.code, 0);
  assert.match(dry.stderr, /would drop ob_beta \(dry run; nothing dropped\)/);
  assert.deepEqual(await h.drops(), [], "dry run issues no DROP");
  const template = await h.run("drop", "openbooks_template");
  assert.equal(template.code, 1, "the template can never be the target: names always resolve to ob_<name>");
  assert.match(template.stderr, /ob_openbooks_template does not exist/);
  assert.deepEqual(await h.drops(), []);
});

test("gc ages from the copy stamp, protects unstamped copies, and its dry run drops nothing", async (t) => {
  const h = await harness({
    existing: ["ob_old", "ob_fresh", "ob_nostamp"],
    stamps: {
      ob_old: { stamp: "2026-01-01 00:00:00", old: true },
      ob_fresh: { stamp: "2026-09-19 12:00:00", old: false },
      ob_nostamp: { stamp: "", old: false },
    },
  });
  t.after(h.cleanup);
  const dry = await h.run("gc", "--dry-run");
  assert.equal(dry.code, 0);
  assert.match(dry.stderr, /would drop 1 database\(s\): ob_old \(1 recent kept, 1 unstamped skipped\); nothing dropped/);
  assert.match(dry.stderr, /ob_nostamp — no copy stamp \(age unknown\); skipped/);
  assert.deepEqual(await h.drops(), [], "dry run issues no DROP");
  const plan = (await h.statements()).join("\n");
  assert.doesNotMatch(plan, /greatest\(/i, "the NULL-swallowing age predicate is gone");
  assert.match(plan, /d\.datname <> 'openbooks_template'/, "the template is never a candidate");

  const included = await h.run("gc", "--dry-run", "--include-unstamped");
  assert.match(included.stderr, /would drop 2 database\(s\): ob_old ob_nostamp/);
  assert.deepEqual(await h.drops(), []);

  const bad = await h.run("gc", "--older-than");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--older-than needs an interval/);
  const unknown = await h.run("gc", "--nuke");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown option '--nuke'/);
});

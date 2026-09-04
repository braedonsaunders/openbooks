/**
 * The swarm release path must migrate before it serves.
 *
 * compose.yaml gets this declaratively: a one-shot `bootstrap` service that
 * `web` waits on. Swarm ignores `depends_on` in stack mode, so the swarm stack
 * carried only web and worker and NOTHING applied migrations -- production ran
 * code 22 migrations ahead of its own schema, and no deploy step said so.
 *
 * swarm-release.sh is the procedural replacement for that ordering. These are
 * contract tests over the script itself, because the property under test is an
 * ordering between two commands and there is no runtime that can assert it
 * before it has already gone wrong in production.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("./swarm-release.sh", import.meta.url), "utf8");

/** Strip comments so the prose explaining an ordering cannot satisfy the test
 *  that the ordering exists. */
const code = script
  .split("\n")
  .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
  .join("\n");

test("the release runs the bootstrap migration chain", () => {
  assert.match(code, /node scripts\/bootstrap\.mjs/, "the release must apply pending migrations");
  assert.match(
    code,
    /OPENBOOKS_BOOTSTRAP=1/,
    "bootstrap requires its explicit opt-in flag",
  );
  assert.match(
    code,
    /OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION=1/,
    "this cluster migrates as the constrained schema owner; without the flag bootstrap demands two roles and fails closed",
  );
});

test("migrations run BEFORE the stack is repointed, not after", () => {
  const migrateAt = code.indexOf("node scripts/bootstrap.mjs");
  const deployAt = code.indexOf("docker stack deploy");
  // The shell source escapes the identifier quotes, so match the statement head.
  const swapAt = code.indexOf("update compose set");
  assert.ok(migrateAt > -1 && deployAt > -1 && swapAt > -1, "all three steps must exist");
  assert.ok(
    migrateAt < swapAt,
    "the digest swap must not happen before migrations apply, or the new code serves against an old schema",
  );
  assert.ok(
    migrateAt < deployAt,
    "the stack deploy must not happen before migrations apply",
  );
});

test("a failed migration aborts the release instead of serving anyway", () => {
  assert.match(code, /set -euo pipefail/, "an unguarded failure would fall through to the swap");
  // The migration must not be neutered by a fallback that lets the release continue.
  const migrateLine = code
    .split("\n")
    .find((line) => line.includes("node scripts/bootstrap.mjs"));
  assert.ok(migrateLine !== undefined);
  assert.ok(
    !/\|\||true\s*$/.test(migrateLine),
    "a `||` fallback on the migration step would convert the gate into a suggestion",
  );
});

test("the release is pinned to an immutable digest, never a moving tag", () => {
  assert.match(
    code,
    /\^sha256:\[0-9a-f\]\{64\}\$/,
    "the release argument must be validated as a full digest",
  );
  assert.match(
    code,
    /\$\{IMAGE_REPO\}@\$\{NEW\}/,
    "the migration container must run the exact digest being released, not :latest",
  );
});

test("psql calls cannot swallow the script's own stdin", () => {
  // `docker exec -i` reads this script from stdin when it is piped over ssh,
  // truncating everything after the first call. That failure is silent: the
  // script simply stops, mid-release.
  for (const line of code.split("\n")) {
    if (!line.includes("docker exec") || !line.includes("psql")) continue;
    assert.match(
      line.includes("</dev/null") ? line : `${line}${nextRedirect(code, line)}`,
      /<\/dev\/null/,
      `every docker exec psql call must redirect stdin: ${line.trim()}`,
    );
  }
});

/** A call may place its redirect on a continuation line. */
function nextRedirect(source, line) {
  const at = source.indexOf(line);
  return source.slice(at, at + line.length + 200).split("\n").slice(1, 3).join("\n");
}

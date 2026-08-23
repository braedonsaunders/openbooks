import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

test("scheduler ticks are claimed with a stable Postgres advisory lock", () => {
  const worker = source("./scheduler.ts");
  assert.match(worker, /TICK_LOCK_KEY = "openbooks:report-scheduler-tick"/);
  assert.match(worker, /pg_try_advisory_lock\(hashtextextended\(\$1, 0\)\)/);
  assert.match(
    worker,
    /pg_advisory_unlock\(hashtextextended\(\$1, 0\)\)/,
    "the session lock must be released explicitly, not left to die with idle sessions",
  );
  // The claim wraps the whole tick body: a replica that loses the race must
  // skip materialization/dispatch entirely, not merely one subsystem.
  const claimStart = worker.indexOf("await withTickClaim");
  const body = worker.indexOf("materializeDueReportRuns()");
  assert.ok(claimStart > -1 && body > claimStart, "the tick body runs under withTickClaim");
  // The module-local flag stays as an intra-process overlap guard only.
  assert.match(worker, /let running = false/);
});

test("the tick claim releases on both success and error paths", () => {
  const worker = source("./scheduler.ts");
  const fn = worker.slice(
    worker.indexOf("export async function withTickClaim"),
    worker.indexOf("export async function tick"),
  );
  assert.ok(fn.length > 0, "withTickClaim exists between start/stop helpers and tick");
  assert.match(fn, /if \(claimed\.rows\[0\]\?\.locked !== true\)/);
  assert.match(fn, /held = true/, "ownership is recorded only after the try-lock wins");
  assert.match(fn, /finally/, "release happens in finally, covering throws");
  assert.ok(
    fn.indexOf("pg_advisory_unlock") < fn.indexOf("client.release"),
    "unlock precedes release so the connection never re-enters the pool locked",
  );
});

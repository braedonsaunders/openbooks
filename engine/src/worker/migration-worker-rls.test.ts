import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./migration-worker.ts", import.meta.url),
  "utf8",
);

test("migration jobs execute inside their tenant RLS context", () => {
  assert.match(
    source,
    /async \(job\) =>\s+withOrgContext\(job\.data\.orgId, async \(\) => \{/,
  );
});

test("mirror discovery and the stale-run reaper cross an explicit trusted boundary", () => {
  const reaper = source.slice(
    source.indexOf("export async function reapStaleSyncRuns"),
    source.indexOf("export function startMirrorScheduler"),
  );
  const scheduler = source.slice(
    source.indexOf("export function startMirrorScheduler"),
  );
  assert.match(reaper, /withBypassContext\(\(\) =>\s+db\.execute/);
  assert.match(scheduler, /withBypassContext\(\(\) =>\s+db\.execute/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("web/app/api/admin/backups/run/route.ts", "utf8");
const migration = readFileSync(
  "schema/migrations/generated/0001_baseline.sql",
  "utf8",
);

test("manual backup creation relies on the database in-flight invariant", () => {
  assert.doesNotMatch(route, /select id from backup_runs/);
  assert.match(route, /insert into backup_runs/);
  assert.match(route, /postgresError\.code === "23505"/);
  assert.match(route, /backup_runs_one_inflight_per_org/);
  assert.match(route, /status: 409/);
});

test("canonical baseline enforces one queued or running row per organization", () => {
  assert.match(migration, /create unique index backup_runs_one_inflight_per_org/i);
  assert.match(migration, /on public\.backup_runs using btree \(org_id\)/i);
  assert.match(migration, /where \(status = any \(array\['queued'::text, 'running'::text\]\)\)/i);
});

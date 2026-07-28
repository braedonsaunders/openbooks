import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "..");
const bootstrap = readFileSync(join(root, "scripts", "bootstrap.ts"), "utf8");
const environments = readFileSync(
  join(root, "schema", "migrations", "environments.sql"),
  "utf8",
);

test("deployment bootstrap serializes migrate and seed work", () => {
  assert.match(bootstrap, /pg_advisory_lock/);
  assert.match(bootstrap, /openbooks:deployment-bootstrap/);
  assert.match(bootstrap, /pg_advisory_unlock/);
  assert.ok(
    bootstrap.indexOf("pg_advisory_lock") <
      bootstrap.indexOf("await migrate()"),
  );
  assert.ok(
    bootstrap.indexOf("await seedProjectTypes") <
      bootstrap.indexOf("pg_advisory_unlock"),
  );
});

test("row-level security refresh is versioned and drift-driven", () => {
  assert.match(bootstrap, /applied_digest !== digest/);
  assert.match(bootstrap, /catalog_drift/);
  assert.match(environments, /openbooks:org_isolation:v1/);
  assert.match(environments, /openbooks:sandbox_isolation:v1/);
  assert.match(environments, /if not rls_enabled then/i);
  assert.match(environments, /if policy_version is distinct from/i);
});

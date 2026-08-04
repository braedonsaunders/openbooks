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
const projectTypeSeed = readFileSync(
  join(root, "engine", "src", "seed-project-types.ts"),
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
  assert.match(bootstrap, /await withBypassContext\(async \(\) =>/);
  assert.ok(
    bootstrap.indexOf("await withBypassContext") <
      bootstrap.indexOf("await migrate()"),
  );
});

test("legacy owned-schema mode is migration-only and fail-closed", () => {
  assert.match(bootstrap, /OPENBOOKS_LEGACY_OWNED_SCHEMA === "1"/);
  assert.match(bootstrap, /role\.rolsuper or role\.rolbypassrls/);
  assert.match(bootstrap, /role\.rolcreatedb/);
  assert.match(bootstrap, /role\.rolcreaterole/);
  assert.match(bootstrap, /role\.rolreplication/);
  assert.match(bootstrap, /posture\.current_user !== runtimeConfig\.roleName/);
  assert.match(bootstrap, /posture\.current_database !== runtimeDatabase/);
  assert.match(bootstrap, /posture\.unowned_tables !== 0/);

  const legacyBranch = bootstrap.slice(
    bootstrap.indexOf("if (legacyOwnedSchema)"),
    bootstrap.indexOf("// Some migrations grant privileges"),
  );
  assert.match(legacyBranch, /await assertLegacyOwnedSchemaMigrationRole/);
  assert.match(legacyBranch, /await migrate\(\)/);
  assert.match(legacyBranch, /return;/);
  assert.doesNotMatch(legacyBranch, /ensureReadRole/);
  assert.doesNotMatch(legacyBranch, /ensureRuntimeDatabaseRole/);
  assert.doesNotMatch(legacyBranch, /seed[A-Z]/);
});

test("row-level security refresh is versioned and drift-driven", () => {
  assert.match(bootstrap, /applied_digest !== digest/);
  assert.match(bootstrap, /catalog_drift/);
  assert.match(environments, /openbooks:org_isolation:v1/);
  assert.match(environments, /openbooks:sandbox_isolation:v1/);
  assert.match(environments, /if not rls_enabled then/i);
  assert.match(environments, /if policy_version is distinct from/i);
});

test("bundled bootstrap cannot launch the project-type seed CLI twice", () => {
  assert.doesNotMatch(
    projectTypeSeed,
    /import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/,
  );
  assert.match(projectTypeSeed, /isSeedProjectTypesCli\(process\.argv\[1\]\)/);
  assert.match(projectTypeSeed, /seed-project-types\\\./);
});

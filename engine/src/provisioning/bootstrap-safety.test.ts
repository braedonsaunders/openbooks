import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "..", "..");
const bootstrap = readFileSync(join(root, "scripts", "bootstrap.ts"), "utf8");
const environments = readFileSync(
  join(root, "schema", "migrations", "environments.sql"),
  "utf8",
);
const projectTypeSeed = readFileSync(
  join(root, "engine", "src", "projects", "seed-project-types.ts"),
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

test("constrained schema-owner mode is migration-only and fail-closed", () => {
  assert.match(
    bootstrap,
    /OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION === "1"/,
  );
  assert.match(bootstrap, /role\.rolsuper or role\.rolbypassrls/);
  assert.match(bootstrap, /role\.rolcreatedb/);
  assert.match(bootstrap, /role\.rolcreaterole/);
  assert.match(bootstrap, /role\.rolreplication/);
  assert.match(bootstrap, /posture\.unowned_tables !== 0/);
  // The old contract pinned the migration login to the runtime role
  // (`current_user !== runtimeConfig.roleName` as a requirement), which is
  // exactly the single-role bypass this mode must not allow in production.
  // The new contract refuses identical logins outside development/test.
  assert.doesNotMatch(
    bootstrap,
    /posture\.current_user !== runtimeConfig\.roleName/,
  );
  assert.match(bootstrap, /refuses a runtime role identical to the migration login/);
  assert.match(bootstrap, /sameTarget\(migrationUrl, runtimeUrl\)/);

  const constrainedOwnerBranch = bootstrap.slice(
    bootstrap.indexOf("if (constrainedSchemaOwnerMigration)"),
    bootstrap.indexOf("// Some migrations grant privileges"),
  );
  assert.match(
    constrainedOwnerBranch,
    /await assertConstrainedSchemaOwnerMigrationRole/,
  );
  assert.match(constrainedOwnerBranch, /await requireRuntimeLoginRole/);
  assert.match(constrainedOwnerBranch, /await migrate\(\)/);
  // The migration owner grants the separate runtime login after the chain
  // (new tables included) and verifies it non-owner + RLS-proved — the
  // branch still seeds nothing and creates no roles.
  assert.match(constrainedOwnerBranch, /await ensureRuntimeDatabaseRole\(runtimeConfig, true\)/);
  assert.match(constrainedOwnerBranch, /await verifyRuntimeOwnership/);
  assert.match(constrainedOwnerBranch, /await verifyRuntimeDatabaseRole/);
  assert.match(constrainedOwnerBranch, /return;/);
  assert.doesNotMatch(constrainedOwnerBranch, /ensureReadRole/);
  assert.doesNotMatch(constrainedOwnerBranch, /ensureRuntimeRoleExists/);
  assert.doesNotMatch(constrainedOwnerBranch, /seed[A-Z]/);
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

test("test ownership transfer is explicit, production-refused, and verified", () => {
  // The transfer exists so test logins are RLS-subject constrained owners
  // rather than exempt bootstrap superusers. Each interlock below is load
  // bearing: without the explicit variable a typo'd CI config silently keeps
  // the exempt posture; without the production refusal it could divest a live
  // database; without the ownership proof a partial transfer looks complete.
  assert.match(
    bootstrap,
    /OPENBOOKS_TEST_OWNERSHIP_TRANSFER !== "1"/,
  );
  assert.match(
    bootstrap,
    /OPENBOOKS_TEST_OWNERSHIP_TRANSFER is refused in production/,
  );
  assert.match(bootstrap, /OPENBOOKS_TEST_OWNERSHIP_TRANSFER requires OPENBOOKS_RUNTIME_DB_URL/);
  assert.match(bootstrap, /owner to ' \|\| quote_ident\(\$1\)/);
  assert.match(bootstrap, /alter database .* owner to/i);
  assert.match(bootstrap, /alter schema public owner to/i);
  assert.match(
    bootstrap,
    /ownership transfer incomplete; RLS nexus objects not owned by/,
  );
  // The transfer runs after seeds and before the runtime-role proof, so the
  // fail-closed/tenant proof attests the transferred state, not the pre-state.
  // Scoped past the constrained-owner branch, which has its own earlier
  // verifyRuntimeDatabaseRole call for the separate runtime login.
  const fullMode = bootstrap.slice(bootstrap.indexOf("// Some migrations grant privileges"));
  assert.ok(fullMode.indexOf("// Some migrations grant privileges") === 0);
  assert.ok(
    fullMode.indexOf("await transferTestOwnershipToRuntimeRole") <
      fullMode.indexOf("await verifyRuntimeDatabaseRole"),
  );
  assert.ok(
    fullMode.indexOf("await seedAdmin") <
      fullMode.indexOf("await transferTestOwnershipToRuntimeRole"),
  );
});

/**
 * Deployment bootstrap — idempotent, runs before the web server starts.
 *
 *   1. Applies the canonical baseline and any future forward migrations in
 *      schema/migrations/generated/*.sql, tracked by immutable file digest.
 *   2. Verifies environments.sql (row-level security), applying it only when
 *      its version or live catalog coverage has changed.
 *   3. Ensures the SELECT-only `openbooks_read` role + grants (SQL workbench
 *      and user-script queries need it).
 *   4. Ensures an org, its primary accounting book, monthly accounting
 *      periods, and the built-in RBAC roles.
 *   5. Upserts the initial admin user from ADMIN_EMAIL / ADMIN_NAME /
 *      ADMIN_PASSWORD (skipped when unset).
 *   6. Grants platform super-admin from PLATFORM_ADMIN_EMAIL when set and no
 *      active super administrator exists anywhere in the installation (strict
 *      one-time, audited; refused by name when the address names no user).
 *
 * Run: npx tsx scripts/bootstrap.ts   (or the esbuild bundle in the image)
 *
 * Before applying any pending migration, bootstrap runs every pending
 * migration's preflight (schema/migrations/preflight/<basename>.sql), each
 * in BEGIN READ ONLY with bypass RLS and a bounded statement_timeout, then
 * ROLLBACK. Any refuse finding stops bootstrap before the first migration;
 * notices are printed and the upgrade continues. Preflights that need an
 * object an earlier pending migration creates are deferred to apply time.
 *
 * Read-only check (no writes, no locks, no role/seed/RLS work):
 *   node --import tsx scripts/bootstrap.ts --check [--json]
 * (npm run upgrade:check). Exits 1 on any refuse finding, 0 otherwise.
 */
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sealLegacyPaymentLinkTokens } from "../engine/src/payments/payment-link-seal.ts";
import { revokeRuntimeFunctionExecute } from "./bootstrap-function-denials.ts";
import { sql } from "drizzle-orm";
import pg from "pg";
import {
  precreatedRolesEnabled,
  verifyPrecreatedRoles,
  verifyPrecreatedObjectAccess,
  verifyReadRoleAssumption,
  verifyRuntimeOwnership,
  type RuntimeDatabaseConfig,
} from "./bootstrap-roles.ts";
import { db, env, longPool, pool, withBypassContext } from "../engine/src/platform/db.ts";
import {
  connectMigrationClient,
  describeBootstrapMigrationFailure,
  executeMigrationAttempt,
  executeMigrationBody,
  isLockNotAvailable,
  migrationLockConfig,
  migrationRetryDelayMs,
  migrationRunsWithoutTransaction,
  releaseMigrationClient,
  sanitizeMigrationContent,
} from "./bootstrap-migration-client.ts";
import {
  PREFLIGHT_MIN_ORDINAL,
  earlierPendingCreatesObject,
  evaluatePreflight,
  formatFinding,
  ordinalOf as preflightOrdinalOf,
  preflightDecisionFor,
  preflightDirFor,
  preflightStatementTimeoutMs,
  readNoneReason,
  readPreflightSql,
  type PreflightFinding,
} from "./migration-preflight.ts";
import { ensureCloseDefaults } from "../engine/src/close/defaults.ts";
import { provisionOrganizationDefaults } from "../engine/src/provisioning/organization-provisioning.ts";
import { SUPPORTED_CURRENCIES } from "../engine/src/fx/currencies.ts";
import { BUILT_IN_ROLES } from "../web/lib/permissions.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "schema", "migrations");

type MigrationFilenameIdentity = {
  filename: string;
  sha256: string;
};

type MigrationFilenameTransition = {
  from: MigrationFilenameIdentity;
  to: MigrationFilenameIdentity;
  reason: string;
};

/**
 * A published migration rename is not a new migration and must never re-run
 * its body. Each transition therefore binds both filenames to the exact same
 * reviewed bytes. Existing ledgers move only the primary-key filename; their
 * digest is neither rewritten nor restamped.
 */
export const APPROVED_MIGRATION_FILENAME_TRANSITIONS: ReadonlyArray<MigrationFilenameTransition> = [
  {
    from: {
      filename: "generated/0006_terminal_failure_surfacing.sql",
      sha256: "df5db290b100f7bfd51cb4301b86a81442d6031c5efb451df28ad667f6ed3991",
    },
    to: {
      filename: "generated/0035_terminal_failure_surfacing.sql",
      sha256: "df5db290b100f7bfd51cb4301b86a81442d6031c5efb451df28ad667f6ed3991",
    },
    reason: "give terminal-failure surfacing a unique migration ordinal",
  },
  {
    from: {
      filename: "generated/0010_bank_statement_source_idempotency.sql",
      sha256: "a78e9e61ea2860192304c4a254e86f57ecd70c92bd6c5225f7bbaa425c80788e",
    },
    to: {
      filename: "generated/0036_bank_statement_source_idempotency.sql",
      sha256: "a78e9e61ea2860192304c4a254e86f57ecd70c92bd6c5225f7bbaa425c80788e",
    },
    reason: "give bank-statement source idempotency a unique migration ordinal",
  },
  {
    from: {
      filename: "generated/0008_durable_work_lease_fencing.sql",
      sha256: "bd2ade3638423462d48b539afd9c18e77a9ad1301ca2bca3fb4e2e132f8e2011",
    },
    to: {
      filename: "generated/0052_durable_work_lease_fencing.sql",
      sha256: "bd2ade3638423462d48b539afd9c18e77a9ad1301ca2bca3fb4e2e132f8e2011",
    },
    reason:
      "move the lease-fencing backfill after terminal-failure column creation; " +
        "fresh installs otherwise fail at 0008 because the approved 0006-to-0035 " +
        "canonicalization reordered the column DDL behind its backfill",
  },
  {
    from: {
      filename: "generated/0028_email_delivery_idempotency.sql",
      sha256: "ca93c827fa161d267f6b93717f4d0ef28f9d6c30511c52152618229e6f07e052",
    },
    to: {
      filename: "generated/0063_email_delivery_idempotency.sql",
      sha256: "ca93c827fa161d267f6b93717f4d0ef28f9d6c30511c52152618229e6f07e052",
    },
    reason:
      "move the email delivery_key format CHECK + org-scoped index after " +
        "0059_email_delivery_identity_reconciliation which creates the delivery_key " +
        "column; fresh installs otherwise fail at 0028 with 'column delivery_key does " +
        "not exist' because filename order runs 0028 before 0059",
  },
];

function runtimeDatabaseConfig(): RuntimeDatabaseConfig | null {
  const connectionString = env.OPENBOOKS_RUNTIME_DB_URL?.trim();
  if (!connectionString) return null;
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("OPENBOOKS_RUNTIME_DB_URL must be a PostgreSQL URL");
  }
  const roleName = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(roleName)) {
    throw new Error("OPENBOOKS_RUNTIME_DB_URL contains an invalid PostgreSQL role name");
  }
  if (password.length < 24) {
    throw new Error("the runtime database password must contain at least 24 characters");
  }
  return { connectionString, roleName, password };
}

async function quoted(value: string, kind: "identifier" | "literal"): Promise<string> {
  const fn = kind === "identifier" ? "quote_ident" : "quote_literal";
  const result = await pool.query<{ value: string }>(
    `select ${fn}($1) as value`,
    [value],
  );
  return result.rows[0]!.value;
}

async function assertConstrainedSchemaOwnerMigrationRole(
  runtimeConfig: RuntimeDatabaseConfig,
): Promise<void> {
  const result = await pool.query<{
    current_user: string;
    current_database: string;
    unsafe: boolean;
    unowned_tables: number;
  }>(`
    select current_user, current_database(),
           role.rolsuper or role.rolbypassrls or role.rolcreatedb
             or role.rolcreaterole or role.rolreplication as unsafe,
           (select count(*)::int
              from pg_class relation
              join pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind in ('r', 'p')
               and pg_get_userbyid(relation.relowner) <> current_user) as unowned_tables
      from pg_roles role
     where role.rolname = current_user
  `);
  const posture = result.rows[0];
  const runtimeUrl = new URL(runtimeConfig.connectionString);
  if (!env.OPENBOOKS_DB_URL?.trim()) {
    throw new Error("constrained schema-owner migration requires OPENBOOKS_DB_URL (the migration login)");
  }
  const migrationUrl = new URL(env.OPENBOOKS_DB_URL);
  const sameTarget = (a: URL, b: URL): boolean =>
    a.hostname === b.hostname &&
    (a.port || "5432") === (b.port || "5432") &&
    decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname);
  // Fail closed: the escape hatch this flag opens (migrating as the schema
  // owner instead of a dedicated migration login) must never collapse the
  // migration and runtime logins into one outside explicit development/test
  // environments. Same-role constrained runs in production are how the
  // application ends up serving as the schema owner. An unset NODE_ENV (a
  // hand-run maintenance script) is treated as production.
  const nodeEnv = process.env.NODE_ENV;
  if (
    posture?.current_user === runtimeConfig.roleName &&
    nodeEnv !== "development" &&
    nodeEnv !== "test"
  ) {
    throw new Error(
      "constrained schema-owner migration refuses a runtime role identical to the migration login outside development/test; " +
        "provision a separate non-owner runtime role and set OPENBOOKS_RUNTIME_DB_URL to it — " +
        "see docs/operations/communal-postgres.md and deploy/README.md",
    );
  }
  if (
    !posture ||
    posture.current_database !== decodeURIComponent(runtimeUrl.pathname.replace(/^\//, "")) ||
    !sameTarget(migrationUrl, runtimeUrl) ||
    posture.unsafe ||
    posture.unowned_tables !== 0
  ) {
    throw new Error(
      "constrained schema-owner migration requires a restricted role that owns every public table, " +
        "with the runtime URL targeting the same host, port and database",
    );
  }
  console.log(
    `[bootstrap] constrained schema owner ${posture.current_user} verified for migration-only mode`,
  );
}

/**
 * The constrained migration login cannot create roles (it is deliberately
 * unprivileged), so the runtime login must already exist. Refuse with the
 * exact host step instead of failing later on the first GRANT.
 */
async function requireRuntimeLoginRole(config: RuntimeDatabaseConfig): Promise<void> {
  const existing = await pool.query<{ login: boolean }>(
    "select rolcanlogin as login from pg_roles where rolname = $1",
    [config.roleName],
  );
  if (!existing.rows[0]?.login) {
    throw new Error(
      `[bootstrap] runtime role ${config.roleName} does not exist with LOGIN; ` +
        `ask the database host to provision it per docs/operations/communal-postgres.md ` +
        `(CREATE ROLE ${config.roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION ` +
        `PASSWORD '<at least 24 characters>'; GRANT CONNECT, TEMPORARY ON DATABASE <database> TO ${config.roleName}), ` +
        `then retry bootstrap`,
    );
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function generatedMigrationFiles(): string[] {
  const generated = readdirSync(join(migrationsDir, "generated"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const seenOrdinals = new Map<number, string>();
  let previousOrdinal = -1;

  for (const file of generated) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
    if (!match) {
      throw new Error(
        `[bootstrap] generated migration ${file} does not have a four-digit ordinal`,
      );
    }
    const ordinal = Number(match[1]);
    const duplicate = seenOrdinals.get(ordinal);
    if (duplicate) {
      throw new Error(
        `[bootstrap] generated migrations ${duplicate} and ${file} share ordinal ${match[1]}`,
      );
    }
    if (ordinal <= previousOrdinal) {
      throw new Error(
        `[bootstrap] generated migration ${file} is not in strictly increasing ordinal order`,
      );
    }
    seenOrdinals.set(ordinal, file);
    previousOrdinal = ordinal;
  }

  return generated;
}

function assertMigrationFilenameTransitionTargets(generated: readonly string[]): void {
  const generatedSet = new Set(generated.map((file) => `generated/${file}`));
  for (const transition of APPROVED_MIGRATION_FILENAME_TRANSITIONS) {
    if (transition.from.sha256 !== transition.to.sha256) {
      throw new Error(
        `[bootstrap] migration filename transition ${transition.from.filename} -> ${transition.to.filename} changes its digest`,
      );
    }
    if (generatedSet.has(transition.from.filename)) {
      throw new Error(
        `[bootstrap] legacy migration filename ${transition.from.filename} is still published`,
      );
    }
    if (!generatedSet.has(transition.to.filename)) {
      throw new Error(
        `[bootstrap] renamed migration ${transition.to.filename} is not published`,
      );
    }
    const target = readFileSync(join(migrationsDir, transition.to.filename), "utf8");
    if (sha256(target) !== transition.to.sha256) {
      throw new Error(
        `[bootstrap] renamed migration ${transition.to.filename} does not match its approved digest`,
      );
    }
  }
}

type MigrationLedgerClient = Pick<pg.PoolClient, "query">;

const ORDER_QUANTITY_PROGRESS_MIGRATION_FILENAME =
  "generated/0064_order_quantity_progress_precision.sql";
const ORDER_QUANTITY_PROGRESS_MIGRATION_SHA256 =
  "1c92eb07479a3bf9eb93ab14841df51d1d05dcbb5c95b4b492578f2f90f85b34";

/** The governed query view must remain an explicit, tenant-scoped projection. */
const DOCUMENT_LINES_VIEW_COLUMNS = [
  "id",
  "org_id",
  "document_id",
  "line_number",
  "item_id",
  "account_id",
  "description",
  "quantity",
  "unit",
  "unit_price",
  "amount",
  "tax_code_id",
  "tax_amount",
  "department_id",
  "project_id",
  "location_id",
  "class_id",
  "employee_id",
  "time_entry_id",
  "time_type_id",
  "cost_multiplier",
  "is_billable",
  "billed_by_line_id",
  "quantity_fulfilled",
  "quantity_billed",
  "custom",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  "tax_overridden",
  "subsidiary_id",
  "extra_dims",
  "stock_location_id",
  "party_id",
  "equipment_unit_id",
  "rate_version_id",
  "rate_presentation",
  "base_quantity",
  "base_unit",
  "cost_rate",
  "bill_rate",
  "cost_amount",
  "bill_amount",
  "recovery_account_id",
  "tax_group_id",
  "tax_input_amount",
  "field_ticket_id",
  "markup_percent",
] as const;

type GovernedViewAclEntry = {
  grantee: string | null;
  privilege: string;
  isGrantable: boolean;
};

type GovernedViewSnapshot = {
  owner: string;
  acl: GovernedViewAclEntry[] | null;
  reloptions: string[] | null;
  objectComment: string | null;
  columnComments: Array<{ name: string; comment: string | null }>;
};

function sqlLiteral(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

async function quoteIdentifierOnClient(
  client: pg.PoolClient,
  value: string,
): Promise<string> {
  const result = await client.query<{ value: string }>(
    "select quote_ident($1) as value",
    [value],
  );
  return result.rows[0]!.value;
}

async function snapshotDocumentLinesGovernedView(
  client: pg.PoolClient,
): Promise<GovernedViewSnapshot | null> {
  const relation = await client.query<{
    oid: string;
    relkind: string;
    owner: string;
    relacl: string[] | null;
    reloptions: string[] | null;
    objectComment: string | null;
    isDocumentLinesDependency: boolean;
  }>(`
    select relation.oid::text,
           relation.relkind,
           pg_get_userbyid(relation.relowner) as owner,
           relation.relacl,
           relation.reloptions,
           obj_description(relation.oid, 'pg_class') as "objectComment",
           exists (
             select 1
               from pg_depend dependency
               join pg_rewrite rewrite on rewrite.oid = dependency.objid
              where rewrite.ev_class = relation.oid
                and dependency.refobjid = 'public.document_lines'::regclass
           ) as "isDocumentLinesDependency"
      from pg_class relation
      join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
     where namespace_row.nspname = 'openbooks_query'
       and relation.relname = 'document_lines'
  `);
  const row = relation.rows[0];
  if (!row) return null;
  if (row.relkind !== "v" || !row.isDocumentLinesDependency) {
    throw new Error(
      "[bootstrap] openbooks_query.document_lines is not the governed document_lines view",
    );
  }

  const acl = await client.query<{
    grantee: string | null;
    privilege: string;
    isGrantable: boolean;
  }>(
    `select case when expanded.grantee = 0 then null
                 else pg_get_userbyid(expanded.grantee)
            end as grantee,
            expanded.privilege_type as privilege,
            expanded.is_grantable as "isGrantable"
       from pg_class relation
       cross join lateral aclexplode(relation.relacl) expanded
      where relation.oid = $1::oid
      order by expanded.grantee, expanded.privilege_type`,
    [row.oid],
  );
  const columns = await client.query<{
    name: string;
    comment: string | null;
  }>(
    `select attribute.attname as name,
            col_description(attribute.attrelid, attribute.attnum) as comment
       from pg_attribute attribute
      where attribute.attrelid = $1::oid
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by attribute.attnum`,
    [row.oid],
  );
  return {
    owner: row.owner,
    acl: row.relacl === null ? null : acl.rows,
    reloptions: row.reloptions,
    objectComment: row.objectComment,
    columnComments: columns.rows,
  };
}

async function restoreDocumentLinesGovernedView(
  client: pg.PoolClient,
  snapshot: GovernedViewSnapshot,
): Promise<void> {
  const owner = await quoteIdentifierOnClient(client, snapshot.owner);
  await client.query(`alter view openbooks_query.document_lines owner to ${owner}`);

  // The published view has one supported storage option. Reset first so an
  // option introduced by the CREATE cannot survive a snapshot that had it off.
  await client.query(
    "alter view openbooks_query.document_lines reset (security_barrier)",
  );
  for (const option of snapshot.reloptions ?? []) {
    const [name, value] = option.split("=", 2);
    if (name !== "security_barrier" || (value !== "true" && value !== "false")) {
      throw new Error(
        `[bootstrap] unsupported openbooks_query.document_lines option ${option}`,
      );
    }
    await client.query(
      `alter view openbooks_query.document_lines set (security_barrier = ${value})`,
    );
  }

  // Revoke the new relation's explicit ACL before replaying the captured one.
  // This handles default privileges owned by the migration connection without
  // disturbing any unrelated relation.
  const relation = await client.query<{ oid: string }>(
    `select relation.oid::text
       from pg_class relation
       join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
      where namespace_row.nspname = 'openbooks_query'
        and relation.relname = 'document_lines'
        and relation.relkind = 'v'`,
  );
  if (!relation.rows[0]) {
    throw new Error("[bootstrap] governed document_lines view was not recreated");
  }
  if (snapshot.acl !== null) {
    const currentAcl = await client.query<{ grantee: string | null }>(
      `select case when expanded.grantee = 0 then null
                   else pg_get_userbyid(expanded.grantee)
              end as grantee
         from pg_class relation
         cross join lateral aclexplode(relation.relacl) expanded
        where relation.oid = $1::oid`,
      [relation.rows[0].oid],
    );
    const principals = new Set<string | null>([
      null,
      ...currentAcl.rows.map((entry) => entry.grantee),
      ...snapshot.acl.map((entry) => entry.grantee),
    ]);
    for (const principal of principals) {
      const target = principal === null
        ? "PUBLIC"
        : await quoteIdentifierOnClient(client, principal);
      await client.query(
        `revoke all privileges on table openbooks_query.document_lines from ${target}`,
      );
    }
    for (const entry of snapshot.acl) {
      if (!/^[A-Z_]+$/.test(entry.privilege)) {
        throw new Error(
          `[bootstrap] unsupported ACL privilege ${entry.privilege} on governed document_lines view`,
        );
      }
      const target = entry.grantee === null
        ? "PUBLIC"
        : await quoteIdentifierOnClient(client, entry.grantee);
      await client.query(
        `grant ${entry.privilege} on table openbooks_query.document_lines to ${target}`
        + (entry.isGrantable ? " with grant option" : ""),
      );
    }
  }

  await client.query(
    `comment on view openbooks_query.document_lines is ${sqlLiteral(snapshot.objectComment)}`,
  );
  const expectedColumns = new Set(DOCUMENT_LINES_VIEW_COLUMNS);
  for (const column of snapshot.columnComments) {
    if (!expectedColumns.has(column.name as (typeof DOCUMENT_LINES_VIEW_COLUMNS)[number])) {
      throw new Error(
        `[bootstrap] governed document_lines comment targets unknown column ${column.name}`,
      );
    }
    const identifier = await quoteIdentifierOnClient(client, column.name);
    await client.query(
      `comment on column openbooks_query.document_lines.${identifier} is ${sqlLiteral(column.comment)}`,
    );
  }
}

async function executeOrderQuantityProgressMigration(
  client: pg.PoolClient,
  content: string,
  digest: string,
): Promise<void> {
  if (digest !== ORDER_QUANTITY_PROGRESS_MIGRATION_SHA256) {
    throw new Error(
      `[bootstrap] ${ORDER_QUANTITY_PROGRESS_MIGRATION_FILENAME} does not match its approved digest`,
    );
  }
  const snapshot = await snapshotDocumentLinesGovernedView(client);
  if (!snapshot) {
    throw new Error(
      "[bootstrap] governed document_lines view is missing; refusing 0064 without its repair boundary",
    );
  }
  await client.query("drop view openbooks_query.document_lines");
  await client.query(content);

  const projection = DOCUMENT_LINES_VIEW_COLUMNS.join(",\n    ");
  await client.query(
    `create view openbooks_query.document_lines with (security_barrier=true) as
     select ${projection}
       from public.document_lines
      where (org_id = public.openbooks_query_org_id())`,
  );
  await restoreDocumentLinesGovernedView(client, snapshot);
}

// BEGIN migration-filename-convergence-test-surface
export async function reconcileMigrationFilenameTransitions(
  client: MigrationLedgerClient,
  transitions: ReadonlyArray<MigrationFilenameTransition> = APPROVED_MIGRATION_FILENAME_TRANSITIONS,
): Promise<void> {
  for (const transition of transitions) {
    if (transition.from.sha256 !== transition.to.sha256) {
      throw new Error(
        `[bootstrap] migration filename transition ${transition.from.filename} -> ${transition.to.filename} changes its digest`,
      );
    }

    const recorded = await client.query<{ filename: string; sha256: string }>(
      `select filename, sha256
         from public._applied_migrations
        where filename in ($1, $2)
        order by filename
        for update`,
      [transition.from.filename, transition.to.filename],
    );
    const legacy = recorded.rows.find(
      (row) => row.filename === transition.from.filename,
    );
    if (!legacy) continue;
    if (legacy.sha256 !== transition.from.sha256) {
      throw new Error(
        `[bootstrap] ${transition.from.filename} changed after it was applied; refusing migration filename convergence`,
      );
    }
    const canonical = recorded.rows.find(
      (row) => row.filename === transition.to.filename,
    );
    if (canonical) {
      throw new Error(
        `[bootstrap] migration history contains both ${transition.from.filename} and ${transition.to.filename}`,
      );
    }

    const updated = await client.query(
      `update public._applied_migrations
          set filename = $1
        where filename = $2 and sha256 = $3`,
      [transition.to.filename, transition.from.filename, transition.from.sha256],
    );
    if (updated.rowCount !== 1) {
      throw new Error(
        `[bootstrap] ${transition.from.filename} changed during migration filename convergence`,
      );
    }
    console.log(
      `[bootstrap] migration history renamed ${transition.from.filename} -> ${transition.to.filename}`,
    );
    console.log(`[bootstrap]   ${transition.reason}`);
  }
}
// END migration-filename-convergence-test-surface

async function convergeMigrationFilenames(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await reconcileMigrationFilenameTransitions(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Published migrations are immutable except for an exact, reviewed digest
 * transition. A restamp is limited to a schema-equivalent rebaseline whose
 * before/after dumps match. A reapply is limited to a corrective revision that
 * is deliberately idempotent against the old migration's successful state.
 *
 * This is a fixed table of digest pairs rather than a bypass flag. Each entry
 * names both byte identities and its one permitted strategy; every other
 * mismatch still fails closed.
 */
const APPROVED_MIGRATION_TRANSITIONS: ReadonlyArray<{
  filename: string;
  from: string;
  to: string;
  strategy: "restamp" | "reapply";
  reason: string;
}> = [
  {
    filename: "generated/0001_baseline.sql",
    from: "f65211f25eb7d6fb31669612b9be2cfcafd1c24717902adc8f1cffa3fb121f5b",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 7c8c5d5a4) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "1fadf5ee6e4639f7755844d9b1b36b5739deeb9b0f58590ff7c3de2f0aa02659",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 3a4f4ccf4) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "b4e3aa7d8dee59e79e7e3317d2faff4a425676af8549297681a35345efa19b9d",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at eee5886ab) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "51442b77d6796b1e0ef042839e01e4098ab4888281e9d611873227fc0a7cb5c9",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at f6018a4ae) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "197b4a0d018dbbeb93a80786ebddf1a2171c671b9f80a1254d202a8b0dcbb049",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at a544960bd) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "ab9387ff76b968fb9c3edbeacfabc8dbc355f14597e85ee2886436e6a188b834",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 60e5b4fca) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "f6ecbacdf37ff464d5cf2625594fbe6e69288e719f5428a60c63d7b07c84fb5e",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 672b72ffa) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "f932387099f3e8eed708f7caf113b5747bf06665b33053112366f8b9ddbc30e2",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at febe8f2d6) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "0779993e7ab72be43b9f87e80fe928ba34adb97d6fdecce5e31dac83f8e9f5b5",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at b5bbbb084) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "6e9a1efeb9093df663ca8168881c818dfa492f4a4f36f7ad61536cefb5731795",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at ca3250a9f) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "b564ecd1e31e1a67a74e88c41620e6dc9428092942913a3b03dba023f30ad61e",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at dddf430d4) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "c05effa006b6cce26a3f1a3e9fcd64720a0ddc3dca24141a56defceb5109c083",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 10b048323) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "74a3b21e956f2f02334f5245f54b37fe235af732a8eb3345d86a9ea9611df007",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 9f47d9479) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "780dfaf134f8d98a40c5e9d143291c161194fec196151aca30d1d4f6f4fbade6",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 2521e288d) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "4456055b785a98bd396ae0f79cf1f667567a51c4a048771dea8ca4af650f4403",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at c10ef0b98) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "e55af0e3d57075639ca9295c8935b34d031892bd2ec6d77c73c322e1f0fc4041",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 9020552e9) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "payroll opening balance components); reconciliation migrations for those are "
      + "pending, and past this transition any use of them surfaces as a named "
      + "failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "be286c62810e6bd5a83c1296e7b3edba0905b35790411c6e93d4fba7c69d59e8",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 6697ee99c) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "8441c24678ddb20770d3d8dc7974b05006fe875f6fc1ab81e409f03853468582",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 4193046ba) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment "
      + "stats); reconciliation migrations for those are pending, and past this "
      + "transition any use of them surfaces as a named failure instead of the "
      + "blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "25d4e4da19a70b0c802b628b452909c458ee993ffbc1e85391f302a0a420f897",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at e2951940b) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment "
      + "stats); reconciliation migrations for those are pending, and past this "
      + "transition any use of them surfaces as a named failure instead of the "
      + "blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "d28acf11d61654a936db58830475d3cd190dd4c55454d5e9d24f3d53b485277a",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at c57edc899) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment "
      + "stats); reconciliation migrations for those are pending, and past this "
      + "transition any use of them surfaces as a named failure instead of the "
      + "blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "fbb2e1ddcceecba7d35c9d6cb96699a4ff05e27652cf1313983ffaa79f08b245",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at de2de5c8f) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment "
      + "stats); reconciliation migrations for those are pending, and past this "
      + "transition any use of them surfaces as a named failure instead of the "
      + "blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "44f9d9aee56eaa87d51b37fab43e3ae96f9a0ba453351bed27ad230e5628f05c",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at f7b392df9) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment "
      + "stats); reconciliation migrations for those are pending, and past this "
      + "transition any use of them surfaces as a named failure instead of the "
      + "blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "700b5d03f383c3d85924d1cfdbd39eceb157727751878260f14eeb2d59378c65",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at bf47ae3e7) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "7c403687f332814513f33ff3a5628265f8f4aca6e28742e5cfa167e74918c851",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at ae8c64e49) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "35ce0c7a8efe59c6a3f19a36be64a9a87ea62e826b2b3d3c26aec818aa361612",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at c608d5d22) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data.",
  },
  {
    filename: "generated/0026_scheduler_outbox_terminal_audit.sql",
    from: "c7dde9ba1846fd0609faaa4426f70d5cbbd14d5a3731a51fb666c048a4a8b235",
    to: "929fd15922f09e86d1b416a6cfedca684492d2b7e20f19e700a83b64a3cfa286",
    strategy: "reapply",
    reason:
      "the corrective revision makes the replay-allowed predicate NULL-safe: a "
      + "NULL p_org_id previously left the comparison NULL, so `IF NOT ...` "
      + "fell through instead of denying. It now returns false for NULL and the "
      + "trigger tests `IS NOT TRUE`, closing a fail-open path on system-scan "
      + "rows that carry no tenant. Every statement is idempotent — CREATE TABLE "
      + "/ INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF "
      + "EXISTS, a policy guarded by IF NOT EXISTS, and an anti-joined backfill "
      + "— so reapplying redefines the guard and inserts no duplicate evidence.",
  },
  {
    filename: "generated/0060_lease_base_rent_window_exclusive.sql",
    from: "03f488dd20d7e56efc3a1a4ccc7d5d20977c9f88b821561186a902bb30535e9c",
    to: "72410c818c0c0b5bd006d29cbc7d281f6097f90ca5833690219554b81cabd4da",
    strategy: "restamp",
    reason:
      "the sole difference is one line inside the one-time repair DO block, "
      + "where a cancelled-line counter overwrote instead of accumulating and so "
      + "under-reported in its RAISE NOTICE. The repair has already run on any "
      + "database carrying the old digest and the count was only ever logged, "
      + "never stored. Restamp rather than reapply: the file ends in ALTER TABLE "
      + "... ADD CONSTRAINT, which has no IF NOT EXISTS form and would fail on a "
      + "database that already has the exclusion constraint.",
  },
  {
    filename: "generated/0015_payment_instruction_posting_claim_fence.sql",
    from: "8c71d6c3dfdde2f83c5d7a13c48296bfc3841d54020d6cb29a87cee8e89e663f",
    to: "90b8dcf7b3dccc670bcfc4edb3078ce1a8a234cf0e050254215a6ad59309efc9",
    strategy: "reapply",
    reason:
      "the corrective revision TIGHTENS the fence: the settlement-style retreat "
      + "carve-out (settled/returned/rejected) now also requires every other "
      + "instruction field to be unchanged, so a bank-outcome writer can no "
      + "longer alter unrelated columns without holding the posting claim. The "
      + "file is idempotent — CREATE OR REPLACE FUNCTION, DROP TRIGGER IF "
      + "EXISTS, then comments — so reapplying only redefines the trigger and "
      + "touches no row. A database still on the looser definition is strictly "
      + "less protected until it runs.",
  },
  {
    filename: "generated/0010_bank_statement_source_evidence.sql",
    from: "577f345ac58b2b585fce5802f2895234c2a0494e2835677ad223d735280e2ec6",
    to: "0f36b431a4574d340da65f401fdac15f2e5a92339118d2a2d041529c495be631",
    strategy: "reapply",
    reason:
      "the original migration could only be recorded after every statement "
      + "already had source evidence and raw_file_ref was NOT NULL. Reapplying "
      + "the corrective revision therefore creates no legacy-gap attestations "
      + "on that database and safely refreshes the evidence catalog comment.",
  },
  {
    filename: "generated/0002_kernel_hardening.sql",
    from: "964952e28517abe607b4c6490b7ce1644addfaf4c011c16c8592bb65fa60bb46",
    to: "33947b5ff76c8d3b042e362ebaccfa056ab46690ee448d546aa9e088ea1c37b7",
    strategy: "reapply",
    reason:
      "corrective revision replaces the racy BEFORE-trigger SELECT EXISTS guard "
      + "on income_tax_rates with a storage-side GiST exclusion constraint "
      + "(income_tax_rates_no_active_overlap, mirroring 0051), so concurrent "
      + "overlapping active-rate inserts can no longer both commit. The revision "
      + "is deliberately idempotent against the old migration's successful state "
      + "(retire the single-duty trigger, repair lost-race rows, then add the "
      + "constraint) and replays cleanly on an already-bootstrapped database. "
      + "Now also carries the query-console REVOKE fix described in the "
      + "b814bcca transition below.",
  },
  {
    filename: "generated/0002_kernel_hardening.sql",
    from: "b814bccaa12d21d425aee0fc940c43317b554bbceab0cb12a813f41d1034d156",
    to: "33947b5ff76c8d3b042e362ebaccfa056ab46690ee448d546aa9e088ea1c37b7",
    strategy: "restamp",
    reason:
      "section 1 revoked EXECUTE on the pg_catalog file readers from PUBLIC "
      + "unconditionally. Those functions are not granted to PUBLIC on a stock "
      + "PostgreSQL 16 cluster, so the loop only ever revoked privileges nobody "
      + "held — and because pg_catalog is owned by the superuser, it raised "
      + "'permission denied for function pg_current_logfile' under the "
      + "constrained schema-owner migration role that "
      + "assertConstrainedSchemaOwnerMigrationRole requires, aborting the entire "
      + "chain at 0002 before any later migration could run. The revision skips "
      + "signatures PUBLIC does not hold and downgrades an unrevokable real "
      + "grant to a WARNING naming the superuser statement. A database that "
      + "already recorded b814bcca ran section 1 as a privileged role, so its "
      + "schema is already the revision's outcome and only the digest moves. "
      + "Section 4's duplicate entry_number repair carries a second fix in the "
      + "same revision: it updated posted and reversed journal_entries headers "
      + "without a sanctioned migration path, so it aborted the chain with "
      + "'journal entry % is posted and immutable' on every database that "
      + "actually had duplicates. It now locks journal_entries against "
      + "concurrent writers, suspends je_guard transactionally for the narrowly "
      + "scoped entry_number repair, restores it before later sections run, and "
      + "writes durable per-entry before/after audit evidence. A database that "
      + "recorded b814bcca completed section 4, so it had no duplicates left to "
      + "rename and the revision is a no-op there too.",
  },
  {
    filename: "generated/0062_recognition_events.sql",
    from: "8a21bbb92ccc5ae295ed23572888e396e9099eb96f49403aecc6167b203bebc2",
    to: "3d9146e6152005ced41915a7ad45c3f16c7524a7ba13703126c0a4a4626d9a7b",
    strategy: "restamp",
    reason:
      "corrective RLS policy revision changes TO openbooks_app to TO PUBLIC "
      + "while preserving the tenant predicate; environments.sql already "
      + "replaces org_isolation with the PUBLIC form on every run where the "
      + "policy comment is not openbooks:org_isolation:v1, so databases that "
      + "applied the prior migration already have an equivalent schema before "
      + "and after the restamp.",
  },
  {
    filename: "generated/0006_recurring_occurrence_guard.sql",
    from: "e67de81a35d3e27db9494395d444380361b92d44ba84ecbe72ac8ca976a860c1",
    to: "8bb20d32a74195e630747f48024f5e35e5d72457fa7669d2d80a409b53d72510",
    strategy: "reapply",
    reason:
      "corrective revision adds tenant-coherent composite foreign keys for "
      + "recurring occurrence lineage, after a preflight that refuses to rewrite "
      + "mismatched legacy rows. It drops the original global-id references and "
      + "rebuilds the constraints idempotently against the prior migration state.",
  },
  {
    filename: "generated/0060_lease_base_rent_window_exclusive.sql",
    from: "03f488dd20d7e56efc3a1a4ccc7d5d20977c9f88b821561186a902bb30535e9c",
    to: "72410c818c0c0b5bd006d29cbc7d281f6097f90ca5833690219554b81cabd4da",
    strategy: "restamp",
    reason:
      "corrective revision fixes only the cumulative cancellation count in the "
      + "legacy-overlap repair notice; the exclusion constraint and repaired "
      + "schema/data outcome are unchanged, so existing installations need only "
      + "the reviewed digest restamp.",
  },
  {
    filename: "generated/0079_budget_subsidiary.sql",
    from: "1bec7d225490c8a1fcb0b8a69dccc5b22b77d6da13447d2992a20bc044998353",
    to: "fabec3977b4b5345923a8871098ce46c183fc8bf52a9d7e8026cb4b092f99fac",
    strategy: "restamp",
    reason:
      "local/origin reconciliation: both lines published 0079 with divergent "
      + "bytes and no transition. The local revision is authoritative because it "
      + "carries the newer subsidiary-identity fix (preserve subsidiary identity "
      + "in budget cells) that supersedes the origin revision; the owner-fill and "
      + "resulting budget_lines.subsidiary_id state are equivalent before and "
      + "after, so a ledger recorded at the origin digest advances safely.",
  },
  {
    filename: "generated/0080_payment_instruction_claim_fence_bundle_guard.sql",
    from: "98c8992c32ed83463ea2709a2f4b9a929a0ce366b05a271e65f954997712c93c",
    to: "091062cfeecd8047d8eb22f21eaa8c1917b4735b4d822f294e1bfb9c8186f759",
    strategy: "restamp",
    reason:
      "local/origin reconciliation, corrected direction: both lines published "
      + "0080 with divergent bytes. The local revision advanced the file and was "
      + "then reverted to the origin bytes, which are what the tree publishes "
      + "today - so the published digest is this entry's former 'from', not its "
      + "'to'. As previously written the entry could never fire (a ledger only "
      + "advances when from matches the recorded digest AND to matches the "
      + "published one), and a ledger recorded at the local digest 98c8992c "
      + "stayed wedged. Flipped, those ledgers advance back to the published "
      + "origin identity; the installed trigger and its guard semantics are "
      + "equivalent on both sides, so only the recorded bytes move.",
  },
  {
    filename: "generated/0252_ca_eht_remuneration_opening_ytd.sql",
    from: "52c4b7e9f43fdc4fea907142bf55de7089644849d243ee6f9c4a395b22aa06aa",
    to: "e6727002bfba426eb8bbf67ccf1d380ea9191fb9b3f7592fe4686e3c98c16c20",
    strategy: "reapply",
    reason:
      "corrective revision eb5311a73 hardens the governed payroll_opening_balances "
      + "view replacement: CREATE OR REPLACE cannot reorder a drifted view's columns, "
      + "so the revision drops and recreates the view (nothing depends on it), restores "
      + "the read-role grant explicitly, and adds the five standard header SETs. A "
      + "database that recorded 52c4b7e9 already has the eht_remuneration_ytd column and "
      + "an equivalent view; re-running the current body only re-adds the column (IF NOT "
      + "EXISTS), rebuilds the identical view, and re-issues the grant. Reapply, not "
      + "restamp: the installed view definition text changed, so only executing the body "
      + "converges it.",
  },
  {
    filename: "generated/0257_provisional_cost_subsidiary.sql",
    from: "569040393f4ccd6c64186c49c9d0f7e917a78228d2aacaf5e01a22027099fc43",
    to: "ecd2626b775e72025ce26251643930f1bf676ec06fcfae4f1605d35374c734f3",
    strategy: "reapply",
    reason:
      "corrective revision b8403c9a drops the forbidden lock_timeout SET and wraps "
      + "both provisional-cost constraint adds in IF NOT EXISTS guards, so runner "
      + "retries on lock timeouts are re-runnable. The resulting schema is unchanged; "
      + "a database that recorded 56904039 already holds both constraints, so re-running "
      + "the current body is a no-op there. Reapply, not restamp: the body text changed "
      + "and only execution proves the guarded path converges.",
  },
  {
    filename: "generated/0258_payment_run_file_created_at.sql",
    from: "5f259721c26016d4642a4ae0c6c7a6d5bd4759116c0576ee7cb61240cde02393",
    to: "acb659bbcd9ac6929267c771070ec4c8f6ca8b34c6e69440ad22d14e5f662f24",
    strategy: "reapply",
    reason:
      "corrective revision af3bf4e appends the billing anchor-day columns (IF NOT "
      + "EXISTS DDL, NULL-guarded backfills, guarded check constraints) to the original "
      + "file_created_at migration. A database recorded at 5f259721 that re-runs the "
      + "current body gains the anchor-day schema idempotently; targeting the current "
      + "digest also carries the later sync-overlap append in the same run. Reapply, not "
      + "restamp: the revision adds real schema the old state lacks.",
  },
  {
    filename: "generated/0258_payment_run_file_created_at.sql",
    from: "2190304596efb06ee372ee695dcd0be042f864dac02801faeda66f49b5fd9381",
    to: "acb659bbcd9ac6929267c771070ec4c8f6ca8b34c6e69440ad22d14e5f662f24",
    strategy: "reapply",
    reason:
      "corrective revision 313d85e appends the bank_feed_connections sync_overlap_days "
      + "column (IF NOT EXISTS DDL, guarded range check; null means the 14-day default, "
      + "so no backfill) to the anchor-day revision. A database recorded at 21903045 "
      + "that re-runs the current body converges to the published schema idempotently. "
      + "Reapply, not restamp: the revision adds real schema the old state lacks.",
  },
  {
    filename: "generated/0265_filing_currency_and_ship_to_snapshot.sql",
    from: "84fe8ca15877116d6f7cb221907a13c2163a1f38f13019afa85962ec80912498",
    to: "863fb22fc97911ed8ef81a8a0808277a8069c4039b96838de94a7c8001639944",
    strategy: "reapply",
    reason:
      "corrective revision 97609eae (tax-nexus shard) appends the documents ship-to "
      + "snapshot to the filings-only 0265: ship_to_country / ship_to_region DDL (both "
      + "IF NOT EXISTS) plus an evidence-only backfill from first-line provider-quote "
      + "destinations, limited to untouched rows so a kernel stamp is never overwritten. "
      + "A database recorded at the filings-only 84fe8ca1 that re-runs the current body "
      + "gains the snapshot columns and backfill idempotently; the filings DDL is all "
      + "IF NOT EXISTS and its backfill NULL-guarded. Reapply, not restamp: the revision "
      + "adds real schema the old state lacks.",
  },
  {
    filename: "generated/0265_filing_currency_and_ship_to_snapshot.sql",
    from: "ae246367720744529f44d87887e154b7f2c28b92bcb3f3fdc6ac0d4d6f76de65",
    to: "863fb22fc97911ed8ef81a8a0808277a8069c4039b96838de94a7c8001639944",
    strategy: "reapply",
    reason:
      "corrective revision UPG-0265 (upgrade rehearsal R1): the functional_currency "
      + "backfill UPDATEs tax_filings, whose baseline tax_filing_immutable guard refuses "
      + "every UPDATE except prepared->filed, so any install holding a filing failed the "
      + "upgrade. The revision suspends that one trigger for the single NULL-guarded "
      + "statement inside the migration's transaction and asserts it is enabled again "
      + "before commit. A database recorded at ae246367 (it could only have applied with "
      + "no filings) re-runs the current body idempotently: every DDL is IF NOT EXISTS "
      + "and both backfills are NULL-guarded. Reapply, not restamp: the body changed.",
  },
  {
    filename: "generated/0296_payroll_remittance_destination_snapshot.sql",
    from: "65164ea1ba89df3dde63064a76bf931f3704ca0c8c802368247858d26d2f2c37",
    to: "126d6d8962862048241522d9862a7a9a72e3cf552f50aac3c5acbb00ba608bb7",
    strategy: "reapply",
    reason:
      "corrective revisions U1+U2+U4+PR6b+U5 (payroll-remittance shard) supersede "
      + "every earlier 0296: U1 refuses first over unparseable legacy markers, naming "
      + "each bill and field. U2 replaces the grand-total backfill with an exact "
      + "reconciliation repair (recorded party equals the marker party, lines per "
      + "liability account equal the accrual groups). U4 resolves each line's "
      + "destination pack-aware (regional key, then snapshot, then pack default, "
      + "from a frozen 0296-era map parity-pinned against the TypeScript "
      + "resolver), so legacy statutory and regional bills gain correct coverage "
      + "instead of zero. PR6b admits the frozen-destination guard for the "
      + "merge's paired amend+migration authority, so a source-asserted merge "
      + "re-points absorbed snapshots to the survivor. Reconciling bills fill "
      + "anti-joined, anything else empties to no backfill rows and is named "
      + "by notice, backfill rows for voided bills are deleted, app-recorded "
      + "rows are never rewritten. Every statement stays idempotent against "
      + "every published revision. Reapply, not restamp: the revisions add "
      + "real guards and repair semantics the old states lack.",
  },
  {
    filename: "generated/0296_payroll_remittance_destination_snapshot.sql",
    from: "5589a8b5b31dfcabd8ccd74ce4d5d6eeca95b141844b6282bfdda4b6ce45f62b",
    to: "126d6d8962862048241522d9862a7a9a72e3cf552f50aac3c5acbb00ba608bb7",
    strategy: "reapply",
    reason:
      "same U1+U2+U4+PR6b+U5 revision as the entry above, for databases that recorded "
      + "the U1-only 5589a8b5.",
  },
  {
    filename: "generated/0296_payroll_remittance_destination_snapshot.sql",
    from: "097ed6dd7492562a23147fca19d013c22da682373c17c7793b008f123ab58704",
    to: "126d6d8962862048241522d9862a7a9a72e3cf552f50aac3c5acbb00ba608bb7",
    strategy: "reapply",
    reason:
      "same U1+U2+U4+PR6b+U5 revision as the entry above, for databases that recorded "
      + "the U1+U2 097ed6dd.",
  },
  {
    filename: "generated/0296_payroll_remittance_destination_snapshot.sql",
    from: "a24896ea622d91dde33b3dd8b25e47928618723d1eb60b08a9ab9f793c063ef3",
    to: "126d6d8962862048241522d9862a7a9a72e3cf552f50aac3c5acbb00ba608bb7",
    strategy: "reapply",
    reason:
      "same U1+U2+U4+PR6b+U5 revision as the entry above, for databases that recorded "
      + "the U1+U2+U4 a24896ea.",
  },
  {
    filename: "generated/0296_payroll_remittance_destination_snapshot.sql",
    from: "96d038a431b19b806fa36dac97ebaf5e3bbbb3001e2240091ef3cf11fe67ab70",
    to: "126d6d8962862048241522d9862a7a9a72e3cf552f50aac3c5acbb00ba608bb7",
    strategy: "reapply",
    reason:
      "U5 hot-table conversion (payroll-remittance shard): the file declares "
      + "no-transaction and the runner applies it statement by statement, the "
      + "snapshot index builds CONCURRENTLY behind an INVALID-drop guard, and "
      + "the snapshot FK arrives NOT VALID with a separate VALIDATE step. "
      + "Every statement stays idempotent against the PR6b state, so reapply, "
      + "not restamp.",
  },
  {
    filename: "generated/0293_stock_count_line_subject_unique.sql",
    from: "19b0e9b674360129aec13cb3c911de38dfd1cb86f1976cca3979c28521720c11",
    to: "38eaf276d1a5f1994b06726a87d4b14d7c703c058967acf2752002368d60a099",
    strategy: "reapply",
    reason:
      "staged revision (U10) builds the duplicate-subject unique as CREATE UNIQUE "
      + "INDEX CONCURRENTLY outside the tracked transaction instead of holding the "
      + "ALTER TABLE lock for the whole build, and preserves pre-guard immutable "
      + "history (U13): lines of duplicate groups on posted or cancelled counts are "
      + "marked is_pre_guard_legacy, and the guard is a partial unique index over "
      + "unmarked rows (a constraint cannot attach a partial index, so enforcement "
      + "lives on the index under the same name). A database recorded at the old "
      + "digest re-runs the current body: the classify finds no legacy rows (the "
      + "old precheck refused them), ADD COLUMN IF NOT EXISTS gains the marker, the "
      + "guarded DROP removes the old full constraint, and the concurrent build "
      + "recreates the guard in staged partial form — converging to the "
      + "fresh-install catalog. Reapply, not restamp: the revision adds the marker "
      + "column and the partiality, which a restamp would leave behind on "
      + "old-ledger databases.",
  },
  {
    filename: "generated/0293_stock_count_line_subject_unique.sql",
    from: "307683c85d8536bcdc3838b48fb02c3630d56820100138b95371d2a75e3ad726",
    to: "38eaf276d1a5f1994b06726a87d4b14d7c703c058967acf2752002368d60a099",
    strategy: "reapply",
    reason:
      "same staged revision as the entry above, for databases that recorded the "
      + "picked-then-superseded 307683c8 (partial index, marker column, no old "
      + "constraint): the guarded DROP finds nothing and the body replays "
      + "idempotently to the same catalog.",
  },
  {
    filename: "generated/0299_stock_count_line_counted_nonnegative.sql",
    from: "65a3e4fa4abaee059777ccaf198ea996c4d5b29064971d20765626a085fd0ab8",
    to: "e0806b314fcdeee02b1393f0e96cb51656c86520d5de5cdd9dba76feea6cadb7",
    strategy: "reapply",
    reason:
      "staged revision (U11) replaces the validated CHECK with ADD CONSTRAINT ... "
      + "NOT VALID plus a guarded VALIDATE that treats an already-validated guard "
      + "as done, and preserves pre-guard immutable history (U14): posted and "
      + "cancelled negatives are marked is_pre_guard_legacy (the column is added "
      + "by 0293, which runs first) and the CHECK exempts marked rows. A database "
      + "recorded at the old digest re-runs the current body: the classify finds "
      + "no legacy rows, the guarded DROP removes the old CHECK, and the ADD plus "
      + "VALIDATE recreate it in staged exempting form — converging to the "
      + "fresh-install catalog. Reapply, not restamp: the revision adds the "
      + "exemption the old CHECK lacks.",
  },
  {
    filename: "generated/0294_dunning_delivery_state_machine.sql",
    from: "d911b36ae7fc8eace336a44b4d45f4f32d7025e48d5e4ebaedfc9a6e0de213a9",
    to: "09a6e05f50536bb6d2c36bae7193548c8f713200f06b458c0463e69727e9078d",
    strategy: "restamp",
    reason:
      "staged revision (U12) replaces the validated CHECK with a guarded DROP "
      + "plus ADD CONSTRAINT ... NOT VALID and a guarded VALIDATE that treats an "
      + "already-validated guard as done. The new CHECK is a strict superset of "
      + "the old one, so every existing row already satisfies it. A database "
      + "recorded at the old digest applied the old validated guard successfully "
      + "and holds the identical end catalog — same name, same expression, "
      + "validated — so only the digest moves. Restamp, not reapply: the "
      + "revision stages the build but changes no enforced state.",
  },
  {
    filename: "generated/0301_item_price_schedule_versioning.sql",
    from: "e829a51ac2cc235bfa00408adb33ff55ecc7ff2c6fb0261c9aed8be7c3b7d5f8",
    to: "31b3e345c6a76b900e0a2d0fc51f59cae3f65f4c81b96fbab2638f56ba6ff668",
    strategy: "restamp",
    reason:
      "staged revision (U12): the two CHECKs and the self-referential foreign "
      + "key arrive NOT VALID with guarded VALIDATEs that treat "
      + "already-validated guards as done, instead of scanning the schedule "
      + "history under the ALTER TABLE lock. Existing rows start at revision 0 "
      + "with no predecessor and no reason, so none can violate the new guards. "
      + "A database recorded at the old digest holds the identical end catalog "
      + "— same names, expressions and references, validated — so only the "
      + "digest moves. Restamp, not reapply: the revision stages the build but "
      + "changes no enforced state.",
  },
  {
    filename: "generated/0327_item_price_level_activation_history.sql",
    from: "26606980c32021dae07ba3942fbe0bf955c6c10dae5e5f5985f84b19ce4049b2",
    to: "74408c2026f5e84d304f1a1586dca7e7967222efd6cdb388f02ffd128f9552be",
    strategy: "reapply",
    reason:
      "corrective revision PRC15c: deactivating an assignment that starts "
      + "today removed no row and end-dated the window to yesterday, which "
      + "violates the customer_price_level_dates CHECK — the operator got an "
      + "opaque database error and could not revoke a mistaken same-day "
      + "assignment. The trigger now removes the never-effective row (it never "
      + "covered any date, so no pricing history is lost) and the backfill "
      + "deletes matching pre-upgrade rows instead of flooring them at a "
      + "single live day. Every statement stays idempotent against the old "
      + "migration's successful state — IF NOT EXISTS DDL, CREATE OR REPLACE "
      + "FUNCTION, conditional triggers, gap-only backfills — so reapplying "
      + "redefines the trigger and converges rows the old revision left "
      + "behind. Reapply, not restamp: the revision changes enforced trigger "
      + "behavior the old state lacks.",
  },
  {
    filename: "generated/0327_item_price_level_activation_history.sql",
    from: "26606980c32021dae07ba3942fbe0bf955c6c10dae5e5f5985f84b19ce4049b2",
    to: "683a93ba8734ba3b472ce6dbdff1fe4a7fe1477c687b70a90a837b22129f5432",
    strategy: "reapply",
    reason:
      "corrective revision (PRC15d plus the Sol residual): revoking a "
      + "future-effective assignment before it starts kept its open window "
      + "while the resolver matches windows ignoring the flag, so a dead "
      + "future window would price when its dates arrive — the trigger now "
      + "removes it audited with the before-image. A same-day revoke keeps "
      + "the row and stamps revoked_at/revoked_by instead of deleting it: "
      + "the row may already have priced intraday transactions whose "
      + "recorded price basis points at it, and removing it destroyed that "
      + "lineage; the resolver treats the row as inactive for lookups at or "
      + "after the instant, and reactivation clears the stamp. Activation "
      + "periods record opened_at/closed_at instants for same-date evidence. "
      + "Same idempotence story as the PRC15c entry: IF NOT EXISTS DDL, "
      + "ADD-COLUMN-IF-NOT-EXISTS, CREATE OR REPLACE FUNCTION, DROP + "
      + "CREATE of the widened trigger, gap-only backfills. Reapply, not "
      + "restamp: enforced trigger behavior changes. For databases still at "
      + "the original digest; databases already at the PRC15c digest use "
      + "the next entry.",
  },
  {
    filename: "generated/0327_item_price_level_activation_history.sql",
    from: "74408c2026f5e84d304f1a1586dca7e7967222efd6cdb388f02ffd128f9552be",
    to: "683a93ba8734ba3b472ce6dbdff1fe4a7fe1477c687b70a90a837b22129f5432",
    strategy: "reapply",
    reason:
      "same revision as the entry above, for databases that already "
      + "reapplied the PRC15c revision: the delta from that state is the "
      + "future-start audited removal, the same-day keep-and-stamp with "
      + "revoked_at/revoked_by (instead of PRC15c's delete), the activation "
      + "period instants, and comments; the resolver asOf/backstop change is "
      + "a query, not stored state. Re-running converges half-revocations "
      + "the PRC15c revision left behind and redefines the trigger "
      + "idempotently. Reapply, not restamp.",
  },
  {
    filename: "generated/0327_item_price_level_activation_history.sql",
    from: "b70ecb046f73f2f4310cacfaa9f45075819466e09e73a85d2902db75a65c8eab",
    to: "683a93ba8734ba3b472ce6dbdff1fe4a7fe1477c687b70a90a837b22129f5432",
    strategy: "reapply",
    reason:
      "same revision as the two entries above, for databases that applied the "
      + "interim PRC15d body (b70ecb04, briefly on local main between the PRC15d "
      + "and residual commits and applied by the coordinator's and shards' test "
      + "databases): the residual replaced that body without a transition from it, "
      + "so those databases could not reach the current digest. The delta is the "
      + "keep-and-stamp revocation (revoked_at/revoked_by) and activation instants; "
      + "every statement is idempotent. Reapply, not restamp.",
  },
  {
    filename: "generated/0334_tenant_isolation_and_posting_guards.sql",
    from: "08c69798a164afcace78fbf2b18bc196f983de7ab0d8599f62a7b8d94c99a30f",
    to: "85e22004dcc3ea50eb5225e683c7e39de5335a65d7c004f02c4e4c0a3b55e7b7",
    strategy: "restamp",
    reason:
      "comment-only header correction on an unpublished migration: the 0334 "
      + "header described posting-guard and derived-summary sections that ship "
      + "separately in 0338, so the file overclaimed its own contents. No "
      + "statement changed — the applied RLS state is byte-identical before "
      + "and after. Restamp, not reapply: replaying the file would be a no-op "
      + "by construction (every statement tolerates re-execution), and only "
      + "the recorded identity moves.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "b3738d09a836ba824febc892bac3a081cb162b9a4fafe1561edbc28a17f9a1f0",
    to: "d91d0842bd8c0741eddb06ec4e16969bc216a79f0b2fc7fa3cb5a1a85aa2024e",
    strategy: "reapply",
    reason:
      "unshipped 0338 corrective revision: posted_document_status_guard trusted a raw "
      + "openbooks.sandbox_wipe session GUC that any session can SET, reopening the "
      + "posted -> draft rewrite G4 exists to refuse; the guard now admits a wipe only "
      + "through openbooks_sandbox_wipe_allowed(org_id). A database recorded at the "
      + "G4-only (3f4e33911) body re-runs the current file: every statement is CREATE OR REPLACE / "
      + "DROP TRIGGER IF EXISTS + CREATE TRIGGER, so reapply converges idempotently.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "3d46141b8540f29d28d1905acad92a0d3478c6b0b7297e85e2b3654783a3ffab",
    to: "d91d0842bd8c0741eddb06ec4e16969bc216a79f0b2fc7fa3cb5a1a85aa2024e",
    strategy: "reapply",
    reason:
      "unshipped 0338 corrective revision: posted_document_status_guard trusted a raw "
      + "openbooks.sandbox_wipe session GUC that any session can SET, reopening the "
      + "posted -> draft rewrite G4 exists to refuse; the guard now admits a wipe only "
      + "through openbooks_sandbox_wipe_allowed(org_id). A database recorded at the "
      + "G4+G5 (673890cb9) body re-runs the current file: every statement is CREATE OR REPLACE / "
      + "DROP TRIGGER IF EXISTS + CREATE TRIGGER, so reapply converges idempotently.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "8a941cc3890f3159392c37dd7c94848d2fa3b7b60df9bf7684cc075fa6fa50d4",
    to: "d91d0842bd8c0741eddb06ec4e16969bc216a79f0b2fc7fa3cb5a1a85aa2024e",
    strategy: "reapply",
    reason:
      "unshipped 0338 gains its G11 section (the monthly GL aggregate follows book "
      + "rehomes under amend) after the raw-wipe-GUC correction 06a5b82a7. Every 0338 "
      + "statement is CREATE OR REPLACE / DROP ... IF EXISTS + CREATE, so a database "
      + "recorded at the corrected body re-runs the current file idempotently. Each "
      + "later 0338 revision re-points every earlier digest here to its own.",
  },
  {
    filename: "generated/0257_provisional_cost_subsidiary.sql",
    from: "ecd2626b775e72025ce26251643930f1bf676ec06fcfae4f1605d35374c734f3",
    to: "67256fd8450973ff88a2592c4d0bb834547499da41e9410ff96a43a3eb1583fa",
    strategy: "restamp",
    reason:
      "staged revision declares no-transaction, builds both lookup indexes "
      + "CONCURRENTLY behind an INVALID-drop guard, and arrives both foreign "
      + "keys NOT VALID with separate guarded VALIDATEs, instead of scanning "
      + "inventory_provisional_costs under write-blocking locks. An install "
      + "recorded at the old digest holds the identical end catalog — same "
      + "index names and definitions, same foreign-key names and references, "
      + "validated — so only the digest moves. Restamp, not reapply: the "
      + "revision stages the build but changes no enforced state.",
    filename: "generated/0328_obligation_legacy_reconciliation.sql",
    from: "1c526dc25a2edb8aa2ec2da422bcf11b6eef00cba2021994359e5e512a3a0d0f",
    to: "4ef841e91a1c3ec9c0609c93a677f562b0e5b44c601ad549a553b4efb8715703",
    strategy: "restamp",
    reason:
      "staged revision replaces the validated CHECK with a guarded ADD "
      + "CONSTRAINT ... NOT VALID plus a guarded VALIDATE that treats an "
      + "already-validated guard as done, instead of scanning every "
      + "performance_obligations row under the ALTER TABLE lock. The three "
      + "columns are added by this same migration, so every pre-existing row "
      + "trivially holds all three NULLs and satisfies the shape. A database "
      + "recorded at the old digest holds the identical end catalog — same "
      + "name, same expression, validated — so only the digest moves. "
      + "Restamp, not reapply: the revision stages the build but changes no "
      + "enforced state.",
  },
];

async function executeTrackedMigration(
  filename: string,
  content: string,
  digest: string,
  recordedDigest?: string,
): Promise<void> {
  // Long DDL rides the timeout-free maintenance pool: the request pool's 120s
  // client query_timeout aborts the whole-schema baseline on a slow host.
  //
  // Lock discipline: every migration used to run with `SET lock_timeout = 0`
  // in its own body, each in one transaction while the old stack keeps
  // serving traffic — an ALTER TABLE queued behind a long report query waits
  // forever, and every later query on that table queues behind the
  // migration. Published files are immutable, so they cannot be rewritten;
  // the runner strips their file-level lock_timeout statements instead and
  // imposes its own bound per attempt (SET LOCAL inside the transaction, a
  // session SET around a no-transaction file). On an empty database — a
  // fresh install — there is no concurrent traffic to contend with, so the
  // old unbounded files were harmless there; with the strip they run under
  // the same bound as everything else, so fresh installs need no special
  // case. A lock_timeout firing (SQLSTATE 55P03) retries the whole attempt
  // with backoff; anything else fails the deploy at once, because retrying
  // a half-applied non-idempotent migration would run its body twice.
  const started = Date.now();
  const lock = migrationLockConfig(env);
  const body = sanitizeMigrationContent(content);
  const transactional = !migrationRunsWithoutTransaction(content);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const client = await connectMigrationClient();
    try {
      // No-transaction files (CREATE INDEX CONCURRENTLY and friends) run
      // statement by statement with no BEGIN/COMMIT — the contract is
      // strict (every statement idempotent, INVALID indexes dropped up
      // front) because a failure mid-file leaves earlier statements
      // committed and the retry replays the whole body.
      await executeMigrationAttempt(client, {
        filename,
        body,
        transactional,
        lock,
        digest,
        recordedDigest,
        executeBody:
          filename === ORDER_QUANTITY_PROGRESS_MIGRATION_FILENAME
            ? (migrationClient, migrationBody) =>
                executeOrderQuantityProgressMigration(migrationClient, migrationBody, digest)
            : executeMigrationBody,
      });
      return;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      if (isLockNotAvailable(err) && attempt < lock.maxAttempts) {
        const backoffMs = migrationRetryDelayMs(lock, attempt);
        console.log(
          `[bootstrap] ${filename} could not acquire a lock on attempt `
            + `${attempt}/${lock.maxAttempts} (lock_timeout ${lock.lockTimeoutMs}ms); `
            + `retrying in ${backoffMs}ms`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw new Error(describeBootstrapMigrationFailure(filename, err, Date.now() - started));
    } finally {
      await releaseMigrationClient(client);
    }
  }
}

async function applyTracked(
  label: string,
  filename: string,
  content: string,
): Promise<boolean> {
  const digest = sha256(content);
  const seen = (await db.execute<{ sha256: string }>(sql`
    select sha256 from public._applied_migrations where filename = ${filename}
  `));
  const recordedRow = seen.rows[0];
  if (recordedRow) {
    const recorded = recordedRow.sha256;
    if (recorded !== digest) {
      const transition = APPROVED_MIGRATION_TRANSITIONS.find(
        (entry) =>
          entry.filename === filename
          && entry.from === recorded
          && entry.to === digest,
      );
      if (!transition) {
        throw new Error(
          `[bootstrap] ${filename} changed after it was applied; published migrations are immutable`,
        );
      }
      console.log(
        `[bootstrap] ${filename} has an approved ${transition.strategy} transition (`
        + `${recorded.slice(0, 12)} -> ${digest.slice(0, 12)})`,
      );
      console.log(`[bootstrap]   ${transition.reason}`);
      if (transition.strategy === "reapply") {
        await executeTrackedMigration(filename, content, digest, recorded);
        return true;
      }
      await db.execute(sql`
        update public._applied_migrations
           set sha256 = ${digest}
         where filename = ${filename} and sha256 = ${recorded}
      `);
      return false;
    }
    return false;
  }
  console.log(`[bootstrap] applying ${label}: ${filename}`);
  await executeTrackedMigration(filename, content, digest);
  return true;
}

type PendingMigrationItem = {
  file: string;
  filename: string;
  ordinal: string;
  content: string;
};

type DeferredPreflight = {
  file: string;
  filename: string;
  ordinal: string;
  sql: string;
};

type PendingPreflightReport = {
  findings: PreflightFinding[];
  deferred: DeferredPreflight[];
  noPreflight: { migration: string; reason: string }[];
  missingDecisions: string[];
  evaluated: string[];
  leastPrivilege: boolean;
};

async function appliedMigrationsTableExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "select to_regclass('public._applied_migrations') is not null as exists",
  );
  return result.rows[0]!.exists;
}

async function readAppliedMigrationFilenames(): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>(
    "select filename from public._applied_migrations",
  );
  return new Set(result.rows.map((row) => row.filename));
}

function pendingMigrationItems(
  generated: readonly string[],
  applied: ReadonlySet<string>,
): PendingMigrationItem[] {
  const pending: PendingMigrationItem[] = [];
  for (const f of generated) {
    const filename = `generated/${f}`;
    if (applied.has(filename)) continue;
    if ((preflightOrdinalOf(f) ?? -1) < PREFLIGHT_MIN_ORDINAL) continue;
    pending.push({
      file: f,
      filename,
      ordinal: f.slice(0, 4),
      content: readFileSync(join(migrationsDir, "generated", f), "utf8"),
    });
  }
  return pending;
}

function listPreflightEntries(): Set<string> {
  try {
    return new Set(readdirSync(preflightDirFor(repoRoot)));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return new Set();
    throw error;
  }
}

/**
 * Run every pending migration's preflight in ordinal order, each in
 * BEGIN READ ONLY with bypass RLS and a bounded statement_timeout, then
 * ROLLBACK. A preflight that needs an object an earlier PENDING migration
 * creates is deferred to apply time; anything else missing is a real error.
 */
async function evaluatePendingMigrations(
  pending: readonly PendingMigrationItem[],
  options: { leastPrivilegeRole?: string },
): Promise<PendingPreflightReport> {
  const report: PendingPreflightReport = {
    findings: [],
    deferred: [],
    noPreflight: [],
    missingDecisions: [],
    evaluated: [],
    leastPrivilege: true,
  };
  if (pending.length === 0) return report;
  const entries = listPreflightEntries();
  const timeoutMs = preflightStatementTimeoutMs(env);
  const preflightDir = preflightDirFor(repoRoot);
  const client = await connectMigrationClient();
  try {
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index]!;
      const decision = preflightDecisionFor(item.file, entries);
      if (decision.kind === "missing") {
        report.missingDecisions.push(item.filename);
        console.log(
          `[bootstrap] migration preflight: ${item.filename} has no decision file; `
            + `add schema/migrations/preflight/${item.file.replace(/\.sql$/, ".sql")} or .none`,
        );
        continue;
      }
      if (decision.kind === "none") {
        report.noPreflight.push({
          migration: item.filename,
          reason: readNoneReason(preflightDir, decision.filename),
        });
        continue;
      }
      const sqlText = readPreflightSql(preflightDir, decision.filename);
      const earlierContents = pending.slice(0, index).map((earlier) => earlier.content);
      let evaluation;
      try {
        evaluation = await evaluatePreflight(client, item.filename, item.ordinal, sqlText, {
          statementTimeoutMs: timeoutMs,
          leastPrivilegeRole: options.leastPrivilegeRole,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[bootstrap] migration preflight ${item.filename} failed to evaluate: ${message}`,
        );
      }
      report.leastPrivilege = report.leastPrivilege && evaluation.leastPrivilege;
      if (evaluation.status === "deferred") {
        if (!earlierPendingCreatesObject(evaluation.reason, earlierContents)) {
          throw new Error(
            `[bootstrap] migration preflight ${item.filename} cannot evaluate: ${evaluation.reason}; `
              + `no earlier pending migration creates that object, so this is not a deferral — fix the preflight or the schema`,
          );
        }
        report.deferred.push({ file: item.file, filename: item.filename, ordinal: item.ordinal, sql: sqlText });
        console.log(
          `[bootstrap] migration preflight ${item.filename} is deferred: it needs an object an earlier `
            + `pending migration creates, so it runs at apply time (${evaluation.reason})`,
        );
        continue;
      }
      report.evaluated.push(item.filename);
      report.findings.push(...evaluation.findings);
    }
  } finally {
    await releaseMigrationClient(client);
  }
  return report;
}

function printPreflightFindings(findings: readonly PreflightFinding[]): void {
  for (const finding of findings) {
    console.log(`[bootstrap] migration preflight finding: ${formatFinding(finding)}`);
  }
}

/**
 * A pending migration with no decision file upgrades blind: neither a
 * preflight nor a reviewed reason covers it. Refuse by name listing every
 * gap, so one run shows the whole deficit instead of one file at a time.
 */
function throwOnMissingDecisions(report: PendingPreflightReport): void {
  if (report.missingDecisions.length === 0) return;
  const missing = [...report.missingDecisions].sort();
  throw new Error(
    `[bootstrap] ${missing.length} pending migration(s) have no preflight decision file: ${missing.join(", ")}. `
      + `Add schema/migrations/preflight/<basename>.sql or <basename>.none for each; `
      + `see docs/operations/upgrades.md#migration-preflights. No migration was applied.`,
  );
}

/**
 * The pre-apply gate: every evaluable pending preflight has run BEFORE the
 * first migration. Any refuse finding stops bootstrap here, with every
 * finding printed and no migration applied.
 */
async function runPreflightGate(pending: readonly PendingMigrationItem[]): Promise<DeferredPreflight[]> {
  if (pending.length === 0) {
    console.log("[bootstrap] no pending migrations: nothing to preflight");
    return [];
  }
  const report = await evaluatePendingMigrations(pending, {});
  printPreflightFindings(report.findings);
  throwOnMissingDecisions(report);
  const refusals = report.findings.filter((finding) => finding.severity === "refuse");
  if (refusals.length > 0) {
    const codes = [...new Set(refusals.map((finding) => finding.code))].sort().join(", ");
    throw new Error(
      `[bootstrap] migration preflights refuse this upgrade (${codes}). Every finding above names its remedy; `
        + `resolve them, then re-run bootstrap. No migration was applied.`,
    );
  }
  if (report.findings.length > 0) {
    console.log("[bootstrap] migration preflights report only notices; upgrade continues");
  } else {
    console.log(
      `[bootstrap] migration preflights clean for ${pending.length} pending migration(s)`,
    );
  }
  return report.deferred;
}

/**
 * A deferred preflight runs immediately before its own migration, when the
 * earlier migrations it needs have applied. A refusal here stops the upgrade
 * naming exactly which migrations already applied in this run.
 */
async function runDeferredPreflight(
  deferred: DeferredPreflight,
  appliedThisRun: readonly string[],
): Promise<void> {
  const client = await connectMigrationClient();
  try {
    const evaluation = await evaluatePreflight(client, deferred.filename, deferred.ordinal, deferred.sql, {
      statementTimeoutMs: preflightStatementTimeoutMs(env),
    });
    if (evaluation.status === "deferred") {
      throw new Error(
        `[bootstrap] migration preflight ${deferred.filename} still cannot see its objects at apply time `
          + `(${evaluation.reason}); the earlier migration that should create them did not`,
      );
    }
    printPreflightFindings(evaluation.findings);
    const refusals = evaluation.findings.filter((finding) => finding.severity === "refuse");
    if (refusals.length === 0) return;
    const codes = [...new Set(refusals.map((finding) => finding.code))].sort().join(", ");
    const applied = appliedThisRun.length > 0 ? appliedThisRun.join(", ") : "(none)";
    throw new Error(
      `[bootstrap] migration preflight ${deferred.filename} refuses this upgrade (${codes}). `
        + `Migrations already applied in this run: ${applied}. Every finding above names its remedy; `
        + `resolve them, then re-run bootstrap.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[bootstrap] migration preflight")) throw error;
    throw new Error(
      `[bootstrap] migration preflight ${deferred.filename} failed to evaluate at apply time: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await releaseMigrationClient(client);
  }
}

/**
 * Read-only upgrade check: list the pending migrations, run the evaluable
 * preflights, and print the findings. Strictly read-only — no ledger table
 * creation, no role or seed work, no RLS refresh, and no advisory lock that
 * could block a live app. Every statement is a SELECT (plus transaction
 * control), so this also runs under the SELECT-only openbooks_read role;
 * when the connecting login cannot assume it, the check says so and runs
 * as the connecting role instead. Exits 1 on any refuse finding, else 0.
 *
 * Usage: node --import tsx scripts/bootstrap.ts --check [--json]
 */
async function runUpgradeCheckMain(json: boolean): Promise<number> {
  const generated = generatedMigrationFiles();
  assertMigrationFilenameTransitionTargets(generated);
  const ledgerPreexisted = await appliedMigrationsTableExists();
  const result = {
    freshInstall: !ledgerPreexisted,
    pending: [] as string[],
    noPreflight: [] as { migration: string; reason: string }[],
    missingDecisions: [] as string[],
    evaluated: [] as string[],
    deferred: [] as { migration: string; reason: string }[],
    leastPrivilege: false,
    findings: [] as PreflightFinding[],
  };
  const emit = (): void => {
    if (json) {
      // One line: the rehearsal reads the last `{`-leading line as the result.
      console.log(JSON.stringify(result));
      return;
    }
    console.log(`[bootstrap] upgrade check: ${result.pending.length} pending migration(s)`);
    for (const filename of result.pending) console.log(`[bootstrap]   pending: ${filename}`);
    for (const entry of result.noPreflight) {
      console.log(`[bootstrap]   no preflight: ${entry.migration} — ${entry.reason}`);
    }
    for (const filename of result.missingDecisions) {
      console.log(
        `[bootstrap]   no decision file yet: ${filename} (add its .sql or .none under schema/migrations/preflight/)`,
      );
    }
    printPreflightFindings(result.findings);
    for (const entry of result.deferred) {
      console.log(`[bootstrap]   deferred to apply time: ${entry.migration} (${entry.reason})`);
    }
    if (result.evaluated.length > 0 && !result.leastPrivilege) {
      console.log(
        "[bootstrap] upgrade check ran as the connecting role because SET LOCAL ROLE openbooks_read was refused; "
          + "grant the check login membership in openbooks_read to prove least privilege",
      );
    }
  };
  if (!ledgerPreexisted) {
    emit();
    if (!json) {
      console.log("[bootstrap] upgrade check: no _applied_migrations table (fresh install): nothing to preflight");
    }
    return 0;
  }
  const applied = await readAppliedMigrationFilenames();
  const pending = pendingMigrationItems(generated, applied);
  result.pending = pending.map((item) => item.filename);
  if (pending.length === 0) {
    emit();
    return 0;
  }
  const report = await evaluatePendingMigrations(pending, { leastPrivilegeRole: "openbooks_read" });
  result.noPreflight = report.noPreflight;
  result.missingDecisions = report.missingDecisions;
  result.evaluated = report.evaluated;
  result.deferred = report.deferred.map((deferred) => ({
    migration: deferred.filename,
    reason: "evaluated at apply time",
  }));
  const ranAnyCheck = report.evaluated.length + report.deferred.length > 0;
  result.leastPrivilege = report.leastPrivilege && ranAnyCheck;
  result.findings = report.findings;
  emit();
  throwOnMissingDecisions(report);
  const refusals = result.findings.filter((finding) => finding.severity === "refuse");
  if (refusals.length > 0) {
    if (!json) {
      console.log(
        `[bootstrap] upgrade check refused: ${refusals.length} refuse finding(s); resolve each remedy above, then re-run`,
      );
    }
    return 1;
  }
  if (!json) console.log("[bootstrap] upgrade check: no refuse findings");
  return 0;
}

async function migrate(): Promise<void> {
  const generated = generatedMigrationFiles();
  assertMigrationFilenameTransitionTargets(generated);
  const ledgerPreexisted = await appliedMigrationsTableExists();
  await db.execute(sql`
    create table if not exists public._applied_migrations (
      filename text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )
  `);
  await convergeMigrationFilenames();

  const applied = await readAppliedMigrationFilenames();
  const pending = pendingMigrationItems(generated, applied);
  let deferred: DeferredPreflight[] = [];
  if (!ledgerPreexisted) {
    console.log("[bootstrap] fresh install: no _applied_migrations table, nothing to preflight");
  } else {
    deferred = await runPreflightGate(pending);
  }

  const appliedThisRun: string[] = [];
  for (const f of generated) {
    const filename = `generated/${f}`;
    const content = readFileSync(join(migrationsDir, "generated", f), "utf8");
    const deferredPreflight = deferred.find((candidate) => candidate.filename === filename);
    if (deferredPreflight) await runDeferredPreflight(deferredPreflight, appliedThisRun);
    if (await applyTracked("migration", filename, content)) appliedThisRun.push(filename);
  }
  if (await isPaymentLinkSealApplicable()) {
    await sealLegacyPaymentLinkTokens();
  } else {
    console.log(
      "[bootstrap] skipping payment-link at-rest seal: 0251 is not applied to this schema",
    );
  }
  await applyRowLevelSecurity();
}

/**
 * The at-rest seal is the second half of 0251: it must run only where 0251
 * ran. The ledger is checked first as a matter of principle — but the ledger
 * alone can lie, because migration-replay fixtures fake _applied_migrations
 * on historical schemas (the 0064 suite holds a pre-0064 catalog with the
 * full tail marked applied). The column check is the structural guard that
 * saves those fixtures from a 42703 on the seal's SELECT.
 */
const PAYMENT_LINK_SEAL_MIGRATION = "generated/0251_payment_link_token_at_rest.sql";

async function isPaymentLinkSealApplicable(): Promise<boolean> {
  const ledger = await pool.query("select 1 from _applied_migrations where filename = $1", [
    PAYMENT_LINK_SEAL_MIGRATION,
  ]);
  if (ledger.rows.length === 0) return false;
  const columns = await pool.query<{ n: number }>(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'payment_links'
        and column_name in ('token_hash', 'token_sealed')`,
  );
  return columns.rows[0]?.n === 2;
}

/**
 * 0251 stores the pay-link lookup hash and display seal, but the seal half
 * cannot run in SQL because the data key never enters a migration. This
 * step, in the same bootstrap invocation that applies 0251, seals AND hashes
 * each hash-less row (including rows written by code still serving during a
 * rolling deploy) and heals rows an older bootstrap sealed without hashing,
 * then NULLs the plaintext column, so no window exists where a link is
 * undisplayable, unresolvable, or a raw secret persists. Idempotent: rows
 * already carrying a hash are untouched.
 *
 * Implemented in engine/src/payments/payment-link-seal.ts so the hash
 * encoding stays byte-identical to the engine lookup by construction:
 * sealing a row without hashing it orphans the link, because the engine
 * resolves by hash only.
 */
/**
 * Install and verify the tenant-isolation policies.
 *
 * `environments.sql` creates the `org_isolation` policy for every base table
 * carrying `org_id`, so its job is to cover tables that did not exist when it
 * last ran. The file digest plus a live catalog drift check provide both
 * properties we need: changed policy code and newly added/unprotected tables
 * trigger a refresh, while an ordinary container restart performs no
 * AccessExclusive table-lock sweep.
 */
async function applyRowLevelSecurity(): Promise<void> {
  const file = join(migrationsDir, "environments.sql");
  const content = readFileSync(file, "utf8");
  const digest = sha256(content);
  const state = (await db.execute<{
      applied_digest: string | null;
      catalog_drift: boolean;
    }>(sql`
    select
      (select sha256
         from public._applied_migrations
        where filename = 'environments.sql') as applied_digest,
      exists (
        select 1
          from pg_class relation
          join pg_namespace namespace_row
            on namespace_row.oid = relation.relnamespace
         where namespace_row.nspname = 'public'
           and relation.relkind = 'r'
           and exists (
             select 1
               from information_schema.columns column_row
              where column_row.table_schema = 'public'
                and column_row.table_name = relation.relname
                and column_row.column_name = 'org_id'
           )
           and relation.relname not in ('sandboxes', 'user_org_access')
           and (
             not relation.relrowsecurity
             or not relation.relforcerowsecurity
             or not exists (
               select 1
                 from pg_policy policy
                where policy.polrelid = relation.oid
                  and policy.polname = 'org_isolation'
                  and obj_description(policy.oid, 'pg_policy')
                    = 'openbooks:org_isolation:v1'
             )
           )
      )
      or exists (
        select 1
          from pg_constraint
         where contype = 'f'
           and connamespace = 'public'::regnamespace
           and not condeferrable
      )
      or exists (
        select 1
          from pg_class relation
          join pg_namespace namespace_row
            on namespace_row.oid = relation.relnamespace
         where namespace_row.nspname = 'public'
           and relation.relname = 'sandboxes'
           and (
             not relation.relrowsecurity
             or not relation.relforcerowsecurity
             or not exists (
               select 1
                 from pg_policy policy
                where policy.polrelid = relation.oid
                  and policy.polname = 'sandbox_isolation'
                  and obj_description(policy.oid, 'pg_policy')
                    = 'openbooks:sandbox_isolation:v1'
             )
           )
      ) as catalog_drift
  `));
  const policyState = state.rows[0]!;
  if (policyState.applied_digest !== digest || policyState.catalog_drift) {
    console.log("[bootstrap] refreshing row-level security catalog");
    // Long DDL like the migrations above: no 120s client cap. Previously this
    // failure surfaced raw, so a client-side "Query read timeout" reached the
    // operator with neither cause nor remedy.
    const started = Date.now();
    const rlsClient = await connectMigrationClient();
    try {
      await rlsClient.query(content);
    } catch (err) {
      throw new Error(
        describeBootstrapMigrationFailure("environments.sql", err, Date.now() - started),
      );
    } finally {
      await releaseMigrationClient(rlsClient);
    }
    await db.execute(sql`
      insert into public._applied_migrations (filename, sha256)
      values ('environments.sql', ${digest})
      on conflict (filename) do update
        set sha256 = excluded.sha256,
            applied_at = now()
    `);
  }
  // Three conditions, not one. ENABLE alone is not isolation: without FORCE
  // the table OWNER is exempt, and the owning role is what CI and several
  // tooling paths connect as -- so an unprotected table looks protected in
  // every test. And a table with RLS on but no policy denies everyone, which
  // is a different failure that also must not reach a booting app.
  const unprotected = (await db.execute<{ table_name: string; reason: string }>(sql`
    select c.relname as table_name,
           case
             when not c.relrowsecurity then 'row-level security not enabled'
             when not c.relforcerowsecurity then 'FORCE not set (table owner would bypass)'
             else 'no policy defined'
           end as reason
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and exists (
         select 1 from information_schema.columns col
          where col.table_schema = 'public'
            and col.table_name = c.relname
            and col.column_name = 'org_id')
       and (
         not c.relrowsecurity
         or not c.relforcerowsecurity
         or not exists (
           select 1 from pg_policies p
            where p.schemaname = 'public' and p.tablename = c.relname)
       )
  `));
  // Fail loudly rather than booting an app whose tenant isolation has a hole.
  if (unprotected.rows.length > 0) {
    throw new Error(
      `row-level security incomplete on: ${unprotected.rows.map((r) => `${r.table_name} (${r.reason})`).join(", ")}`,
    );
  }
  console.log(
    "[bootstrap] row-level security verified on every org-scoped table",
  );
}

// Create the runtime database role (and reassert its safe posture) if it does
// not yet exist. This must run BEFORE migrations are applied: forward
// migrations may reference the runtime role directly (e.g. an RLS policy
// targeted `TO <runtime role>`), and PostgreSQL requires the role to exist at
// DDL time. Mirrors the openbooks_read pre-creation below migrate because
// migrations also grant privileges to those roles. Idempotent — safe to call
// again after migrate to grant access to newly created relations.
async function ensureRuntimeRoleExists(
  config: RuntimeDatabaseConfig,
): Promise<void> {
  const role = await quoted(config.roleName, "identifier");
  const password = await quoted(config.password, "literal");
  const existing = await pool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_roles where rolname = $1)",
    [config.roleName],
  );
  if (!existing.rows[0]!.exists) {
    await pool.query(`create role ${role} login password ${password}`);
  }
  // Reassert every prohibited cluster privilege on every deployment. A role
  // that was accidentally elevated must be made safe before traffic starts.
  try {
    await pool.query(
      `alter role ${role} login inherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password ${password}`,
    );
  } catch (err) {
    // A re-run over the transferred test login runs without role privileges
    // (only a superuser or CREATEROLE may alter roles, and the transferred
    // login is neither). Converge instead of enforcing — but a drifted posture
    // still fails loudly. Password rotation likewise requires a privileged run.
    if ((err as { code?: string }).code !== "42501") throw err;
    const posture = await pool.query<{ safe: boolean }>(
      `select (rolcanlogin and rolinherit and not rolsuper and not rolbypassrls
                 and not rolcreatedb and not rolcreaterole and not rolreplication) as safe
         from pg_roles where rolname = $1`,
      [config.roleName],
    );
    if (!posture.rows[0]?.safe) {
      throw new Error(
        `[bootstrap] cannot enforce safe posture on role ${config.roleName} without privilege; re-run as a superuser`,
      );
    }
    console.log(
      `[bootstrap] runtime role ${config.roleName} posture already safe; not re-enforced without privilege (password rotation needs a privileged run)`,
    );
  }
}

async function ensureRuntimeDatabaseRole(
  config: RuntimeDatabaseConfig,
  precreated = false,
): Promise<void> {
  const role = await quoted(config.roleName, "identifier");
  const databaseResult = await pool.query<{ database_name: string }>(
    "select current_database() as database_name",
  );
  const database = await quoted(databaseResult.rows[0]!.database_name, "identifier");
  if (!precreated) {
    await ensureRuntimeRoleExists(config);
    await pool.query(`grant connect, temporary on database ${database} to ${role}`);
  }
  await pool.query(`grant usage on schema public to ${role}`);
  await pool.query(
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
  );
  await pool.query(
    `grant usage, select, update on all sequences in schema public to ${role}`,
  );
  // Function execution is inherited only from deliberately retained PUBLIC
  // grants. Never blanket-grant the runtime role: the public schema also holds
  // tightly controlled SECURITY DEFINER maintenance functions. The revoke is
  // issued per function, skipping owner-held entries: after the ownership
  // transfer the runtime role owns these functions, and a blanket revoke
  // would strip its own entry, collapsing the ACL to explicitly empty —
  // which denies EXECUTE even to the owner.
  await revokeRuntimeFunctionExecute(pool, config.roleName);
  // Retain the automatic mode's catalog-refresh grant for legacy constrained
  // owners and migration-replay tooling. In host-managed mode, only the
  // separate migration owner needs this maintenance function.
  if (!precreated) {
    await pool.query(
      `grant execute on function public.openbooks_refresh_query_catalog() to ${role}`,
    );
  }
  // The application needs set_config to establish tenant identity. Hosted
  // preflight verifies EXECUTE without administering pg_catalog ACLs. In
  // automatic mode, a transferred test owner may only verify an existing
  // grant (including PostgreSQL's default PUBLIC grant).
  if (!precreated) {
    try {
      await pool.query(
        `grant execute on function pg_catalog.set_config(text, text, boolean) to ${role}`,
      );
    } catch (err) {
      if ((err as { code?: string }).code !== "42501") throw err;
      const granted = await pool.query<{ ok: boolean }>(
        `select has_function_privilege($1, 'pg_catalog.set_config(text, text, boolean)', 'EXECUTE') as ok`,
        [config.roleName],
      );
      if (!granted.rows[0]?.ok) throw err;
    }
  }
  await pool.query(
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${role}`,
  );
  await pool.query(
    `alter default privileges in schema public grant usage, select, update on sequences to ${role}`,
  );
  console.log(
    `[bootstrap] runtime database role ${config.roleName} constrained and granted application privileges`,
  );
}

async function verifyRuntimeDatabaseRole(
  config: RuntimeDatabaseConfig,
  orgId: string,
): Promise<void> {
  const runtimePool = new pg.Pool({
    connectionString: config.connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const client = await runtimePool.connect();
    try {
      const role = await client.query<{
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        unsafeRoles: string[];
      }>(`select current_user,
                 role_row.rolsuper,
                 role_row.rolbypassrls,
                 role_row.rolcreatedb,
                 role_row.rolcreaterole,
                 role_row.rolreplication,
                 array(
                   select assumable.rolname
                     from pg_roles assumable
                    where assumable.rolname <> current_user
                      and pg_has_role(current_user, assumable.oid, 'MEMBER')
                      and (
                        assumable.rolsuper
                        or assumable.rolbypassrls
                        or assumable.rolcreatedb
                        or assumable.rolcreaterole
                        or assumable.rolreplication
                        or assumable.rolname in (
                          'pg_read_server_files',
                          'pg_write_server_files',
                          'pg_execute_server_program'
                        )
                      )
                    order by assumable.rolname
                 )::text[] as "unsafeRoles"
            from pg_roles role_row
           where role_row.rolname = current_user`);
      const posture = role.rows[0];
      if (
        !posture ||
        posture.current_user !== config.roleName ||
        posture.rolsuper ||
        posture.rolbypassrls ||
        posture.rolcreatedb ||
        posture.rolcreaterole ||
        posture.rolreplication ||
        posture.unsafeRoles.length > 0
      ) {
        throw new Error(
          `unsafe runtime database role: ${JSON.stringify(posture ?? null)}`,
        );
      }

      await client.query(
        "select set_config('app.current_org', '', false), set_config('app.bypass_rls', 'off', false)",
      );
      const denied = await client.query<{ count: string }>("select count(*) from orgs");
      if (denied.rows[0]?.count !== "0") {
        throw new Error(
          `RLS fail-closed proof failed: unscoped runtime role saw ${denied.rows[0]?.count ?? "unknown"} organizations`,
        );
      }

      await client.query(
        "select set_config('app.current_org', $1, false), set_config('app.bypass_rls', 'off', false)",
        [orgId],
      );
      const allowed = await client.query<{ id: string }>(
        "select id from orgs where id = $1",
        [orgId],
      );
      if (allowed.rows.length !== 1) {
        throw new Error("RLS tenant proof failed: runtime role could not read its selected organization");
      }
      // Exercise the real definer/temporary-context boundary from the runtime
      // login. Checking membership from the migration connection misses both
      // unusable SET grants and a definer owner unable to read runtime context.
      await client.query("create temporary table openbooks_query_context (org_id uuid not null)");
      await client.query("insert into pg_temp.openbooks_query_context values ($1)", [orgId]);
      try {
        await client.query("begin transaction read only");
        await client.query("set local role openbooks_read");
        const context = await client.query<{ org: string }>("select public.openbooks_query_org_id() as org");
        if (context.rows[0]?.org !== orgId) throw new Error("governed query context did not resolve its organization");
        await client.query("select id from openbooks_query.accounting_books limit 1");
      } catch (error) {
        throw new Error("[bootstrap] runtime governed-query verification failed; verify the read-role SET grant and migration-owner inheritance of the runtime role in docs/operations/communal-postgres.md", { cause: error });
      } finally {
        await client.query("rollback");
      }
      console.log(
        `[bootstrap] runtime database role ${config.roleName} verified: NOSUPERUSER, NOBYPASSRLS, fail-closed RLS`,
      );
    } finally {
      client.release();
    }
  } finally {
    await runtimePool.end();
  }
}

// Test-database ownership transfer (CI/testdb provisioning only — refused in
// production). CI service containers log in as the initdb bootstrap superuser,
// and PostgreSQL exempts superusers from every RLS policy unconditionally
// (FORCE ROW LEVEL SECURITY constrains owners, never superusers; and PG16 even
// refuses to desuperuser the bootstrap login). So a test login that IS the
// bootstrap user can never be RLS-subject — and every isolation assertion
// through the app pool is vacuous there. The uniform target posture is a
// CONSTRAINED OWNER (exactly what long-lived installs already run as): after
// the privileged steps (extensions, roles, migrations) the executor hands
// every app-schema object plus database and schema ownership to the
// constrained runtime role, so the test login owns every object it must DDL
// while its sessions stay fully RLS-subject under FORCE.
//
// The loop is scoped to this database's two app schemas (a cluster-wide
// REASSIGN OWNED would also be complete, but it refuses outright when the
// bootstrap login owns system-required objects — always true via the template
// databases' boilerplate — so it cannot serve here). The explicit opt-in
// variable plus the production refusal below are the interlocks: never set it
// on a shared or production database.
async function transferTestOwnershipToRuntimeRole(
  config: RuntimeDatabaseConfig,
): Promise<void> {
  if (env.OPENBOOKS_TEST_OWNERSHIP_TRANSFER !== "1") return;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "[bootstrap] OPENBOOKS_TEST_OWNERSHIP_TRANSFER is refused in production",
    );
  }
  const loginResult = await pool.query<{ login: string }>(
    "select current_user as login",
  );
  const login = loginResult.rows[0]!.login;
  if (login === config.roleName) return;
  const superResult = await pool.query<{ superuser: boolean }>(
    "select rolsuper as superuser from pg_roles where rolname = current_user",
  );
  if (!superResult.rows[0]?.superuser) {
    // A re-run over the test login (e.g. local bootstrap after the template
    // transferred) cannot reassign anything; converge instead of enforcing and
    // fail loudly with instructions when the posture drifted.
    await verifyTestOwnership(config);
    console.log(
      `[bootstrap] ownership transfer skipped without privilege; runtime role ${config.roleName} already owns the RLS nexus`,
    );
    return;
  }
  // Scoped, catalog-driven ownership loop over THIS database only. REASSIGN
  // OWNED would be complete by construction but it is cluster-wide and refuses
  // outright when the bootstrap login owns system-required objects (it always
  // does: the template databases' boilerplate), so it cannot serve here. The
  // loop covers every class with an isolation nexus — base tables (RLS),
  // views, and SECURITY DEFINER functions (which execute as their owner) —
  // plus sequences and matviews for uniformity. Types are intentionally left
  // alone: type ownership has no RLS or execution nexus, and array types
  // cannot be altered directly. Statements are fully quoted server-side.
  const stmts = await pool.query<{ stmt: string }>(
    `select (case c.relkind
               when 'v' then 'alter view '
               when 'm' then 'alter materialized view '
               when 'S' then 'alter sequence '
               when 'f' then 'alter foreign table '
               else 'alter table ' end)
              || format('%I.%I', n.nspname, c.relname)
              || ' owner to ' || quote_ident($1) as stmt
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'openbooks_query')
        and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
        and pg_get_userbyid(c.relowner) <> $1
        -- A serial/identity sequence is LINKED to its column: PostgreSQL
        -- refuses ALTER SEQUENCE ... OWNER TO on it (SQLSTATE 0A000) unless
        -- the owning table has already changed hands, and this list has no
        -- guaranteed order. Skip them: altering the table carries its
        -- sequences with it, so they still end up on the runtime role.
        and not (
          c.relkind = 'S'
          and exists (
            select 1 from pg_depend d
             where d.classid = 'pg_class'::regclass
               and d.objid = c.oid
               and d.refclassid = 'pg_class'::regclass
               and d.deptype in ('a', 'i')
          )
        )
      union all
     select 'alter function ' || p.oid::regprocedure::text
              || ' owner to ' || quote_ident($1) as stmt
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'openbooks_query')
        and pg_get_userbyid(p.proowner) <> $1`,
    [config.roleName],
  );
  for (const { stmt } of stmts.rows) {
    await pool.query(stmt);
  }
  const runtimeRole = await quoted(config.roleName, "identifier");
  const dbResult = await pool.query<{ database_name: string }>(
    "select current_database() as database_name",
  );
  const database = await quoted(dbResult.rows[0]!.database_name, "identifier");
  await pool.query(`alter database ${database} owner to ${runtimeRole}`);
  await pool.query(`alter schema public owner to ${runtimeRole}`);
  await pool.query(`alter schema openbooks_query owner to ${runtimeRole}`);
  await verifyTestOwnership(config);
  console.log(
    `[bootstrap] test ownership transferred to ${config.roleName} (${stmts.rows.length} objects plus database and schemas): constrained owner, RLS-subject sessions`,
  );
}

/**
 * Positive ownership proof over the RLS nexus: every org-scoped base table,
 * every governed view, every SECURITY DEFINER function (which executes as its
 * owner — a superuser-owned definer is an exempt path that survives FORCE),
 * and both app schemas (future CREATEs vest in the schema owner) must be
 * owned by the runtime role. Deliberately not a census — provisioning
 * bookkeeping outside the app schema (e.g. testdb's own build record, written
 * after bootstrap) and type ownership (no RLS or execution nexus) are
 * ignored; the isolation surface is what must be fully vested.
 */
async function verifyTestOwnership(
  config: RuntimeDatabaseConfig,
): Promise<void> {
  const offenders = await pool.query<{ object_name: string }>(
    `select c.relname as object_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_roles r on r.oid = c.relowner
      where ((n.nspname = 'public' and c.relkind in ('r', 'p')
              and exists (
                select 1 from pg_attribute a
                 where a.attrelid = c.oid and a.attname = 'org_id'))
             or (n.nspname = 'openbooks_query' and c.relkind = 'v'))
        and r.rolname <> $1
      union all
     select p.oid::regprocedure::text as object_name
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_roles r on r.oid = p.proowner
      where n.nspname in ('public', 'openbooks_query')
        and p.prosecdef
        and r.rolname <> $1
      union all
     select 'schema ' || n.nspname as object_name
       from pg_namespace n
       join pg_roles r on r.oid = n.nspowner
      where n.nspname in ('public', 'openbooks_query')
        and r.rolname <> $1
      order by 1`,
    [config.roleName],
  );
  if (offenders.rows.length > 0) {
    throw new Error(
      `[bootstrap] ownership transfer incomplete; RLS nexus objects not owned by ${config.roleName}: ` +
        offenders.rows.map((r) => r.object_name).join(", "),
    );
  }
}

async function ensureReadRole(runtimeRoleName?: string): Promise<void> {
  const steps: [string, string][] = [
    [
      "create role",
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = 'openbooks_read') then
           create role openbooks_read nologin;
         end if;
       end $$;`,
    ],
    [
      "grant to bootstrap user",
      `do $$ begin
         if not pg_has_role(current_user, 'openbooks_read', 'SET') then
           grant openbooks_read to current_user with set true;
         end if;
       end $$;`,
    ],
  ];
  if (runtimeRoleName) {
    const runtimeRole = await quoted(runtimeRoleName, "identifier");
    const runtimeLiteral = await quoted(runtimeRoleName, "literal");
    // Conditional like the bootstrap-user grant above: a re-run over the
    // transferred test login cannot administer memberships, so skip when it
    // already has SET permission instead of requiring an ADMIN OPTION grant.
    steps.push(["grant to runtime user", `do $$ begin
         if not pg_has_role(${runtimeLiteral}, 'openbooks_read', 'SET') then
           grant openbooks_read to ${runtimeRole} with set true;
         end if;
       end $$;`]);
  }
  for (const [label, stmt] of steps) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err) {
      throw new Error(
        `[bootstrap] openbooks_read ${label} failed: ${(err as Error).message}`,
      );
    }
  }
  await verifyReadRoleAssumption(pool, "bootstrap login");
  console.log("[bootstrap] openbooks_read role usable");
}

async function ensureOrg(): Promise<string> {
  const existing = (await db.execute<{ id: string }>(
    sql`select id from orgs order by created_at limit 1`,
  ));
  const existingRow = existing.rows[0];
  if (existingRow) return existingRow.id;

  const name = env.ORG_NAME || "OpenBooks";
  const currency = env.ORG_CURRENCY?.trim().toUpperCase();
  const country = env.ORG_COUNTRY?.trim().toUpperCase();
  if (!currency) {
    throw new Error("ORG_CURRENCY is required when creating the first organization");
  }
  if (!country || !/^[A-Z]{2}$/.test(country)) {
    throw new Error(
      "ORG_COUNTRY is required as an ISO 3166-1 alpha-2 code when creating the first organization",
    );
  }
  const ins = (await db.execute<{ id: string }>(sql`
    insert into orgs (name, base_currency, country) values (${name}, ${currency}, ${country})
    returning id
  `));
  const orgId = ins.rows[0]?.id;
  if (!orgId) throw new Error("org insert returned no id");
  console.log(`[bootstrap] created org "${name}" (${currency}/${country})`);

  await db.execute(sql`
    insert into accounting_books (org_id, code, name, is_primary)
    values (${orgId}, 'primary', 'Primary book', true)
    -- Fresh org id (minted two lines above) under the bootstrap-wide advisory
    -- lock: a conflict is not reachable, and doing nothing rather than
    -- failing keeps a re-run of this ensure idempotent.
    on conflict do nothing
  `);

  const { calendarId } = await ensureCloseDefaults(orgId);

  // Monthly periods: two fiscal years back through five ahead — plenty for a
  // dev instance; Setup → Periods & Close manages them afterwards.
  const thisYear = new Date().getUTCFullYear();
  for (let y = thisYear - 2; y <= thisYear + 5; y++) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      const endDate = new Date(Date.UTC(y, m, 0));
      const end = endDate.toISOString().slice(0, 10);
      await db.execute(sql`
        insert into accounting_periods (org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on)
        values (${orgId}, ${calendarId}, ${y}, ${m}, ${`${y}-${String(m).padStart(2, "0")}`}, ${start}, ${end})
        -- Fresh org + fresh calendar under the bootstrap-wide advisory lock;
        -- the conflict is not reachable and do-nothing keeps re-runs idempotent.
        on conflict do nothing
      `);
    }
  }
  console.log(
    `[bootstrap] primary book + periods ${thisYear - 2}..${thisYear + 5} ensured`,
  );
  return orgId;
}

async function seedCurrencies(): Promise<void> {
  for (const currency of SUPPORTED_CURRENCIES) {
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values (${currency.code}, ${currency.name}, ${currency.minorUnits})
      on conflict (code) do update
        set name = excluded.name, minor_units = excluded.minor_units
    `);
  }
  const configured = env.ORG_CURRENCY?.trim().toUpperCase();
  if (configured && !SUPPORTED_CURRENCIES.some((currency) => currency.code === configured)) {
    throw new Error(
      `ORG_CURRENCY ${configured} is not in the supported ISO 4217 registry`,
    );
  }
  console.log(`[bootstrap] ${SUPPORTED_CURRENCIES.length} currencies ensured`);
}

async function ensureRootSubsidiary(orgId: string): Promise<void> {
  await db.execute(sql`
    insert into subsidiaries
      (org_id, name, legal_name, base_currency, country, created_at, updated_at)
    select id, name, legal_name, base_currency, country, now(), now()
      from orgs
     where id = ${orgId}
       and not exists (
         select 1 from subsidiaries where org_id = ${orgId} and parent_id is null
       )
    -- The not-exists guard makes the insert conditional; the conflict arm
    -- only covers a lost race against another ensure, which the bootstrap-
    -- wide advisory lock already excludes. Do-nothing is the ensure's
    -- intent, and the re-read below fails loudly if the row is absent.
    on conflict do nothing
  `);
  const root = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null
  `));
  if (root.rows.length !== 1) {
    throw new Error(`organization ${orgId} must have exactly one root subsidiary`);
  }
  console.log("[bootstrap] root subsidiary ensured");
}

async function seedRoles(orgId: string): Promise<void> {
  for (const [key, def] of Object.entries(BUILT_IN_ROLES)) {
    await db.execute(sql`
      insert into app_roles (org_id, key, name, description, is_built_in, permissions)
      values (${orgId}, ${key}, ${def.name}, ${def.description}, true, ${JSON.stringify(def.permissions)})
      on conflict (org_id, key) do update
        set name = excluded.name, description = excluded.description,
            is_built_in = true, permissions = excluded.permissions, updated_at = now()
    `);
  }
  console.log("[bootstrap] built-in roles ensured");
}

async function seedAdmin(orgId: string): Promise<void> {
  const email = env.ADMIN_EMAIL;
  if (!email) {
    console.log("[bootstrap] ADMIN_EMAIL not set — skipping admin seed");
    return;
  }
  const name = env.ADMIN_NAME || "Administrator";
  const password = env.ADMIN_PASSWORD || randomBytes(12).toString("base64url");
  const salt = randomBytes(16);
  const hash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
  // Only set the password when the user is first created — a running instance
  // must not have its admin password silently reset on every deploy.
  const created = await db.transaction(async (tx) => {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into users (org_id, email, name, password_hash)
      values (${orgId}, ${email.toLowerCase()}, ${name}, ${hash})
      on conflict (org_id, email) do nothing
      returning id
    `));
    const userId = inserted.rows[0]?.id ?? ((await tx.execute<{ id: string }>(sql`
      select id from users where org_id = ${orgId} and email = ${email.toLowerCase()} limit 1
    `))).rows[0]?.id;
    if (!userId) throw new Error(`administrator ${email} could not be resolved after seed`);
    const assignment = (await tx.execute<{ id: string }>(sql`
      insert into role_assignments (org_id, user_id, role_id)
      select ${orgId}, ${userId}, id from app_roles
       where org_id = ${orgId} and key = 'admin'
      on conflict (org_id, user_id, role_id) do nothing
      returning id
    `));
    if (inserted.rows.length > 0 && assignment.rows.length === 0) {
      throw new Error("new administrator did not receive an explicit admin role assignment");
    }
    return inserted.rows.length > 0;
  });
  if (created) {
    console.log(
      `[bootstrap] admin user ${email} created${env.ADMIN_PASSWORD ? "" : ` — generated password: ${password}`}`,
    );
  } else {
    console.log(`[bootstrap] admin user ${email} already exists — untouched`);
  }
}

/**
 * First platform super-admin for a fresh self-hosted install. The platform
 * console authorizes on users.is_super_admin, and its only grant path is the
 * console itself, which already requires a super administrator — so a fresh
 * install could never reach it. When PLATFORM_ADMIN_EMAIL names an existing
 * user and no active super administrator exists anywhere in the
 * installation, that user is promoted; the grant is audited and logged.
 * It is a strict no-op once any active super administrator exists (later
 * grants are governed by the console) and when PLATFORM_ADMIN_EMAIL is
 * unset. The transaction lock serializes concurrent bootstraps so two
 * cannot both grant.
 */
async function ensureFirstPlatformAdmin(): Promise<void> {
  const configured = env.PLATFORM_ADMIN_EMAIL?.trim();
  if (!configured) return;
  const email = configured.toLowerCase();
  const granted = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('openbooks:first-platform-admin', 0))`);
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from users where is_super_admin and is_active limit 1
    `));
    if (existing.rows.length > 0) return false;
    const candidates = (await tx.execute<{
      id: string;
      org_id: string;
      email: string;
      is_active: boolean;
      is_super_admin: boolean;
    }>(sql`
      select id, org_id, email, is_active, is_super_admin
        from users
       where lower(email) = ${email}
    `));
    const active = candidates.rows.filter((row) => row.is_active);
    if (active.length === 0) {
      const state =
        candidates.rows.length > 0 ? "exists but is inactive" : "does not exist";
      const remedy =
        candidates.rows.length > 0
          ? "reactivate that user"
          : "set PLATFORM_ADMIN_EMAIL to the seeded administrator (ADMIN_EMAIL) or create the user first";
      throw new Error(
        `[bootstrap] PLATFORM_ADMIN_EMAIL names ${configured}, but that user ${state}; ` +
          `${remedy}, then re-run bootstrap`,
      );
    }
    if (active.length > 1) {
      throw new Error(
        `[bootstrap] PLATFORM_ADMIN_EMAIL names ${configured}, but that address belongs to ` +
          `${active.length} active users in different organizations; keep exactly one active user ` +
          `with that address, then re-run bootstrap`,
      );
    }
    const target = active[0]!;
    const promoted = (await tx.execute<{ id: string }>(sql`
      update users
         set is_super_admin = true, updated_at = now(), updated_by = ${target.id}
       where id = ${target.id} and not is_super_admin and is_active
         and not exists (select 1 from users where is_super_admin and is_active)
      returning id
    `));
    if (promoted.rows.length === 0) {
      // A concurrent bootstrap granted first: the no-op condition now holds,
      // so this is the benign lost race rather than a dropped write.
      const raced = (await tx.execute<{ id: string }>(sql`
        select id from users where is_super_admin and is_active limit 1
      `));
      if (raced.rows.length > 0) return false;
      throw new Error(
        `[bootstrap] PLATFORM_ADMIN_EMAIL grant for ${configured} affected no rows; re-run bootstrap`,
      );
    }
    const audit = (await tx.execute<{ id: string }>(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${target.org_id},
        'users',
        ${target.id},
        'update',
        ${JSON.stringify({
          source: "bootstrap",
          reason: `Granted platform super-admin access on first bootstrap via PLATFORM_ADMIN_EMAIL (${configured})`,
          before: { is_super_admin: false },
          after: { is_super_admin: true },
        })}::jsonb,
        ${target.id}
      )
      returning id
    `));
    if (audit.rows.length !== 1) {
      throw new Error(
        `[bootstrap] PLATFORM_ADMIN_EMAIL grant for ${configured} was not audited; re-run bootstrap`,
      );
    }
    return true;
  });
  if (granted) {
    console.log(
      `[bootstrap] ${configured} granted platform super-admin via PLATFORM_ADMIN_EMAIL (no active super administrator existed)`,
    );
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    // Strictly read-only: this path takes no advisory lock (it must not
    // block a live app), creates nothing, and performs no role, seed, or
    // RLS work. It lists the pending migrations and runs the evaluable
    // preflights, exiting 1 on any refuse finding and 0 otherwise.
    const json = process.argv.includes("--json");
    let code = 1;
    try {
      code = await runUpgradeCheckMain(json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      // A caller asked for machine output, so it gets machine output, error
      // included. A bare crash leaves it nothing to parse.
      if (json) console.log(JSON.stringify({ error: message }));
      code = 1;
    } finally {
      await pool.end().catch(() => {});
      await longPool.end().catch(() => {});
    }
    process.exit(code);
  }
  const precreated = precreatedRolesEnabled(env);
  const runtimeConfig = runtimeDatabaseConfig();
  const constrainedSchemaOwnerMigration =
    env.OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION === "1";
  const restoreTarget = env.OPENBOOKS_RESTORE_TARGET === "1";
  if (restoreTarget && constrainedSchemaOwnerMigration) {
    throw new Error(
      "OPENBOOKS_RESTORE_TARGET and constrained schema-owner migration modes cannot be combined",
    );
  }
  if (env.NODE_ENV === "production" && !runtimeConfig) {
    throw new Error(
      "OPENBOOKS_RUNTIME_DB_URL is required for production bootstrap; migrations and application traffic must use separate database roles",
    );
  }
  const lockClient = await pool.connect();
  let locked = false;
  try {
    // Rolling deployments can start more than one container against the same
    // database. Serialize the entire migrate+seed unit so one
    // bootstrap cannot seed a relation while another is changing its policy
    // or constraint definition.
    await lockClient.query("set statement_timeout = 0");
    await lockClient.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      "openbooks:deployment-bootstrap",
    ]);
    locked = true;
    console.log("[bootstrap] starting");
    // Bootstrap is the one intentional installation-wide maintenance boundary.
    // Set it explicitly: an absent tenant remains fail-closed everywhere else,
    // while migration validation must see every row before it changes a global
    // constraint. Context-only scope keeps each tracked migration's own
    // transaction authoritative instead of pinning an outer transaction.
    await withBypassContext(async () => {
      if (constrainedSchemaOwnerMigration) {
        if (!runtimeConfig) {
          throw new Error(
            "constrained schema-owner migration requires OPENBOOKS_RUNTIME_DB_URL",
          );
        }
        await assertConstrainedSchemaOwnerMigrationRole(runtimeConfig);
        // The runtime login must already exist (this login cannot create
        // roles); grants for tables this run creates are applied after the
        // migration chain, then the runtime login is verified non-owner and
        // RLS-proved before anything serves it.
        await requireRuntimeLoginRole(runtimeConfig);
        await migrate();
        await ensureRuntimeDatabaseRole(runtimeConfig, true);
        await verifyRuntimeOwnership(pool, runtimeConfig.roleName);
        const firstOrg = await pool.query<{ id: string }>(
          "select id from orgs order by created_at limit 1",
        );
        if (firstOrg.rows[0]) {
          await verifyRuntimeDatabaseRole(runtimeConfig, firstOrg.rows[0].id);
        } else {
          console.log(
            "[bootstrap] no organizations yet; runtime RLS proofs are deferred to the first deploy with an organization",
          );
        }
        return;
      }
      // Some migrations grant privileges to openbooks_read, so a fresh database
      // must establish the role before applying them. Run the same idempotent
      // routine again afterward to grant access to the newly created tables.
      if (precreated) {
        await verifyPrecreatedRoles(pool, runtimeConfig!);
        console.log("[bootstrap] pre-created roles verified; host owns role provisioning");
      } else {
        await ensureReadRole();
      }
      // Runtime roles the migrations may reference (e.g. RLS policies targeted
      // `TO openbooks_app`) must also exist before the migration chain runs;
      // the post-migrate ensureRuntimeDatabaseRole still grants the now-created
      // relations their privileges.
      if (runtimeConfig && !precreated) await ensureRuntimeRoleExists(runtimeConfig);
      await migrate();
      if (runtimeConfig) await ensureRuntimeDatabaseRole(runtimeConfig, precreated);
      if (precreated) {
        await verifyPrecreatedObjectAccess(pool, runtimeConfig!);
      } else {
        await ensureReadRole(runtimeConfig?.roleName);
      }
      await seedCurrencies();
      if (restoreTarget) {
        const organizations = (await db.execute<{ count: number }>(
          sql`select count(*)::int as count from orgs`,
        ));
        if (organizations.rows[0]?.count !== 0) {
          throw new Error(
            "OPENBOOKS_RESTORE_TARGET requires a new database with zero organizations",
          );
        }
        console.log(
          "[bootstrap] schema-only restore target ready; no organization or administrator was seeded",
        );
        return;
      }
      const primaryOrgId = await ensureOrg();
      const organizations = (await db.execute<{ id: string }>(
        sql`select id from orgs order by created_at`,
      ));
      for (const { id: orgId } of organizations.rows) {
        await ensureRootSubsidiary(orgId);
        await seedRoles(orgId);
        await provisionOrganizationDefaults(orgId);
      }
      await seedAdmin(primaryOrgId);
      await ensureFirstPlatformAdmin();
      if (env.OPENBOOKS_TEST_OWNERSHIP_TRANSFER === "1" && !runtimeConfig) {
        throw new Error(
          "[bootstrap] OPENBOOKS_TEST_OWNERSHIP_TRANSFER requires OPENBOOKS_RUNTIME_DB_URL",
        );
      }
      if (runtimeConfig) await transferTestOwnershipToRuntimeRole(runtimeConfig);
      if (runtimeConfig)
        await verifyRuntimeDatabaseRole(runtimeConfig, primaryOrgId);
    });
    console.log("[bootstrap] done");
  } finally {
    if (locked) {
      await lockClient
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [
          "openbooks:deployment-bootstrap",
        ])
        .catch(() => {});
    }
    lockClient.release();
    await pool.end();
    // Migration and RLS DDL now check out longPool sessions, which (unlike the
    // governed read pool) keep the process alive while idle. Without this the
    // bootstrap process hangs after "[bootstrap] done".
    await longPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
 *
 * Run: npx tsx scripts/bootstrap.ts   (or the esbuild bundle in the image)
 */
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db, env, pool, withBypassContext } from "../engine/src/db.ts";
import { ensureCloseDefaults } from "../engine/src/close.ts";
import { provisionOrganizationDefaults } from "../engine/src/organization-provisioning.ts";
import { SUPPORTED_CURRENCIES } from "../engine/src/currencies.ts";
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

type RuntimeDatabaseConfig = {
  connectionString: string;
  roleName: string;
  password: string;
};

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
  const runtimeDatabase = decodeURIComponent(
    new URL(runtimeConfig.connectionString).pathname.replace(/^\//, ""),
  );
  if (
    !posture ||
    posture.current_user !== runtimeConfig.roleName ||
    posture.current_database !== runtimeDatabase ||
    posture.unsafe ||
    posture.unowned_tables !== 0
  ) {
    throw new Error(
      "constrained schema-owner migration requires a restricted role that owns every public table",
    );
  }
  console.log(
    `[bootstrap] constrained schema owner ${posture.current_user} verified for migration-only mode`,
  );
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
    from: "74a3b21e956f2f02334f5245f54b37fe235af732a8eb3345d86a9ea9611df007",
    to: "780dfaf134f8d98a40c5e9d143291c161194fec196151aca30d1d4f6f4fbade6",
    strategy: "restamp",
    reason:
      "regenerated from a dump of the database it builds: twelve payroll views "
      + "gained the tenant filter the refresh function already applied, "
      + "entitlement_plans regained base-table column order, and hand-appended "
      + "objects returned to pg_dump order. Verified: dumps identical.",
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
];

async function executeTrackedMigration(
  filename: string,
  content: string,
  digest: string,
  recordedDigest?: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (filename === ORDER_QUANTITY_PROGRESS_MIGRATION_FILENAME) {
      await executeOrderQuantityProgressMigration(client, content, digest);
    } else {
      await client.query(content);
    }
    // pg_dump-style baselines intentionally clear search_path while creating
    // fully qualified objects. Restore the application default before this
    // pooled session is returned to callers that execute reviewed SQL files.
    await client.query("set search_path = public, pg_catalog");
    await client.query("set row_security = on");
    if (recordedDigest) {
      const updated = await client.query(
        `update public._applied_migrations
            set sha256 = $1, applied_at = now()
          where filename = $2 and sha256 = $3`,
        [digest, filename, recordedDigest],
      );
      if (updated.rowCount !== 1) {
        throw new Error("migration digest changed during approved revision");
      }
    } else {
      await client.query(
        "insert into public._applied_migrations (filename, sha256) values ($1, $2)",
        [filename, digest],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw new Error(
      `[bootstrap] ${filename} failed: ${(err as Error).message}`,
    );
  } finally {
    client.release();
  }
}

async function applyTracked(
  label: string,
  filename: string,
  content: string,
): Promise<void> {
  const digest = sha256(content);
  const seen = (await db.execute<{ sha256: string }>(sql`
    select sha256 from public._applied_migrations where filename = ${filename}
  `));
  if (seen.rows.length > 0) {
    const recorded = seen.rows[0].sha256;
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
        return;
      }
      await db.execute(sql`
        update public._applied_migrations
           set sha256 = ${digest}
         where filename = ${filename} and sha256 = ${recorded}
      `);
      return;
    }
    return;
  }
  console.log(`[bootstrap] applying ${label}: ${filename}`);
  await executeTrackedMigration(filename, content, digest);
}

async function migrate(): Promise<void> {
  const generated = generatedMigrationFiles();
  assertMigrationFilenameTransitionTargets(generated);
  await db.execute(sql`
    create table if not exists public._applied_migrations (
      filename text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )
  `);
  await convergeMigrationFilenames();

  for (const f of generated) {
    const filename = `generated/${f}`;
    const content = readFileSync(join(migrationsDir, "generated", f), "utf8");
    await applyTracked("migration", filename, content);
  }
  await applyRowLevelSecurity();
}

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
    await pool.query(content);
    await db.execute(sql`
      insert into public._applied_migrations (filename, sha256)
      values ('environments.sql', ${digest})
      on conflict (filename) do update
        set sha256 = excluded.sha256,
            applied_at = now()
    `);
  }
  const unprotected = (await db.execute<{ table_name: string }>(sql`
    select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and not c.relrowsecurity
       and exists (
         select 1 from information_schema.columns col
          where col.table_schema = 'public'
            and col.table_name = c.relname
            and col.column_name = 'org_id')
  `));
  // Fail loudly rather than booting an app whose tenant isolation has a hole.
  if (unprotected.rows.length > 0) {
    throw new Error(
      `row-level security missing on: ${unprotected.rows.map((r) => r.table_name).join(", ")}`,
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
  await pool.query(
    `alter role ${role} login inherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password ${password}`,
  );
}

async function ensureRuntimeDatabaseRole(
  config: RuntimeDatabaseConfig,
): Promise<void> {
  const role = await quoted(config.roleName, "identifier");
  const databaseResult = await pool.query<{ database_name: string }>(
    "select current_database() as database_name",
  );
  const database = await quoted(databaseResult.rows[0]!.database_name, "identifier");
  await ensureRuntimeRoleExists(config);
  await pool.query(`grant connect, temporary on database ${database} to ${role}`);
  await pool.query(`grant usage on schema public to ${role}`);
  await pool.query(
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
  );
  await pool.query(
    `grant usage, select, update on all sequences in schema public to ${role}`,
  );
  // Function execution is inherited only from deliberately retained PUBLIC
  // grants. Never blanket-grant the runtime role: the public schema also holds
  // tightly controlled SECURITY DEFINER maintenance functions.
  await pool.query(`revoke execute on all functions in schema public from ${role}`);
  // The application establishes tenant identity with connection-local GUCs.
  // This privilege belongs to the runtime login, never to openbooks_read; the
  // governed SQL console switches to openbooks_read before user SQL executes.
  await pool.query(
    `grant execute on function pg_catalog.set_config(text, text, boolean) to ${role}`,
  );
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
         if not pg_has_role(current_user, 'openbooks_read', 'USAGE') then
           grant openbooks_read to current_user;
         end if;
       end $$;`,
    ],
  ];
  if (runtimeRoleName) {
    const runtimeRole = await quoted(runtimeRoleName, "identifier");
    steps.push(["grant to runtime user", `grant openbooks_read to ${runtimeRole}`]);
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
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role openbooks_read");
      await client.query("rollback");
      console.log("[bootstrap] openbooks_read role usable");
    } finally {
      client.release();
    }
  } catch {
    console.warn(
      "[bootstrap] WARNING: cannot assume openbooks_read — SQL workbench/user-script queries will fail",
    );
  }
}

async function ensureOrg(): Promise<string> {
  const existing = (await db.execute<{ id: string }>(
    sql`select id from orgs order by created_at limit 1`,
  ));
  if (existing.rows.length > 0) return existing.rows[0].id;

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
  const orgId = ins.rows[0].id;
  console.log(`[bootstrap] created org "${name}" (${currency}/${country})`);

  await db.execute(sql`
    insert into accounting_books (org_id, code, name, is_primary)
    values (${orgId}, 'primary', 'Primary book', true)
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

async function main(): Promise<void> {
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
        await migrate();
        return;
      }
      // Some migrations grant privileges to openbooks_read, so a fresh database
      // must establish the role before applying them. Run the same idempotent
      // routine again afterward to grant access to the newly created tables.
      await ensureReadRole();
      // Runtime roles the migrations may reference (e.g. RLS policies targeted
      // `TO openbooks_app`) must also exist before the migration chain runs;
      // the post-migrate ensureRuntimeDatabaseRole still grants the now-created
      // relations their privileges.
      if (runtimeConfig) await ensureRuntimeRoleExists(runtimeConfig);
      await migrate();
      if (runtimeConfig) await ensureRuntimeDatabaseRole(runtimeConfig);
      await ensureReadRole(runtimeConfig?.roleName);
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
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

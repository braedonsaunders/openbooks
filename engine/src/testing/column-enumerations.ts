/**
 * Column-enumeration registry.
 *
 * Every place in the codebase that enumerates a table's columns from the
 * PostgreSQL catalog (`information_schema.columns` or `pg_attribute`) must
 * declare what it does about GENERATED ALWAYS columns. A generated column is
 * a readable projection the row computes itself: PostgreSQL refuses any
 * INSERT or UPDATE that names it with a non-DEFAULT value. The sandbox clone
 * learned this the expensive way (0193 landed, eleven database shards went
 * red, 0193 was reverted): an enumeration that quietly feeds a write is green
 * until the first generated column arrives.
 *
 * column-enumerations.test.ts scans the source tree and fails on any site
 * that is not declared here, on any declaration whose site is gone, and on
 * any `feeds-a-write` site whose query does not visibly filter generated
 * columns. Adding a new enumeration means adding its stance here, in source
 * order within the file.
 */

export const STANCES = {
  "feeds-a-write":
    "the enumerated names become the column list of an INSERT, UPDATE or a write validator; " +
    "the query MUST exclude generated columns (is_generated = 'NEVER' / attgenerated = '') near the enumeration",
  "presence-probe":
    "asks only whether one named column (org_id, custom, ...) exists on a table; the answer is a table-selection " +
    "fact and nothing writes with it",
  "key-members":
    "resolves the member columns of a constraint or index for read-side validation or ordering; " +
    "the names are never written through",
  descriptive:
    "reads column metadata for display, documentation, a fingerprint, a snapshot or the query console; " +
    "generated columns are legitimately part of what is described",
} as const;

export type Stance = keyof typeof STANCES;

export interface EnumerationSite {
  stance: Stance;
  /** Why this stance is the right one for this site. */
  note: string;
}

export interface EnumerationRegistration {
  /** Repository-relative path. */
  file: string;
  /** One entry per catalog enumeration, in source order. */
  sites: readonly EnumerationSite[];
}

export const COLUMN_ENUMERATIONS: readonly EnumerationRegistration[] = [
  {
    file: "engine/src/backup/backup.ts",
    sites: [
      {
        stance: "key-members",
        note: "FK member columns for the cross-organization reference check on export",
      },
      { stance: "key-members", note: "referenced-side member columns of the same check" },
    ],
  },
  {
    file: "engine/src/backup/format.ts",
    sites: [
      {
        stance: "descriptive",
        note: "the archive's schema fingerprint describes every column, generated ones included",
      },
    ],
  },
  {
    file: "engine/src/backup/restore.ts",
    sites: [
      {
        stance: "presence-probe",
        note: "which public tables carry org_id and belong in the archive",
      },
      {
        stance: "key-members",
        note: "self-referencing FK member columns for the restore staging order; the names order the restore, never a write list",
      },
      {
        stance: "feeds-a-write",
        note: "the storable column list the spool insert names; generated columns are recomputed by the target row",
      },
      { stance: "key-members", note: "FK source members for post-restore validation" },
      { stance: "key-members", note: "FK target members for post-restore validation" },
      { stance: "presence-probe", note: "source table carries org_id" },
      { stance: "presence-probe", note: "target table carries org_id" },
    ],
  },
  {
    file: "engine/src/chart/account-merge.ts",
    sites: [
      {
        stance: "feeds-a-write",
        note: "declared account reference columns present in the schema; the merge redirects configuration through them",
      },
    ],
  },
  {
    file: "engine/src/chart/account-references.ts",
    sites: [
      {
        stance: "feeds-a-write",
        note: "foreign-key columns into accounts; the merge redirects configuration rows through them",
      },
    ],
  },
  {
    file: "engine/src/crm/sales-readiness.ts",
    sites: [
      { stance: "presence-probe", note: "Sales rollout gate: the employee role flag exists" },
      { stance: "presence-probe", note: "Sales rollout gate: the quota employee column exists" },
      { stance: "presence-probe", note: "Sales rollout gate: the quota lifecycle column exists" },
      {
        stance: "presence-probe",
        note: "Sales rollout gate: the team member employee column exists",
      },
      {
        stance: "presence-probe",
        note: "Sales rollout gate: the account profile rep column exists",
      },
    ],
  },
  {
    file: "engine/src/golden/scenario.ts",
    sites: [{ stance: "presence-probe", note: "RLS census over tables that carry org_id" }],
  },
  {
    file: "engine/src/hrm/benefits/transaction-policy.ts",
    sites: [
      {
        stance: "presence-probe",
        note: "asks whether the installed positions table carries the context fallback column before transaction programs run",
      },
    ],
  },
  {
    file: "engine/src/hrm/documents/dsar.ts",
    sites: [
      {
        stance: "descriptive",
        note: "subject-access export projection shown to the data subject; generated columns are readable computed values legitimately part of the export",
      },
    ],
  },
  {
    file: "engine/src/hrm/employment-start-correction.ts",
    sites: [
      {
        stance: "feeds-a-write",
        note: "the copied successor version's column list; generated columns are never copied into an INSERT",
      },
    ],
  },
  {
    file: "engine/src/hrm/performance/authoring-schema.ts",
    sites: [
      {
        stance: "presence-probe",
        note: "review authoring readiness: the named columns exist on the review tables",
      },
    ],
  },
  {
    file: "engine/src/platform/sqlapi.ts",
    sites: [
      {
        stance: "key-members",
        note: "unique-index membership behind the schema listing's is_key flag; the flag is displayed, never written through",
      },
      {
        stance: "descriptive",
        note: "openbooks_query view columns for the SQL API's schema listing",
      },
    ],
  },
  {
    file: "engine/src/projects/merge.ts",
    sites: [
      { stance: "presence-probe", note: "target table has a custom column" },
      { stance: "presence-probe", note: "target table is org-scoped" },
    ],
  },
  {
    file: "engine/src/sample-companies/install-scenarios.ts",
    sites: [
      {
        stance: "feeds-a-write",
        note: "native demo record validation permits only writable columns; generated columns are excluded before constructing inserts or updates",
      },
    ],
  },
  {
    file: "engine/src/sample-companies/preservation.ts",
    sites: [
      {
        stance: "descriptive",
        note: "sample-record preservation snapshot: the columns of each preserved table",
      },
      { stance: "key-members", note: "native primary-key member columns of each preserved table" },
    ],
  },
  {
    file: "engine/src/sample-companies/retirement-data.ts",
    sites: [
      {
        stance: "key-members",
        note: "foreign-key child member columns for the retirement dependency order",
      },
      {
        stance: "key-members",
        note: "foreign-key parent member columns for the retirement dependency order",
      },
      {
        stance: "presence-probe",
        note: "retirement table selection: a table carries a user reference column",
      },
    ],
  },
  {
    file: "engine/src/sample-companies/retirement-plan.ts",
    sites: [
      {
        stance: "descriptive",
        note: "retirement plan fingerprint: column names, types and nullability per table",
      },
      {
        stance: "presence-probe",
        note: "retirement plan: the table carries an organization column",
      },
    ],
  },
  {
    file: "engine/src/sandbox/catalog.ts",
    sites: [
      {
        stance: "feeds-a-write",
        note: "the clone's copy column list; generated columns are never named in `insert into t (cols)`",
      },
      { stance: "key-members", note: "FK edges by attnum from pg_constraint" },
      { stance: "key-members", note: "unique-index members that omit org_id (forced rebase)" },
      { stance: "presence-probe", note: "the indexed table carries org_id" },
      { stance: "key-members", note: "org_id is not itself an index member" },
    ],
  },
  {
    file: "engine/src/sandbox/promote.ts",
    sites: [
      { stance: "presence-probe", note: "which promotable tables carry org_id" },
      {
        stance: "feeds-a-write",
        note: "the promotion's SET / INSERT list; generated payload keys are known but never written",
      },
    ],
  },
  {
    file: "engine/src/testing/migration-catalog.ts",
    sites: [
      {
        stance: "descriptive",
        note: "pre/post-test table snapshot (name, type, nullability, default) diffed for humans; generated columns are legitimately part of what is described",
      },
    ],
  },
  {
    file: "engine/src/sync/entity-mappings.ts",
    sites: [
      {
        stance: "presence-probe",
        note: "reference choices: the display and organization-scope columns of a whitelisted table",
      },
    ],
  },
  {
    file: "engine/src/sync/party-merges.ts",
    sites: [
      { stance: "presence-probe", note: "target table has a custom column" },
      { stance: "presence-probe", note: "target table is org-scoped" },
    ],
  },
  {
    file: "engine/src/testing/fixtures.ts",
    sites: [
      {
        stance: "presence-probe",
        note: "every base table that carries org_id, for residue counts",
      },
      { stance: "feeds-a-write", note: "scratch-fixture snapshot columns copied back by name" },
      {
        stance: "key-members",
        note: "plain-column unique-key members from the index catalog; they only build the collider delete predicate, never an insert/update column list",
      },
    ],
  },
  {
    file: "scripts/bootstrap/database-roles.ts",
    sites: [
      { stance: "presence-probe", note: "RLS coverage census over org_id tables" },
      { stance: "presence-probe", note: "RLS policy census over org_id tables" },
      { stance: "presence-probe", note: "ownership census over org_id tables" },
    ],
  },
  {
    file: "scripts/migration-baseline-catalog.mjs",
    sites: [
      {
        stance: "descriptive",
        note: "migration baseline fingerprint: column definitions read from the catalog",
      },
    ],
  },
  {
    file: "scripts/schema-catalog-snapshot.ts",
    sites: [
      {
        stance: "descriptive",
        note: "the canonical catalog snapshot records attgenerated per column",
      },
    ],
  },
  {
    file: "scripts/upgrade-rehearsal/ledger.mjs",
    sites: [
      {
        stance: "descriptive",
        note: "ledger fingerprint column list for the rehearsal row-hash comparison; generated and volatile columns are excluded so the hash is stable",
      },
    ],
  },
  {
    file: "scripts/upgrade-rehearsal/seeders/perf-1m.ts",
    sites: [
      {
        stance: "presence-probe",
        note: "bulk-path wanted columns exist before seeding; the probe only throws on drift",
      },
      {
        stance: "presence-probe",
        note: "version-dependent wanted columns exist before seeding; the probe only throws on drift",
      },
    ],
  },
  {
    file: "web/app/(app)/query/snippets.ts",
    sites: [
      { stance: "descriptive", note: "query-console sample: column counts per view" },
      { stance: "descriptive", note: "query-console sample: column listing per view" },
    ],
  },
  {
    file: "web/lib/api/schema-registry.ts",
    sites: [
      {
        stance: "feeds-a-write",
        note: "the /api/v1/records field list drives write validation; generated columns are read-only fields",
      },
    ],
  },
];

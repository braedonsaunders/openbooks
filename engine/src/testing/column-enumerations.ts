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
  "descriptive":
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
      { stance: "key-members", note: "FK member columns for the cross-organization reference check on export" },
      { stance: "key-members", note: "referenced-side member columns of the same check" },
    ],
  },
  {
    file: "engine/src/backup/format.ts",
    sites: [
      { stance: "descriptive", note: "the archive's schema fingerprint describes every column, generated ones included" },
    ],
  },
  {
    file: "engine/src/backup/restore.ts",
    sites: [
      { stance: "presence-probe", note: "which public tables carry org_id and belong in the archive" },
      { stance: "feeds-a-write", note: "the storable column list the spool insert names; generated columns are recomputed by the target row" },
      { stance: "key-members", note: "FK source members for post-restore validation" },
      { stance: "key-members", note: "FK target members for post-restore validation" },
      { stance: "presence-probe", note: "source table carries org_id" },
      { stance: "presence-probe", note: "target table carries org_id" },
    ],
  },
  {
    file: "engine/src/harness/scenario.ts",
    sites: [
      { stance: "presence-probe", note: "RLS census over tables that carry org_id" },
    ],
  },
  {
    file: "engine/src/platform/sqlapi.ts",
    sites: [
      { stance: "descriptive", note: "openbooks_query view columns for the SQL API's schema listing" },
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
    file: "engine/src/sandbox/catalog.ts",
    sites: [
      { stance: "feeds-a-write", note: "the clone's copy column list; generated columns are never named in `insert into t (cols)`" },
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
      { stance: "feeds-a-write", note: "the promotion's SET / INSERT list; generated payload keys are known but never written" },
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
      { stance: "presence-probe", note: "every base table that carries org_id, for residue counts" },
      { stance: "feeds-a-write", note: "scratch-fixture snapshot columns copied back by name" },
      { stance: "key-members", note: "plain-column unique-key members from the index catalog; they only build the collider delete predicate, never an insert/update column list" },
    ],
  },
  {
    file: "scripts/bootstrap.ts",
    sites: [
      { stance: "descriptive", note: "column comments for the schema documentation check" },
      { stance: "presence-probe", note: "payment-link seal applicability: whether token_hash/token_sealed exist; the probe only counts, the seal names its columns literally" },
      { stance: "presence-probe", note: "RLS coverage census over org_id tables" },
      { stance: "presence-probe", note: "RLS policy census over org_id tables" },
      { stance: "presence-probe", note: "ownership census over org_id tables" },
    ],
  },
  {
    file: "scripts/schema-catalog-snapshot.ts",
    sites: [
      { stance: "descriptive", note: "the canonical catalog snapshot records attgenerated per column" },
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
      { stance: "feeds-a-write", note: "the /api/v1/records field list drives write validation; generated columns are read-only fields" },
    ],
  },
];

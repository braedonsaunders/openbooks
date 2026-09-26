/** Governed document_lines view snapshot/restore plus the order-quantity progress migration. Split from scripts/bootstrap.ts (pure moves only). */
import pg from "pg"

export type MigrationLedgerClient = Pick<pg.PoolClient, "query">;

export const ORDER_QUANTITY_PROGRESS_MIGRATION_FILENAME =
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

export async function executeOrderQuantityProgressMigration(
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

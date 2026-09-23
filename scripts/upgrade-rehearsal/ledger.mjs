/**
 * Version-tolerant ledger fingerprint for the upgrade rehearsal.
 *
 * The same queries run before the upgrade (against the source release's
 * schema) and after it (against the candidate's). They use only columns
 * present in every supported source release, and a table that does not exist
 * is recorded as absent rather than failing the query. An upgrade must never
 * change what the books say. The trial balance, document totals and open
 * balances, applications, and row counts must all be identical before and
 * after. Any change is refused, because there is no allow-list: a migration
 * that meant to change ledger meaning would need a reviewed exception, and
 * none exists.
 *
 * Aggregates alone cannot see a change that preserves totals. Moving a posted
 * invoice to another party or subsidiary, or re-pointing an application
 * between two equal lines, leaves every sum and count intact. So every row of
 * the core ledger tables is also hashed over EVERY column the source release
 * had. The after-snapshot reuses the before-snapshot's column list: columns
 * the upgrade adds are ignored, and a column it drops is refused. Only
 * `updated_at` is excluded, because it is bookkeeping metadata that a trigger
 * bumps on any backfill.
 */

const COUNTED_TABLES = Object.freeze([
  "orgs",
  "accounts",
  "parties",
  "items",
  "journal_entries",
  "journal_lines",
  "documents",
  "document_lines",
  "applications",
  "accounting_periods",
]);

/** Tables whose every row is fingerprinted over every source-release column. */
export const FINGERPRINTED_TABLES = Object.freeze([
  "journal_entries",
  "journal_lines",
  "documents",
  "document_lines",
  "applications",
]);
const VOLATILE_COLUMNS = new Set(["updated_at"]);

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function assertIdentifier(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing to fingerprint unexpected identifier ${JSON.stringify(name)}`);
  return name;
}

async function fingerprintColumns(client, schema, table) {
  const result = await client.query(
    `select column_name from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_generated = 'NEVER'
      order by column_name`,
    [schema, table],
  );
  return result.rows.map((row) => row.column_name).filter((column) => !VOLATILE_COLUMNS.has(column));
}

/**
 * One SQL statement giving, per org, the row count and an order-independent
 * sum of 60-bit row hashes over the named columns. The id is inside the hashed
 * row, so a value that moves between two rows changes both of their hashes.
 */
export function rowHashQuery(schema, table, columns) {
  const cols = columns.map((column) => `t.${quoteIdent(assertIdentifier(column))}`).join(", ");
  return `select t.org_id::text as org_id, count(*)::bigint::text as rows,
       sum(('x' || substr(md5(row(${cols})::text), 1, 15))::bit(60)::bigint::numeric)::text as hash
  from ${quoteIdent(assertIdentifier(schema))}.${quoteIdent(assertIdentifier(table))} t
 group by t.org_id
 order by 1`;
}

async function tableExists(client, table) {
  const result = await client.query("select to_regclass($1) is not null as present", [table]);
  return result.rows[0].present === true;
}

async function rows(client, text) {
  return (await client.query(text)).rows;
}

/**
 * Fingerprint every org's ledger. The caller owns the connection. This runs
 * inside a READ ONLY transaction with the tenant-RLS bypass set locally, so
 * the counts cannot be the zeros RLS returns to an unscoped session.
 */
export async function snapshotLedger(client, { schema = "public", columns = null } = {}) {
  await client.query("begin read only");
  try {
    await client.query("set local app.bypass_rls = 'on'");
    await client.query(`set local search_path = ${quoteIdent(assertIdentifier(schema))}`);
    const counts = {};
    for (const table of COUNTED_TABLES) {
      counts[table] = (await tableExists(client, table))
        ? Number((await rows(client, `select count(*)::bigint as n from ${quoteIdent(assertIdentifier(table))}`))[0].n)
        : null;
    }

    const orgs = await rows(client, "select id::text as org_id from orgs order by id");

    const entryStatus = await rows(client, `
      select org_id::text, status, count(*)::bigint::text as entries
        from journal_entries
       group by org_id, status
       order by org_id, status`);

    // Posted-ledger trial balance, per book, account, currency and entry status.
    const trialBalance = await rows(client, `
      select e.org_id::text, e.book_id::text, e.status, l.subsidiary_id::text, l.account_id::text, l.currency,
             count(*)::bigint::text as lines,
             sum(l.amount)::text as amount,
             sum(l.txn_amount)::text as txn_amount
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where e.status <> 'draft'
       group by e.org_id, e.book_id, e.status, l.subsidiary_id, l.account_id, l.currency
       order by 1, 2, 3, 4, 5, 6`);

    const unbalancedEntries = await rows(client, `
      select e.org_id::text, e.id::text as entry_id, sum(l.amount)::text as residual
        from journal_entries e
        join journal_lines l on l.entry_id = e.id
       where e.status <> 'draft'
       group by e.org_id, e.id
      having sum(l.amount) <> 0
       order by 1, 2
       limit 50`);

    const documents = await rows(client, `
      select org_id::text, kind, status, currency,
             count(*)::bigint::text as documents,
             sum(total)::text as total,
             sum(open_balance)::text as open_balance
        from documents
       group by org_id, kind, status, currency
       order by 1, 2, 3, 4`);

    const applications = (await tableExists(client, "applications"))
      ? await rows(client, `
          select org_id::text, count(*)::bigint::text as applications, sum(amount)::text as amount
            from applications
           group by org_id
           order by 1`)
      : null;

    // Per-record fingerprints over every column the SOURCE release had. The
    // after-snapshot passes the before-snapshot's column lists back in.
    const rowHashes = {};
    for (const table of FINGERPRINTED_TABLES) {
      if (!(await tableExists(client, table))) continue;
      const present = await fingerprintColumns(client, schema, table);
      const wanted = columns?.[table] ?? present;
      const dropped = wanted.filter((column) => !present.includes(column));
      rowHashes[table] = dropped.length > 0
        ? { columns: wanted, dropped, perOrg: [] }
        : { columns: wanted, dropped: [], perOrg: await rows(client, rowHashQuery(schema, table, wanted)) };
    }

    return {
      counts,
      rowHashes,
      orgs: orgs.map((row) => row.org_id),
      entryStatus,
      trialBalance,
      unbalancedEntries,
      documents,
      applications,
    };
  } finally {
    await client.query("rollback");
  }
}

function keyed(list, keyFields) {
  const map = new Map();
  for (const row of list ?? []) {
    map.set(keyFields.map((field) => row[field] ?? "∅").join(" | "), row);
  }
  return map;
}

function diffKeyed(section, before, after, keyFields, differences) {
  const left = keyed(before, keyFields);
  const right = keyed(after, keyFields);
  for (const [key, row] of left) {
    const other = right.get(key);
    if (!other) {
      differences.push({ section, key, before: row, after: null });
      continue;
    }
    if (JSON.stringify(row) !== JSON.stringify(other)) differences.push({ section, key, before: row, after: other });
  }
  for (const [key, row] of right) {
    if (!left.has(key)) differences.push({ section, key, before: null, after: row });
  }
}

/**
 * Compare two fingerprints. Returns the refusals: every difference, plus any
 * unbalanced posted entry on either side. An unbalanced entry BEFORE the
 * upgrade means the dataset was already broken at the source, and the
 * rehearsal cannot attribute anything after that, so it is refused too.
 */
export function compareSnapshots(before, after) {
  const differences = [];
  for (const table of COUNTED_TABLES) {
    const was = before.counts?.[table] ?? null;
    const now = after.counts?.[table] ?? null;
    // A table the source release did not have may appear, and it holds only
    // rows the upgrade created. A table that existed must keep every row.
    if (was === null) continue;
    if (now !== was) differences.push({ section: "counts", key: table, before: was, after: now });
  }
  if (JSON.stringify(before.orgs) !== JSON.stringify(after.orgs)) {
    differences.push({ section: "orgs", key: "org ids", before: before.orgs, after: after.orgs });
  }
  diffKeyed("entryStatus", before.entryStatus, after.entryStatus, ["org_id", "status"], differences);
  diffKeyed(
    "trialBalance",
    before.trialBalance,
    after.trialBalance,
    ["org_id", "book_id", "status", "subsidiary_id", "account_id", "currency"],
    differences,
  );
  diffKeyed("documents", before.documents, after.documents, ["org_id", "kind", "status", "currency"], differences);
  if (before.applications !== null && after.applications !== null) {
    diffKeyed("applications", before.applications, after.applications, ["org_id"], differences);
  }
  for (const [table, was] of Object.entries(before.rowHashes ?? {})) {
    const now = after.rowHashes?.[table];
    if (!now) {
      differences.push({ section: "rowHashes", key: table, before: "present", after: "table missing" });
      continue;
    }
    if (now.dropped?.length > 0) {
      differences.push({ section: "rowHashes", key: `${table}: columns dropped by the upgrade`, before: now.dropped, after: null });
      continue;
    }
    diffKeyed(`rowHashes.${table}`, was.perOrg, now.perOrg, ["org_id"], differences);
  }
  for (const [side, snapshot] of [["before", before], ["after", after]]) {
    for (const entry of snapshot.unbalancedEntries ?? []) {
      differences.push({ section: `unbalanced-${side}`, key: entry.entry_id, before: null, after: entry });
    }
  }
  return differences;
}

/** Orgs that carry posted ledger activity. */
export function activeOrgIds(snapshot) {
  return [...new Set((snapshot.trialBalance ?? []).map((row) => row.org_id))].sort();
}

/**
 * The orgs the candidate harness must run on: every org the seed reported
 * (whether or not it posted anything) plus every org with posted activity.
 * An org with only drafts or configuration passed the SOURCE harness; its
 * upgraded state must be exercised too, never skipped for having no lines.
 */
export function candidateHarnessOrgIds(seededOrgIds, snapshot) {
  return [...new Set([...seededOrgIds, ...activeOrgIds(snapshot)])].sort();
}

/** The column lists a before-snapshot hashed, for the after-snapshot to reuse. */
export function fingerprintColumnsOf(snapshot) {
  return Object.fromEntries(Object.entries(snapshot.rowHashes ?? {}).map(([table, entry]) => [table, entry.columns]));
}

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

async function tableExists(client, table) {
  const result = await client.query("select to_regclass($1) is not null as present", [`public.${table}`]);
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
export async function snapshotLedger(client) {
  await client.query("begin read only");
  try {
    await client.query("set local app.bypass_rls = 'on'");
    const counts = {};
    for (const table of COUNTED_TABLES) {
      counts[table] = (await tableExists(client, table))
        ? Number((await rows(client, `select count(*)::bigint as n from public.${table}`))[0].n)
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
      select e.org_id::text, e.book_id::text, e.status, l.account_id::text, l.currency,
             count(*)::bigint::text as lines,
             sum(l.amount)::text as amount,
             sum(l.txn_amount)::text as txn_amount
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where e.status <> 'draft'
       group by e.org_id, e.book_id, e.status, l.account_id, l.currency
       order by 1, 2, 3, 4, 5`);

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

    return {
      counts,
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
    ["org_id", "book_id", "status", "account_id", "currency"],
    differences,
  );
  diffKeyed("documents", before.documents, after.documents, ["org_id", "kind", "status", "currency"], differences);
  if (before.applications !== null && after.applications !== null) {
    diffKeyed("applications", before.applications, after.applications, ["org_id"], differences);
  }
  for (const [side, snapshot] of [["before", before], ["after", after]]) {
    for (const entry of snapshot.unbalancedEntries ?? []) {
      differences.push({ section: `unbalanced-${side}`, key: entry.entry_id, before: null, after: entry });
    }
  }
  return differences;
}

/** Orgs that carry posted ledger activity (the ones worth running the golden harness on). */
export function activeOrgIds(snapshot) {
  return [...new Set((snapshot.trialBalance ?? []).map((row) => row.org_id))].sort();
}

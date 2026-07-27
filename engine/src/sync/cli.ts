import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { getConnection, listConnections } from "./connection.ts";
import { buildSource } from "./connection.ts";
import { runFullMigration, runSync } from "./sync.ts";

/**
 * Dev CLI for the native sync engine, driven by a stored connection.
 *   npm run sync -- --org <id> [--full] [--connection <id>] [--production]
 */
const argv = process.argv.slice(2);
const FULL = argv.includes("--full");
const connIdx = argv.indexOf("--connection");
const CONN_ID = connIdx >= 0 ? argv[connIdx + 1] : null;
const orgIdx = argv.indexOf("--org");
const ORG_ID = orgIdx >= 0 ? argv[orgIdx + 1] : null;

if (!ORG_ID || !/^[0-9a-f-]{36}$/i.test(ORG_ID)) {
  console.error("--org <uuid> is required; sync never guesses a tenant");
  process.exit(1);
}
const [org] = ((await db.execute(sql`
  select id, name, env_kind from orgs where id = ${ORG_ID}
`)) as unknown as {
  rows: { id: string; name: string; env_kind: string }[];
}).rows;
if (!org) { console.error("organization not found"); process.exit(1); }
if (org.env_kind !== "sandbox" && !argv.includes("--production")) {
  console.error(
    `${org.name} is ${org.env_kind}; pass --production to sync a live tenant intentionally`,
  );
  process.exit(1);
}

const conns = await listConnections(org.id);
const conn = CONN_ID ? await getConnection(org.id, CONN_ID) : conns[0];
if (!conn) { console.error("no connection configured — add one in the platform page"); process.exit(1); }

console.log(`org=${org.name} connection=${conn.displayName} mode=${FULL ? "full_migration" : "mirror"}`);
const source = buildSource(conn);
const ctxOpts = { orgId: org.id, connectionId: conn.id };
const r = FULL ? await runFullMigration(source, "cli", ctxOpts) : await runSync(source, "cli", ctxOpts);
console.log(JSON.stringify(
  {
    ...r,
    skipped: r.skipped.slice(0, 10),
    tb: { ...r.tb, mismatches: r.tb.mismatches.slice(0, 10) },
    openItems: r.openItems
      ? { ...r.openItems, mismatches: r.openItems.mismatches.slice(0, 10) }
      : null,
  },
  null,
  1,
));
process.exit(0);

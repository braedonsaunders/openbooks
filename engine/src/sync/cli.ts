import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { getConnection, listConnections } from "./connection.ts";
import { buildSource } from "./connection.ts";
import { runFullMigration, runSync } from "./sync.ts";

/**
 * Dev CLI for the native sync engine, driven by a stored connection.
 *   npm run sync -- [--full] [--connection <id>]
 */
const argv = process.argv.slice(2);
const FULL = argv.includes("--full");
const connIdx = argv.indexOf("--connection");
const CONN_ID = connIdx >= 0 ? argv[connIdx + 1] : null;

const [org] = ((await db.execute(sql`select id, name from orgs order by created_at limit 1`)) as unknown as {
  rows: { id: string; name: string }[];
}).rows;
if (!org) { console.error("no org"); process.exit(1); }

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

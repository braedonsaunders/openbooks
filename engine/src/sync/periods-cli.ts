import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { buildSource, type ConnectionRow } from "./connection.ts";
import { syncSourceAccountingPeriods } from "./migrate.ts";

/**
 * Refresh source fiscal periods and lock state without running a transaction
 * migration. Useful immediately after upgrading an existing connection.
 *
 *   npx tsx engine/src/sync/periods-cli.ts [--connection <uuid>]
 */
const argv = process.argv.slice(2);
const connectionIndex = argv.indexOf("--connection");
const requestedId = connectionIndex >= 0 ? argv[connectionIndex + 1] : null;

await db.execute(sql`set app.bypass_rls = on`);
const result = (await db.execute(sql`
  select id, org_id as "orgId", source, display_name as "displayName",
         auth_kind as "authKind", status, config, secrets,
         mirror_enabled as "mirrorEnabled", mirror_schedule as "mirrorSchedule",
         cursor, last_run_at as "lastRunAt", last_error as "lastError"
    from connections
   where status = 'active'
     ${requestedId ? sql`and id = ${requestedId}` : sql``}
   order by created_at
`)) as unknown as { rows: ConnectionRow[] };

if (result.rows.length === 0) throw new Error("no active source connection matched");
for (const connection of result.rows) {
  const stats = await syncSourceAccountingPeriods(buildSource(connection), connection.orgId);
  console.log(`${connection.displayName}: ${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped`);
}

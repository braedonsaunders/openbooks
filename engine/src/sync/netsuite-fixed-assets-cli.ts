import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../db.ts";
import { buildSource, getConnection } from "./connection.ts";
import { syncNetSuiteFixedAssets } from "./netsuite-fixed-assets.ts";
import { NetSuiteSource } from "./netsuite-source.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | null => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
};
const orgId = arg("--org");
const connectionId = arg("--connection");
if (!orgId || !connectionId) {
  throw new Error("usage: npm run sync:fixed-assets -- --org <org-id> --connection <connection-id>");
}

const result = await withOrgContext(orgId, async () => {
  const connection = await getConnection(orgId, connectionId);
  if (!connection) throw new Error(`NetSuite connection ${connectionId} not found for org ${orgId}`);
  const source = buildSource(connection);
  if (!(source instanceof NetSuiteSource)) throw new Error(`connection ${connectionId} is not NetSuite`);
  const actor = (await db.execute<{ id: string }>(sql`
    select id from users where org_id = ${orgId} order by created_at limit 1
  `));
  return syncNetSuiteFixedAssets(source, {
    orgId,
    connectionId,
    actorId: actor.rows[0]?.id ?? null,
  });
});

console.log(JSON.stringify(result, null, 2));

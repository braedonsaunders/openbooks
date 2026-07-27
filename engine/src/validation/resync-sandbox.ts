/**
 * Re-run the REAL migration against a sandbox, through the product's own path.
 *
 * The audit (job-line-audit.ts) showed the tenant's job cost imported with its
 * billability stripped: 10,980 transactions whose lines the source marks
 * billable arrived is_billable false, invisible to the project-billing engine.
 * The mapper fix landed after this tenant was imported, so the correction is a
 * re-sync, not more code — and running it through runFullMigration rather than
 * a patch script is also the only way to prove the importer itself is right.
 *
 * Usage: npx tsx --conditions=react-server src/validation/resync-sandbox.ts --apply
 */
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { buildSource } from "../sync/connection.ts";
import { runFullMigration } from "../sync/sync.ts";

const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const APPLY = process.argv.includes("--apply");

async function retry<T>(fn: () => Promise<T>, n = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

(async () => {
  const env = (await retry(() => db.execute(sql`select env_kind, name from orgs where id = ${ORG}`))) as any;
  if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: target org is not a sandbox");
  console.log(`target: ${env.rows[0].name} (sandbox ${ORG})`);

  const conn = (await retry(() => db.execute(sql`
    select * from connections where org_id = ${ORG} and source = 'netsuite' and status = 'active' limit 1`))) as any;
  const row = conn.rows[0];
  if (!row) throw new Error("no active source connection on this sandbox");

  if (!APPLY) {
    console.log("PLAN: would run a full migration through runFullMigration (pass --apply)");
    process.exit(0);
  }

  const started = Date.now();
  const result = await runFullMigration(
    buildSource({
      id: row.id, orgId: row.org_id, source: row.source,
      config: row.config ?? {}, secrets: row.secrets,
    } as any),
    "job-line-parity-resync",
    { orgId: ORG, connectionId: row.id },
  );
  console.log(`\nrun ${result.runId} — ${((Date.now() - started) / 60000).toFixed(1)} min`);
  console.log(JSON.stringify({
    kind: result.kind, docsNew: result.docsNew, docsUpdated: (result as any).docsUpdated,
    docsSkipped: (result as any).docsSkipped, failures: (result as any).failures?.length ?? 0,
  }, null, 2));
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c: any = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 300));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});

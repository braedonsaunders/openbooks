/**
 * Synchronous operator CLI for the existing stored S3 backup service.
 *
 * This is intentionally separate from the UI/queue path so a controlled
 * maintenance script can prove the backup completed before its first write.
 *
 * Usage:
 *   npx tsx src/backup-stored-cli.ts \
 *     --org=<uuid> --actor=<uuid> --out=/absolute/report.json [--production]
 */
import { existsSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { executeBackupRun } from "./backup.ts";
import { s3Enabled } from "./file-storage.ts";

const args = new Map(
  process.argv
    .slice(2)
    .filter((value) => value.startsWith("--"))
    .map((value) => {
      const [key, ...rest] = value.slice(2).split("=");
      return [key!, rest.length ? rest.join("=") : "true"];
    }),
);
const orgId = args.get("org");
const actorId = args.get("actor");
const out = args.get("out");
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!orgId || !uuid.test(orgId)) throw new Error("--org=<uuid> is required");
if (!actorId || !uuid.test(actorId)) throw new Error("--actor=<uuid> is required");
if (!out?.startsWith("/")) throw new Error("--out=<absolute-path> is required");
if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
if (!s3Enabled) {
  throw new Error("stored S3 backup is not configured in this runtime");
}

const org = (await db.execute(sql`
  select id, name, env_kind from orgs where id = ${orgId}
`)) as unknown as {
  rows: { id: string; name: string; env_kind: string }[];
};
if (!org.rows[0]) throw new Error("organization not found");
if (org.rows[0].env_kind !== "sandbox" && !args.has("production")) {
  throw new Error("--production is required for a live tenant");
}
const actor = (await db.execute(sql`
  select id from users where id = ${actorId} and org_id = ${orgId}
`)) as unknown as { rows: { id: string }[] };
if (!actor.rows[0]) throw new Error("audit actor does not belong to organization");

const active = (await db.execute(sql`
  select id from backup_runs
   where org_id = ${orgId} and status in ('queued', 'running')
   limit 1
`)) as unknown as { rows: { id: string }[] };
if (active.rows[0]) {
  throw new Error(`backup ${active.rows[0].id} is already in progress`);
}
const inserted = (await db.execute(sql`
  insert into backup_runs (org_id, kind, status, actor_id)
  values (${orgId}, 'manual', 'queued', ${actorId})
  returning id
`)) as unknown as { rows: { id: string }[] };
const runId = inserted.rows[0]!.id;
await executeBackupRun(runId);
const result = (await db.execute(sql`
  select id, org_id, kind, status, object_key, file_name, byte_size::text,
         sha256, table_count, row_count, started_at, completed_at, error
    from backup_runs where id = ${runId} and org_id = ${orgId}
`)) as unknown as { rows: Array<Record<string, unknown>> };
const report = result.rows[0];
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
if (report?.status !== "completed" || !report.sha256 || !report.object_key) {
  throw new Error(`stored backup ${runId} did not complete: ${String(report?.error ?? report?.status)}`);
}
console.log(JSON.stringify(report));

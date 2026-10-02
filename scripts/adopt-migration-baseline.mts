/** Verify a reconciled database and append its release identity without replaying DDL. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertBaselineCatalogsEqual, baselineCatalog, baselineDigest } from "./migration-baseline-catalog.mjs";
import { validateBaselineManifest } from "./migration-baseline-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "node --import tsx scripts/adopt-migration-baseline.mts --database <name> --check | --apply --actor <operator> --reason <reason> --backup <verified-backup-reference>";

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    if (!["--database", "--check", "--apply", "--actor", "--reason", "--backup"].includes(flag) || options.has(flag)) throw new Error(usage);
    if (["--check", "--apply"].includes(flag)) options.set(flag, "true");
    else {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("--")) throw new Error(usage);
      options.set(flag, value);
    }
  }
  if (!options.has("--database") || options.has("--check") === options.has("--apply")) throw new Error(usage);
  const apply = options.has("--apply");
  if (apply && ["--actor", "--reason", "--backup"].some((flag) => !options.has(flag))) throw new Error(usage);
  const rawUrl = process.env.OPENBOOKS_BASELINE_TARGET_URL;
  if (!rawUrl) throw new Error("set OPENBOOKS_BASELINE_TARGET_URL explicitly; application .env credentials are never used for baseline adoption");
  const url = new URL(rawUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || decodeURIComponent(url.pathname.slice(1)) !== options.get("--database")) throw new Error("the explicitly named database must match OPENBOOKS_BASELINE_TARGET_URL");
  const directory = join(root, "schema/migrations");
  const manifest = JSON.parse(readFileSync(join(directory, "baseline.json"), "utf8"));
  validateBaselineManifest(manifest, directory);
  const expected = JSON.parse(readFileSync(join(directory, `${manifest.filename}.catalog.json`), "utf8"));
  if (baselineDigest(JSON.stringify(expected)) !== manifest.catalogSha256) throw new Error("release catalog evidence differs from its verified digest");
  const client = new pg.Client({ connectionString: rawUrl });
  await client.connect();
  try {
    await client.query(apply ? "begin isolation level repeatable read" : "begin isolation level repeatable read read only");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='60s'");
    await client.query("select set_config('app.bypass_rls','on',true)");
    const role = (await client.query("select rolsuper or rolbypassrls as privileged from pg_roles where rolname=current_user")).rows[0];
    if (!role?.privileged) throw new Error("baseline verification requires an explicitly supplied superuser or BYPASSRLS maintenance login so no system registry is hidden");
    if (apply) {
      await client.query("select pg_advisory_xact_lock(hashtextextended('openbooks:deployment-bootstrap',0))");
      const others = (await client.query("select count(*)::int as n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and backend_type='client backend'")).rows[0].n;
      if (others) throw new Error(`baseline adoption requires maintenance mode: ${others} other database client session(s) remain; stop application services and maintenance clients, then retry`);
    }
    const actual = await baselineCatalog(client);
    assertBaselineCatalogsEqual(expected, actual);
    if (!apply) {
      await client.query("rollback");
      console.log(`VERIFIED ${options.get("--database")}: schema, security attributes and system registries match ${manifest.filename}; no changes made`);
      return;
    }
    await client.query("create table if not exists public._applied_migrations (filename text primary key,sha256 text not null,applied_at timestamptz not null default now())");
    const before = (await client.query("select filename,sha256,applied_at from public._applied_migrations order by filename for update")).rows;
    const existing = before.find((row) => row.filename === manifest.filename);
    if (existing && existing.sha256 !== manifest.baselineSha256) throw new Error("release baseline identity already exists with a different digest; investigate the ledger before adopting it");
    if (existing) {
      await client.query("rollback");
      console.log(`VERIFIED ${manifest.filename} already adopted; no changes made`);
      return;
    }
    // The audit belongs to the installation migration ledger, never to one
    // tenant's transactional history. Historical ledger rows remain intact.
    await client.query("create schema if not exists openbooks_migrations");
    await client.query("revoke all on schema openbooks_migrations from public");
    await client.query(`create table if not exists openbooks_migrations.baseline_adoptions (
      filename text primary key, sha256 text not null, catalog_sha256 text not null,
      adopted_at timestamptz not null default now(), database_name text not null,
      database_role text not null, actor text not null, reason text not null,
      backup_reference text not null, previous_ledger jsonb not null)`);
    await client.query("insert into public._applied_migrations (filename,sha256) values ($1,$2)", [manifest.filename, manifest.baselineSha256]);
    const audit = await client.query(`insert into openbooks_migrations.baseline_adoptions
      (filename,sha256,catalog_sha256,database_name,database_role,actor,reason,backup_reference,previous_ledger)
      values ($1,$2,$3,current_database(),current_user,$4,$5,$6,$7::jsonb)`,
    [manifest.filename, manifest.baselineSha256, manifest.catalogSha256, options.get("--actor"), options.get("--reason"), options.get("--backup"), JSON.stringify(before)]);
    if (audit.rowCount !== 1) throw new Error("baseline adoption audit was not persisted; adoption is refused");
    await client.query("commit");
    console.log(`adopted ${manifest.filename}; historical ledger and tenant data preserved`);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

/** Replay immutable inputs and prove a release baseline in disposable databases. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { canonicalizePgDump, extractHandwrittenAnnotations } from "./regenerate-canonical-baseline.mjs";
import { assertBaselineCatalogsEqual, BASELINE_REGISTRIES, baselineCatalog, baselineDigest, baselineRegistrySql } from "./migration-baseline-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(root, "schema/migrations");
const PINNED_IMAGE = "postgres:16.9-alpine3.22@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7";
const usage = "node --import tsx scripts/prepare-migration-baseline.mts --output <new-directory> [--container openbooks-testdb]";

function argumentsOf(argv: string[]) {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!["--output", "--container"].includes(flag) || options.has(flag) || !value || value.startsWith("--")) throw new Error(usage);
    options.set(flag, value);
  }
  if (!options.has("--output")) throw new Error(usage);
  return { output: resolve(options.get("--output")!), container: options.get("--container") ?? "openbooks-testdb" };
}

async function main() {
  const { output, container } = argumentsOf(process.argv.slice(2));
  // The replay imports the production executor, which resolves its pools on
  // import. Require an explicitly named local resource before loading it.
  const rawUrl = process.env.OPENBOOKS_BASELINE_ADMIN_URL;
  if (!rawUrl) throw new Error("set OPENBOOKS_BASELINE_ADMIN_URL to the disposable local PostgreSQL administrator URL");
  const adminUrl = new URL(rawUrl);
  if (!["postgres:", "postgresql:"].includes(adminUrl.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname)
      || adminUrl.pathname !== "/postgres") {
    throw new Error("baseline preparation requires a loopback PostgreSQL URL naming /postgres; remote and tenant databases are refused");
  }
  const image = execFileSync("docker", ["inspect", "--format", "{{.Config.Image}}", container], { encoding: "utf8" }).trim();
  if (image !== PINNED_IMAGE) throw new Error("baseline replay and pg_dump must use the release-pinned PostgreSQL image");
  const dockerPort = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", container], { encoding: "utf8" }));
  if (!dockerPort["5432/tcp"]?.some((entry: { HostPort: string }) => entry.HostPort === (adminUrl.port || "5432"))) {
    throw new Error("administrator URL must name the pinned container's published PostgreSQL port");
  }
  mkdirSync(output); // An existing evidence directory is never overwritten.
  const files = readdirSync(join(migrations, "generated")).filter((file) => file.endsWith(".sql")).sort();
  const ordinals = files.map((file) => /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file)?.[1]);
  if (files[0] !== "0001_baseline.sql" || ordinals.some((value) => !value) || new Set(ordinals).size !== files.length) throw new Error("migration inputs must have unique four-digit ordinals rooted at 0001_baseline.sql");
  const inputs = files.map((file) => ({ filename: `generated/${file}`, content: readFileSync(join(migrations, "generated", file), "utf8") }));
  const environment = readFileSync(join(migrations, "environments.sql"), "utf8");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const sourceStatus = execFileSync("git", ["status", "--porcelain", "--", "schema/migrations"], { cwd: root, encoding: "utf8" });
  const suffix = randomBytes(6).toString("hex");
  const names = [`openbooks_baseline_replay_${suffix}`, `openbooks_baseline_fresh_${suffix}`, `openbooks_baseline_fallback_${suffix}`];
  const clients: pg.Client[] = [];
  const created: string[] = [];
  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  try {
    const identity = (await admin.query("select current_setting('server_version_num') as version, (select rolsuper from pg_roles where rolname=current_user) as superuser")).rows[0];
    if (identity.version !== "160009" || !identity.superuser) throw new Error("baseline preparation requires the pinned PostgreSQL 16.9 disposable superuser");
    for (const name of names) {
      await admin.query(`create database ${name} template template0`);
      created.push(name);
      const url = new URL(rawUrl);
      url.pathname = `/${name}`;
      const client = new pg.Client({ connectionString: url.href });
      await client.connect();
      clients.push(client);
      await client.query("select set_config('app.bypass_rls','on',false)");
      await client.query("create table public._applied_migrations (filename text primary key, sha256 text not null, applied_at timestamptz not null default now())");
    }
    process.env.NODE_ENV = "test";
    const executorUrl = new URL(rawUrl);
    executorUrl.pathname = `/${names[0]}`;
    process.env.OPENBOOKS_DB_URL = executorUrl.href;
    process.env.OPENBOOKS_MIGRATION_DB_URL = executorUrl.href;
    process.env.OPENBOOKS_BYPASS_DB_URL = executorUrl.href;
    const executor = await import("./bootstrap-migration-client.ts");
    const governed = await import("./bootstrap/governed-views.ts");
    const [replay, fresh] = clients as [pg.Client, pg.Client];
    for (const input of inputs) {
      console.log(`[baseline] replay ${input.filename}`);
      try {
        await executor.executeMigrationAttempt(replay as unknown as pg.PoolClient, {
          filename: input.filename,
          body: executor.sanitizeMigrationContent(input.content),
          digest: baselineDigest(input.content),
          transactional: !executor.migrationRunsWithoutTransaction(input.content),
          lock: executor.migrationLockConfig({}),
          executeBody: input.filename === governed.ORDER_QUANTITY_PROGRESS_MIGRATION_FILENAME
            ? (client, body) => governed.executeOrderQuantityProgressMigration(client, body, baselineDigest(input.content))
            : executor.executeMigrationBody,
        });
      } catch (error) {
        throw new Error(`baseline replay failed at ${input.filename}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    await replay.query(environment);
    // Ordinary bootstrap grants the read-only role access to the application schema.
    await replay.query("grant usage on schema public to openbooks_read");
    await replay.query("select public.openbooks_refresh_query_catalog()");
    const catalog = await baselineCatalog(replay);
    // Discover every nonempty table. Omitting a new system seed is a refusal,
    // never a successful schema-only cut. Tenant data cannot enter this dump.
    const tables = (await replay.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
    const unreviewedSeeds: string[] = [];
    for (const { tablename } of tables) {
      if (tablename === "_applied_migrations" || Object.hasOwn(BASELINE_REGISTRIES, tablename)) continue;
      const exists = (await replay.query(`select exists(select 1 from public."${tablename.replaceAll('"','""')}" limit 1) as present`)).rows[0].present;
      if (exists) unreviewedSeeds.push(tablename);
    }
    if (unreviewedSeeds.length) throw new Error(`unreviewed nonempty baseline tables: ${unreviewedSeeds.join(", ")}; classify and preserve their system seeds before cutting the release`);
    const rawDump = execFileSync("docker", ["exec", container, "pg_dump", "-U", decodeURIComponent(adminUrl.username), "-d", names[0]!,
      "--format=plain", "--schema-only", "--encoding=UTF8", "--no-owner", "--no-tablespaces", "--no-table-access-method",
      "--no-security-labels", "--no-publications", "--no-subscriptions", "--strict-names", "--schema=public", "--schema=openbooks_query",
      "--extension=btree_gist", "--extension=pgcrypto", "--extension=pg_trgm",
      "--exclude-table=public._applied_migrations"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(output, "raw-schema.sql"), rawDump);
    writeFileSync(join(output, "replay-catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    const registrySql = baselineRegistrySql(catalog);
    const dumpObjects = new Set([...rawDump.matchAll(/^-- Name: (.+)$/gm)].map((match) => match[1]));
    // Historical SQL keeps rationale for removed objects. Preserve annotations
    // for surviving objects without editing that immutable source baseline.
    const annotations = new Map([...extractHandwrittenAnnotations(inputs[0]!.content)]
      .filter(([name]) => dumpObjects.has(name)));
    const canonical = canonicalizePgDump(rawDump, {
      annotations,
      registryRelations: catalog.openbooks_query_catalog_relations.map((row: { relation: string }) => row.relation),
    }).replace("SELECT public.openbooks_refresh_query_catalog();", `${registrySql}\nSELECT public.openbooks_refresh_query_catalog();`);
    writeFileSync(join(output, "0001_baseline.sql"), canonical);
    writeFileSync(join(output, "replay-catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    await executor.executeMigrationAttempt(fresh as unknown as pg.PoolClient, {
      filename: "0001_baseline.sql", body: executor.sanitizeMigrationContent(canonical), digest: baselineDigest(canonical),
      transactional: true, lock: executor.migrationLockConfig({}), executeBody: executor.executeMigrationBody,
    });
    const freshCatalog = await baselineCatalog(fresh);
    writeFileSync(join(output, "fresh-catalog.json"), JSON.stringify(freshCatalog, null, 2) + "\n");
    assertBaselineCatalogsEqual(catalog, freshCatalog);
    // Exercise the optional-extension refusal against PostgreSQL itself:
    // a provider that cannot install pg_trgm must still install the schema.
    const fallback = clients[2]!;
    await fallback.query("begin");
    await fallback.query(canonical.replace("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;", "RAISE insufficient_privilege;"));
    await fallback.query("set search_path = public, pg_catalog");
    await fallback.query("commit");
    const fallbackCatalog = await baselineCatalog(fallback);
    assertBaselineCatalogsEqual(catalog, fallbackCatalog);
    writeFileSync(join(output, "fallback-catalog.json"), JSON.stringify(fallbackCatalog, null, 2) + "\n");
    const currentFiles = readdirSync(join(migrations, "generated")).filter((file) => file.endsWith(".sql")).sort();
    if (JSON.stringify(currentFiles) !== JSON.stringify(files)
        || inputs.some((input) => readFileSync(join(migrations, input.filename), "utf8") !== input.content)
        || readFileSync(join(migrations, "environments.sql"), "utf8") !== environment) {
      throw new Error("migration inputs changed during baseline preparation; rerun on the final release tree");
    }
    const manifest = {
      format: 1, sourceCommit, sourceStatus, postgresImage: PINNED_IMAGE,
      baselineSha256: baselineDigest(canonical), catalogSha256: baselineDigest(JSON.stringify(catalog)),
      environmentSha256: baselineDigest(environment),
      covered: inputs.map(({ filename, content }) => ({ filename, sha256: baselineDigest(content) })),
      verified: true,
    };
    writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`[baseline] VERIFIED ${inputs.length} migrations; fresh schema and system registries match replay`);
    console.log(`[baseline] ${output}`);
    if (sourceStatus) console.log("[baseline] candidate includes uncommitted migration inputs; rerun after those changes land before releasing");
  } finally {
    for (const client of clients) await client.end();
    for (const name of created.reverse()) await admin.query(`drop database ${name}`);
    await admin.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

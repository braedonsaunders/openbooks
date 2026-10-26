/** Build a fresh installation of this tree and prove a release baseline in disposable databases. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  canonicalizePgDump,
  extractHandwrittenAnnotations,
} from "./regenerate-canonical-baseline.mjs";
import {
  assertBaselineCatalogsEqual,
  BASELINE_REGISTRIES,
  baselineCatalog,
  baselineDigest,
  baselineRegistrySql,
  catalogPrivilegeSql,
  MIGRATION_LEDGER_TABLES,
} from "./migration-baseline-catalog.mjs";
import { releaseMigrationPlan } from "./migration-baseline-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(root, "schema/migrations");
const PINNED_IMAGE =
  "postgres:16.9-alpine3.22@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7";
const usage =
  "node --import tsx scripts/prepare-migration-baseline.mts --output <new-directory> [--container openbooks-testdb]";

type Identity = { filename: string; sha256: string };

function argumentsOf(argv: string[]) {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (
      !["--output", "--container"].includes(flag) ||
      options.has(flag) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error(usage);
    options.set(flag, value);
  }
  if (!options.has("--output")) throw new Error(usage);
  return {
    output: resolve(options.get("--output")!),
    container: options.get("--container") ?? "openbooks-testdb",
  };
}

/** Every migration identity an installation of this tree records, in apply order. */
function releaseInputs(): {
  plan: Identity[];
  previous: { filename: string; sha256: string; covered: Identity[] } | null;
} {
  const generated = readdirSync(join(migrations, "generated"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const { baseline, filenames } = releaseMigrationPlan(migrations, generated);
  const plan = filenames.map((filename: string) => ({
    filename,
    sha256: baselineDigest(readFileSync(join(migrations, filename))),
  }));
  return {
    plan,
    previous: baseline
      ? { filename: baseline.filename, sha256: baseline.baselineSha256, covered: baseline.covered }
      : null,
  };
}

async function main() {
  const { output, container } = argumentsOf(process.argv.slice(2));
  const rawUrl = process.env.OPENBOOKS_BASELINE_ADMIN_URL;
  if (!rawUrl)
    throw new Error(
      "set OPENBOOKS_BASELINE_ADMIN_URL to the disposable local PostgreSQL administrator URL",
    );
  const adminUrl = new URL(rawUrl);
  if (
    !["postgres:", "postgresql:"].includes(adminUrl.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname) ||
    adminUrl.pathname !== "/postgres"
  ) {
    throw new Error(
      "baseline preparation requires a loopback PostgreSQL URL naming /postgres; remote and tenant databases are refused",
    );
  }
  const image = execFileSync("docker", ["inspect", "--format", "{{.Config.Image}}", container], {
    encoding: "utf8",
  }).trim();
  if (image !== PINNED_IMAGE)
    throw new Error(
      "baseline installation and pg_dump must use the release-pinned PostgreSQL image",
    );
  const dockerPort = JSON.parse(
    execFileSync("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", container], {
      encoding: "utf8",
    }),
  );
  if (
    !dockerPort["5432/tcp"]?.some(
      (entry: { HostPort: string }) => entry.HostPort === (adminUrl.port || "5432"),
    )
  ) {
    throw new Error("administrator URL must name the pinned container's published PostgreSQL port");
  }
  mkdirSync(output); // An existing evidence directory is never overwritten.
  const inputs = releaseInputs();
  if (!inputs.plan.length)
    throw new Error("this tree has no migrations to cut into a release baseline");
  const environment = readFileSync(join(migrations, "environments.sql"), "utf8");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const sourceStatus = execFileSync("git", ["status", "--porcelain", "--", "schema/migrations"], {
    cwd: root,
    encoding: "utf8",
  });
  const suffix = randomBytes(6).toString("hex");
  const names = [
    `openbooks_baseline_install_${suffix}`,
    `openbooks_baseline_fresh_${suffix}`,
    `openbooks_baseline_fallback_${suffix}`,
  ];
  const clients: pg.Client[] = [];
  const created: string[] = [];
  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  const urlFor = (name: string) => {
    const url = new URL(rawUrl);
    url.pathname = `/${name}`;
    return url.href;
  };
  try {
    const identity = (
      await admin.query(
        "select current_setting('server_version_num') as version, (select rolsuper from pg_roles where rolname=current_user) as superuser",
      )
    ).rows[0];
    if (identity.version !== "160009" || !identity.superuser)
      throw new Error(
        "baseline preparation requires the pinned PostgreSQL 16.9 disposable superuser",
      );
    for (const name of names) {
      await admin.query(`create database ${name} template template0`);
      created.push(name);
    }
    // The installation the baseline must reproduce is the one a fresh
    // deployment of this tree receives: the native bootstrap with its
    // reviewed execution rules, prerequisite order, tenant-policy environment
    // and governed views. A schema-only restore target seeds no organization,
    // so no tenant data can enter the dump.
    console.log(
      `[baseline] installing ${inputs.plan.length} release migration identities through native bootstrap`,
    );
    execFileSync(process.execPath, ["--import", "tsx", "scripts/bootstrap.ts"], {
      cwd: root,
      stdio: "inherit",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "test",
        OPENBOOKS_DB_URL: urlFor(names[0]!),
        OPENBOOKS_RESTORE_TARGET: "1",
        OPENBOOKS_DATA_KEY: randomBytes(32).toString("hex"),
        SESSION_SECRET: randomBytes(32).toString("hex"),
      },
    });
    for (const name of names) {
      const client = new pg.Client({ connectionString: urlFor(name) });
      await client.connect();
      clients.push(client);
      await client.query("select set_config('app.bypass_rls','on',false)");
    }
    const [install, fresh, fallback] = clients as [pg.Client, pg.Client, pg.Client];
    const recorded = (
      await install.query<Identity>(
        "select filename, sha256 from public._applied_migrations where filename <> 'environments.sql' order by filename",
      )
    ).rows;
    const expected = [...inputs.plan].sort((a, b) =>
      a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0,
    );
    if (JSON.stringify(recorded) !== JSON.stringify(expected))
      throw new Error(
        "the fresh installation's migration ledger differs from this tree's release plan; inspect bootstrap output before cutting the release",
      );
    const catalog = await baselineCatalog(install);
    // Discover every nonempty table. Omitting a new system seed is a refusal,
    // never a successful schema-only cut. Tenant data cannot enter this dump.
    const tables = (
      await install.query(
        "select schemaname, tablename from pg_tables where schemaname in ('public','tenant_retirement') order by 1,2",
      )
    ).rows;
    const unreviewedSeeds: string[] = [];
    for (const { schemaname, tablename } of tables) {
      if (
        schemaname === "public" &&
        (MIGRATION_LEDGER_TABLES.includes(tablename) ||
          Object.hasOwn(BASELINE_REGISTRIES, tablename))
      )
        continue;
      const relation = `"${schemaname}"."${tablename.replaceAll('"', '""')}"`;
      const exists = (
        await install.query(`select exists(select 1 from ${relation} limit 1) as present`)
      ).rows[0].present;
      if (exists) unreviewedSeeds.push(`${schemaname}.${tablename}`);
    }
    if (unreviewedSeeds.length)
      throw new Error(
        `unreviewed nonempty baseline tables: ${unreviewedSeeds.join(", ")}; classify and preserve their system seeds before cutting the release`,
      );
    // The private retirement authority is application schema the maintenance
    // login owns; bootstrap hands every other object to the business owner.
    const rawDump = execFileSync(
      "docker",
      [
        "exec",
        container,
        "pg_dump",
        "-U",
        decodeURIComponent(adminUrl.username),
        "-d",
        names[0]!,
        "--format=plain",
        "--schema-only",
        "--encoding=UTF8",
        "--no-owner",
        "--no-tablespaces",
        "--no-table-access-method",
        "--no-security-labels",
        "--no-publications",
        "--no-subscriptions",
        "--strict-names",
        "--schema=public",
        "--schema=openbooks_query",
        "--schema=tenant_retirement",
        "--extension=btree_gist",
        "--extension=pgcrypto",
        "--extension=pg_trgm",
        ...MIGRATION_LEDGER_TABLES.map((table) => `--exclude-table=public.${table}`),
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    writeFileSync(join(output, "raw-schema.sql"), rawDump);
    writeFileSync(join(output, "replay-catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    // A schema-scoped dump omits system-function privileges; derive them.
    const registrySql = `${baselineRegistrySql(catalog)}\n${await catalogPrivilegeSql(install)}\n`;
    const dumpObjects = new Set(
      [...rawDump.matchAll(/^-- Name: (.+)$/gm)].map((match) => match[1]),
    );
    // Carry reviewed object annotations forward from the active baseline for
    // objects that still exist.
    const annotationSource = inputs.previous?.filename ?? inputs.plan[0]!.filename;
    const annotations = new Map(
      [
        ...extractHandwrittenAnnotations(readFileSync(join(migrations, annotationSource), "utf8")),
      ].filter(([name]) => dumpObjects.has(name)),
    );
    const canonical = canonicalizePgDump(rawDump, {
      annotations,
      registryRelations: catalog.openbooks_query_catalog_relations.map(
        (row: { relation: string }) => row.relation,
      ),
    }).replace(
      "SELECT public.openbooks_refresh_query_catalog();",
      `${registrySql}\nSELECT public.openbooks_refresh_query_catalog();`,
    );
    writeFileSync(join(output, "baseline.sql"), canonical);
    const executor = await import("./bootstrap-migration-client.ts");
    await fresh.query(
      "create table public._applied_migrations (filename text primary key, sha256 text not null, applied_at timestamptz not null default now())",
    );
    await executor.executeMigrationAttempt(fresh as unknown as pg.PoolClient, {
      filename: "baseline.sql",
      body: executor.sanitizeMigrationContent(canonical),
      digest: baselineDigest(canonical),
      transactional: true,
      lock: executor.migrationLockConfig({}),
      executeBody: executor.executeMigrationBody,
    });
    const freshCatalog = await baselineCatalog(fresh);
    writeFileSync(join(output, "fresh-catalog.json"), JSON.stringify(freshCatalog, null, 2) + "\n");
    assertBaselineCatalogsEqual(catalog, freshCatalog);
    // Exercise the optional-extension refusal against PostgreSQL itself:
    // a provider that cannot install pg_trgm must still install the schema.
    await fallback.query("begin");
    await fallback.query(
      canonical.replace(
        "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;",
        "RAISE insufficient_privilege;",
      ),
    );
    await fallback.query("set search_path = public, pg_catalog");
    await fallback.query("commit");
    const fallbackCatalog = await baselineCatalog(fallback);
    assertBaselineCatalogsEqual(catalog, fallbackCatalog);
    writeFileSync(
      join(output, "fallback-catalog.json"),
      JSON.stringify(fallbackCatalog, null, 2) + "\n",
    );
    if (
      JSON.stringify(releaseInputs()) !== JSON.stringify(inputs) ||
      readFileSync(join(migrations, "environments.sql"), "utf8") !== environment
    ) {
      throw new Error(
        "migration inputs changed during baseline preparation; rerun on the final release tree",
      );
    }
    // `upgradeFrom` is the exact ledger an existing installation of this tree
    // holds; adoption requires it. `covered` is every historical identity the
    // baseline subsumes, so application-side upgrade steps keyed to a
    // migration identity stay answerable after the source files are retired.
    const covered = new Map<string, Identity>();
    for (const entry of [...(inputs.previous?.covered ?? []), ...inputs.plan]) {
      const prior = covered.get(entry.filename);
      if (prior && prior.sha256 !== entry.sha256)
        throw new Error(`migration identity ${entry.filename} has two digests in release history`);
      covered.set(entry.filename, entry);
    }
    const manifest = {
      format: 2,
      sourceCommit,
      sourceStatus,
      postgresImage: PINNED_IMAGE,
      baselineSha256: baselineDigest(canonical),
      catalogSha256: baselineDigest(JSON.stringify(catalog)),
      environmentSha256: baselineDigest(environment),
      upgradeFrom: inputs.plan,
      covered: [...covered.values()],
      verified: true,
    };
    writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(
      `[baseline] VERIFIED fresh installation of ${inputs.plan.length} release identities (${covered.size} historical migrations); baseline schema and system registries match`,
    );
    console.log(`[baseline] ${output}`);
    if (sourceStatus)
      console.log(
        "[baseline] candidate includes uncommitted migration inputs; rerun after those changes land before releasing",
      );
  } finally {
    for (const client of clients) await client.end();
    for (const name of created.reverse()) await admin.query(`drop database ${name} with (force)`);
    await admin.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

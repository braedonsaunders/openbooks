/** Tracked migration apply, preflight gate, upgrade check, and the payment-link seal. Split from scripts/bootstrap.ts (pure moves only). */
import { repoRoot, migrationsDir, sha256 } from "../bootstrap-paths";
import { applyRowLevelSecurity } from "./database-roles";
import { generatedMigrationFiles } from "./migration-files";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { join } from "node:path";
import { sealLegacyPaymentLinkTokens } from "@openbooks/engine/payments/payment-link-seal";
import { requireDataKey } from "@openbooks/engine/platform/secrets";
import { sql } from "drizzle-orm";
import { db, env, pool } from "@openbooks/engine/platform/db";
import {
  connectMigrationClient,
  describeBootstrapMigrationFailure,
  executeMigrationAttempt,
  executeMigrationBody,
  isLockNotAvailable,
  migrationLockConfig,
  migrationRetryDelayMs,
  migrationRunsWithoutTransaction,
  releaseMigrationClient,
  sanitizeMigrationContent,
} from "../bootstrap-migration-client.ts";
import {
  assertReadOnlyPreflight,
  earlierPendingCreatesObject,
  evaluatePreflight,
  formatFinding,
  preflightDecisionFor,
  preflightDirFor,
  preflightStatementTimeoutMs,
  readNoneReason,
  readPreflightSql,
  validateFindingRows,
  type PreflightFinding,
} from "../migration-preflight.ts";
import { assertBaselineHistory, releaseMigrationPlan } from "../migration-baseline-plan.mjs";
import { ensureRetirementAuthorityOwnership } from "./retirement-ownership.ts";
import {
  migrationBusinessOwnerRole,
  migrationRequiresMaintenanceAuthority,
} from "../migration-owner-authority.ts";

/** Business DDL retains the installation's restricted owner. Catalog and
 * private-authority publishers keep the maintenance session's authority. */
async function provisionedSchemaOwnerRole(client: pg.PoolClient): Promise<string | undefined> {
  const row = (
    await client.query<{ owner: string; privileged: boolean; current: string }>(`select
      n.nspowner::regrole::text as owner, current_user::text as current,
      coalesce((select rolsuper from pg_roles where rolname=session_user), false) as privileged
    from pg_namespace n where n.nspname='public'`)
  ).rows[0];
  if (!row?.privileged) return undefined;
  if (env.OPENBOOKS_PRECREATED_ROLES === "1") {
    const provisioned = (
      await client.query<{ owner: string; safe: boolean }>(`select r.rolname as owner,
      not (r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication) as safe
      from pg_database d join pg_roles r on r.oid=d.datdba where d.datname=current_database()`)
    ).rows[0];
    if (!provisioned?.safe)
      throw new Error(
        "Host-managed installation requires a restricted database owner distinct from its maintenance administrator",
      );
    return provisioned.owner;
  }
  const established = (
    await client.query<{
      owner: string;
      safe: boolean;
      isolated: boolean;
    }>(`select r.rolname as owner,
      not (r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication) as safe,
      not pg_has_role(b.relowner,a.relowner,'MEMBER') as isolated
    from pg_class b join pg_roles r on r.oid=b.relowner cross join pg_class a
    where b.oid=to_regclass('public.orgs') and a.oid=to_regclass('tenant_retirement.runs')`)
  ).rows[0];
  if (established?.safe && established.isolated && established.owner !== row.current)
    return established.owner;
  if (row.owner !== "openbooks_schema_owner" || row.current === row.owner) return undefined;
  return row.owner;
}

async function executeTrackedMigration(
  filename: string,
  content: string,
  digest: string,
  deferredPreflight?: DeferredPreflight,
): Promise<void> {
  // Long DDL rides the timeout-free maintenance pool: the request pool's 120s
  // client query_timeout aborts the whole-schema baseline on a slow host.
  //
  // Lock discipline: every migration used to run with `SET lock_timeout = 0`
  // in its own body, each in one transaction while the old stack keeps
  // serving traffic — an ALTER TABLE queued behind a long report query waits
  // forever, and every later query on that table queues behind the
  // migration. Published files are immutable, so they cannot be rewritten;
  // the runner strips their file-level lock_timeout statements instead and
  // imposes its own bound per attempt (SET LOCAL inside the transaction, a
  // session SET around a no-transaction file). On an empty database — a
  // fresh install — there is no concurrent traffic to contend with, so the
  // old unbounded files were harmless there; with the strip they run under
  // the same bound as everything else, so fresh installs need no special
  // case. A lock_timeout firing (SQLSTATE 55P03) retries the whole attempt
  // with backoff; anything else fails the deploy at once, because retrying
  // a half-applied non-idempotent migration would run its body twice.
  const started = Date.now();
  const lock = migrationLockConfig(env);
  const body = sanitizeMigrationContent(content);
  const transactional = !migrationRunsWithoutTransaction(content);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const client = await connectMigrationClient();
    try {
      // No-transaction files (CREATE INDEX CONCURRENTLY and friends) run
      // statement by statement with no BEGIN/COMMIT — the contract is
      // strict (every statement idempotent, INVALID indexes dropped up
      // front) because a failure mid-file leaves earlier statements
      // committed and the retry replays the whole body.
      await executeMigrationAttempt(client, {
        filename,
        body,
        transactional,
        lock,
        digest,
        beforeBody: deferredPreflight
          ? async (migrationClient) => {
              assertReadOnlyPreflight(deferredPreflight.filename, deferredPreflight.sql);
              await migrationClient.query(
                `set local statement_timeout = ${preflightStatementTimeoutMs(env)}`,
              );
              const result = await migrationClient.query<Record<string, unknown>>(
                deferredPreflight.sql,
              );
              const findings = validateFindingRows(
                deferredPreflight.filename,
                deferredPreflight.ordinal,
                result.rows,
              );
              printPreflightFindings(findings);
              const codes = findings
                .filter((finding) => finding.severity === "refuse")
                .map((finding) => finding.code);
              if (codes.length)
                throw new Error(
                  `[bootstrap] migration preflight ${filename} refuses this upgrade (${[...new Set(codes)].join(", ")}); this migration and its ledger record were not applied`,
                );
              await migrationClient.query("set local statement_timeout = 0");
            }
          : undefined,
        schemaOwnerRole: migrationBusinessOwnerRole(
          filename,
          digest,
          await provisionedSchemaOwnerRole(client),
        ),
        executeBody: executeMigrationBody,
      });
      return;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      if (isLockNotAvailable(err) && attempt < lock.maxAttempts) {
        const backoffMs = migrationRetryDelayMs(lock, attempt);
        console.log(
          `[bootstrap] ${filename} could not acquire a lock on attempt ` +
            `${attempt}/${lock.maxAttempts} (lock_timeout ${lock.lockTimeoutMs}ms); ` +
            `retrying in ${backoffMs}ms`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw new Error(describeBootstrapMigrationFailure(filename, err, Date.now() - started));
    } finally {
      await releaseMigrationClient(client);
    }
  }
}

async function applyTracked(
  label: string,
  filename: string,
  content: string,
  deferredPreflight?: DeferredPreflight,
): Promise<boolean> {
  const digest = sha256(content);
  const seen = await db.execute<{ sha256: string }>(sql`
    select sha256 from public._applied_migrations where filename = ${filename}
  `);
  const recordedRow = seen.rows[0];
  if (recordedRow) {
    if (recordedRow.sha256 !== digest) {
      throw new Error(
        `[bootstrap] ${filename} changed after it was applied; published migrations are immutable`,
      );
    }
    return false;
  }
  console.log(`[bootstrap] applying ${label}: ${filename}`);
  await executeTrackedMigration(filename, content, digest, deferredPreflight);
  return true;
}

type PendingMigrationItem = {
  file: string;
  filename: string;
  ordinal: string;
  content: string;
};

type DeferredPreflight = {
  file: string;
  filename: string;
  ordinal: string;
  sql: string;
};

type PendingPreflightReport = {
  findings: PreflightFinding[];
  deferred: DeferredPreflight[];
  noPreflight: { migration: string; reason: string }[];
  missingDecisions: string[];
  evaluated: string[];
  leastPrivilege: boolean;
};

async function appliedMigrationsTableExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "select to_regclass('public._applied_migrations') is not null as exists",
  );
  return result.rows[0]!.exists;
}

async function readAppliedMigrationFilenames(): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>(
    "select filename from public._applied_migrations",
  );
  return new Set(result.rows.map((row) => row.filename));
}

function pendingMigrationItems(
  filenames: readonly string[],
  applied: ReadonlySet<string>,
): PendingMigrationItem[] {
  const pending: PendingMigrationItem[] = [];
  for (const filename of filenames) {
    const f = filename.split("/").at(-1)!;
    if (applied.has(filename)) continue;
    if (!filename.startsWith("generated/")) continue;
    pending.push({
      file: f,
      filename,
      ordinal: f.slice(0, 4),
      content: readFileSync(join(migrationsDir, filename), "utf8"),
    });
  }
  return pending;
}

/**
 * Contents of every migration without a ledger row, in prerequisite order. A
 * deferred preflight can only be explained by an earlier migration that is
 * still unapplied.
 */
function readUnappliedContents(
  filenames: readonly string[],
  applied: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const filename of filenames) {
    if (!applied.has(filename)) {
      out.set(filename, readFileSync(join(migrationsDir, filename), "utf8"));
    }
  }
  return out;
}

function listPreflightEntries(): Set<string> {
  try {
    return new Set(readdirSync(preflightDirFor(repoRoot)));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return new Set();
    throw error;
  }
}

/**
 * Run every pending migration's preflight in prerequisite order, each in
 * BEGIN READ ONLY with bypass RLS and a bounded statement_timeout, then
 * ROLLBACK. A preflight that needs an object an earlier PENDING migration
 * creates is deferred to apply time; anything else missing is a real error.
 */
async function evaluatePendingMigrations(
  pending: readonly PendingMigrationItem[],
  options: { leastPrivilegeRole?: string },
  unappliedContents: ReadonlyMap<string, string>,
): Promise<PendingPreflightReport> {
  const report: PendingPreflightReport = {
    findings: [],
    deferred: [],
    noPreflight: [],
    missingDecisions: [],
    evaluated: [],
    leastPrivilege: true,
  };
  if (pending.length === 0) return report;
  const entries = listPreflightEntries();
  const timeoutMs = preflightStatementTimeoutMs(env);
  const preflightDir = preflightDirFor(repoRoot);
  const client = await connectMigrationClient();
  try {
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index]!;
      const decision = preflightDecisionFor(item.file, entries);
      if (decision.kind === "missing") {
        report.missingDecisions.push(item.filename);
        console.log(
          `[bootstrap] migration preflight: ${item.filename} has no decision file; ` +
            `add schema/migrations/preflight/${item.file.replace(/\.sql$/, ".sql")} or .none`,
        );
        continue;
      }
      if (decision.kind === "none") {
        report.noPreflight.push({
          migration: item.filename,
          reason: readNoneReason(preflightDir, decision.filename),
        });
        continue;
      }
      const sqlText = readPreflightSql(preflightDir, decision.filename);
      const earlierContents: string[] = [];
      for (const [filename, content] of unappliedContents) {
        if (filename === item.filename) break;
        earlierContents.push(content);
      }
      let evaluation;
      try {
        evaluation = await evaluatePreflight(client, item.filename, item.ordinal, sqlText, {
          statementTimeoutMs: timeoutMs,
          leastPrivilegeRole: options.leastPrivilegeRole,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[bootstrap] migration preflight ${item.filename} failed to evaluate: ${message}`,
        );
      }
      report.leastPrivilege = report.leastPrivilege && evaluation.leastPrivilege;
      if (evaluation.status === "deferred") {
        if (!earlierPendingCreatesObject(evaluation.reason, earlierContents, sqlText)) {
          throw new Error(
            `[bootstrap] migration preflight ${item.filename} cannot evaluate: ${evaluation.reason}; ` +
              `no earlier pending migration creates that object, so this is not a deferral — fix the preflight or the schema`,
          );
        }
        report.deferred.push({
          file: item.file,
          filename: item.filename,
          ordinal: item.ordinal,
          sql: sqlText,
        });
        console.log(
          `[bootstrap] migration preflight ${item.filename} is deferred: it needs an object an earlier ` +
            `pending migration creates, so it runs at apply time (${evaluation.reason})`,
        );
        continue;
      }
      report.evaluated.push(item.filename);
      report.findings.push(...evaluation.findings);
    }
  } finally {
    await releaseMigrationClient(client);
  }
  return report;
}

function printPreflightFindings(findings: readonly PreflightFinding[]): void {
  for (const finding of findings) {
    console.log(`[bootstrap] migration preflight finding: ${formatFinding(finding)}`);
  }
}

/**
 * A pending migration with no decision file upgrades blind: neither a
 * preflight nor a reviewed reason covers it. Refuse by name listing every
 * gap, so one run shows the whole deficit instead of one file at a time.
 */
function throwOnMissingDecisions(report: PendingPreflightReport): void {
  if (report.missingDecisions.length === 0) return;
  const missing = [...report.missingDecisions].sort();
  throw new Error(
    `[bootstrap] ${missing.length} pending migration(s) have no preflight decision file: ${missing.join(", ")}. ` +
      `Add schema/migrations/preflight/<basename>.sql or <basename>.none for each; ` +
      `see docs/operations/upgrades.md#migration-preflights. No migration was applied.`,
  );
}

/**
 * The pre-apply gate: every evaluable pending preflight has run BEFORE the
 * first migration. Any refuse finding stops bootstrap here, with every
 * finding printed and no migration applied.
 */
async function runPreflightGate(
  pending: readonly PendingMigrationItem[],
  unappliedContents: ReadonlyMap<string, string>,
): Promise<DeferredPreflight[]> {
  if (pending.length === 0) {
    console.log("[bootstrap] no pending migrations: nothing to preflight");
    return [];
  }
  const report = await evaluatePendingMigrations(pending, {}, unappliedContents);
  printPreflightFindings(report.findings);
  throwOnMissingDecisions(report);
  const refusals = report.findings.filter((finding) => finding.severity === "refuse");
  if (refusals.length > 0) {
    const codes = [...new Set(refusals.map((finding) => finding.code))].sort().join(", ");
    throw new Error(
      `[bootstrap] migration preflights refuse this upgrade (${codes}). Every finding above names its remedy; ` +
        `resolve them, then re-run bootstrap. No migration was applied.`,
    );
  }
  if (report.findings.length > 0) {
    console.log("[bootstrap] migration preflights report only notices; upgrade continues");
  } else {
    console.log(
      `[bootstrap] migration preflights clean for ${pending.length} pending migration(s)`,
    );
  }
  return report.deferred;
}

/**
 * A deferred preflight runs immediately before its own migration, when the
 * earlier migrations it needs have applied. A refusal here stops the upgrade
 * naming exactly which migrations already applied in this run.
 */
async function runDeferredPreflight(
  deferred: DeferredPreflight,
  appliedThisRun: readonly string[],
): Promise<void> {
  const client = await connectMigrationClient();
  try {
    const evaluation = await evaluatePreflight(
      client,
      deferred.filename,
      deferred.ordinal,
      deferred.sql,
      {
        statementTimeoutMs: preflightStatementTimeoutMs(env),
      },
    );
    if (evaluation.status === "deferred") {
      throw new Error(
        `[bootstrap] migration preflight ${deferred.filename} still cannot see its objects at apply time ` +
          `(${evaluation.reason}); the earlier migration that should create them did not`,
      );
    }
    printPreflightFindings(evaluation.findings);
    const refusals = evaluation.findings.filter((finding) => finding.severity === "refuse");
    if (refusals.length === 0) return;
    const codes = [...new Set(refusals.map((finding) => finding.code))].sort().join(", ");
    const applied = appliedThisRun.length > 0 ? appliedThisRun.join(", ") : "(none)";
    throw new Error(
      `[bootstrap] migration preflight ${deferred.filename} refuses this upgrade (${codes}). ` +
        `Migrations already applied in this run: ${applied}. Every finding above names its remedy; ` +
        `resolve them, then re-run bootstrap.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[bootstrap] migration preflight"))
      throw error;
    throw new Error(
      `[bootstrap] migration preflight ${deferred.filename} failed to evaluate at apply time: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await releaseMigrationClient(client);
  }
}

/**
 * Read-only upgrade check: list the pending migrations, run the evaluable
 * preflights, and print the findings. Strictly read-only — no ledger table
 * creation, no role or seed work, no RLS refresh, and no advisory lock that
 * could block a live app. Every statement is a SELECT (plus transaction
 * control), so this also runs under the SELECT-only openbooks_read role;
 * when the connecting login cannot assume it, the check says so and runs
 * as the connecting role instead. Exits 1 on any refuse finding, else 0.
 *
 * Usage: node --import tsx scripts/bootstrap.ts --check [--json]
 */
export async function runUpgradeCheckMain(json: boolean): Promise<number> {
  // Fail closed before touching the database: without a valid data key no
  // sealed credential can open, so an upgrade check must not report healthy.
  try {
    requireDataKey();
  } catch (error) {
    throw new Error(`[bootstrap] ${error instanceof Error ? error.message : String(error)}`);
  }
  const plan = releaseMigrationPlan(migrationsDir, generatedMigrationFiles());
  const ledgerPreexisted = await appliedMigrationsTableExists();
  const freshInstall = await assertReleaseBaselineReady(plan.baseline, ledgerPreexisted);
  const result = {
    freshInstall,
    pending: [] as string[],
    noPreflight: [] as { migration: string; reason: string }[],
    missingDecisions: [] as string[],
    evaluated: [] as string[],
    deferred: [] as { migration: string; reason: string }[],
    leastPrivilege: false,
    findings: [] as PreflightFinding[],
  };
  const emit = (): void => {
    if (json) {
      // One line: the rehearsal reads the last `{`-leading line as the result.
      console.log(JSON.stringify(result));
      return;
    }
    console.log(`[bootstrap] upgrade check: ${result.pending.length} pending migration(s)`);
    for (const filename of result.pending) console.log(`[bootstrap]   pending: ${filename}`);
    for (const entry of result.noPreflight) {
      console.log(`[bootstrap]   no preflight: ${entry.migration} — ${entry.reason}`);
    }
    for (const filename of result.missingDecisions) {
      console.log(
        `[bootstrap]   no decision file yet: ${filename} (add its .sql or .none under schema/migrations/preflight/)`,
      );
    }
    printPreflightFindings(result.findings);
    for (const entry of result.deferred) {
      console.log(`[bootstrap]   deferred to apply time: ${entry.migration} (${entry.reason})`);
    }
    if (result.evaluated.length > 0 && !result.leastPrivilege) {
      console.log(
        "[bootstrap] upgrade check ran as the connecting role because SET LOCAL ROLE openbooks_read was refused; " +
          "grant the check login membership in openbooks_read to prove least privilege",
      );
    }
  };
  if (freshInstall) {
    emit();
    if (!json) {
      console.log(
        "[bootstrap] upgrade check: empty installation history and schema; nothing to preflight",
      );
    }
    return 0;
  }
  const applied = await readAppliedMigrationFilenames();
  const pending = pendingMigrationItems(plan.filenames, applied);
  result.pending = pending.map((item) => item.filename);
  if (pending.length === 0) {
    emit();
    return 0;
  }
  const report = await evaluatePendingMigrations(
    pending,
    { leastPrivilegeRole: "openbooks_read" },
    readUnappliedContents(plan.filenames, applied),
  );
  result.noPreflight = report.noPreflight;
  result.missingDecisions = report.missingDecisions;
  result.evaluated = report.evaluated;
  result.deferred = report.deferred.map((deferred) => ({
    migration: deferred.filename,
    reason: "evaluated at apply time",
  }));
  const ranAnyCheck = report.evaluated.length + report.deferred.length > 0;
  result.leastPrivilege = report.leastPrivilege && ranAnyCheck;
  result.findings = report.findings;
  emit();
  throwOnMissingDecisions(report);
  const refusals = result.findings.filter((finding) => finding.severity === "refuse");
  if (refusals.length > 0) {
    if (!json) {
      console.log(
        `[bootstrap] upgrade check refused: ${refusals.length} refuse finding(s); resolve each remedy above, then re-run`,
      );
    }
    return 1;
  }
  if (!json) console.log("[bootstrap] upgrade check: no refuse findings");
  return 0;
}

export async function migrate(): Promise<void> {
  const plan = releaseMigrationPlan(migrationsDir, generatedMigrationFiles());
  const ledgerPreexisted = await appliedMigrationsTableExists();
  // A legacy database must prove adoption before role refresh, preflights or
  // schema writes can reinterpret its installation history.
  const freshInstall = await assertReleaseBaselineReady(plan.baseline, ledgerPreexisted);
  const recordedBeforeApply = ledgerPreexisted
    ? await readAppliedMigrationFilenames()
    : new Set<string>();
  const maintenance = plan.filenames.filter(
    (filename) =>
      !recordedBeforeApply.has(filename) && migrationRequiresMaintenanceAuthority(filename),
  );
  if (
    maintenance.length &&
    !(
      await pool.query<{ privileged: boolean }>(
        "select rolsuper as privileged from pg_roles where rolname=session_user",
      )
    ).rows[0]?.privileged
  ) {
    throw new Error(
      `[bootstrap] pending migrations require the database host's PostgreSQL maintenance administrator (${maintenance.join(", ")}); run this native bootstrap with that administrator as OPENBOOKS_MIGRATION_DB_URL, retaining the restricted runtime and database-owner roles. No migration was applied.`,
    );
  }
  await db.execute(sql`
    create table if not exists public._applied_migrations (
      filename text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )
  `);
  if (freshInstall && env.OPENBOOKS_PRECREATED_ROLES === "1") {
    const client = await connectMigrationClient();
    try {
      const owner = await provisionedSchemaOwnerRole(client);
      if (owner)
        await client.query(
          `alter table public._applied_migrations owner to ${pg.escapeIdentifier(owner)}`,
        );
    } finally {
      await releaseMigrationClient(client);
    }
  }

  const applied = await readAppliedMigrationFilenames();
  const pending = pendingMigrationItems(plan.filenames, applied);
  await ensureRetirementAuthorityOwnership();
  let deferred: DeferredPreflight[] = [];
  if (freshInstall) {
    console.log(
      "[bootstrap] fresh install: empty installation history and schema; nothing to preflight",
    );
  } else {
    deferred = await runPreflightGate(pending, readUnappliedContents(plan.filenames, applied));
  }

  const appliedThisRun: string[] = [];
  for (const filename of plan.filenames) {
    const content = readFileSync(join(migrationsDir, filename), "utf8");
    const deferredPreflight = deferred.find((candidate) => candidate.filename === filename);
    const transactional = !migrationRunsWithoutTransaction(content);
    if (deferredPreflight && !transactional)
      await runDeferredPreflight(deferredPreflight, appliedThisRun);
    if (
      await applyTracked(
        "migration",
        filename,
        content,
        transactional ? deferredPreflight : undefined,
      )
    )
      appliedThisRun.push(filename);
    // The baseline is applied with maintenance authority; every business
    // object then passes to the business owner before forward migrations run.
    if (filename === plan.baseline?.filename) await ensureRetirementAuthorityOwnership();
  }
  // Payment-link tokens are hashed and sealed here rather than in SQL because
  // the data key never enters a migration. The seal is idempotent and also
  // covers rows written by the previous release during a rolling deploy.
  await sealLegacyPaymentLinkTokens();
  await applyRowLevelSecurity();
  await ensureRetirementAuthorityOwnership();
}

async function assertReleaseBaselineReady(
  baseline: ReturnType<typeof releaseMigrationPlan>["baseline"],
  ledgerExists: boolean,
): Promise<boolean> {
  const recorded = ledgerExists
    ? (await pool.query("select filename, sha256 from public._applied_migrations")).rows
    : [];
  const objects = await pool.query<{ present: boolean }>(`select exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v','m','S','f')
      and c.relname <> '_applied_migrations'
      and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
    union all
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
    ) as present`);
  const schemaHasObjects = objects.rows[0]!.present;
  if (baseline) assertBaselineHistory(baseline, recorded, schemaHasObjects);
  return recorded.length === 0 && !schemaHasObjects;
}

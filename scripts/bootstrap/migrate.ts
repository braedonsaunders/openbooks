/** Tracked migration apply, preflight gate, upgrade check, and the payment-link seal. Split from scripts/bootstrap.ts (pure moves only). */
import { repoRoot, migrationsDir, sha256 } from "../bootstrap-paths"
import { applyRowLevelSecurity } from "./database-roles"
import { ORDER_QUANTITY_PROGRESS_MIGRATION_FILENAME, executeOrderQuantityProgressMigration } from "./governed-views"
import { generatedMigrationFiles, assertMigrationFilenameTransitionTargets, convergeMigrationFilenames, APPROVED_MIGRATION_TRANSITIONS } from "./migration-transitions"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { sealLegacyPaymentLinkTokens } from "../../engine/src/payments/payment-link-seal.ts"
import { sql } from "drizzle-orm"
import { db, env, pool } from "../../engine/src/platform/db.ts"
import { connectMigrationClient, describeBootstrapMigrationFailure, executeMigrationAttempt, executeMigrationBody, isLockNotAvailable, migrationLockConfig, migrationRetryDelayMs, migrationRunsWithoutTransaction, releaseMigrationClient, sanitizeMigrationContent } from "../bootstrap-migration-client.ts"
import { PREFLIGHT_MIN_ORDINAL, earlierPendingCreatesObject, evaluatePreflight, formatFinding, ordinalOf as preflightOrdinalOf, preflightDecisionFor, preflightDirFor, preflightStatementTimeoutMs, readNoneReason, readPreflightSql, type PreflightFinding } from "../migration-preflight.ts"

async function executeTrackedMigration(
  filename: string,
  content: string,
  digest: string,
  recordedDigest?: string,
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
        recordedDigest,
        executeBody:
          filename === ORDER_QUANTITY_PROGRESS_MIGRATION_FILENAME
            ? (migrationClient, migrationBody) =>
                executeOrderQuantityProgressMigration(migrationClient, migrationBody, digest)
            : executeMigrationBody,
      });
      return;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      if (isLockNotAvailable(err) && attempt < lock.maxAttempts) {
        const backoffMs = migrationRetryDelayMs(lock, attempt);
        console.log(
          `[bootstrap] ${filename} could not acquire a lock on attempt `
            + `${attempt}/${lock.maxAttempts} (lock_timeout ${lock.lockTimeoutMs}ms); `
            + `retrying in ${backoffMs}ms`,
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
): Promise<boolean> {
  const digest = sha256(content);
  const seen = (await db.execute<{ sha256: string }>(sql`
    select sha256 from public._applied_migrations where filename = ${filename}
  `));
  const recordedRow = seen.rows[0];
  if (recordedRow) {
    const recorded = recordedRow.sha256;
    if (recorded !== digest) {
      const transition = APPROVED_MIGRATION_TRANSITIONS.find(
        (entry) =>
          entry.filename === filename
          && entry.from === recorded
          && entry.to === digest,
      );
      if (!transition) {
        throw new Error(
          `[bootstrap] ${filename} changed after it was applied; published migrations are immutable`,
        );
      }
      console.log(
        `[bootstrap] ${filename} has an approved ${transition.strategy} transition (`
        + `${recorded.slice(0, 12)} -> ${digest.slice(0, 12)})`,
      );
      console.log(`[bootstrap]   ${transition.reason}`);
      if (transition.strategy === "reapply") {
        await executeTrackedMigration(filename, content, digest, recorded);
        return true;
      }
      await db.execute(sql`
        update public._applied_migrations
           set sha256 = ${digest}
         where filename = ${filename} and sha256 = ${recorded}
      `);
      return false;
    }
    return false;
  }
  console.log(`[bootstrap] applying ${label}: ${filename}`);
  await executeTrackedMigration(filename, content, digest);
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
  generated: readonly string[],
  applied: ReadonlySet<string>,
): PendingMigrationItem[] {
  const pending: PendingMigrationItem[] = [];
  for (const f of generated) {
    const filename = `generated/${f}`;
    if (applied.has(filename)) continue;
    if ((preflightOrdinalOf(f) ?? -1) < PREFLIGHT_MIN_ORDINAL) continue;
    pending.push({
      file: f,
      filename,
      ordinal: f.slice(0, 4),
      content: readFileSync(join(migrationsDir, "generated", f), "utf8"),
    });
  }
  return pending;
}

/**
 * Contents of every migration without a ledger row, in ordinal order. The
 * preflight floor (PREFLIGHT_MIN_ORDINAL) scopes which preflights run, but
 * a deferred preflight can only be explained by ANY earlier migration that
 * is still unapplied — including one below the floor, like the employment
 * column an old HR migration adds for a newer guard's preflight.
 */
function readUnappliedContents(
  generated: readonly string[],
  applied: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of generated) {
    const filename = `generated/${f}`;
    if (!applied.has(filename)) {
      out.set(filename, readFileSync(join(migrationsDir, "generated", f), "utf8"));
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
 * Run every pending migration's preflight in ordinal order, each in
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
          `[bootstrap] migration preflight: ${item.filename} has no decision file; `
            + `add schema/migrations/preflight/${item.file.replace(/\.sql$/, ".sql")} or .none`,
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
            `[bootstrap] migration preflight ${item.filename} cannot evaluate: ${evaluation.reason}; `
              + `no earlier pending migration creates that object, so this is not a deferral — fix the preflight or the schema`,
          );
        }
        report.deferred.push({ file: item.file, filename: item.filename, ordinal: item.ordinal, sql: sqlText });
        console.log(
          `[bootstrap] migration preflight ${item.filename} is deferred: it needs an object an earlier `
            + `pending migration creates, so it runs at apply time (${evaluation.reason})`,
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
    `[bootstrap] ${missing.length} pending migration(s) have no preflight decision file: ${missing.join(", ")}. `
      + `Add schema/migrations/preflight/<basename>.sql or <basename>.none for each; `
      + `see docs/operations/upgrades.md#migration-preflights. No migration was applied.`,
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
      `[bootstrap] migration preflights refuse this upgrade (${codes}). Every finding above names its remedy; `
        + `resolve them, then re-run bootstrap. No migration was applied.`,
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
    const evaluation = await evaluatePreflight(client, deferred.filename, deferred.ordinal, deferred.sql, {
      statementTimeoutMs: preflightStatementTimeoutMs(env),
    });
    if (evaluation.status === "deferred") {
      throw new Error(
        `[bootstrap] migration preflight ${deferred.filename} still cannot see its objects at apply time `
          + `(${evaluation.reason}); the earlier migration that should create them did not`,
      );
    }
    printPreflightFindings(evaluation.findings);
    const refusals = evaluation.findings.filter((finding) => finding.severity === "refuse");
    if (refusals.length === 0) return;
    const codes = [...new Set(refusals.map((finding) => finding.code))].sort().join(", ");
    const applied = appliedThisRun.length > 0 ? appliedThisRun.join(", ") : "(none)";
    throw new Error(
      `[bootstrap] migration preflight ${deferred.filename} refuses this upgrade (${codes}). `
        + `Migrations already applied in this run: ${applied}. Every finding above names its remedy; `
        + `resolve them, then re-run bootstrap.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[bootstrap] migration preflight")) throw error;
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
  const generated = generatedMigrationFiles();
  assertMigrationFilenameTransitionTargets(generated);
  const ledgerPreexisted = await appliedMigrationsTableExists();
  const result = {
    freshInstall: !ledgerPreexisted,
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
        "[bootstrap] upgrade check ran as the connecting role because SET LOCAL ROLE openbooks_read was refused; "
          + "grant the check login membership in openbooks_read to prove least privilege",
      );
    }
  };
  if (!ledgerPreexisted) {
    emit();
    if (!json) {
      console.log("[bootstrap] upgrade check: no _applied_migrations table (fresh install): nothing to preflight");
    }
    return 0;
  }
  const applied = await readAppliedMigrationFilenames();
  const pending = pendingMigrationItems(generated, applied);
  result.pending = pending.map((item) => item.filename);
  if (pending.length === 0) {
    emit();
    return 0;
  }
  const report = await evaluatePendingMigrations(
    pending,
    { leastPrivilegeRole: "openbooks_read" },
    readUnappliedContents(generated, applied),
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
  const generated = generatedMigrationFiles();
  assertMigrationFilenameTransitionTargets(generated);
  const ledgerPreexisted = await appliedMigrationsTableExists();
  await db.execute(sql`
    create table if not exists public._applied_migrations (
      filename text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )
  `);
  await convergeMigrationFilenames();

  const applied = await readAppliedMigrationFilenames();
  const pending = pendingMigrationItems(generated, applied);
  let deferred: DeferredPreflight[] = [];
  if (!ledgerPreexisted) {
    console.log("[bootstrap] fresh install: no _applied_migrations table, nothing to preflight");
  } else {
    deferred = await runPreflightGate(pending, readUnappliedContents(generated, applied));
  }

  const appliedThisRun: string[] = [];
  for (const f of generated) {
    const filename = `generated/${f}`;
    const content = readFileSync(join(migrationsDir, "generated", f), "utf8");
    const deferredPreflight = deferred.find((candidate) => candidate.filename === filename);
    if (deferredPreflight) await runDeferredPreflight(deferredPreflight, appliedThisRun);
    if (await applyTracked("migration", filename, content)) appliedThisRun.push(filename);
  }
  if (await isPaymentLinkSealApplicable()) {
    await sealLegacyPaymentLinkTokens();
  } else {
    console.log(
      "[bootstrap] skipping payment-link at-rest seal: 0251 is not applied to this schema",
    );
  }
  await applyRowLevelSecurity();
}

/**
 * The at-rest seal is the second half of 0251: it must run only where 0251
 * ran. The ledger is checked first as a matter of principle — but the ledger
 * alone can lie, because migration-replay fixtures fake _applied_migrations
 * on historical schemas (the 0064 suite holds a pre-0064 catalog with the
 * full tail marked applied). The column check is the structural guard that
 * saves those fixtures from a 42703 on the seal's SELECT.
 */
const PAYMENT_LINK_SEAL_MIGRATION = "generated/0251_payment_link_token_at_rest.sql";

async function isPaymentLinkSealApplicable(): Promise<boolean> {
  const ledger = await pool.query("select 1 from _applied_migrations where filename = $1", [
    PAYMENT_LINK_SEAL_MIGRATION,
  ]);
  if (ledger.rows.length === 0) return false;
  const columns = await pool.query<{ n: number }>(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'payment_links'
        and column_name in ('token_hash', 'token_sealed')`,
  );
  return columns.rows[0]?.n === 2;
}

/**
 * 0251 stores the pay-link lookup hash and display seal, but the seal half
 * cannot run in SQL because the data key never enters a migration. This
 * step, in the same bootstrap invocation that applies 0251, seals AND hashes
 * each hash-less row (including rows written by code still serving during a
 * rolling deploy) and heals rows an older bootstrap sealed without hashing,
 * then NULLs the plaintext column, so no window exists where a link is
 * undisplayable, unresolvable, or a raw secret persists. Idempotent: rows
 * already carrying a hash are untouched.
 *
 * Implemented in engine/src/payments/payment-link-seal.ts so the hash
 * encoding stays byte-identical to the engine lookup by construction:
 * sealing a row without hashing it orphans the link, because the engine
 * resolves by hash only.
 */

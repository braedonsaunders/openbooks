/**
 * One-time employment migration operator entrypoint.
 *
 *   npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json>
 *   npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json> --apply
 *   npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json> --apply --allow-partial
 *   npx tsx scripts/hrm-migrate-employments.ts --collect=<uuid> [--operator-mappings=<map.json>] > rows.json
 *   npx tsx scripts/hrm-migrate-employments.ts --collect=<uuid> --apply [--operator-mappings=<map.json>]
 *
 * The input file is the collector output: a JSON array of SourcePersonRow
 * (see engine/src/hrm/migration-preflight.ts); --input=- reads it from
 * stdin. --collect=<uuid> builds those rows from the live database with the
 * legacy evidence collector (see engine/src/hrm/migration-collect.ts) and
 * prints ONLY the JSON array to stdout, so `> rows.json` captures a clean
 * file; the person count and evidence hash go to stderr. The default is a
 * dry run that writes nothing; --apply writes. Everything for the org runs
 * in ONE transaction and any refusal rolls the whole org back, unless
 * --allow-partial accepts the ready subset with the rest listed.
 *
 * Production interlock (fail closed): --apply proceeds without controls
 * ONLY when NODE_ENV is explicitly development/test AND the target database
 * carries the ephemeral marker; anything else requires --allow-production
 * AND --dry-run-hash=<sha256> matching the dry-run report hash computed in
 * this same run, so the exact evaluated report the operator reviewed is
 * what gets applied.
 *
 * Exit code is non-zero when any person was not ready (already_migrated is
 * settled and never blocks) unless --allow-partial is given; an empty
 * inventory is never a clean claim.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "../engine/src/db.ts";
import { decideProductionApply } from "../engine/src/hrm/migration-cli-gate.ts";
import {
  collectLegacyEmployments,
  EmploymentCollectionError,
  type OperatorEmploymentMapping,
} from "../engine/src/hrm/migration-collect.ts";
import {
  EmploymentMigrationError,
  EmploymentMigrationRefusalError,
  executeEmploymentMigration,
  migrationExitCode,
  type EmploymentMigrationReport,
} from "../engine/src/hrm/migration-execute.ts";
import type { SourcePersonRow } from "../engine/src/hrm/migration-preflight.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "usage: npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json> [--apply] [--allow-partial]",
    "       [--allow-production --dry-run-hash=<sha256>] (production apply only)",
    "       npx tsx scripts/hrm-migrate-employments.ts --collect=<uuid> [--operator-mappings=<map.json>] [--apply]",
    "         [--allow-partial] [--org=<uuid>] > rows.json",
    "",
    "Migrates one org's legacy person-keyed employment facts into the canonical",
    "0184 tables exactly once. Default is a dry run: evaluates, prints the",
    "report (human summary plus JSON), writes nothing.",
    "With --collect, rows are built from the live database and only the JSON",
    "array goes to stdout (count and evidence hash go to stderr); without",
    "--apply the run ends after collecting. --input=- reads rows from stdin.",
  ].join("\n");
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function isOperatorMapping(value: unknown): value is OperatorEmploymentMapping {
  if (typeof value !== "object" || value === null) return false;
  const mapping = value as Record<string, unknown>;
  return (
    typeof mapping.partyId === "string" &&
    (mapping.employerSubsidiaryId === null ||
      typeof mapping.employerSubsidiaryId === "string") &&
    (mapping.hiredOn === null || typeof mapping.hiredOn === "string") &&
    (mapping.terminatedOn === null || typeof mapping.terminatedOn === "string") &&
    typeof mapping.approvedBy === "string" &&
    typeof mapping.approvedAt === "string" &&
    typeof mapping.rationale === "string"
  );
}

function readOperatorMappings(path: string): OperatorEmploymentMapping[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    console.error(
      `hrm-migrate-employments: cannot read operator mappings file ${path}: ${(error as Error).message}`,
    );
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { mappings?: unknown }).mappings)
      ? (parsed as { mappings: unknown[] }).mappings
      : null;
  if (list === null || !list.every(isOperatorMapping)) {
    console.error(
      `hrm-migrate-employments: operator mappings file ${path} must be a JSON array (or ` +
        '{"mappings": [...]} ) of {partyId, employerSubsidiaryId|null, hiredOn|null, ' +
        "terminatedOn|null, approvedBy, approvedAt, rationale}",
    );
    return null;
  }
  return list as OperatorEmploymentMapping[];
}

function fail(message: string): number {
  console.error(`hrm-migrate-employments: ${message}`);
  return 1;
}

/**
 * Read the target database's marker comment (the same catalog read
 * engine/src/test-fixtures.ts enforces). Read-only; used only as the
 * interlock's second input, never as a write precondition bypass.
 */
async function readDatabaseMarker(): Promise<string | null> {
  try {
    const result = (await db.execute<{ marker: string | null }>(sql`
      select shobj_description(oid, 'pg_database') as marker
        from pg_database where datname = current_database()`)) as unknown as {
      rows: Array<{ marker: string | null }>;
    };
    return result.rows[0]?.marker ?? null;
  } catch {
    // Fail closed: an unreadable marker never counts as ephemeral.
    return null;
  }
}

function printReport(report: EmploymentMigrationReport): void {
  console.log(report.summary);
  console.log(`report hash: ${report.reportHash}`);
  console.log(JSON.stringify(report, null, 2));
}

function isSourcePersonRow(value: unknown): value is SourcePersonRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.orgId === "string" &&
    typeof row.sourceNamespace === "string" &&
    typeof row.sourceId === "string" &&
    typeof row.nativePartyId === "string" &&
    typeof row.sourceVersion === "string"
  );
}

export interface HrmMigrationCliOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Testable entrypoint: the same flow the script runs, with injectable
 * arguments and environment. Importing this module never runs it and never
 * closes the shared pool — only the isEntrypoint block below does that.
 */
export async function runHrmMigrationCli(options: HrmMigrationCliOptions): Promise<number> {
  const args = options.argv;
  const env = options.env ?? process.env;
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }
  if (!env.OPENBOOKS_DB_URL?.trim()) {
    return fail(
      "OPENBOOKS_DB_URL is not set; refusing to run without an explicit database. " +
        "Export OPENBOOKS_DB_URL (and OPENBOOKS_RUNTIME_DB_URL) for the target database first.",
    );
  }
  const orgFlag = args.find((a) => a.startsWith("--org="))?.slice("--org=".length) ?? null;
  const inputPath = args.find((a) => a.startsWith("--input="))?.slice("--input=".length) ?? null;
  const collectOrg =
    args.find((a) => a.startsWith("--collect="))?.slice("--collect=".length) ?? null;
  const mappingsPath =
    args.find((a) => a.startsWith("--operator-mappings="))?.slice("--operator-mappings=".length) ??
    null;
  const apply = args.includes("--apply");
  const allowPartial = args.includes("--allow-partial");
  const allowProduction = args.includes("--allow-production");
  const dryRunHash = args.find((a) => a.startsWith("--dry-run-hash="))?.slice("--dry-run-hash=".length) ?? null;
  const unknown = args.filter(
    (a) =>
      !a.startsWith("--org=") &&
      !a.startsWith("--input=") &&
      !a.startsWith("--collect=") &&
      !a.startsWith("--operator-mappings=") &&
      !a.startsWith("--dry-run-hash=") &&
      a !== "--apply" &&
      a !== "--allow-partial" &&
      a !== "--allow-production",
  );
  if (unknown.length > 0) {
    console.error(usage());
    return fail(`unknown arguments: ${unknown.join(" ")}`);
  }
  if (collectOrg !== null && inputPath !== null) {
    console.error(usage());
    return fail("refusing --collect with --input: one run builds rows from the live database or reads them, never both");
  }
  if (mappingsPath !== null && collectOrg === null) {
    console.error(usage());
    return fail("refusing --operator-mappings without --collect: operator overrides attach at collection time");
  }
  // --collect carries the tenant scope; --org may repeat it but never
  // override it with a second org.
  const orgId = collectOrg ?? orgFlag;
  if (orgFlag !== null && collectOrg !== null && orgFlag !== collectOrg) {
    return fail(
      `--org=${orgFlag} disagrees with --collect=${collectOrg}; refusing a two-org run ` +
        "— migrate one org per run",
    );
  }
  if (orgId === null || !UUID_PATTERN.test(orgId)) {
    console.error(usage());
    return fail("--org=<uuid> (or --collect=<uuid>) is required; refusing to migrate without an explicit tenant scope");
  }
  let rows: SourcePersonRow[];
  if (collectOrg !== null) {
    if (!UUID_PATTERN.test(collectOrg)) {
      console.error(usage());
      return fail(`--collect=${collectOrg} is not a valid UUID; refusing to collect without an explicit tenant scope`);
    }
    let operatorMappings: OperatorEmploymentMapping[] | undefined;
    if (mappingsPath !== null) {
      const read = readOperatorMappings(mappingsPath);
      if (read === null) return 1;
      operatorMappings = read;
    }
    try {
      const collected = await collectLegacyEmployments(collectOrg, { operatorMappings });
      rows = [...collected.rows];
      if (!apply) {
        // Machine contract on stdout (redirect-safe); humans read stderr.
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        console.error(
          `hrm-migrate-employments: collected ${rows.length} person(s) for org ` +
            `${collectOrg}; evidence hash ${collected.evidenceHash}`,
        );
        if (rows.length === 0) {
          return fail(
            "collection is empty: no employee roles exist for this org, so there is " +
              "no evidence to migrate — an empty inventory is never a clean claim",
          );
        }
        return 0;
      }
      console.error(
        `hrm-migrate-employments: collected ${rows.length} person(s) for org ` +
          `${collectOrg}; evidence hash ${collected.evidenceHash}`,
      );
    } catch (error) {
      if (error instanceof EmploymentCollectionError) {
        return fail(error.message);
      }
      throw error;
    }
  } else {
    if (inputPath === null || inputPath.length === 0) {
      console.error(usage());
      return fail("--input=<rows.json> is required: the collector output array of source person rows");
    }
    let raw: string;
    try {
      raw = inputPath === "-" ? readStdin() : readFileSync(inputPath, "utf8");
    } catch (error) {
      return fail(`cannot read input ${inputPath}: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      return fail(`cannot parse input ${inputPath}: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed) || !parsed.every(isSourcePersonRow)) {
      return fail(
        `input ${inputPath} must be a JSON array of source person rows ` +
          "(orgId, sourceNamespace, sourceId, nativePartyId, sourceVersion with the classifier inventories)",
      );
    }
    rows = parsed as SourcePersonRow[];
  }
  const foreign = rows.find((row) => row.orgId !== orgId);
  if (foreign !== undefined) {
    return fail(
      `input row ${foreign.sourceNamespace}/${foreign.sourceId} belongs to org ` +
        `${foreign.orgId}, not --org=${orgId}; refusing a multi-org batch — migrate one org per run`,
    );
  }

  // Always evaluate first: the dry-run report is what the operator reviews,
  // and on production its hash is the apply interlock. It writes nothing.
  let planned: EmploymentMigrationReport;
  try {
    planned = await executeEmploymentMigration({ orgId, rows, dryRun: true, allowPartial });
  } catch (error) {
    if (error instanceof EmploymentMigrationRefusalError) {
      printReport(error.report);
      return 1;
    }
    throw error;
  }
  if (!apply) {
    printReport(planned);
    return migrationExitCode(planned);
  }

  // The database is the authority, the environment only supplementary:
  // read the target's marker before deciding. Unreadable or absent never
  // counts as ephemeral (fail closed); the dry-run evaluate above already
  // failed loudly on its own if the database was unreachable.
  const databaseMarker = await readDatabaseMarker();
  const gate = decideProductionApply({
    nodeEnv: env.NODE_ENV,
    databaseMarker,
    apply,
    allowProduction,
    dryRunHash,
    computedHash: planned.reportHash,
  });
  if (!gate.proceed) return fail(`[${gate.code}] ${gate.reason}`);

  try {
    const applied = await executeEmploymentMigration({ orgId, rows, allowPartial });
    printReport(applied);
    return migrationExitCode(applied);
  } catch (error) {
    if (error instanceof EmploymentMigrationRefusalError) {
      printReport(error.report);
      return 1;
    }
    throw error;
  }
}

/**
 * Run only when invoked as a script. Importing this module must never
 * execute a migration or close the shared pool.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  void (async () => {
    try {
      process.exitCode = await runHrmMigrationCli({ argv: process.argv.slice(2) });
    } catch (error) {
      if (
        error instanceof EmploymentMigrationError ||
        error instanceof EmploymentCollectionError
      ) {
        console.error(`hrm-migrate-employments: ${error.message}`);
      } else {
        console.error(error);
      }
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}

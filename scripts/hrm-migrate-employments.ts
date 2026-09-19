/**
 * One-time employment migration operator entrypoint.
 *
 *   npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json>
 *   npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json> --apply
 *   npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json> --apply --allow-partial
 *
 * The input file is the collector output: a JSON array of SourcePersonRow
 * (see engine/src/hrm/migration-preflight.ts). The default is a dry run that
 * writes nothing; --apply writes. Everything for the org runs in ONE
 * transaction and any refusal rolls the whole org back, unless
 * --allow-partial accepts the ready subset with the rest listed.
 *
 * Production interlock: when NODE_ENV=production, --apply additionally
 * requires --allow-production AND --dry-run-hash=<sha256> matching the
 * dry-run report hash computed in this same run, so the exact evaluated
 * report the operator reviewed is what gets applied.
 *
 * Exit code is non-zero when any person was not ready (already_migrated is
 * settled and never blocks) unless --allow-partial is given; an empty
 * inventory is never a clean claim.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../engine/src/db.ts";
import {
  EmploymentMigrationError,
  EmploymentMigrationRefusalError,
  executeEmploymentMigration,
  migrationExitCode,
  type EmploymentMigrationReport,
  type SourcePersonRow,
} from "../engine/src/hrm/migration-execute.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "usage: npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json> [--apply] [--allow-partial]",
    "       [--allow-production --dry-run-hash=<sha256>] (production apply only)",
    "",
    "Migrates one org's legacy person-keyed employment facts into the canonical",
    "0184 tables exactly once. Default is a dry run: evaluates, prints the",
    "report (human summary plus JSON), writes nothing.",
  ].join("\n");
}

function fail(message: string): number {
  console.error(`hrm-migrate-employments: ${message}`);
  return 1;
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

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }
  if (!process.env.OPENBOOKS_DB_URL?.trim()) {
    return fail(
      "OPENBOOKS_DB_URL is not set; refusing to run without an explicit database. " +
        "Export OPENBOOKS_DB_URL (and OPENBOOKS_RUNTIME_DB_URL) for the target database first.",
    );
  }
  const orgId = args.find((a) => a.startsWith("--org="))?.slice("--org=".length) ?? null;
  const inputPath = args.find((a) => a.startsWith("--input="))?.slice("--input=".length) ?? null;
  const apply = args.includes("--apply");
  const allowPartial = args.includes("--allow-partial");
  const allowProduction = args.includes("--allow-production");
  const dryRunHash = args.find((a) => a.startsWith("--dry-run-hash="))?.slice("--dry-run-hash=".length) ?? null;
  const unknown = args.filter(
    (a) =>
      !a.startsWith("--org=") &&
      !a.startsWith("--input=") &&
      !a.startsWith("--dry-run-hash=") &&
      a !== "--apply" &&
      a !== "--allow-partial" &&
      a !== "--allow-production",
  );
  if (unknown.length > 0) {
    console.error(usage());
    return fail(`unknown arguments: ${unknown.join(" ")}`);
  }
  if (orgId === null || !UUID_PATTERN.test(orgId)) {
    console.error(usage());
    return fail("--org=<uuid> is required; refusing to migrate without an explicit tenant scope");
  }
  if (inputPath === null || inputPath.length === 0) {
    console.error(usage());
    return fail("--input=<rows.json> is required: the collector output array of source person rows");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  } catch (error) {
    return fail(`cannot read input file ${inputPath}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isSourcePersonRow)) {
    return fail(
      `input file ${inputPath} must be a JSON array of source person rows ` +
        "(orgId, sourceNamespace, sourceId, nativePartyId, sourceVersion with the classifier inventories)",
    );
  }
  const rows = parsed as SourcePersonRow[];
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

  if (process.env.NODE_ENV === "production") {
    if (!allowProduction || dryRunHash === null) {
      return fail(
        "refusing production apply without --allow-production AND --dry-run-hash=<sha256>; " +
          "review the dry-run report first, then re-run with its hash. " +
          `This run's dry-run report hash is ${planned.reportHash}.`,
      );
    }
    if (dryRunHash !== planned.reportHash) {
      return fail(
        "refusing production apply: --dry-run-hash does not match this run's evaluated " +
          `report (expected ${planned.reportHash}); the inputs changed since review — ` +
          "re-review the dry run and re-supply its hash. Nothing was written.",
      );
    }
  }

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
      process.exitCode = await main();
    } catch (error) {
      if (error instanceof EmploymentMigrationError) {
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

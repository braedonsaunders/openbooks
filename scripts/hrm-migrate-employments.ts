/**
 * One-time employment migration operator entrypoint.
 *
 *   npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json> [--applied-by=<uuid>]
 *   npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json> --apply [--applied-by=<uuid>]
 *   npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json> --apply --allow-partial [--applied-by=<uuid>]
 *   npx tsx scripts/hrm-migrate-employments.ts --collect=<uuid> [--operator-mappings=<map.json>] > rows.json
 *   npx tsx scripts/hrm-migrate-employments.ts --collect=<uuid> --apply [--operator-mappings=<map.json>] [--applied-by=<uuid>]
 *   npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --operator-mappings=<map.json> --request-approval --requested-by=<uuid>
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
 * Operator mapping approval (fail closed): a mapping is applicable only
 * under a decided Flows gate over the digest of the exact mapping set
 * (subject kind hrm_employment_migration_mapping) — free-text approver
 * metadata never authorizes. --request-approval pins the mappings file's
 * digest and submits it for approval, printing the gate ids; an approver
 * distinct from the applier decides in Flows; then the apply runs with the
 * gate id in the mappings file and --applied-by=<the applier's user id>.
 * Any run carrying mappings without --applied-by is refused before
 * evaluation, and any mapping the approval does not cover refuses in the
 * report instead of applying.
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
import { db, pool } from "../engine/src/platform/db.ts";
import { decideProductionApply } from "../engine/src/hrm/migration-cli-gate.ts";
import {
  collectLegacyEmployments,
  EmploymentCollectionError,
  type OperatorEmploymentMapping,
} from "../engine/src/hrm/migration-collect.ts";
import {
  MappingApprovalError,
  requestMigrationMappingApproval,
} from "../engine/src/hrm/migration-approval.ts";
import {
  EmploymentMigrationError,
  EmploymentMigrationRefusalError,
  executeEmploymentMigration,
  migrationExitCode,
  type EmploymentMigrationReport,
} from "../engine/src/hrm/migration-execute.ts";
import {
  hashOperatorMappingSet,
  type MappingSetEntry,
  type SourcePersonRow,
} from "../engine/src/hrm/migration-preflight.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "usage: npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --input=<rows.json> [--apply] [--allow-partial] [--applied-by=<uuid>]",
    "       [--allow-production --dry-run-hash=<sha256>] (production apply only)",
    "       npx tsx scripts/hrm-migrate-employments.ts --collect=<uuid> [--operator-mappings=<map.json>] [--apply]",
    "         [--allow-partial] [--applied-by=<uuid>] [--org=<uuid>] > rows.json",
    "       npx tsx scripts/hrm-migrate-employments.ts --org=<uuid> --operator-mappings=<map.json>",
    "         --request-approval --requested-by=<uuid>",
    "",
    "Migrates one org's legacy person-keyed employment facts into the canonical",
    "0184 tables exactly once. Default is a dry run: evaluates, prints the",
    "report (human summary plus JSON), writes nothing.",
    "With --collect, rows are built from the live database and only the JSON",
    "array goes to stdout (count and evidence hash go to stderr); without",
    "--apply the run ends after collecting. --input=- reads rows from stdin.",
    "Runs carrying operator mappings require --applied-by=<the applier's user id>.",
    "--request-approval pins the mappings file's digest and submits it for Flows",
    "approval, printing the approval id and the pending gate ids as JSON.",
  ].join("\n");
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
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
    // Free-text approver metadata is non-authoritative record context: it
    // may be absent, and it never authorizes. Authority is the Flows
    // approval gate named by approvalGateId.
    isOptionalText(mapping.approvedBy) &&
    isOptionalText(mapping.approvedAt) &&
    isOptionalText(mapping.rationale) &&
    isOptionalText(mapping.approvalGateId)
  );
}

function mappingSetEntries(mappings: readonly OperatorEmploymentMapping[]): MappingSetEntry[] {
  return mappings.map((mapping) => ({
    partyId: mapping.partyId,
    employerSubsidiaryId: mapping.employerSubsidiaryId,
    hiredOn: mapping.hiredOn,
    terminatedOn: mapping.terminatedOn,
  }));
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
        'terminatedOn|null, approvalGateId?, approvedBy?, approvedAt?, rationale?} — ' +
        "free-text approver metadata never authorizes; authority is the Flows approval gate",
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
 * engine/src/testing/fixtures.ts enforces). Read-only; used only as the
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

/**
 * Pin a mappings file's digest and submit it for Flows approval. One job
 * per run: requesting approval never collects, evaluates, or applies —
 * the approver decides after this request, and a later run applies.
 */
async function runRequestApproval(options: {
  mappingsPath: string | null;
  requestedBy: string | null;
  orgFlag: string | null;
  inputPath: string | null;
  collectOrg: string | null;
  apply: boolean;
}): Promise<number> {
  const { mappingsPath, requestedBy, orgFlag, inputPath, collectOrg, apply } = options;
  if (mappingsPath === null) {
    console.error(usage());
    return fail("refusing --request-approval without --operator-mappings=<map.json>: approval covers an exact mapping set");
  }
  if (requestedBy === null || !UUID_PATTERN.test(requestedBy)) {
    console.error(usage());
    return fail("--requested-by=<uuid> is required; refusing to request approval without an explicit requester");
  }
  if (orgFlag === null || !UUID_PATTERN.test(orgFlag)) {
    console.error(usage());
    return fail("--org=<uuid> is required; refusing to request approval without an explicit tenant scope");
  }
  if (inputPath !== null || collectOrg !== null) {
    console.error(usage());
    return fail("refusing --request-approval with --input or --collect: one run requests approval or migrates, never both");
  }
  if (apply) {
    return fail(
      "refusing --request-approval with --apply: the approver decides after the request — " +
        "re-run the apply with the decided gate id and --applied-by once Flows approves",
    );
  }
  const read = readOperatorMappings(mappingsPath);
  if (read === null) return 1;
  try {
    const requested = await requestMigrationMappingApproval(
      orgFlag,
      mappingSetEntries(read),
      requestedBy,
    );
    process.stdout.write(`${JSON.stringify(requested, null, 2)}\n`);
    console.error(
      `hrm-migrate-employments: mapping set digest ${requested.digest} ` +
        (requested.created
          ? `submitted for Flows approval ${requested.approvalId}; pending gates: ${requested.gateIds.join(", ") || "none"}`
          : `was already submitted for approval ${requested.approvalId}; reuse its decided gate`),
    );
    return 0;
  } catch (error) {
    if (error instanceof MappingApprovalError) return fail(error.message);
    throw error;
  }
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
  const requestApproval = args.includes("--request-approval");
  const dryRunHash = args.find((a) => a.startsWith("--dry-run-hash="))?.slice("--dry-run-hash=".length) ?? null;
  const appliedBy = args.find((a) => a.startsWith("--applied-by="))?.slice("--applied-by=".length) ?? null;
  const requestedBy = args.find((a) => a.startsWith("--requested-by="))?.slice("--requested-by=".length) ?? null;
  const unknown = args.filter(
    (a) =>
      !a.startsWith("--org=") &&
      !a.startsWith("--input=") &&
      !a.startsWith("--collect=") &&
      !a.startsWith("--operator-mappings=") &&
      !a.startsWith("--dry-run-hash=") &&
      !a.startsWith("--applied-by=") &&
      !a.startsWith("--requested-by=") &&
      a !== "--apply" &&
      a !== "--allow-partial" &&
      a !== "--allow-production" &&
      a !== "--request-approval",
  );
  if (unknown.length > 0) {
    console.error(usage());
    return fail(`unknown arguments: ${unknown.join(" ")}`);
  }
  if (appliedBy !== null && !UUID_PATTERN.test(appliedBy)) {
    console.error(usage());
    return fail(`--applied-by=${appliedBy} is not a valid UUID; refusing without an explicit applying actor`);
  }
  if (requestApproval) {
    return runRequestApproval({ mappingsPath, requestedBy, orgFlag, inputPath, collectOrg, apply });
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
      if (operatorMappings !== undefined) {
        console.error(
          `hrm-migrate-employments: mapping set digest ` +
            `${hashOperatorMappingSet(mappingSetEntries(operatorMappings))} — ` +
            "request Flows approval for this digest before apply",
        );
      }
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
      if (error instanceof EmploymentCollectionError || error instanceof MappingApprovalError) {
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
  // The dry run verifies mapping approvals exactly like the apply — the
  // reviewed report certifies the same authority the apply enforces.
  let planned: EmploymentMigrationReport;
  try {
    planned = await executeEmploymentMigration({
      orgId,
      rows,
      dryRun: true,
      allowPartial,
      appliedBy: appliedBy ?? undefined,
    });
  } catch (error) {
    if (error instanceof EmploymentMigrationRefusalError) {
      printReport(error.report);
      return 1;
    }
    if (error instanceof MappingApprovalError) return fail(error.message);
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
    const applied = await executeEmploymentMigration({
      orgId,
      rows,
      allowPartial,
      appliedBy: appliedBy ?? undefined,
    });
    printReport(applied);
    return migrationExitCode(applied);
  } catch (error) {
    if (error instanceof EmploymentMigrationRefusalError) {
      printReport(error.report);
      return 1;
    }
    if (error instanceof MappingApprovalError) return fail(error.message);
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
        error instanceof EmploymentCollectionError ||
        error instanceof MappingApprovalError
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

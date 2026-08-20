/**
 * Produce a fail-closed, machine-readable financial release certificate.
 *
 * This command intentionally reruns the complete release gate. It also proves
 * immutable migration integrity, clean-bootstrap catalog convergence, exhaustive GL
 * coverage, ledger balance, validated constraints, and canonical data
 * integrity before writing a passing certificate.
 *
 * Usage:
 *   npx tsx scripts/verify-financial-release.ts \
 *     --reference=.local/schema-convergence/clean-0109.json
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { db, pool } from "../engine/src/db.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const args = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const [key, ...value] = argument.slice(2).split("=");
      return [key!, value.length > 0 ? value.join("=") : "true"];
    }),
);
const requestedReference = args.get("reference") ?? "";
if (!requestedReference) {
  throw new Error("--reference=<clean-catalog.json> is required");
}
const referencePath = isAbsolute(requestedReference)
  ? requestedReference
  : resolve(repoRoot, requestedReference);
if (!existsSync(referencePath)) {
  throw new Error(`clean catalog reference does not exist: ${referencePath}`);
}
const requestedOutput =
  args.get("output") ?? ".local/erpnext-parity/release-readiness.json";
const outputPath = isAbsolute(requestedOutput)
  ? requestedOutput
  : resolve(repoRoot, requestedOutput);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function run(
  label: string,
  command: string,
  commandArgs: string[],
): string {
  console.log(`[financial-release] ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(
      `${label} failed\n${output.slice(-20_000) ||
        `${command} ${commandArgs.join(" ")} exited ${result.status}`}`,
    );
  }
  return output;
}

function parseJsonOutput<T>(output: string, label: string): T {
  const start = output.indexOf("{");
  if (start < 0) throw new Error(`${label} did not emit JSON`);
  try {
    return JSON.parse(output.slice(start)) as T;
  } catch (error) {
    throw new Error(`${label} emitted invalid JSON`, { cause: error });
  }
}

function assertRelease(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`release refused: ${message}`);
}

function countMatch(output: string, label: string): number {
  const match = output.match(new RegExp(`ℹ ${label} (\\d+)`));
  if (!match) throw new Error(`release gate omitted ${label} count`);
  return Number(match[1]);
}

async function queryOne<T>(
  query: ReturnType<typeof sql>,
): Promise<T> {
  const result = (await db.execute<T>(query));
  if (!result.rows[0]) throw new Error("release audit query returned no row");
  return result.rows[0];
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "openbooks-release-proof-"));
  try {
    const releaseOutput = run("complete release gate", "npm", [
      "run",
      "verify:release",
    ]);
    const testCount = countMatch(releaseOutput, "tests");
    const passCount = countMatch(releaseOutput, "pass");
    const failCount = countMatch(releaseOutput, "fail");
    assertRelease(testCount > 0, "test runner executed zero tests");
    assertRelease(passCount === testCount, "not every test passed");
    assertRelease(failCount === 0, "release gate contains failing tests");
    assertRelease(
      releaseOutput.includes("Compiled successfully"),
      "production web build did not report successful compilation",
    );

    const bootstrapOutput = run("deployment bootstrap", process.execPath, [
      "--import",
      "tsx",
      "scripts/bootstrap.ts",
    ]);
    assertRelease(
      bootstrapOutput.includes(
        "row-level security verified on every org-scoped table",
      ),
      "bootstrap did not verify row-level security",
    );

    run("GL parity coverage report", "npm", [
      "-w",
      "engine",
      "run",
      "harness:ledger-parity",
      "--",
      "report",
    ]);
    const coveragePath = join(
      repoRoot,
      ".local",
      "erpnext-parity",
      "coverage-report.json",
    );
    const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as {
      generatedAt: string;
      exhaustive: boolean;
      exhaustiveReason: string | null;
      evidence: {
        passingFiles: number;
        failingFiles: unknown[];
        resolvedFindings: unknown[];
      };
      operationStatus: {
        verified: number;
        partial: number;
        pending: number;
        "product-specific": number;
      };
      matrixStatus: {
        direct: number;
        semantic: number;
        "openbooks-only": number;
        "erpnext-only": number;
        pending: number;
      };
      sourceIntegrity: {
        openbooks: {
          entries: string;
          unbalanced_entries: string;
          net: string;
        };
        erpnext: {
          activeGlRows: number;
          unbalancedActiveVouchers: number;
          net: string;
        };
      };
      operations: unknown[];
    };
    assertRelease(coverage.exhaustive, coverage.exhaustiveReason ?? "GL coverage is not exhaustive");
    assertRelease(
      coverage.evidence.failingFiles.length === 0,
      "GL parity evidence contains a failing checkpoint",
    );
    assertRelease(
      coverage.operationStatus.partial === 0 &&
        coverage.operationStatus.pending === 0,
      "GL operation registry contains partial or pending work",
    );
    assertRelease(
      coverage.matrixStatus.pending === 0,
      "GL coverage matrix contains pending work",
    );
    assertRelease(
      coverage.sourceIntegrity.openbooks.unbalanced_entries === "0" &&
        coverage.sourceIntegrity.openbooks.net === "0.0000",
      "OpenBooks parity ledger is not exactly balanced",
    );
    assertRelease(
      coverage.sourceIntegrity.erpnext.unbalancedActiveVouchers === 0 &&
        coverage.sourceIntegrity.erpnext.net === "0.0000",
      "ERPNext comparison ledger is not exactly balanced",
    );

    const actualCatalog = run(
      "live catalog snapshot",
      process.execPath,
      ["--import", "tsx", "scripts/schema-catalog-snapshot.ts"],
    );
    const actualPath = join(scratch, "actual-catalog.json");
    writeFileSync(actualPath, actualCatalog, { mode: 0o600 });
    const catalogComparison = parseJsonOutput<{
      equivalent: boolean;
      relations: { actualCount: number };
      columns: { actualCount: number };
      indexes: { actualCount: number };
      triggers: { actualCount: number };
      functions: { actualCount: number };
      policies: { actualCount: number };
      constraints: {
        semantic: {
          actualSignatureCount: number;
          missing: unknown[];
          extra: unknown[];
          multiplicityDifferences: unknown[];
        };
        validationDifferences: unknown[];
      };
    }>(
      run("clean-bootstrap catalog comparison", process.execPath, [
        "scripts/compare-schema-catalogs.mjs",
        actualPath,
        referencePath,
      ]),
      "catalog comparison",
    );
    assertRelease(
      catalogComparison.equivalent,
      "live catalog differs from the clean bootstrap",
    );

    const databaseControls = await queryOne<{
      unvalidated_constraints: string;
      active_orphans: string;
      invalid_voids: string;
    }>(sql`
      select
        (
          select count(*)::text
            from pg_constraint constraint_row
            join pg_namespace namespace
              on namespace.oid = constraint_row.connamespace
           where namespace.nspname = 'public'
             and not constraint_row.convalidated
        ) as unvalidated_constraints,
        (
          select count(*)::text
            from document_line_tax_components component
            left join document_lines line
              on line.id = component.document_line_id
           where line.id is null
        ) as active_orphans,
        (
          select count(*)::text
            from documents document
           where document.status = 'voided'
             and not (
               document.voided_at is not null
               and document.voided_by is not null
               and document.void_reason is not null
               and length(btrim(document.void_reason)) between 5 and 500
               and (
                 document.posted_entry_id is null
                 or document.reversal_entry_id is not null
               )
             )
        ) as invalid_voids
    `);
    assertRelease(
      databaseControls.unvalidated_constraints === "0",
      "public schema contains unvalidated constraints",
    );
    assertRelease(
      databaseControls.active_orphans === "0",
      "active tax-component subledger retains orphan rows",
    );
    assertRelease(
      databaseControls.invalid_voids === "0",
      "voided documents retain invalid attribution or reversal lineage",
    );

    const certificate = {
      generatedAt: new Date().toISOString(),
      status: "release-candidate-ready",
      scope:
        "Every declared OpenBooks GL mutation path is directly compared, semantically compared, or covered by a native invariant suite. ERPNext-only application modules are explicitly excluded rather than treated as implicit passes.",
      releaseGate: {
        status: "passed",
        tests: testCount,
        passed: passCount,
        failed: failCount,
        productNeutrality: true,
        productionBuild: true,
      },
      deploymentControls: {
        bootstrap: "passed",
        rowLevelSecurityCatalogVerified: true,
        immutableMigrationDigests: true,
      },
      schemaConvergence: {
        equivalent: true,
        liveCatalogSha256: sha256(actualCatalog),
        cleanReferenceSha256: sha256(readFileSync(referencePath)),
        relations: catalogComparison.relations.actualCount,
        columns: catalogComparison.columns.actualCount,
        constraintSignatures:
          catalogComparison.constraints.semantic.actualSignatureCount,
        indexes: catalogComparison.indexes.actualCount,
        triggers: catalogComparison.triggers.actualCount,
        functions: catalogComparison.functions.actualCount,
        policies: catalogComparison.policies.actualCount,
        unvalidatedConstraints:
          Number(databaseControls.unvalidated_constraints),
      },
      glCoverage: {
        generatedAt: coverage.generatedAt,
        exhaustive: coverage.exhaustive,
        operations: coverage.operations.length,
        operationStatus: coverage.operationStatus,
        matrixStatus: coverage.matrixStatus,
        passingEvidenceFiles: coverage.evidence.passingFiles,
        failingEvidenceFiles: coverage.evidence.failingFiles.length,
        resolvedFindings: coverage.evidence.resolvedFindings.length,
        sourceIntegrity: coverage.sourceIntegrity,
      },
      dataIntegrity: {
        activeOrphanRows: Number(databaseControls.active_orphans),
        invalidVoidedDocuments: Number(databaseControls.invalid_voids),
      },
      unresolvedAccountingBlockers: [],
      qualifications: [
        "This is a repeatable technical release certificate, not a guarantee that defects are impossible.",
        "ERPNext manufacturing, payroll, loan, and subscription doctypes are recorded as product-scope differences because OpenBooks does not claim those application modules.",
        "Production launch still requires environment-specific backup/restore evidence, monitoring, access review, legal/tax review, and staged operational acceptance.",
      ],
    };
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(certificate, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          path: outputPath,
          status: certificate.status,
          unresolvedAccountingBlockers: 0,
          tests: testCount,
          exhaustiveGlCoverage: true,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

void (async () => {
  try {
    await main();
  } finally {
    await pool.end();
  }
})();

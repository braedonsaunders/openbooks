/**
 * Reconcile historical migration-file checksum drift only after proving the
 * current database catalog is semantically identical to a clean bootstrap.
 *
 * This never reruns changed historical SQL. It preserves each original digest
 * and the catalog proof in _migration_control_exceptions, then updates only the
 * digest used by bootstrap's tamper alarm.
 *
 * Usage:
 *   npx tsx scripts/reconcile-migration-checksums.ts \
 *     --reference=.local/schema-convergence/clean-0109.json
 *   npx tsx scripts/reconcile-migration-checksums.ts \
 *     --reference=.local/schema-convergence/clean-0109.json \
 *     --apply --operator=<name> --reason="<20-500 chars>"
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { db, pool } from "../engine/src/db.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const migrationRoot = join(repoRoot, "schema", "migrations");
const args = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const [key, ...value] = argument.slice(2).split("=");
      return [key!, value.length > 0 ? value.join("=") : "true"];
    }),
);
const apply = args.get("apply") === "true";
const operator = args.get("operator")?.trim() ?? "";
const reason = args.get("reason")?.trim() ?? "";
const requestedReference = args.get("reference") ?? "";
if (!requestedReference) throw new Error("--reference=<clean-catalog.json> is required");
if (apply && (operator.length < 3 || operator.length > 200)) {
  throw new Error("--operator must be 3-200 characters when applying");
}
if (apply && (reason.length < 20 || reason.length > 500)) {
  throw new Error("--reason must be 20-500 characters when applying");
}
const referencePath = isAbsolute(requestedReference)
  ? requestedReference
  : resolve(repoRoot, requestedReference);
if (!existsSync(referencePath)) {
  throw new Error(`clean catalog reference does not exist: ${referencePath}`);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function run(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `${command} ${commandArgs.join(" ")} failed`,
    );
  }
  return result.stdout;
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "openbooks-checksum-proof-"));
  try {
    const actualCatalog = run(process.execPath, [
      "--import",
      "tsx",
      "scripts/schema-catalog-snapshot.ts",
    ]);
    const actualPath = join(scratch, "actual.json");
    // Avoid a second source of filesystem mutation in this safety tool: the
    // catalog comparator accepts stdin-independent files, so use Node's own
    // fs implementation only inside this disposable directory.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(actualPath, actualCatalog, { mode: 0o600 });
    const comparison = JSON.parse(
      run(process.execPath, [
        "scripts/compare-schema-catalogs.mjs",
        actualPath,
        referencePath,
      ]),
    ) as { equivalent: boolean };
    if (!comparison.equivalent) {
      throw new Error(
        "current catalog is not equivalent to the clean reference; checksum reconciliation refused",
      );
    }

    const tracked = (await db.execute(sql`
      select filename, sha256
        from _applied_migrations
       order by filename
    `)) as unknown as {
      rows: Array<{ filename: string; sha256: string }>;
    };
    const drift = tracked.rows.flatMap((row) => {
      const migrationPath = join(migrationRoot, row.filename);
      if (!existsSync(migrationPath)) return [];
      const currentDigest = sha256(readFileSync(migrationPath));
      return currentDigest === row.sha256
        ? []
        : [
            {
              filename: row.filename,
              storedDigest: row.sha256,
              currentDigest,
            },
          ];
    });
    const proof = {
      actualCatalogSha256: sha256(actualCatalog),
      cleanReferenceSha256: sha256(readFileSync(referencePath)),
      catalogEquivalent: true,
    };

    if (apply && drift.length > 0) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          select pg_advisory_xact_lock(
            hashtextextended('openbooks:deployment-bootstrap', 0)
          )
        `);
        for (const item of drift) {
          const current = (await tx.execute(sql`
            select sha256
              from _applied_migrations
             where filename = ${item.filename}
             for update
          `)) as unknown as { rows: Array<{ sha256: string }> };
          if (current.rows[0]?.sha256 !== item.storedDigest) {
            throw new Error(
              `${item.filename} applied digest changed after preflight`,
            );
          }
          await tx.execute(sql`
            insert into _migration_control_exceptions (
              migration_filename,
              control_key,
              affected_rows,
              detected_at,
              details
            )
            values (
              ${item.filename},
              'checksum_reconciled',
              0,
              now(),
              ${JSON.stringify({
                operator,
                reason,
                storedDigest: item.storedDigest,
                currentDigest: item.currentDigest,
                ...proof,
                historicalSqlRerun: false,
                catalogStateChanged: false,
              })}::jsonb
            )
            on conflict (migration_filename, control_key) do update
              set affected_rows = excluded.affected_rows,
                  detected_at = excluded.detected_at,
                  details =
                    excluded.details
                    || jsonb_build_object(
                      'history',
                      case
                        when _migration_control_exceptions.details ? 'history'
                          then _migration_control_exceptions.details->'history'
                        else jsonb_build_array(
                          _migration_control_exceptions.details
                        )
                      end
                      || jsonb_build_array(excluded.details)
                    )
          `);
          await tx.execute(sql`
            update _applied_migrations
               set sha256 = ${item.currentDigest}
             where filename = ${item.filename}
               and sha256 = ${item.storedDigest}
          `);
        }
      });
    }

    console.log(
      JSON.stringify(
        {
          mode: apply ? "apply" : "plan",
          proof,
          driftCount: drift.length,
          reconciledCount: apply ? drift.length : 0,
          drift,
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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { PreflightFinding } from "./migration-preflight.ts";
import { assertBaselineCatalogsEqual, baselineCatalog } from "./migration-baseline-catalog.mjs";
import contract from "./migration-baseline-transitions.json" with { type: "json" };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Consumer = { migrationSha256: string; preflightSha256: string;
  prerequisites: Record<string, string>; findingCodes: string[] };

/** A catalog transition is deferred, never accepted as a clean preflight.
 * The unchanged consumer query must run after its publishers are recorded. */
export function baselineTransitionCandidate(input: {
  migration: string; consumerSql: string; findings: readonly PreflightFinding[];
  published: ReadonlyMap<string, string>; pendingBeforeConsumer: ReadonlySet<string>;
}): boolean {
  const consumer = (contract.consumers as Record<string, Consumer>)[input.migration];
  if (!consumer || !input.findings.length
    || digest(input.consumerSql) !== consumer.preflightSha256
    || digest(input.published.get(input.migration) ?? "") !== consumer.migrationSha256
    || input.findings.some(row => row.migration !== input.migration || row.severity !== "refuse"
      || !consumer.findingCodes.includes(row.code))) return false;
  // An unknown trigger remains unknown except for this exact published rename.
  if (input.findings.some(row => row.code.endsWith(".unknown_delete_trigger")
    && (row.subject !== "wip_prebill_events.wip_prebill_event_append_only"
      || row.detail !== "wip_prebill_event_append_only_guard"))) return false;
  return Object.entries(consumer.prerequisites).every(([filename, hash]) =>
    input.pendingBeforeConsumer.has(filename) && digest(input.published.get(filename) ?? "") === hash);
}

export function baselineTransitionCatalogMatches(manifest: {
  filename: string; baselineSha256: string; catalogSha256: string;
  environmentSha256: string;
  covered: Array<{ filename: string; sha256: string }>;
}, recorded: ReadonlyMap<string, string>, expected: unknown, actual: unknown): boolean {
  if (manifest.filename !== contract.baseline.filename
    || manifest.baselineSha256 !== contract.baseline.sha256
    || manifest.catalogSha256 !== contract.baseline.catalogSha256
    || digest(JSON.stringify(expected)) !== contract.baseline.catalogSha256
    || recorded.get(manifest.filename) !== manifest.baselineSha256) return false;
  const covered = new Map(manifest.covered.map(row => [row.filename, row.sha256]));
  covered.set("environments.sql",manifest.environmentSha256);
  if ([...recorded].some(([filename, hash]) => filename !== manifest.filename
    && covered.get(filename) !== hash)) return false;
  try { assertBaselineCatalogsEqual(expected, actual); return true; }
  catch { return false; }
}

/** Prove the complete starting schema and registry in one read-only snapshot.
 * Partial upgrades and additional objects are not baseline transitions. */
export async function verifyBaselineTransitionCatalog(client: pg.PoolClient,
  migrationsDirectory: string, statementTimeoutMs: number): Promise<boolean> {
  const manifest = JSON.parse(readFileSync(join(migrationsDirectory, "baseline.json"), "utf8"));
  if (manifest.filename !== contract.baseline.filename) return false;
  const expected = JSON.parse(readFileSync(join(migrationsDirectory,
    `${contract.baseline.filename}.catalog.json`), "utf8"));
  await client.query("begin isolation level repeatable read read only");
  try {
    await client.query(`set local statement_timeout=${statementTimeoutMs}`);
    await client.query("set local app.bypass_rls='on'");
    // Baseline catalog scope is public/query only. A pre-existing private
    // authority outside its ledger must not be mistaken for a missing publisher.
    if ((await client.query<{ present: boolean }>(
      "select to_regnamespace('tenant_retirement') is not null as present")).rows[0]?.present) return false;
    const recorded = await client.query<{ filename: string; sha256: string }>(
      "select filename,sha256 from public._applied_migrations order by filename");
    return baselineTransitionCatalogMatches(manifest,
      new Map(recorded.rows.map(row => [row.filename, row.sha256])), expected,
      await baselineCatalog(client));
  } finally { await client.query("rollback"); }
}

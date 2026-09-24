/**
 * Clone-time RLS isolation proof. The create/refresh lifecycle calls
 * `verifyCloneRls` after the clone is materialized. Operators can also run:
 *   npx tsx engine/src/sandbox/verify-rls.ts [productionOrgId sandboxOrgId]
 *
 * Confirms deny-by-default tenant isolation is enforced at the database for
 * the production source AND its sandbox clone:
 *   - the proof covers exactly the tables the clone tier actually copied
 *     (derived from the clone plan, never a fixed list: a dev-tier proof
 *     over ledger tables would pass vacuously on zero rows while production
 *     counts kept the total positive)
 *   - bypass counts of each tenant match scoped counts of that tenant
 *   - scoping to a different/bogus org sees ZERO (fail-closed, no leak)
 *   - a table with no rows on either side proves nothing and is reported by
 *     name as unverified; a proof with no verified table is a failure
 */
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, withBypass, withOrg } from "../platform/db.ts";
import { loadCatalog } from "./catalog.ts";
import { selectCloneTables, type SandboxTier } from "./clone.ts";

export const BOGUS_ORG_ID = "00000000-0000-0000-0000-000000000000";

const UUID_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CloneRlsTableCounts = {
  table: string;
  bypassProduction: number;
  bypassSandbox: number;
  scopedProduction: number;
  scopedSandbox: number;
  scopedBogus: number;
};

export type CloneRlsProof = {
  productionOrgId: string;
  sandboxOrgId: string;
  tables: CloneRlsTableCounts[];
  /** Tables empty on at least one side: leak-checked but proving nothing, named aloud. */
  unverifiedTables?: string[];
};

/**
 * Tables a table-side observation actually proves something about: rows
 * exist on BOTH sides, so both scoped comparisons are non-vacuous. A table
 * with rows on only one side (or none) is still leak-checked by
 * evaluateCloneRlsProof, but it joins the unverified list instead of the
 * proof.
 */
export function unverifiedCloneRlsTables(tables: CloneRlsTableCounts[]): string[] {
  return tables
    .filter((table) => !(table.bypassProduction > 0 && table.bypassSandbox > 0))
    .map((table) => table.table);
}

export function assertCloneRlsPair(productionOrgId: string, sandboxOrgId: string): void {
  if (!UUID_VALUE.test(productionOrgId)) {
    throw new Error(
      `clone RLS re-verification refused an invalid production org id (${productionOrgId}). Pass the source tenant UUID.`,
    );
  }
  if (!UUID_VALUE.test(sandboxOrgId)) {
    throw new Error(
      `clone RLS re-verification refused an invalid sandbox org id (${sandboxOrgId}). Pass the clone org UUID.`,
    );
  }
  if (productionOrgId === sandboxOrgId) {
    throw new Error(
      `clone RLS re-verification cannot compare a tenant to itself (${productionOrgId}); pass the production org and its sandbox clone.`,
    );
  }
}

/** Pure isolation predicate. Throws with a named remedy; never returns success for empty counts. */
export function evaluateCloneRlsProof(proof: CloneRlsProof): void {
  assertCloneRlsPair(proof.productionOrgId, proof.sandboxOrgId);
  if (proof.tables.length === 0) {
    throw new Error(
      `clone RLS re-verification named no tables for production ${proof.productionOrgId} and sandbox ${proof.sandboxOrgId}; isolation cannot be proven.`,
    );
  }

  let observedRows = 0;
  for (const table of proof.tables) {
    if (table.scopedBogus !== 0) {
      throw new Error(
        `clone RLS re-verification failed on ${table.table}: bogus org ${BOGUS_ORG_ID} saw ${table.scopedBogus} rows; expected 0. Tenant isolation is not fail-closed — restore FORCE RLS and the org_id policy, then re-clone.`,
      );
    }
    if (table.scopedProduction !== table.bypassProduction) {
      throw new Error(
        `clone RLS re-verification failed on ${table.table}: production scope saw ${table.scopedProduction} rows but bypass counted ${table.bypassProduction} production rows. Scoped reads must match the production tenant exactly; a higher scoped count is a cross-tenant leak.`,
      );
    }
    if (table.scopedSandbox !== table.bypassSandbox) {
      throw new Error(
        `clone RLS re-verification failed on ${table.table}: sandbox scope saw ${table.scopedSandbox} rows but bypass counted ${table.bypassSandbox} sandbox rows. Scoped reads must match the clone tenant exactly; a higher scoped count is a cross-tenant leak.`,
      );
    }
    // Only a both-sides observation proves isolation: a one-sided table
    // (rows on production but none copied, the dev-tier ledger shape) still
    // matches 0 == 0 on the empty side, so it is leak-checked above but
    // never counted as proof.
    if (table.bypassProduction > 0 && table.bypassSandbox > 0) {
      observedRows += table.bypassProduction + table.bypassSandbox;
    }
  }

  if (observedRows === 0) {
    const unverified = unverifiedCloneRlsTables(proof.tables);
    throw new Error(
      `clone RLS re-verification failed: production ${proof.productionOrgId} and sandbox ${proof.sandboxOrgId} have zero verified rows (unverified tables: ${unverified.join(", ") || "none"}); isolation cannot be proven on empty tables. Clone a tenant that holds rows in the tables the clone tier actually copied.`,
    );
  }
}

/**
 * The tables the proof must cover for one clone tier: the clone plan's
 * table set for that tier, restricted to org-scoped (RLS-subject) tables.
 * Anything else — a fixed ledger trio, the full catalog regardless of
 * tier — either proves nothing (uncopied tables read 0 == 0 on the clone
 * side) or reads tables RLS cannot scope.
 */
export async function cloneTierVerificationTables(tier: SandboxTier): Promise<string[]> {
  const cat = await loadCatalog();
  return selectCloneTables(cat.tables, tier)
    .filter((table) => table.hasOrgId)
    .map((table) => table.name)
    .sort();
}

/** One round trip per chunk: per-table counts as (table, n) rows. */
async function countChunk(
  tables: string[],
  whereOrg: string | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < tables.length; i += 100) {
    const branches = tables.slice(i, i + 100).map((table) =>
      whereOrg === null
        ? sql`select ${table}::text as tbl, count(*)::int as n from ${sql.raw(`"${table}"`)}`
        : sql`select ${table}::text as tbl, count(*)::int as n from ${sql.raw(`"${table}"`)} where org_id = ${whereOrg}`,
    );
    const result = await db.execute<{ tbl: string; n: number }>(
      sql.join(branches, sql` union all `),
    );
    for (const row of result.rows) out.set(row.tbl, row.n);
    for (const table of tables.slice(i, i + 100)) {
      if (!out.has(table)) out.set(table, 0);
    }
  }
  return out;
}

export async function verifyCloneRls(args: {
  productionOrgId: string;
  sandboxOrgId: string;
  tier: SandboxTier;
}): Promise<CloneRlsProof> {
  assertCloneRlsPair(args.productionOrgId, args.sandboxOrgId);

  const orgs = await withBypass(async () => {
    const result = await db.execute<{
      id: string;
      env_kind: string;
      sandbox_of: string | null;
    }>(sql`
      select id, env_kind, sandbox_of
        from orgs
       where id = ${args.productionOrgId} or id = ${args.sandboxOrgId}`);
    return result.rows;
  });
  const production = orgs.find((row) => row.id === args.productionOrgId);
  const sandbox = orgs.find((row) => row.id === args.sandboxOrgId);
  if (!production) {
    throw new Error(
      `clone RLS re-verification failed: production org ${args.productionOrgId} was not found. Pass the source tenant of the clone.`,
    );
  }
  if (!sandbox) {
    throw new Error(
      `clone RLS re-verification failed: sandbox org ${args.sandboxOrgId} was not found. Pass the clone org createSandbox just created.`,
    );
  }
  if (sandbox.env_kind !== "sandbox" || sandbox.sandbox_of !== args.productionOrgId) {
    throw new Error(
      `clone RLS re-verification failed: org ${args.sandboxOrgId} is not a sandbox clone of ${args.productionOrgId} (env_kind=${sandbox.env_kind}, sandbox_of=${sandbox.sandbox_of}). Pass the production/sandbox pair from the clone.`,
    );
  }

  const verifyTables = await cloneTierVerificationTables(args.tier);
  if (verifyTables.length === 0) {
    throw new Error(
      `clone RLS re-verification named no tables for tier ${args.tier}; isolation cannot be proven without a table set. Pass the tier the clone actually used.`,
    );
  }

  const bypassProduction = await withBypass(() => countChunk(verifyTables, args.productionOrgId));
  const bypassSandbox = await withBypass(() => countChunk(verifyTables, args.sandboxOrgId));
  const scopedProduction = await withOrg(args.productionOrgId, () => countChunk(verifyTables, null));
  const scopedSandbox = await withOrg(args.sandboxOrgId, () => countChunk(verifyTables, null));
  const scopedBogus = await withOrg(BOGUS_ORG_ID, () => countChunk(verifyTables, null));

  const tables: CloneRlsTableCounts[] = verifyTables.map((table) => ({
    table,
    bypassProduction: bypassProduction.get(table) ?? 0,
    bypassSandbox: bypassSandbox.get(table) ?? 0,
    scopedProduction: scopedProduction.get(table) ?? 0,
    scopedSandbox: scopedSandbox.get(table) ?? 0,
    scopedBogus: scopedBogus.get(table) ?? 0,
  }));

  const proof: CloneRlsProof = {
    productionOrgId: args.productionOrgId,
    sandboxOrgId: args.sandboxOrgId,
    tables,
    unverifiedTables: unverifiedCloneRlsTables(tables),
  };
  evaluateCloneRlsProof(proof);
  return proof;
}

async function resolveClonePair(argv: string[]): Promise<{
  productionOrgId: string;
  sandboxOrgId: string;
  tier: SandboxTier;
}> {
  const productionOrgId = argv[0];
  const sandboxOrgId = argv[1];
  if (productionOrgId && sandboxOrgId) {
    const row = await withBypass(async () => {
      const result = await db.execute<{ tier: SandboxTier }>(sql`
        select tier from sandboxes where org_id = ${sandboxOrgId} order by created_at desc limit 1`);
      return result.rows[0];
    });
    if (!row) {
      throw new Error(
        `clone RLS re-verification found no sandbox row for ${sandboxOrgId}; pass the production org and the sandbox org createSandbox just created.`,
      );
    }
    return { productionOrgId, sandboxOrgId, tier: row.tier };
  }
  if (productionOrgId || sandboxOrgId) {
    throw new Error(
      "clone RLS re-verification usage: npx tsx engine/src/sandbox/verify-rls.ts <productionOrgId> <sandboxOrgId>",
    );
  }
  const pair = await withBypass(async () => {
    const result = await db.execute<{ production_org_id: string; org_id: string; tier: SandboxTier }>(sql`
      select production_org_id, org_id, tier
        from sandboxes
       where status = 'ready'
       order by created_at desc
       limit 1`);
    return result.rows[0];
  });
  if (!pair) {
    throw new Error(
      "clone RLS re-verification has no ready sandbox to check; pass productionOrgId and sandboxOrgId, or create a sandbox first.",
    );
  }
  return { productionOrgId: pair.production_org_id, sandboxOrgId: pair.org_id, tier: pair.tier };
}

async function main(): Promise<void> {
  try {
    const pair = await resolveClonePair(process.argv.slice(2));
    const proof = await verifyCloneRls(pair);
    console.log(
      `table checks for production ${proof.productionOrgId} vs sandbox ${proof.sandboxOrgId} (tier ${pair.tier})`,
    );
    for (const table of proof.tables) {
      const verified = table.bypassProduction > 0 && table.bypassSandbox > 0 ? "verified" : "UNVERIFIED (one side empty)";
      console.log(
        `  ${table.table} [${verified}]: bypass prod=${table.bypassProduction} sandbox=${table.bypassSandbox}; ` +
          `scoped prod=${table.scopedProduction} sandbox=${table.scopedSandbox} bogus=${table.scopedBogus}`,
      );
    }
    if ((proof.unverifiedTables ?? []).length > 0) {
      console.log(`unverified tables (empty on at least one side, proving nothing): ${proof.unverifiedTables!.join(", ")}`);
    }
    console.log(
      "clone RLS enforced: scoped counts match each tenant and the bogus org sees nothing.",
    );
  } finally {
    await pool.end();
  }
}

function launchedAsCli(): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && import.meta.url === pathToFileURL(entry).href;
}

if (launchedAsCli()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

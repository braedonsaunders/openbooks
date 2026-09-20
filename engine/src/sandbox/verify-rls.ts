/**
 * Clone-time RLS isolation proof. The create/refresh lifecycle calls
 * `verifyCloneRls` after the clone is materialized. Operators can also run:
 *   npx tsx engine/src/sandbox/verify-rls.ts [productionOrgId sandboxOrgId]
 *
 * Confirms deny-by-default tenant isolation is enforced at the database for
 * the production source AND its sandbox clone:
 *   - bypass counts of each tenant match scoped counts of that tenant
 *   - scoping to a different/bogus org sees ZERO (fail-closed, no leak)
 *   - an empty pair is a failure: isolation cannot be proven on zero rows
 */
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, withBypass, withOrg } from "../platform/db.ts";

export const BOGUS_ORG_ID = "00000000-0000-0000-0000-000000000000";
export const CLONE_RLS_TABLES = ["journal_lines", "accounts", "accounting_periods"] as const;
export type CloneRlsTable = (typeof CLONE_RLS_TABLES)[number];

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
};

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
    observedRows += table.bypassProduction + table.bypassSandbox;
  }

  if (observedRows === 0) {
    const names = proof.tables.map((table) => table.table).join(", ");
    throw new Error(
      `clone RLS re-verification failed: production ${proof.productionOrgId} and sandbox ${proof.sandboxOrgId} have zero rows on ${names}; isolation cannot be proven on empty tables. Clone a tenant that holds accounts or accounting periods, or pass tables the clone actually copied.`,
    );
  }
}

async function countScoped(table: CloneRlsTable): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.raw(`"${table}"`)}`,
  );
  return result.rows[0]?.n ?? 0;
}

async function countForOrg(table: CloneRlsTable, orgId: string): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.raw(`"${table}"`)} where org_id = ${orgId}`,
  );
  return result.rows[0]?.n ?? 0;
}

export async function verifyCloneRls(args: {
  productionOrgId: string;
  sandboxOrgId: string;
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

  const bypass = await withBypass(async () => {
    const counts: Array<{ table: CloneRlsTable; production: number; sandbox: number }> = [];
    for (const table of CLONE_RLS_TABLES) {
      counts.push({
        table,
        production: await countForOrg(table, args.productionOrgId),
        sandbox: await countForOrg(table, args.sandboxOrgId),
      });
    }
    return counts;
  });

  const tables: CloneRlsTableCounts[] = [];
  for (const row of bypass) {
    tables.push({
      table: row.table,
      bypassProduction: row.production,
      bypassSandbox: row.sandbox,
      scopedProduction: await withOrg(args.productionOrgId, () => countScoped(row.table)),
      scopedSandbox: await withOrg(args.sandboxOrgId, () => countScoped(row.table)),
      scopedBogus: await withOrg(BOGUS_ORG_ID, () => countScoped(row.table)),
    });
  }

  const proof = {
    productionOrgId: args.productionOrgId,
    sandboxOrgId: args.sandboxOrgId,
    tables,
  };
  evaluateCloneRlsProof(proof);
  return proof;
}

async function resolveClonePair(argv: string[]): Promise<{
  productionOrgId: string;
  sandboxOrgId: string;
}> {
  const productionOrgId = argv[0];
  const sandboxOrgId = argv[1];
  if (productionOrgId && sandboxOrgId) {
    return { productionOrgId, sandboxOrgId };
  }
  if (productionOrgId || sandboxOrgId) {
    throw new Error(
      "clone RLS re-verification usage: npx tsx engine/src/sandbox/verify-rls.ts <productionOrgId> <sandboxOrgId>",
    );
  }
  const pair = await withBypass(async () => {
    const result = await db.execute<{ production_org_id: string; org_id: string }>(sql`
      select production_org_id, org_id
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
  return { productionOrgId: pair.production_org_id, sandboxOrgId: pair.org_id };
}

async function main(): Promise<void> {
  try {
    const pair = await resolveClonePair(process.argv.slice(2));
    const proof = await verifyCloneRls(pair);
    console.log(
      `table checks for production ${proof.productionOrgId} vs sandbox ${proof.sandboxOrgId}`,
    );
    for (const table of proof.tables) {
      console.log(
        `  ${table.table}: bypass prod=${table.bypassProduction} sandbox=${table.bypassSandbox}; ` +
          `scoped prod=${table.scopedProduction} sandbox=${table.scopedSandbox} bogus=${table.scopedBogus}`,
      );
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

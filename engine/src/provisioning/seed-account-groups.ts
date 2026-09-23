import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { ensureAccountGroupDefaults } from "./account-group-defaults.ts";

/**
 * Seed the default `cost_pool` and `burden` account groups used by the True
 * Cost report:
 *   npx tsx engine/src/provisioning/seed-account-groups.ts [<orgId>]
 *
 * INSERT-MISSING ONLY (see ensureAccountGroupDefaults): existing groups are
 * never updated and deactivated groups are never reactivated, so re-running
 * this after an operator customizes a rule in Admin → Setup → Account Groups
 * preserves their classification policy. With no argument every org is
 * covered; with an org id only that org is touched. The target is always
 * explicit — never "the first org".
 */

async function groupCounts(orgId: string): Promise<{ costPool: number; burden: number }> {
  const rows = (await db.execute<{ dimension: string; n: number }>(sql`
    select dimension, count(*)::int as n
      from account_groups
     where org_id = ${orgId} and dimension in ('cost_pool', 'burden')
     group by dimension
  `)).rows;
  return {
    costPool: rows.find((row) => row.dimension === "cost_pool")?.n ?? 0,
    burden: rows.find((row) => row.dimension === "burden")?.n ?? 0,
  };
}

async function orgName(orgId: string): Promise<string | null> {
  const rows = (await db.execute<{ name: string }>(sql`
    select name from orgs where id = ${orgId}
  `)).rows;
  return rows[0]?.name ?? null;
}

async function main() {
  const onlyOrgId = process.argv[2];
  if (onlyOrgId) {
    const name = await orgName(onlyOrgId);
    if (!name) {
      throw new Error(
        `no org with id ${onlyOrgId} is visible — check the id and that this connection may read that org, then retry`,
      );
    }
    await ensureAccountGroupDefaults(onlyOrgId);
    const counts = await groupCounts(onlyOrgId);
    console.log(
      `org "${name}": ${counts.costPool} cost_pool + ${counts.burden} burden group(s) present (missing defaults inserted, existing groups untouched)`,
    );
    return;
  }
  const orgs = (await db.execute<{ id: string; name: string }>(sql`
    select id, name from orgs order by created_at
  `));
  if (orgs.rows.length === 0) {
    throw new Error("no orgs found — create an org before seeding account groups");
  }
  for (const org of orgs.rows) {
    await ensureAccountGroupDefaults(org.id);
    const counts = await groupCounts(org.id);
    console.log(
      `org "${org.name}": ${counts.costPool} cost_pool + ${counts.burden} burden group(s) present (missing defaults inserted, existing groups untouched)`,
    );
  }
}

/**
 * Run directly (`tsx seed-account-groups.ts`) but never merely because this
 * module was bundled into another executable. In an esbuild bundle,
 * `import.meta.url` is the bundle URL for every inlined module, so comparing it
 * with argv[1] incorrectly launched this CLI from deployment bootstrap.mjs.
 */
export function isSeedAccountGroupsCli(entrypoint: string | undefined): boolean {
  return /(^|[/\\])seed-account-groups\.(?:[cm]?[jt]s)$/.test(entrypoint ?? "");
}

if (isSeedAccountGroupsCli(process.argv[1])) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

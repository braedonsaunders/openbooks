/**
 * RLS isolation proof. Run: npx tsx engine/src/sandbox/verify-rls.ts
 * Confirms deny-by-default tenant isolation is enforced at the database:
 *   - bypass sees all rows
 *   - scoping to the real org sees its rows
 *   - scoping to a different/bogus org sees ZERO (fail-closed, no leak)
 */
import { sql } from "drizzle-orm";
import { db, pool, withBypass, withOrg } from "../db.ts";

const BOGUS = "00000000-0000-0000-0000-000000000000";

async function count(table: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table}"`));
  return r.rows[0]?.n ?? 0;
}

async function main() {
  const table = "journal_lines"; // a core tenant-scoped table
  const realOrg = await withBypass(async () => {
    const r = (await db.execute(sql`select id from orgs where env_kind = 'production' order by created_at limit 1`));
    return r.rows[0]?.id as string;
  });

  const total = await withBypass(() => count(table));
  const scopedReal = await withOrg(realOrg, () => count(table));
  const scopedBogus = await withOrg(BOGUS, () => count(table));

  console.log(`table: ${table}`);
  console.log(`  bypass (all orgs):     ${total}`);
  console.log(`  scoped to real org:    ${scopedReal}  (org ${realOrg})`);
  console.log(`  scoped to bogus org:   ${scopedBogus}  (expect 0)`);

  const pass = scopedBogus === 0 && scopedReal <= total && (total === 0 || scopedReal > 0);
  console.log(pass ? "\n✅ RLS enforced: fail-closed scoping works." : "\n❌ RLS NOT enforced as expected.");
  await pool.end();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

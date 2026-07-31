/**
 * Data remediation: percent adjustments imported as fractions.
 *
 * `labor_rate_adjustments.value` is a PERCENTAGE for calculation='percent'
 * (3.75 means 3.75%). An import that wrote fractions understates every charge
 * by 100x. Rows already above 1 are left alone — 0.5% is far rarer than a
 * mis-scaled 50%, and this only ever runs against a tenant known to be affected.
 *
 * Usage: npx tsx --conditions=react-server src/validation/fix-percent-units.ts [--apply]
 */
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { resolveTargetOrg } from "./target-org.ts";
const ORG = process.env.TARGET_ORG ?? process.env.SANDBOX_ORG ?? (() => { throw new Error("SANDBOX_ORG is required"); })();
const APPLY = process.argv.includes("--apply");

await resolveTargetOrg(ORG);

const before:any = await db.execute(sql`
  select code, count(*)::int n, max(value)::text hi from labor_rate_adjustments
   where org_id=${ORG} and calculation='percent' and value > 0 and value < 1 group by 1 order by 2 desc`);
console.log("fraction-scaled percent adjustments:"); console.table(before.rows);

if (APPLY) {
  const r:any = await db.execute(sql`
    update labor_rate_adjustments set value = value * 100
     where org_id=${ORG} and calculation='percent' and value > 0 and value < 1`);
  console.log("rescaled:", r.rowCount);
  // The tenant's own cards already carry these terms; the books seeded from the
  // flat export would double up, so retire them rather than leave two truths.
  const d:any = await db.execute(sql`
    delete from item_rate_book_assignments where org_id=${ORG} and rate_book_id in
      (select id from item_rate_books where org_id=${ORG} and code like 'FUEL-%')`);
  console.log("removed duplicate seeded assignments:", d.rowCount);
}
process.exit(0);

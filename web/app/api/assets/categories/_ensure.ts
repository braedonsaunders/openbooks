import "server-only";
import { sql } from "drizzle-orm";
import { inDbTransaction } from "@openbooks/engine/src/platform/db.ts";

/**
 * Every fixed asset needs a category (fixed_assets.category_id is NOT NULL).
 * A brand-new draft asset therefore needs *some* category up front; the drawer
 * lets the user pick/override the real accounts afterward.
 *
 * ensureDefaultCategory returns the org's default category id, creating an
 * "Uncategorised" one on first use. The three posting-role accounts are stored
 * only when the chart supplies all three shapes (an asset_fixed account, its
 * paired accumulated-depreciation account, and a depreciation-expense
 * account); otherwise the category is explicitly unconfigured (all three
 * NULL, see 0384_asset_category_unconfigured_accounts). Drafts may reference
 * an unconfigured category, but in-service and posting transitions refuse by
 * name until real roles are assigned. The accounts are always overridable per
 * asset in the drawer.
 */
export async function ensureDefaultCategory(
  orgId: string,
  actorId: string | null,
): Promise<string> {
  // Category creation is a first-use write, so the existence check, role
  // lookups, and insert must share one transaction-scoped fence. The storage
  // uniqueness index is the final authority for callers that do not use this
  // helper; the fence keeps this helper's normal path deterministic too.
  return inDbTransaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`asset-category:${orgId}`}, 0)
      )`);

    const existing = await tx.execute<{ id: string }>(sql`
      select id from asset_categories where org_id = ${orgId} and name = 'Uncategorised' limit 1
    `);
    if (existing.rows[0]) return existing.rows[0].id;

    // Posting-role lookups from the COA; each may come back empty.
    const pick = async (whereSql: ReturnType<typeof sql>) => {
      const r = await tx.execute<{ id: string }>(sql`
        select id from accounts
         where org_id = ${orgId} and is_active and not is_summary ${whereSql}
         order by number nulls last limit 1`);
      return r.rows[0]?.id ?? null;
    };
    const assetAcct = await pick(
      sql`and type = 'asset_fixed' and name not ilike '%accumulat%' and name not ilike '%amortiz%'`,
    );
    const accumAcct = await pick(
      sql`and type = 'asset_fixed' and (name ilike '%accumulat%' or name ilike '%amortiz%')`,
    );
    const expenseAcct = await pick(
      sql`and name ilike '%depreciation%' and type in ('expense', 'cogs', 'other_expense')`,
    );

    // I2-money-42: never seed the default category with arbitrary accounts. A
    // shared or mistyped fallback here would let drafts reach in-service and
    // posting flows against cash, liability, or one shared account. Unless the
    // chart supplies all three posting roles, store an explicitly unconfigured
    // (all-NULL) category; a partial triple has no meaning, so the insert is
    // coerced to match the schema all-or-nothing rule.
    const roles: [string | null, string | null, string | null] =
      assetAcct !== null && accumAcct !== null && expenseAcct !== null
        ? [assetAcct, accumAcct, expenseAcct]
        : [null, null, null];
    const ins = await tx.execute<{ id: string }>(sql`
      insert into asset_categories
        (org_id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
         default_method, default_life_months, created_by, updated_by)
      values (${orgId}, 'Uncategorised',
              ${roles[0]}, ${roles[1]}, ${roles[2]},
              'straight_line', 60, ${actorId}, ${actorId})
      -- The org/name uniqueness index arbitrates racers that bypassed the
      -- advisory lock; the committed winner is re-read below.
      on conflict do nothing
      returning id`);
    if (ins.rows[0]) return ins.rows[0].id;

    // A direct writer may have won the uniqueness race without taking our
    // advisory lock. Re-read the committed winner instead of returning an
    // empty id or creating a second category.
    const winner = await tx.execute<{ id: string }>(sql`
      select id from asset_categories where org_id = ${orgId} and name = 'Uncategorised' limit 1
    `);
    if (!winner.rows[0])
      throw new Error("default asset category insert was not committed");
    return winner.rows[0].id;
  });
}

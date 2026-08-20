import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Every fixed asset needs a category (fixed_assets.category_id is NOT NULL and
 * the category carries the three GL accounts a depreciation entry touches). A
 * brand-new draft asset therefore needs *some* category up front; the drawer
 * lets the user pick/override the real accounts afterward.
 *
 * ensureDefaultCategory returns the org's default category id, creating an
 * "Uncategorised" one on first use whose accounts are best-effort guessed from
 * the chart of accounts (an asset_fixed account, its paired accumulated-
 * depreciation account, and a depreciation-expense account). The accounts are
 * only defaults — they are always overridable per asset in the drawer.
 */
export async function ensureDefaultCategory(orgId: string, actorId: string | null): Promise<string> {
  const existing = (await db.execute<{ id: string }>(sql`
    select id from asset_categories where org_id = ${orgId} and name = 'Uncategorised' limit 1
  `))
  if (existing.rows[0]) return existing.rows[0].id

  // best-effort account guesses from the COA
  const pick = async (whereSql: ReturnType<typeof sql>) => {
    const r = (await db.execute<{ id: string }>(sql`
      select id from accounts
       where org_id = ${orgId} and is_active and not is_summary ${whereSql}
       order by number nulls last limit 1`))
    return r.rows[0]?.id ?? null
  }
  const assetAcct = await pick(sql`and type = 'asset_fixed' and name not ilike '%accumulat%' and name not ilike '%amortiz%'`)
  const accumAcct =
    (await pick(sql`and type = 'asset_fixed' and (name ilike '%accumulat%' or name ilike '%amortiz%')`)) ?? assetAcct
  const expenseAcct =
    (await pick(sql`and name ilike '%depreciation%' and type in ('expense', 'cogs', 'other_expense')`)) ??
    (await pick(sql`and type in ('expense', 'cogs', 'other_expense')`))

  // Fall back to *any* active non-summary account if the COA lacks the shapes —
  // the notNull columns must be satisfied; the user re-picks in the drawer.
  const anyAcct = assetAcct ?? (await pick(sql``))
  if (!anyAcct) throw new Error('no accounts exist to seed an asset category')

  const ins = (await db.execute<{ id: string }>(sql`
    insert into asset_categories
      (org_id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
       default_method, default_life_months, created_by, updated_by)
    values (${orgId}, 'Uncategorised',
            ${assetAcct ?? anyAcct}, ${accumAcct ?? anyAcct}, ${expenseAcct ?? anyAcct},
            'straight_line', 60, ${actorId}, ${actorId})
    returning id`))
  return ins.rows[0].id
}

/**
 * HOME-DASHBOARD SEED.
 *
 * Seeds real, queryable insight CARDS (built on the same @openbooks/analytics
 * query model CardStudio uses — no hardcoded HTML) and arranges them on two
 * published dashboards:
 *   • "Company overview"   → is_home = true            (system default)
 *   • "Financial snapshot" → home_for_role = 'viewer'  (lighter read-only board)
 *
 * The home-surface columns (insight_dashboards.is_home / home_for_role,
 * users.home_dashboard_id) are created by migration 0010_ai_assistant.sql;
 * see schema/src/insights.ts + schema/src/extension.ts.
 *
 * Idempotent: re-running upserts the seeded cards/dashboards by (org, name) and
 * never duplicates. Run:  npx tsx engine/seed-home-dashboard.mts
 */
import { sql } from 'drizzle-orm'
import { db, pool } from './src/db.ts'

type Card = {
  key: string
  name: string
  description: string
  vizType: 'table' | 'bar' | 'line' | 'area' | 'pie'
  query: Record<string, unknown>
  vizSettings?: Record<string, unknown>
}

// ---- the seeded cards (query model == CardStudio's) -------------------------
// Sign convention (ledger_lines.amount): debit positive / credit negative.
//   asset_bank / asset_receivable read positive via sum(amount).
//   liability_payable is credit-normal → use the `credit` field (= -amount, ≥0).
//   income is credit-normal          → `credit`.  cogs/expense are debit-normal → `debit`.
const CARDS: Card[] = [
  {
    key: 'cash-position',
    name: 'Cash position',
    description: 'Balance by bank account',
    vizType: 'bar',
    query: {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount', alias: 'balance' }],
      dimensions: [{ field: 'account_name' }],
      filters: [{ field: 'account_type', op: 'eq', value: 'asset_bank' }],
      sort: [{ ref: 'balance', dir: 'desc' }],
    },
    vizSettings: { horizontal: true, categoryField: 'account_name', valueFields: ['balance'], hideLegend: true },
  },
  {
    key: 'ar-outstanding',
    name: 'AR outstanding',
    description: 'Open receivables by customer',
    vizType: 'bar',
    query: {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount', alias: 'balance' }],
      dimensions: [{ field: 'party' }],
      filters: [{ field: 'account_type', op: 'eq', value: 'asset_receivable' }],
      sort: [{ ref: 'balance', dir: 'desc' }],
      limit: 12,
    },
    vizSettings: { horizontal: true, categoryField: 'party', valueFields: ['balance'], hideLegend: true },
  },
  {
    key: 'ap-outstanding',
    name: 'AP outstanding',
    description: 'Amounts owed to vendors',
    vizType: 'bar',
    query: {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'credit', alias: 'owed' }],
      dimensions: [{ field: 'party' }],
      filters: [{ field: 'account_type', op: 'eq', value: 'liability_payable' }],
      sort: [{ ref: 'owed', dir: 'desc' }],
      limit: 12,
    },
    vizSettings: { horizontal: true, categoryField: 'party', valueFields: ['owed'], hideLegend: true },
  },
  {
    key: 'revenue-by-month',
    name: 'Revenue by month',
    description: 'Recognized income, last 12 months',
    vizType: 'line',
    query: {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'credit', alias: 'revenue' }],
      dimensions: [{ field: 'posting_date', bin: 'month' }],
      filters: [
        { field: 'account_type', op: 'in', value: ['income', 'income_other'] },
        { field: 'posting_date', op: 'last_n_days', value: 365 },
      ],
      sort: [{ ref: 'posting_date', dir: 'asc' }],
    },
    vizSettings: { categoryField: 'posting_date', valueFields: ['revenue'], smooth: true, hideLegend: true },
  },
  {
    key: 'expenses-by-category',
    name: 'Expenses by category',
    description: 'Spend by account, this fiscal year',
    vizType: 'pie',
    query: {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'debit', alias: 'spend' }],
      dimensions: [{ field: 'account_name' }],
      filters: [
        { field: 'account_type', op: 'in', value: ['expense', 'expense_other', 'cogs'] },
        { field: 'posting_date', op: 'ytd' },
      ],
      sort: [{ ref: 'spend', dir: 'desc' }],
      limit: 10,
    },
    vizSettings: { categoryField: 'account_name', valueFields: ['spend'] },
  },
  {
    key: 'recent-activity',
    name: 'Recent activity',
    description: 'Latest documents',
    vizType: 'table',
    query: {
      source: 'documents',
      sort: [{ ref: 'document_date', dir: 'desc' }],
      limit: 15,
    },
  },
]

// Layout on the 12-col grid: [cardKey, x, y, w, h]
type Placement = [string, number, number, number, number]
const OVERVIEW_LAYOUT: Placement[] = [
  ['cash-position', 0, 0, 6, 6],
  ['revenue-by-month', 6, 0, 6, 6],
  ['ar-outstanding', 0, 6, 4, 6],
  ['ap-outstanding', 4, 6, 4, 6],
  ['expenses-by-category', 8, 6, 4, 6],
  ['recent-activity', 0, 12, 12, 6],
]
const VIEWER_LAYOUT: Placement[] = [
  ['revenue-by-month', 0, 0, 6, 6],
  ['expenses-by-category', 6, 0, 6, 6],
  ['recent-activity', 0, 6, 12, 6],
]

async function main() {
  const orgs = (await db.execute(sql`select id from orgs`)) as any
  for (const { id: orgId } of orgs.rows) {
    // a creator for audit columns (first admin, else any user)
    const who = (await db.execute(sql`
      select id from users where org_id = ${orgId} order by (role = 'admin') desc, created_at asc limit 1
    `)) as any
    const actor = who.rows[0]?.id ?? null

    // ---- 1. upsert cards (by org + name), publish them ---------------------
    const cardIdByKey = new Map<string, string>()
    for (const c of CARDS) {
      const existing = (await db.execute(sql`
        select id from insight_cards where org_id = ${orgId} and name = ${c.name} limit 1
      `)) as any
      if (existing.rows[0]) {
        const id = existing.rows[0].id
        await db.execute(sql`
          update insight_cards set
            description = ${c.description},
            query = ${JSON.stringify(c.query)}::jsonb,
            viz_type = ${c.vizType},
            viz_settings = ${JSON.stringify(c.vizSettings ?? {})}::jsonb,
            status = 'published', updated_at = now(), updated_by = ${actor}
          where id = ${id}
        `)
        cardIdByKey.set(c.key, id)
      } else {
        const ins = (await db.execute(sql`
          insert into insight_cards (org_id, name, description, query, viz_type, viz_settings, status, created_by, updated_by)
          values (${orgId}, ${c.name}, ${c.description}, ${JSON.stringify(c.query)}::jsonb, ${c.vizType},
                  ${JSON.stringify(c.vizSettings ?? {})}::jsonb, 'published', ${actor}, ${actor})
          returning id
        `)) as any
        cardIdByKey.set(c.key, ins.rows[0].id)
      }
    }
    console.log(`✓ [${orgId}] ${CARDS.length} cards published`)

    const toLayout = (placements: Placement[]) =>
      placements
        .filter(([k]) => cardIdByKey.has(k))
        .map(([k, x, y, w, h]) => ({ cardId: cardIdByKey.get(k), x, y, w, h }))

    // ---- 2. upsert the two home dashboards ---------------------------------
    async function upsertDashboard(
      name: string,
      description: string,
      layout: Placement[],
      flags: { isHome?: boolean; homeForRole?: string | null },
    ): Promise<string> {
      const l = JSON.stringify(toLayout(layout))
      const existing = (await db.execute(sql`
        select id from insight_dashboards where org_id = ${orgId} and name = ${name} limit 1
      `)) as any
      if (existing.rows[0]) {
        const id = existing.rows[0].id
        await db.execute(sql`
          update insight_dashboards set
            description = ${description}, layout = ${l}::jsonb, status = 'published',
            is_home = ${flags.isHome ?? false}, home_for_role = ${flags.homeForRole ?? null},
            updated_at = now(), updated_by = ${actor}
          where id = ${id}
        `)
        return id
      }
      const ins = (await db.execute(sql`
        insert into insight_dashboards (org_id, name, description, layout, status, is_home, home_for_role, created_by, updated_by)
        values (${orgId}, ${name}, ${description}, ${l}::jsonb, 'published',
                ${flags.isHome ?? false}, ${flags.homeForRole ?? null}, ${actor}, ${actor})
        returning id
      `)) as any
      return ins.rows[0].id
    }

    // Only one is_home per org — clear any prior flag first.
    await db.execute(sql`update insight_dashboards set is_home = false where org_id = ${orgId}`)
    const overviewId = await upsertDashboard(
      'Company overview',
      'The default home — cash, receivables, payables, revenue and recent activity.',
      OVERVIEW_LAYOUT,
      { isHome: true },
    )
    await upsertDashboard(
      'Financial snapshot',
      'A lighter read-only home for viewers — revenue, spend and recent activity.',
      VIEWER_LAYOUT,
      { homeForRole: 'viewer' },
    )
    console.log(`✓ [${orgId}] home dashboards seeded (system default = ${overviewId})`)
  }

  console.log('\nDone.')
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })

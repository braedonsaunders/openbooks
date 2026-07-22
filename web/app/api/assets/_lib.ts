import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { resolveAssetAccounts } from '@openbooks/engine/src/depreciation.ts'
import { add, fromUnits, toUnits } from '@openbooks/engine/src/money.ts'

/**
 * Asset payload for the flyout: the asset row, its category, the resolved
 * effective GL accounts (asset custom override → category), running totals
 * (accumulated depreciation, NBV) and the full period-by-period schedule.
 */
export interface AssetPayload {
  asset: Record<string, any>
  category: Record<string, any> | null
  accounts: {
    assetAccountId: string | null
    accumulatedDepreciationAccountId: string | null
    depreciationExpenseAccountId: string | null
  }
  accountNames: {
    asset: string | null
    accumulated: string | null
    expense: string | null
  }
  totals: {
    accumulated: string
    netBookValue: string
    posted: string
    planned: string
  }
  schedule: {
    id: string
    sequence: number
    periodName: string
    periodEndsOn: string
    plannedAmount: string
    postedAmount: string | null
    accumulated: string
    netBookValue: string
    journalEntryId: string | null
    source: 'formula' | 'manual' | 'production_usage' | 'imported'
    input: {
      id: string
      kind: 'manual' | 'production_usage'
      productionUnits: string | null
      memo: string
      evidenceReference: string
    } | null
  }[]
}

function acctName(r: Record<string, any> | undefined): string | null {
  if (!r) return null
  return `${r.number ?? ''} ${r.name ?? ''}`.trim() || null
}

export async function loadAsset(id: string, orgId: string): Promise<AssetPayload | null> {
  const assetRes = (await db.execute(sql`
    select * from fixed_assets where id = ${id} and org_id = ${orgId}
  `)) as unknown as { rows: Record<string, any>[] }
  const asset = assetRes.rows[0]
  if (!asset) return null

  const catRes = asset.category_id
    ? ((await db.execute(sql`
        select * from asset_categories where id = ${asset.category_id} and org_id = ${orgId}
      `)) as unknown as { rows: Record<string, any>[] })
    : { rows: [] }
  const category = catRes.rows[0] ?? null

  // Effective accounts (asset override → category).
  const eff = category
    ? resolveAssetAccounts(
        { custom: asset.custom },
        {
          assetAccountId: category.asset_account_id,
          accumulatedDepreciationAccountId: category.accumulated_depreciation_account_id,
          depreciationExpenseAccountId: category.depreciation_expense_account_id,
        },
      )
    : { assetAccountId: '', accumulatedDepreciationAccountId: '', depreciationExpenseAccountId: '' }

  const ids = [
    eff.assetAccountId,
    eff.accumulatedDepreciationAccountId,
    eff.depreciationExpenseAccountId,
  ].filter(Boolean)
  const acctRes = ids.length
    ? ((await db.execute(sql`
        select id, number, name from accounts
         where org_id = ${orgId} and id = any(${sql`array[${sql.join(
           ids.map((i) => sql`${i}::uuid`),
           sql`, `,
         )}]`})
      `)) as unknown as { rows: Record<string, any>[] })
    : { rows: [] }
  const byId = new Map(acctRes.rows.map((r) => [r.id, r]))

  // Full schedule for the primary book, period-ordered, with running totals.
  const linesRes = (await db.execute(sql`
    select l.id, l.sequence, l.planned_amount, l.posted_amount, l.journal_entry_id, l.source,
           i.id as input_id, i.kind as input_kind, i.production_units, i.memo as input_memo,
           i.evidence_reference,
           p.name as period_name, p.ends_on as period_ends_on, p.starts_on as period_starts_on
      from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id
      join accounting_books b on b.id = s.book_id and b.is_primary = true
      join accounting_periods p on p.id = l.period_id
      left join depreciation_inputs i on i.id = l.input_id
     where s.asset_id = ${id} and l.org_id = ${orgId}
     order by p.starts_on, l.sequence
  `)) as unknown as { rows: Record<string, any>[] }

  const cost = toUnits(String(asset.acquisition_cost ?? '0'))
  let running = '0.0000'
  let postedTotal = '0.0000'
  let plannedTotal = '0.0000'
  const schedule = linesRes.rows.map((l) => {
    const planned = String(l.planned_amount ?? '0')
    running = add(running, planned)
    plannedTotal = add(plannedTotal, planned)
    if (l.posted_amount != null) postedTotal = add(postedTotal, String(l.posted_amount))
    return {
      id: l.id as string,
      sequence: Number(l.sequence),
      periodName: l.period_name as string,
      periodEndsOn: l.period_ends_on as string,
      plannedAmount: String(l.planned_amount),
      postedAmount: l.posted_amount != null ? String(l.posted_amount) : null,
      accumulated: running,
      netBookValue: fromUnits(cost - toUnits(running)),
      journalEntryId: (l.journal_entry_id as string | null) ?? null,
      source: l.source as 'formula' | 'manual' | 'production_usage' | 'imported',
      input: l.input_id ? {
        id: l.input_id as string,
        kind: l.input_kind as 'manual' | 'production_usage',
        productionUnits: l.production_units != null ? String(l.production_units) : null,
        memo: String(l.input_memo),
        evidenceReference: String(l.evidence_reference),
      } : null,
    }
  })

  const accumulated = postedTotal
  const netBookValue = fromUnits(cost - toUnits(postedTotal))

  return {
    asset,
    category,
    accounts: {
      assetAccountId: eff.assetAccountId || null,
      accumulatedDepreciationAccountId: eff.accumulatedDepreciationAccountId || null,
      depreciationExpenseAccountId: eff.depreciationExpenseAccountId || null,
    },
    accountNames: {
      asset: acctName(byId.get(eff.assetAccountId)),
      accumulated: acctName(byId.get(eff.accumulatedDepreciationAccountId)),
      expense: acctName(byId.get(eff.depreciationExpenseAccountId)),
    },
    totals: {
      accumulated,
      netBookValue,
      posted: postedTotal,
      planned: plannedTotal,
    },
    schedule,
  }
}

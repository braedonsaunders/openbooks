import 'server-only'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/db.ts'
import { resolveAssetAccounts } from '@openbooks/engine/src/depreciation.ts'
import { fromUnits, toUnits } from '@openbooks/engine/src/money.ts'

/**
 * Asset payload for the flyout: the asset row, its category, the resolved
 * effective GL accounts (native asset override → category), running totals
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
  books: {
    id: string
    code: string
    name: string
    isPrimary: boolean
    postsGl: boolean
    method: string | null
    depreciationMethodId: string | null
    methodName: string | null
  }[]
  schedulePage: { total: number; page: number; perPage: number; bookId: string | null; query: string }
  hasAccountingEvidence: boolean
  schedule: {
    id: string
    sequence: number
    bookId: string
    bookCode: string
    bookName: string
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
      evidenceFileId: string
      evidenceFileName: string
    } | null
  }[]
}

function acctName(r: Record<string, any> | undefined): string | null {
  if (!r) return null
  return `${r.number ?? ''} ${r.name ?? ''}`.trim() || null
}

type LifecycleValueRow = {
  id: string
  book_id: string
  is_primary: boolean
  occurred_on: string
  kind: string
  amount: string | null
  source_kind: string | null
  source_amount: string | null
}

/** Retained originals and their reversals each affect their own effective date. */
function lifecycleValue(rows: LifecycleValueRow[], bookId?: string, through?: string) {
  let delta = 0n
  let disposals = 0
  for (const row of rows) {
    if (bookId ? row.book_id !== bookId : !row.is_primary) continue
    if (through && row.occurred_on > through) continue
    const reversed = row.kind === 'reversed'
    const kind = reversed ? row.source_kind : row.kind
    if (kind === 'impaired' || kind === 'revalued') {
      const amount = reversed ? row.source_amount : row.amount
      if (amount === null) throw new Error(`Asset valuation event ${row.id} has no amount`)
      delta += (reversed ? -1n : 1n) * toUnits(amount)
    } else if (kind === 'disposed' || kind === 'written_off') {
      disposals += reversed ? -1 : 1
    }
  }
  return { delta, disposed: disposals > 0 }
}

type AssetReadOptions = { bookId?: string | null; query?: string; page?: number; perPage?: number }

export async function loadAsset(
  id: string,
  orgId: string,
  options: AssetReadOptions = {},
): Promise<AssetPayload | null> {
  // Lifecycle writers lock this parent before changing journals and schedules.
  return db.transaction((tx) => loadAssetSnapshot(tx, id, orgId, options))
}

async function loadAssetSnapshot(
  tx: SqlExecutor,
  id: string,
  orgId: string,
  options: AssetReadOptions,
): Promise<AssetPayload | null> {
  const assetRes = (await tx.execute<Record<string, any>>(sql`
    select * from fixed_assets where id = ${id} and org_id = ${orgId} for share
  `))
  const asset = assetRes.rows[0]
  if (!asset) return null

  const catRes = asset.category_id
    ? ((await tx.execute<Record<string, any>>(sql`
        select * from asset_categories where id = ${asset.category_id} and org_id = ${orgId}
      `)))
    : { rows: [] }
  const category = catRes.rows[0] ?? null

  // Effective accounts (asset override → category).
  const eff = category
    ? resolveAssetAccounts(
        {
          assetAccountId: asset.asset_account_id,
          accumulatedDepreciationAccountId: asset.accumulated_depreciation_account_id,
          depreciationExpenseAccountId: asset.depreciation_expense_account_id,
        },
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
    ? ((await tx.execute<Record<string, any>>(sql`
        select id, number, name from accounts
         where org_id = ${orgId} and id = any(${sql`array[${sql.join(
           ids.map((i) => sql`${i}::uuid`),
           sql`, `,
         )}]`})
      `)))
    : { rows: [] }
  const byId = new Map(acctRes.rows.map((r) => [r.id, r]))

  const page = Number.isInteger(options.page) && options.page! > 0 ? options.page! : 1
  const perPage = Number.isInteger(options.perPage) && options.perPage! > 0 ? Math.min(options.perPage!, 100) : 25
  const query = (options.query ?? '').trim()
  const bookId = options.bookId ?? null
  const bookRows = await tx.execute<Record<string, any>>(sql`
      select b.id, b.code, b.name, b.is_primary, b.posts_gl,
             s.method, s.depreciation_method_id, m.name as method_name
        from accounting_books b
        left join depreciation_schedules s on s.book_id=b.id and s.asset_id=${id} and s.org_id=b.org_id
        left join depreciation_methods m on m.id=s.depreciation_method_id and m.org_id=s.org_id
       where b.org_id=${orgId} and b.is_active
       order by b.is_primary desc, b.code`)
  const totalRows = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
        join accounting_books b on b.id=s.book_id and b.org_id=s.org_id
        join accounting_periods p on p.id=l.period_id and p.org_id=l.org_id
       where s.asset_id=${id} and l.org_id=${orgId}
         ${bookId ? sql`and s.book_id=${bookId}` : sql``}
         ${query ? sql`and (p.name ilike ${`%${query}%`} or b.name ilike ${`%${query}%`} or l.source ilike ${`%${query}%`})` : sql``}`)
  const primaryTotals = await tx.execute<{ posted: string; planned: string; has_evidence: boolean }>(sql`
      select coalesce(sum(l.posted_amount),0)::text as posted,
             coalesce(sum(l.planned_amount),0)::text as planned,
             exists (
               select 1 from depreciation_schedules es
               join depreciation_schedule_lines el on el.schedule_id=es.id and el.org_id=es.org_id
               where es.asset_id=${id} and es.org_id=${orgId}
                 and (el.posted_amount is not null or el.input_id is not null or el.source='imported')
             ) as has_evidence
        from depreciation_schedules s
        join accounting_books b on b.id=s.book_id and b.org_id=s.org_id and b.is_primary
        left join depreciation_schedule_lines l on l.schedule_id=s.id and l.org_id=s.org_id
       where s.asset_id=${id} and s.org_id=${orgId}`)
  const lifecycle = (await tx.execute<LifecycleValueRow>(sql`
    select event.id, entry.book_id, book.is_primary, event.occurred_on::text,
           event.kind, event.amount::text, source.kind as source_kind,
           source.amount::text as source_amount
      from asset_events event
      join journal_entries entry on entry.id = event.journal_entry_id and entry.org_id = event.org_id
      join accounting_books book on book.id = entry.book_id and book.org_id = entry.org_id
      left join asset_events source on source.id = event.reverses_event_id and source.org_id = event.org_id
     where event.org_id = ${orgId} and event.asset_id = ${id}
       and entry.status in ('posted', 'reversed')
  `)).rows
  const linesRes = (await tx.execute<Record<string, any>>(sql`
    with schedule_rows as (
      select l.id, l.sequence, l.planned_amount, l.posted_amount, l.journal_entry_id, l.source,
             s.book_id, b.code as book_code, b.name as book_name,
             i.id as input_id, i.kind as input_kind, i.production_units, i.memo as input_memo,
             i.evidence_file_id, ef.name as evidence_file_name,
             p.name as period_name, p.ends_on as period_ends_on, p.starts_on as period_starts_on,
             sum(coalesce(l.posted_amount, l.planned_amount)) over (
               partition by l.schedule_id order by p.starts_on, l.sequence
               rows between unbounded preceding and current row
             )::text as accumulated
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
        join accounting_books b on b.id=s.book_id and b.org_id=s.org_id
        join accounting_periods p on p.id=l.period_id and p.org_id=l.org_id
        left join depreciation_inputs i on i.id=l.input_id and i.org_id=l.org_id
        left join files ef on ef.id=i.evidence_file_id and ef.org_id=i.org_id
       where s.asset_id=${id} and l.org_id=${orgId}
    )
    select * from schedule_rows
     where true
       ${bookId ? sql`and book_id=${bookId}` : sql``}
       ${query ? sql`and (period_name ilike ${`%${query}%`} or book_name ilike ${`%${query}%`} or source ilike ${`%${query}%`})` : sql``}
     order by book_code, period_starts_on, sequence
     limit ${perPage} offset ${(page - 1) * perPage}
  `))

  const cost = toUnits(String(asset.acquisition_cost ?? '0'))
  const schedule = linesRes.rows.map((l) => {
    const accumulated = String(l.accumulated ?? '0')
    const valuation = lifecycleValue(lifecycle, String(l.book_id), String(l.period_ends_on))
    return {
      id: l.id as string,
      sequence: Number(l.sequence),
      bookId: String(l.book_id),
      bookCode: String(l.book_code),
      bookName: String(l.book_name),
      periodName: l.period_name as string,
      periodEndsOn: l.period_ends_on as string,
      plannedAmount: String(l.planned_amount),
      postedAmount: l.posted_amount != null ? String(l.posted_amount) : null,
      accumulated,
      netBookValue: valuation.disposed ? '0.0000' : fromUnits(cost + valuation.delta - toUnits(accumulated)),
      journalEntryId: (l.journal_entry_id as string | null) ?? null,
      source: l.source as 'formula' | 'manual' | 'production_usage' | 'imported',
      input: l.input_id ? {
        id: l.input_id as string,
        kind: l.input_kind as 'manual' | 'production_usage',
        productionUnits: l.production_units != null ? String(l.production_units) : null,
        memo: String(l.input_memo),
        evidenceFileId: String(l.evidence_file_id),
        evidenceFileName: String(l.evidence_file_name),
      } : null,
    }
  })

  const postedTotal = String(primaryTotals.rows[0]?.posted ?? '0')
  const plannedTotal = String(primaryTotals.rows[0]?.planned ?? '0')
  const valuation = lifecycleValue(lifecycle)
  const disposed = valuation.disposed || asset.status === 'disposed' || asset.status === 'written_off'
  const accumulated = disposed ? '0.0000' : fromUnits(toUnits(postedTotal) - valuation.delta)
  const netBookValue = disposed ? '0.0000' : fromUnits(cost + valuation.delta - toUnits(postedTotal))

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
    books: bookRows.rows.map((row) => ({
      id: String(row.id), code: String(row.code), name: String(row.name),
      isPrimary: Boolean(row.is_primary), postsGl: Boolean(row.posts_gl),
      method: row.method == null ? null : String(row.method),
      depreciationMethodId: row.depreciation_method_id == null ? null : String(row.depreciation_method_id),
      methodName: row.method_name == null ? null : String(row.method_name),
    })),
    schedulePage: { total: Number(totalRows.rows[0]?.n ?? 0), page, perPage, bookId, query },
    hasAccountingEvidence: Boolean(primaryTotals.rows[0]?.has_evidence) || lifecycle.length > 0,
    schedule,
  }
}

import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type {
  ReportCustomQuery,
  ReportEntity,
  ReportGroup,
  ReportRunLabels,
  ReportRunResult,
} from '@openbooks/reports'
import { decimalAdd, type ExactDecimal } from './statement-format'

/**
 * Rows-mode collapse for the report-builder entities that can carry
 * per-employee payroll detail (`ledger_lines`, `transaction_lines`), for
 * readers WITHOUT payroll.read.
 *
 * Identity is already masked at this point (the per-reader catalog rewrites
 * party columns for restricted readers), but each party-tagged payroll leg is
 * still its own row with its own amount — the per-employee leak. This wrapper
 * merges those rows per (entry/document, account, currency) by summing every
 * money column, so aggregates still tie to the GL while no per-employee
 * amount survives. Non-payroll rows pass through untouched, in order, with
 * the merged row at its group's first position.
 *
 * Summarize mode needs no wrapper: its rows are aggregates already, and the
 * masked party expressions group payroll legs under the restricted label.
 *
 * When the plan omits the keys needed to attribute rows (no entry/document
 * id, or no account identity), the result is returned unchanged — identity
 * stays masked by the catalog rewrite, and the limitation is documented
 * rather than guessed around. Money cells that do not parse as plain
 * numerics refuse loudly instead of summing wrong.
 */

const COLLAPSIBLE: Record<string, { entryColumn: string; pairSource: 'journal' | 'document' }> = {
  ledger_lines: { entryColumn: 'entry_id', pairSource: 'journal' },
  transaction_lines: { entryColumn: 'document_id', pairSource: 'document' },
}

const MONEY_RE = /^-?\d+(\.\d+)?$/

function parseMoneyCell(value: string | number | null | undefined): ExactDecimal | null {
  if (value == null || value === '') return null
  const text = String(value).trim()
  if (!MONEY_RE.test(text)) {
    throw new Error('payroll confidentiality collapse met an unparseable amount — refusing rather than summing wrong')
  }
  return text
}

/** (entry/document, account) pairs carrying party-tagged payroll legs. */
async function payrollPairs(
  orgId: string,
  source: 'journal' | 'document',
  entries: string[],
): Promise<Set<string>> {
  if (entries.length === 0) return new Set()
  const pairs = source === 'journal'
    ? (await db.execute<{ entry_id: string; account_id: string }>(sql`
        select distinct jl.entry_id, jl.account_id
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
          left join documents d on d.id = je.source_document_id and d.org_id = je.org_id
         where jl.org_id = ${orgId} and jl.entry_id in ${entries}
           and jl.party_id is not null
           and (d.kind = 'pay_run' or je.origin = 'payroll')
      `)).rows.map((row) => `${row.entry_id}\0${row.account_id}`)
    : (await db.execute<{ entry_id: string; account_id: string }>(sql`
        select distinct dl.document_id as entry_id, dl.account_id
          from document_lines dl
          join documents d on d.id = dl.document_id and d.org_id = dl.org_id
         where dl.org_id = ${orgId} and dl.document_id in ${entries}
           and d.kind = 'pay_run' and dl.party_id is not null
      `)).rows.map((row) => `${row.entry_id}\0${row.account_id}`)
  return new Set(pairs)
}

export async function applyPayrollConfidentialityToReportResult(args: {
  orgId: string
  query: ReportCustomQuery
  entity: ReportEntity
  result: ReportRunResult
  labels: ReportRunLabels
  /** False when the reader holds payroll.read (full detail, no-op). */
  restricted: boolean
}): Promise<ReportRunResult> {
  const { orgId, query, entity, result, labels, restricted } = args
  if (!restricted) return result
  if (query.mode !== 'rows') return result
  const spec = COLLAPSIBLE[entity.key]
  if (!spec) return result
  const planColumns = [...(query.columns ?? [])]
  if (query.groupBy && !planColumns.includes(query.groupBy)) planColumns.push(query.groupBy)
  const entryIndex = planColumns.indexOf(spec.entryColumn)
  if (entryIndex < 0) return result
  const accountIdIndex = planColumns.indexOf('account_id')
  const accountNumberIndex = planColumns.indexOf('account_number')
  const accountNameIndex = planColumns.indexOf('account_name')
  if (accountIdIndex < 0 && (accountNumberIndex < 0 || accountNameIndex < 0)) return result
  const moneyIndexes = planColumns
    .map((key, index) => ({ key, index }))
    .filter(({ key }) => entity.columns.find((column) => column.key === key)?.kind === 'money')
    .map(({ index }) => index)
  const currencyIndexes = ['currency', 'base_currency']
    .map((key) => planColumns.indexOf(key))
    .filter((index) => index >= 0)

  const accountOf = (row: ReportGroup['rows'][number]): string | null => {
    if (accountIdIndex >= 0) {
      const value = row[accountIdIndex]
      return value == null || value === '' ? null : String(value)
    }
    const number = row[accountNumberIndex]
    const name = row[accountNameIndex]
    if ((number == null || number === '') && (name == null || name === '')) return null
    return `${String(number ?? '')}\0${String(name ?? '')}`
  }

  const entries = [...new Set(
    result.groups.flatMap((group) => group.rows.map((row) => row[entryIndex])),
  )]
    .filter((value): value is string | number => value != null && value !== '')
    .map(String)
  const pairs = await payrollPairs(orgId, spec.pairSource, entries)
  if (pairs.size === 0) return result

  let removedTotal = 0
  const rowCount = (n: number): string => labels.rowCount?.(n) ?? `${n} row(s)`
  const groups = result.groups.map((group) => {
    const out: ReportGroup['rows'] = []
    const at = new Map<string, number>()
    let removed = 0
    for (const row of group.rows) {
      const entry = row[entryIndex]
      const account = accountOf(row)
      const pairKey = entry != null && entry !== '' && account != null
        ? `${String(entry)}\0${account}`
        : null
      if (pairKey == null || !pairs.has(pairKey)) {
        out.push(row)
        continue
      }
      const key = [pairKey, ...currencyIndexes.map((index) => String(row[index] ?? ''))].join('\0')
      const existing = at.get(key)
      if (existing == null) {
        at.set(key, out.length)
        out.push([...row])
        continue
      }
      removed += 1
      const merged = out[existing]!
      for (const index of moneyIndexes) {
        const current = parseMoneyCell(merged[index])
        const incoming = parseMoneyCell(row[index])
        merged[index] = current == null && incoming == null
          ? null
          : decimalAdd(current ?? '0', incoming ?? '0')
      }
    }
    removedTotal += removed
    if (removed === 0) return group
    // Neither collapsible entity authors cell links, so there is nothing to
    // realign; if links ever appear, drop rather than misalign them.
    const { cellLinks: _cellLinks, ...rest } = group
    return {
      ...rest,
      rows: out,
      subtitle: rowCount(out.length),
      isEmpty: out.length === 0,
    }
  })
  if (removedTotal === 0) return result
  const rowCountTotal = result.rowCount - removedTotal
  return {
    ...result,
    groups,
    summary: result.summary.map((item, index) => (index === 0 ? { ...item, value: rowCountTotal } : item)),
    rowCount: rowCountTotal,
    ...(result.pageInfo
      ? {
        pageInfo: {
          ...result.pageInfo,
          totalRows: Math.max(0, result.pageInfo.totalRows - removedTotal),
          hasNext: result.pageInfo.offset + rowCountTotal < result.pageInfo.totalRows - removedTotal,
        },
      }
      : {}),
  }
}

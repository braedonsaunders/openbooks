'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { buildLineageQuery, shortId, type LineageAnchorInput } from './lineage-helpers'

interface LineageRow {
  id: string
  ruleKey: string | null
  driverKey: string | null
  driverValue: string | null
  share: string | null
  amount: string
  residual: string
  journalEntryId: string | null
}

/**
 * Compact lineage drill (A8), reusable by the Runs tab (A8), the GL impact
 * drawer (A5) and the line grid (A9): from a run, a journal entry or a
 * document, every allocated line back to its rule, driver share and amount.
 * Pass `journalHref` where the host page can open a `?txn=` drawer; without
 * it the entry renders as a compact id.
 *
 * Server-paginated (S3b): the drill walks every page through Previous/Next
 * with a "Rows x–y of z" status, so a run with more lines than fit one page
 * never strands rows past the first page behind a static notice.
 */
export function LineagePanel({
  anchor,
  journalHref,
  pageSize = 50,
}: {
  anchor: LineageAnchorInput
  journalHref?: (entryId: string) => string
  pageSize?: number
}) {
  const t = useTranslations('allocations.lineage')
  const [rows, setRows] = useState<LineageRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // The anchor arrives as a fresh object on every parent render: key the
  // drill on the built query string, so paging survives re-renders and
  // resets only when the anchor actually changes.
  let anchorKey: string | null = null
  try {
    anchorKey = buildLineageQuery(anchor)
  } catch {
    anchorKey = null
  }
  const [lastKey, setLastKey] = useState(anchorKey)
  if (anchorKey !== lastKey) {
    setLastKey(anchorKey)
    setOffset(0)
  }

  useEffect(() => {
    // An invalid anchor renders the empty state below; nothing to fetch.
    if (anchorKey === null) return
    let cancelled = false
    fetch(buildLineageQuery(anchor, { limit: pageSize, offset })).then(
      async (res) => {
        if (cancelled) return
        if (!res.ok) {
          setError(t('loadFailed'))
          setRows([])
          return
        }
        const body = (await res.json()) as { rows: LineageRow[]; total: number }
        if (cancelled) return
        // Rows vanished under the page (deleted run): restart at the first
        // page instead of stranding the drill on an empty one.
        if (body.rows.length === 0 && body.total > 0 && offset > 0) {
          setOffset(0)
          return
        }
        setRows(body.rows)
        setTotal(body.total)
      },
      () => {
        if (!cancelled) setRows([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [anchor, anchorKey, pageSize, offset, t])

  if (rows === null) return <p className="text-sm text-slate-500">{'…'}</p>
  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (anchorKey === null || (rows.length === 0 && total === 0)) {
    return <p className="text-sm text-slate-500">{t('empty')}</p>
  }

  const from = offset + 1
  const to = offset + rows.length
  const hasPrevious = offset > 0
  const hasNext = offset + rows.length < total

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{t('title')}</h4>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('rule')}</TableHead>
            <TableHead>{t('driver')}</TableHead>
            <TableHead className="text-right">{t('share')}</TableHead>
            <TableHead className="text-right">{t('amount')}</TableHead>
            <TableHead>{t('viewJournal')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.ruleKey ?? shortId(row.id)}</TableCell>
              <TableCell>{row.driverKey ?? '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{row.share ?? '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{row.amount}</TableCell>
              <TableCell>
                {row.journalEntryId ? (
                  journalHref ? (
                    <Link className="underline" href={journalHref(row.journalEntryId) as never}>
                      {t('viewJournal')}
                    </Link>
                  ) : (
                    <span className="tabular-nums text-slate-500">{shortId(row.journalEntryId)}</span>
                  )
                ) : (
                  '—'
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {total > pageSize ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-slate-500">{t('pageStatus', { from, to, total })}</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!hasPrevious}
              onClick={() => setOffset((current) => Math.max(0, current - pageSize))}
              className="text-sm underline disabled:text-slate-400 disabled:no-underline"
            >
              {t('previous')}
            </button>
            <button
              type="button"
              disabled={!hasNext}
              onClick={() => setOffset((current) => current + pageSize)}
              className="text-sm underline disabled:text-slate-400 disabled:no-underline"
            >
              {t('next')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

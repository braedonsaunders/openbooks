'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
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
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    let url: string
    try {
      url = buildLineageQuery(anchor)
    } catch {
      setRows([])
      return
    }
    const res = await fetch(url)
    if (!res.ok) {
      setError(t('loadFailed'))
      setRows([])
      return
    }
    const body = (await res.json()) as { rows: LineageRow[] }
    setRows(body.rows.slice(0, pageSize))
  }, [anchor, pageSize, t])

  useEffect(() => {
    void load()
  }, [load])

  if (rows === null) return <p className="text-sm text-slate-500">{'…'}</p>
  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (rows.length === 0) return <p className="text-sm text-slate-500">{t('empty')}</p>

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
    </div>
  )
}

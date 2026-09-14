'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Alert,
  AlertDescription,
  Button,
  Drawer,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { dateTime } from '@/lib/format'

type EvidenceRow = {
  id: string
  at: string
  actor_id: string | null
  version?: string
  status?: string
  endpoint?: string
  action?: string
  namespace?: string
  key?: string
  [key: string]: unknown
}
export function AppHistory({
  appKey,
  section,
  canAuthor,
  onRevision,
}: {
  appKey: string
  section: 'versions' | 'runs' | 'audit' | 'storage'
  canAuthor: boolean
  onRevision: (id: string) => void
}) {
  const t = useTranslations('apps.management')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<{
    rows: EvidenceRow[]
    hasMore: boolean
    activeVersionId: string | null
  } | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<EvidenceRow | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void fetch(
      `/api/apps/${encodeURIComponent(appKey)}/management?section=${section}&page=${page}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? t('failed'))
        if (!controller.signal.aborted) setResult(body)
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : t('failed'))
      })
    return () => controller.abort()
  }, [appKey, section, page, refresh, t])
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">{t(`${section}Help`)}</p>
        <Button
          variant="outline"
          onClick={() => {
            setResult(null)
            setError('')
            setRefresh((value) => value + 1)
          }}
        >
          {t('refresh')}
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : !result ? (
        <p role="status">{t('loading')}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('when')}</TableHead>
                <TableHead>
                  {t(
                    section === 'versions'
                      ? 'version'
                      : section === 'storage'
                        ? 'key'
                        : 'activity',
                  )}
                </TableHead>
                <TableHead>{t('status')}</TableHead>
                <TableHead>{t('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.length ? (
                result.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{dateTime(row.at)}</TableCell>
                    <TableCell>
                      {row.version ??
                        row.endpoint ??
                        row.action ??
                        `${row.namespace}/${row.key}`}
                    </TableCell>
                    <TableCell>
                      {row.id === result.activeVersionId
                        ? t('active')
                        : (row.status ?? '—')}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelected(row)}
                        >
                          {t('details')}
                        </Button>
                        {section === 'versions' && canAuthor ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onRevision(row.id)}
                            >
                              {t('reviseVersion')}
                            </Button>
                            <Button size="sm" variant="ghost" asChild>
                              <a
                                href={`/api/apps/${encodeURIComponent(appKey)}/package?download=1&versionId=${row.id}`}
                              >
                                {t('download')}
                              </a>
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="py-8 text-center text-slate-500"
                  >
                    {t('empty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="outline"
              disabled={page === 1}
              onClick={() => {
                setResult(null)
                setError('')
                setPage((value) => value - 1)
              }}
            >
              {t('previous')}
            </Button>
            <span className="text-sm">{t('page', { page })}</span>
            <Button
              variant="outline"
              disabled={!result.hasMore}
              onClick={() => {
                setResult(null)
                setError('')
                setPage((value) => value + 1)
              }}
            >
              {t('next')}
            </Button>
          </div>
        </>
      )}
      {selected ? (
        <Drawer
          open
          stacked
          title={t('details')}
          size="lg"
          onClose={() => setSelected(null)}
        >
          <dl className="space-y-4">
            {Object.entries(selected).map(([key, value]) => (
              <div key={key}>
                <dt className="text-sm font-medium">
                  {t.has(`fields.${key}`) ? t(`fields.${key}`) : key}
                </dt>
                <dd className="mt-1 whitespace-pre-wrap break-words rounded bg-slate-50 p-3 font-mono text-xs dark:bg-slate-900">
                  {typeof value === 'object'
                    ? JSON.stringify(value, null, 2)
                    : String(value ?? '—')}
                </dd>
              </div>
            ))}
          </dl>
        </Drawer>
      ) : null}
    </div>
  )
}

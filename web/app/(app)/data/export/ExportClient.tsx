'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Label, PageHeader, Select } from '@openbooks/ui'
import { dataResourceLabel, dataFieldLabel } from '../../../../lib/data-io/labels'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { requestTransfer, useTransferJob } from '../../../../lib/data-io/transfer-client'
import { DataTransferStatus } from '../../../../components/data-transfer-status'
import { DataTransferPicker } from '../../../../components/data-transfer-picker'

interface ResourceDescriptor {
  key: string
  label: string
  group: string
  iconKey: string
}
interface Column {
  key: string
  label: string
}

const FORMATS = ['csv', 'xlsx', 'json'] as const
type Format = (typeof FORMATS)[number]

export function ExportClient() {
  const t = useTranslations('data')
  const tCatalog = useTranslations()
  const { job, remember, connectionError, running } = useTransferJob('export')
  const [resources, setResources] = useState<ResourceDescriptor[]>([])
  const [resource, setResource] = useState('')
  const [columns, setColumns] = useState<Column[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<Format>('csv')
  const [loadingCols, setLoadingCols] = useState(false)
  const [working, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const restoredJobId = useRef<string | null>(null)
  const creationRequest = useRef<{ key: string; inputs: string } | null>(null)
  const busy = working || running
  useEffect(() => {
    fetch('/api/data/resources')
      .then(async (r) => {
        if (!r.ok) throw new Error(await readApiErrorMessage(r, t('export.loadFailed')))
        return r.json()
      })
      .then((d) => setResources(d.resources ?? []))
      .catch((e) => {
        toast.error((e as Error).message)
      })
  }, [t])

  const grouped = useMemo(() => {
    const map = new Map<string, ResourceDescriptor[]>()
    for (const r of resources) {
      const list = map.get(r.group) ?? []
      list.push(r)
      map.set(r.group, list)
    }
    return [...map.entries()]
  }, [resources])

  const loadColumns = useCallback((key: string, restoredColumns?: string[]) => {
    if (!key) {
      setColumns([])
      setSelected(new Set())
      return
    }
    setLoadingCols(true)
    fetch(`/api/data/resources?key=${encodeURIComponent(key)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await readApiErrorMessage(r, t('export.columnsLoadFailed')))
        return r.json()
      })
      .then((d) => {
        const cols: Column[] = d.columns ?? []
        setColumns(cols)
        setSelected(new Set(restoredColumns ?? cols.map((c) => c.key)))
      })
      .catch((e) => {
        toast.error((e as Error).message)
        setColumns([])
        setSelected(new Set())
      })
      .finally(() => setLoadingCols(false))
  }, [t])

  useEffect(() => {
    if (!job) { restoredJobId.current = null; return }
    if (restoredJobId.current === job.id) return
    restoredJobId.current = job.id
    setResource(job.resource); setFormat(job.format)
    loadColumns(job.resource, job.options.columns)
  }, [job, loadColumns])

  const selectedResource = resources.find((item) => item.key === resource)
  const columnLabel = (field: Column) => dataFieldLabel(field, selectedResource, tCatalog)

  const onResourceChange = (key: string) => {
    setResource(key)
    remember(null)
    loadColumns(key)
  }

  const toggle = (key: string) => {
    remember(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const runExport = async () => {
    if (!resource) return
    setBusy(true)
    setError(null)
    remember(null)
    try {
      const chosen = columns.filter((c) => selected.has(c.key)).map((c) => c.key)
      const inputs = JSON.stringify({ resource, format, columns: chosen })
      if (creationRequest.current?.inputs !== inputs) creationRequest.current = { key: crypto.randomUUID(), inputs }
      remember(await requestTransfer('/api/data/transfers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestKey: creationRequest.current.key, kind: 'export', resource, format,
          filename: `${resource.replace(/[^a-zA-Z0-9_-]/g, '_')}.${format}`, bytes: 0, options: { columns: chosen } }),
      }))
      creationRequest.current = null
    } catch (e) {
      setError((e as Error).message)
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Named disabled reasons: the Export button never sits disabled in
  // silence. The no-resource reason reuses the existing empty-state copy.
  const disabledReason = !resource
    ? t('export.empty')
    : selected.size === 0
      ? t('export.needColumns')
      : null

  return (
    <div className="space-y-6">
      <PageHeader title={t('export.title')} description={t('export.description')} />
      <DataTransferPicker kind="export" job={job} onChange={remember} disabled={working} />
      {(error || (!job && connectionError)) && <Alert variant="destructive">{error || connectionError}</Alert>}
      {job && <DataTransferStatus job={job} onChange={remember} connectionError={connectionError} />}

      <Card>
        <CardContent className="grid gap-5 p-4 sm:grid-cols-2 sm:p-5">
          <div className="space-y-2">
            <Label htmlFor="export-resource">{t('export.resource')}</Label>
            <Select
              id="export-resource"
              value={resource}
              disabled={busy}
              onChange={(e) => onResourceChange(e.target.value)}
            >
              <option value="">{t('export.resourcePlaceholder')}</option>
              {grouped.map(([group, list]) => (
                <optgroup key={group} label={group}>
                  {list.map((r) => <option key={r.key} value={r.key}>{dataResourceLabel(r, tCatalog)}</option>)}
                </optgroup>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="export-format">{t('export.format')}</Label>
            <Select id="export-format" value={format} disabled={busy} onChange={(e) => {
              remember(null)
              setFormat(e.target.value as Format)
            }}>
              {FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </Select>
          </div>
        </CardContent>
      </Card>

      {resource && (
        <Card>
          <CardHeader className="flex flex-wrap flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-sm">{t('export.columns')}</CardTitle>
            {columns.length > 0 && (
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {
                  remember(null)
                  setSelected(new Set(columns.map((c) => c.key)))
                }}>{t('export.selectAll')}</Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {
                  remember(null)
                  setSelected(new Set())
                }}>{t('export.clearAll')}</Button>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {loadingCols ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : columns.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('export.noColumns')}</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {columns.map((c) => (
                  <Label key={c.key} htmlFor={`export-column-${c.key}`} className="flex min-w-0 items-center gap-2 font-normal">
                    <input
                      id={`export-column-${c.key}`}
                      type="checkbox"
                      className="h-4 w-4 shrink-0 rounded border-border"
                      checked={selected.has(c.key)}
                      disabled={busy}
                      onChange={() => toggle(c.key)}
                    />
                    <span className="truncate" title={columnLabel(c)}>{columnLabel(c)}</span>
                  </Label>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="ff-footer space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <Button
          onClick={runExport}
          disabled={!resource || busy || selected.size === 0}
          aria-describedby={disabledReason ? 'data-export-hint' : undefined}
        >
          <Download className="mr-2 h-4 w-4" />
          {busy ? t('export.running') : t('export.run')}
        </Button>
        {disabledReason ? (
          <p id="data-export-hint" className="text-sm text-muted-foreground">
            {disabledReason}
          </p>
        ) : null}
      </div>
    </div>
  )
}

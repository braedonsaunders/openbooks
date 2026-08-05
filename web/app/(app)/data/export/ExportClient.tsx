'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { Button, PageHeader, Select, cn } from '@openbooks/ui'

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
  const [resources, setResources] = useState<ResourceDescriptor[]>([])
  const [resource, setResource] = useState('')
  const [columns, setColumns] = useState<Column[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<Format>('csv')
  const [loadingCols, setLoadingCols] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/data/resources')
      .then((r) => r.json())
      .then((d) => setResources(d.resources ?? []))
      .catch(() => setResources([]))
  }, [])

  const grouped = useMemo(() => {
    const map = new Map<string, ResourceDescriptor[]>()
    for (const r of resources) {
      const list = map.get(r.group) ?? []
      list.push(r)
      map.set(r.group, list)
    }
    return [...map.entries()]
  }, [resources])

  const loadColumns = useCallback((key: string) => {
    if (!key) {
      setColumns([])
      setSelected(new Set())
      return
    }
    setLoadingCols(true)
    fetch(`/api/data/resources?key=${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .then((d) => {
        const cols: Column[] = d.columns ?? []
        setColumns(cols)
        setSelected(new Set(cols.map((c) => c.key)))
      })
      .catch(() => {
        setColumns([])
        setSelected(new Set())
      })
      .finally(() => setLoadingCols(false))
  }, [])

  const onResourceChange = (key: string) => {
    setResource(key)
    loadColumns(key)
  }

  const toggle = (key: string) => {
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
    try {
      const res = await fetch('/api/data/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource,
          format,
          columns: columns.filter((c) => selected.has(c.key)).map((c) => c.key),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'export failed')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const disp = res.headers.get('Content-Disposition') ?? ''
      const match = /filename="?([^"]+)"?/.exec(disp)
      a.download = match?.[1] ?? `${resource}.${format}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('export.title')} description={t('export.description')} />

      <div className="max-w-2xl space-y-6">
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground">{t('export.resource')}</label>
          <Select
            value={resource}
            onChange={(e) => onResourceChange(e.target.value)}
            placeholder={t('export.resourcePlaceholder')}
          >
            <option value="">{t('export.resourcePlaceholder')}</option>
            {grouped.map(([group, list]) => (
              <optgroup key={group} label={group}>
                {list.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>

        {resource && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-muted-foreground">{t('export.columns')}</label>
              {columns.length > 0 && (
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setSelected(new Set(columns.map((c) => c.key)))}
                  >
                    {t('export.selectAll')}
                  </button>
                  <span className="text-muted-foreground">·</span>
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setSelected(new Set())}
                  >
                    {t('export.clearAll')}
                  </button>
                </div>
              )}
            </div>
            {loadingCols ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : columns.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('export.noColumns')}</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-3 sm:grid-cols-3">
                {columns.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border"
                      checked={selected.has(c.key)}
                      onChange={() => toggle(c.key)}
                    />
                    <span className="truncate" title={c.label}>
                      {c.label}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {resource && (
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">{t('export.format')}</label>
            <div className="flex gap-2">
              {FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  className={cn(
                    'rounded-md border px-4 py-2 text-sm font-medium uppercase',
                    format === f
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        )}

        <Button onClick={runExport} disabled={!resource || busy || selected.size === 0}>
          <Download className="mr-2 h-4 w-4" />
          {busy ? t('export.running') : t('export.run')}
        </Button>
      </div>
    </div>
  )
}

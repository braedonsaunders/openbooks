'use client'

import { useCallback, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '@/components/line-grid'
import { apiJson } from '@/lib/api-error'
import { formatDecimal } from '@/lib/money-format'
import { confirmDialog } from '@/lib/confirm'
import { promptDialog } from '@/lib/prompt'
import { toast } from 'sonner'

export interface GridVariant {
  id: string
  code: string | null
  name: string
  optionValues: Record<string, string>
  price: string | null
  barcode: { value: string; kind: string } | null
  onHand: string
  isActive: boolean
}

type GridRow = Record<string, unknown>

function optionKey(name: string): string {
  return `option:${name}`
}

/**
 * The everyday surface of a family: every variant with its option values,
 * inline price/barcode editing, checkbox bulk actions, and generation with
 * a preview of the exact codes before anything is created.
 */
export function FamilyVariantsGrid({
  familyId,
  optionNames,
  variants,
  canManage,
  onChanged,
}: {
  familyId: string
  optionNames: string[]
  variants: GridVariant[]
  canManage: boolean
  onChanged: () => void
}) {
  const t = useTranslations('items.families')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)

  const rows: GridRow[] = useMemo(
    () =>
      variants.map((variant) => {
        const row: GridRow = {
          id: variant.id,
          code: variant.code ?? '',
          name: variant.name,
          price: variant.price ?? '',
          barcode: variant.barcode?.value ?? '',
          onhand: variant.onHand,
          status: variant.isActive ? 'active' : 'inactive',
        }
        for (const name of optionNames) row[optionKey(name)] = variant.optionValues[name] ?? ''
        return row
      }),
    [variants, optionNames],
  )

  const saveCell = useCallback(
    async (id: string, patch: { price?: string | null; barcode?: { value: string; kind: string } | null }): Promise<boolean> => {
      setBusy(true)
      try {
        await apiJson(`/api/item-families/${familyId}/bulk-edit`, {
          method: 'POST',
          body: JSON.stringify({ variantIds: [id], ...patch }),
        })
        onChanged()
        return true
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setBusy(false)
      }
    },
    [familyId, onChanged],
  )

  async function bulk(patch: { price?: string | null; cost?: string | null; isActive?: boolean; barcode?: { value: string; kind: string } | null }): Promise<void> {
    if (selected.size === 0) return
    setBusy(true)
    try {
      await apiJson(`/api/item-families/${familyId}/bulk-edit`, {
        method: 'POST',
        body: JSON.stringify({ variantIds: [...selected], ...patch }),
      })
      setSelected(new Set())
      onChanged()
      toast.success(t('grid.bulkSaved', { count: selected.size }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function generate(): Promise<void> {
    setGenerating(true)
    try {
      const preview = await apiJson<{ missing: { code: string; name: string }[]; existing: number }>(
        `/api/item-families/${familyId}/generate`,
      )
      if (preview.missing.length === 0) {
        toast.success(t('generate.nothingMissing'))
        return
      }
      const sample = preview.missing.slice(0, 5).map((combination) => combination.code).join(', ')
      const confirmed = await confirmDialog({
        title: t('generate.confirmTitle', { count: preview.missing.length }),
        message: t('generate.confirmBody', { sample }),
        confirmLabel: t('generate.confirm'),
      })
      if (!confirmed) return
      await apiJson(`/api/item-families/${familyId}/generate`, { method: 'POST', body: JSON.stringify({}) })
      onChanged()
      toast.success(t('generate.done', { count: preview.missing.length }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setGenerating(false)
    }
  }

  const columns: LineGridColumn<GridRow>[] = useMemo(
    () => [
      ...optionNames.map((name) => ({
        key: optionKey(name),
        label: name,
        width: 'minmax(90px,1fr)',
        type: 'readonly' as const,
      })),
      { key: 'code', label: t('grid.code'), width: 'minmax(120px,1.2fr)', type: 'readonly' as const },
      { key: 'name', label: tCommon('labels.name'), width: 'minmax(160px,1.6fr)', type: 'readonly' as const },
      {
        key: 'price',
        label: t('grid.price'),
        width: '110px',
        type: 'readonly' as const,
        align: 'right' as const,
        render: (row: GridRow) =>
          canManage ? (
            <CellEditor
              display={row.price ? formatDecimal(locale, String(row.price)) : ''}
              disabled={busy}
              ariaLabel={t('grid.priceFor', { name: String(row.name) })}
              onCommit={(value) => saveCell(String(row.id), { price: value === '' ? null : value })}
            />
          ) : (
            <span>{row.price ? formatDecimal(locale, String(row.price)) : ''}</span>
          ),
      },
      {
        key: 'barcode',
        label: t('grid.barcode'),
        width: '140px',
        type: 'readonly' as const,
        render: (row: GridRow) =>
          canManage ? (
            <CellEditor
              display={typeof row.barcode === 'string' ? row.barcode : ''}
              disabled={busy}
              ariaLabel={t('grid.barcodeFor', { name: String(row.name) })}
              onCommit={(value) =>
                saveCell(String(row.id), value === '' ? { barcode: null } : { barcode: { value, kind: 'gtin' } })
              }
            />
          ) : (
            <span>{typeof row.barcode === 'string' ? row.barcode : ''}</span>
          ),
      },
      { key: 'onhand', label: t('grid.onHand'), width: '90px', type: 'readonly' as const, align: 'right' as const },
      {
        key: 'status',
        label: tCommon('labels.status'),
        width: '100px',
        type: 'readonly' as const,
        render: (row: GridRow) => (
          <Badge variant={row.status === 'active' ? 'success' : 'outline'}>
            {row.status === 'active' ? tCommon('status.active') : tCommon('status.inactive')}
          </Badge>
        ),
      },
    ],
    [optionNames, canManage, busy, locale, saveCell, t, tCommon],
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {canManage ? (
          <button
            type="button"
            disabled={generating}
            onClick={() => void generate()}
            className="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {generating ? t('generate.working') : t('generate.action')}
          </button>
        ) : null}
        {canManage && selected.size > 0 ? (
          <>
            <BulkButton disabled={busy} onClick={() => void bulkPrice()} label={t('grid.setPrice')} />
            <BulkButton disabled={busy} onClick={() => void bulkCost()} label={t('grid.setCost')} />
            <BulkButton disabled={busy} onClick={() => void bulkStatus(true)} label={t('grid.activate')} />
            <BulkButton disabled={busy} onClick={() => void bulkStatus(false)} label={t('grid.deactivate')} />
            {selected.size === 1 ? <BulkButton disabled={busy} onClick={() => void bulkBarcode()} label={t('grid.setBarcode')} /> : null}
            <span className="text-xs text-slate-500">{t('grid.selected', { count: selected.size })}</span>
          </>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
          {t('grid.empty')}
        </p>
      ) : (
        <LineGrid<GridRow>
          columns={columns}
          rows={rows}
          onRowsChange={() => {}}
          emptyRow={() => ({})}
          readOnly
          minRows={0}
          getRowKey={(row) => String(row.id)}
          selection={canManage ? { selected, onChange: setSelected } : undefined}
        />
      )}
    </div>
  )

  async function bulkPrice(): Promise<void> {
    const value = await promptDialog({ title: t('grid.setPrice'), label: t('grid.price'), initialValue: '' })
    if (value === null) return
    await bulk({ price: value === '' ? null : value })
  }

  async function bulkCost(): Promise<void> {
    const value = await promptDialog({ title: t('grid.setCost'), label: t('grid.cost'), initialValue: '' })
    if (value === null) return
    await bulk({ cost: value === '' ? null : value })
  }

  async function bulkStatus(isActive: boolean): Promise<void> {
    const confirmed = await confirmDialog({
      title: isActive ? t('grid.activateTitle', { count: selected.size }) : t('grid.deactivateTitle', { count: selected.size }),
      message: isActive ? t('grid.activateBody') : t('grid.deactivateBody'),
      confirmLabel: isActive ? t('grid.activate') : t('grid.deactivate'),
      tone: isActive ? undefined : 'danger',
    })
    if (!confirmed) return
    await bulk({ isActive })
  }

  async function bulkBarcode(): Promise<void> {
    const value = await promptDialog({ title: t('grid.setBarcode'), label: t('grid.barcode'), initialValue: '' })
    if (value === null || value === '') return
    await bulk({ barcode: { value, kind: 'gtin' } })
  }
}

function BulkButton({ disabled, onClick, label }: { disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      {label}
    </button>
  )
}

function CellEditor({
  display,
  disabled,
  ariaLabel,
  onCommit,
}: {
  display: string
  disabled: boolean
  ariaLabel: string
  onCommit: (value: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? display
  return (
    <input
      type="text"
      value={shown}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === null || draft === display) {
          setDraft(null)
          return
        }
        const committed = draft
        setDraft(null)
        void onCommit(committed).then((saved) => {
          if (!saved) setDraft(committed)
        })
      }}
      className="w-full rounded-sm border-0 bg-transparent px-1.5 py-1 text-sm outline-none focus:ring-2 focus:ring-teal-500/60"
    />
  )
}

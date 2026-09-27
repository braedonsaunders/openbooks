'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { customFieldDefKey, isCustomFieldKey, type HeaderFieldPlacement } from '@openbooks/customization'
import type { PickCandidateLine } from '@openbooks/engine/src/sales/fulfillment.ts'
import { Button, FieldLabel, Input, Label, Select } from '@openbooks/ui'
import { useAppAction } from '@/lib/use-app-action'
import { readApiErrorMessage } from '@/lib/api-error'
import { fromQuantityUnits, toQuantityUnits } from '@/lib/order-cycle-math'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import { CustomFieldInput } from '../../../components/custom-field-input'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { confirmDialog } from '../../../lib/confirm'
import { fulfillmentRequest } from '../_fulfillment/fulfillment-client'
import { fulfillmentHref } from '../_fulfillment/FulfillmentSections'
import type { NewPickListData } from '../_fulfillment/types'

interface PickRow extends Record<string, unknown> {
  /** Client-only grid identity; never sent. */
  clientKey: string
  salesOrderLineId: string
  lineNumber: number
  itemLabel: string
  warehouseId: string | null
  warehouseCode: string | null
  open: string
  held: string
  pickable: string
  bins: PickCandidateLine['bins']
  binId: string
  quantity: string
}

const shown = (quantity: string) => fromQuantityUnits(toQuantityUnits(quantity))
const positive = (quantity: string) => toQuantityUnits(quantity) > 0n

function toRow(line: PickCandidateLine): PickRow {
  const pickable = positive(line.pickable) && line.bins.length > 0
  return {
    clientKey: crypto.randomUUID(),
    salesOrderLineId: line.salesOrderLineId,
    lineNumber: line.lineNumber,
    itemLabel: line.itemLabel,
    warehouseId: line.warehouseId,
    warehouseCode: line.warehouseCode,
    open: line.open,
    held: line.heldByPickLists,
    pickable: line.pickable,
    bins: line.bins,
    binId: line.bins[0]?.binId ?? '',
    quantity: pickable ? shown(line.pickable) : '',
  }
}

const blankRow = (): PickRow => ({
  clientKey: crypto.randomUUID(),
  salesOrderLineId: '',
  lineNumber: 0,
  itemLabel: '',
  warehouseId: null,
  warehouseCode: null,
  open: '0',
  held: '0',
  pickable: '0',
  bins: [],
  binId: '',
  quantity: '',
})

/**
 * Create a pick list for an issued sales order. The lines start from what
 * the order still has to pick — each open stock line's pickable quantity
 * from its best-stocked bin — and the operator adjusts quantities, chooses
 * other bins, or duplicates a line to pick it from two bins. One pick list
 * serves one warehouse, so lines from another warehouse wait for their own
 * pick list. Lines with nothing to pick stay visible and locked. Save
 * creates a draft pick list; the server re-checks every quantity and bin and
 * refuses by name.
 */
export function NewPickListDrawer({ data }: { data: NewPickListData }) {
  const t = useTranslations('fulfillment')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const { busy, refusal, execute, refuse } = useAppAction()
  const [rows, setRows] = useState<PickRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [warehouseId, setWarehouseId] = useState<string>('')
  const [documentDate, setDocumentDate] = useState(data.today)
  const [memo, setMemo] = useState('')
  const [custom, setCustom] = useState<Record<string, unknown>>({})
  const defByKey = useMemo(() => new Map(data.headerDefs.map((def) => [def.key, def])), [data.headerDefs])
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/picks/candidates?salesOrderId=${encodeURIComponent(data.salesOrder.id)}`, { cache: 'no-store' })
      if (!res.ok) {
        setLoadError(await readApiErrorMessage(res, t('create.loadFailed')))
        return
      }
      const body = (await res.json()) as { lines: PickCandidateLine[] }
      const loaded = body.lines.map(toRow)
      const first = loaded.find((row) => positive(row.pickable) && row.bins.length > 0 && row.warehouseId)
      setLoadError(null)
      setRows(loaded)
      setWarehouseId(first?.warehouseId ?? loaded.find((row) => row.warehouseId)?.warehouseId ?? '')
    } catch {
      setLoadError(t('create.loadFailed'))
    }
  }, [data.salesOrder.id, t])

  useEffect(() => {
    void load()
  }, [load])

  const warehouses = useMemo(() => {
    const byId = new Map<string, string>()
    for (const row of rows ?? []) if (row.warehouseId) byId.set(row.warehouseId, row.warehouseCode ?? row.warehouseId)
    return [...byId].map(([id, code]) => ({ id, code }))
  }, [rows])

  const pickable = useCallback(
    (row: PickRow) =>
      row.salesOrderLineId !== '' && row.warehouseId === warehouseId && positive(row.pickable) && row.bins.length > 0,
    [warehouseId],
  )

  const whyLocked = useCallback((row: PickRow): string | null => {
    if (row.salesOrderLineId === '') return null
    if (!positive(row.pickable)) return t('create.nothingPickable')
    if (row.bins.length === 0) return t('create.noStock')
    if (row.warehouseId !== warehouseId) return t('create.otherWarehouse', { warehouse: row.warehouseCode ?? '—' })
    return null
  }, [t, warehouseId])

  const columns = useMemo<LineGridColumn<PickRow>[]>(() => [
    {
      key: 'lineNumber', label: t('fields.salesOrderLine'), width: '80px', type: 'readonly',
      render: (row) => (row.salesOrderLineId ? t('lines.orderLine', { line: row.lineNumber }) : ''),
    },
    { key: 'itemLabel', label: tCommon('labels.item'), width: 'minmax(170px,1.6fr)', type: 'readonly' },
    { key: 'warehouseCode', label: tCommon('labels.warehouse'), width: '100px', type: 'readonly', render: (row) => row.warehouseCode ?? '' },
    { key: 'open', label: t('fields.open'), width: '90px', type: 'readonly', align: 'right', render: (row) => (row.salesOrderLineId ? shown(row.open) : '') },
    { key: 'held', label: t('fields.held'), width: '90px', type: 'readonly', align: 'right', render: (row) => (row.salesOrderLineId ? shown(row.held) : '') },
    {
      key: 'pickable', label: t('fields.pickable'), width: 'minmax(110px,1fr)', type: 'readonly', align: 'right',
      render: (row) => {
        const locked = whyLocked(row)
        if (!row.salesOrderLineId) return ''
        return locked
          ? <span className="text-xs text-slate-500 dark:text-slate-400">{locked}</span>
          : shown(row.pickable)
      },
    },
    {
      key: 'binId', label: t('fields.bin'), width: '170px', type: 'select',
      optionsFor: (row) => row.bins.map((bin) => ({ value: bin.binId, label: t('create.binOption', { bin: bin.binCode, onHand: shown(bin.onHand) }) })),
      isCellEditable: (row) => pickable(row),
    },
    {
      key: 'quantity', label: tCommon('labels.quantity'), width: '120px', type: 'decimal', decimalScale: 8, align: 'right',
      isCellEditable: (row) => pickable(row),
    },
  ], [t, tCommon, whyLocked, pickable])

  async function confirmDiscard() {
    if (!dirty) return true
    return confirmDialog({
      message: tCommon('feedback.unsavedChanges'),
      confirmLabel: tCommon('confirm.discardChanges'),
      tone: 'danger',
    })
  }

  async function save() {
    const chosen = (rows ?? []).filter((row) => pickable(row) && row.quantity.trim() !== '')
    if (chosen.length === 0) {
      refuse(t('create.noLines'), t('create.failed'))
      return
    }
    const binless = chosen.find((row) => !row.binId)
    if (binless) {
      refuse(t('create.binRequired', { line: binless.lineNumber }), t('create.failed'))
      return
    }
    await execute(
      () => fulfillmentRequest<{ pickList: { id: string; documentNumber: string } }>('/api/picks', {
        method: 'POST',
        body: {
          salesOrderId: data.salesOrder.id,
          documentDate: documentDate || undefined,
          memo: memo.trim() || null,
          // Quantities travel exactly as typed; the server classifies an
          // unreadable one and names the pick line it sits on.
          lines: chosen.map((row) => ({ salesOrderLineId: row.salesOrderLineId, binId: row.binId, quantity: row.quantity.trim() })),
          ...(Object.keys(custom).length > 0 ? { custom } : {}),
        },
      }, t('create.failed')),
      {
        fallbackMessage: t('create.failed'),
        onOk: (result) => {
          setDirty(false)
          toast.success(t('create.created', { number: result.pickList.documentNumber }))
          router.push(fulfillmentHref('pick_list', result.pickList.id))
          router.refresh()
        },
      },
    )
  }

  const renderField = (placement: HeaderFieldPlacement, editable: boolean): ReactNode => {
    // Custom header fields save with the pick list; the server validates
    // them against the record type's definitions.
    if (isCustomFieldKey(placement.key)) {
      const def = defByKey.get(customFieldDefKey(placement.key))
      if (!def) return null
      return (
        <CustomFieldInput
          def={{ ...def, label: placement.labelOverride?.trim() || def.label }}
          value={custom[def.key]}
          readOnly={!editable}
          onChange={(value) => { setCustom((current) => ({ ...current, [def.key]: value })); setDirty(true) }}
        />
      )
    }
    const override = placement.labelOverride?.trim()
    const value = (label: string, content: ReactNode) => (
      <>
        <FieldLabel fieldName={label}>{label}</FieldLabel>
        <div className="text-sm text-slate-900 dark:text-slate-100">{content}</div>
      </>
    )
    switch (placement.key) {
      case 'party_id':
        return value(override || tCommon('labels.customer'), data.salesOrder.customerName ?? '—')
      case 'sales_order_id':
        return value(override || t('fields.salesOrder'), (
          <Link href={fulfillmentHref('sales_order', data.salesOrder.id)} className="font-mono text-teal-700 hover:underline dark:text-teal-300">
            {data.salesOrder.number}
          </Link>
        ))
      case 'warehouse_id': {
        const label = override || tCommon('labels.warehouse')
        if (warehouses.length <= 1 || !editable) return value(label, warehouses.find((w) => w.id === warehouseId)?.code ?? '—')
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            <Select aria-label={label} value={warehouseId} onChange={(event) => { setWarehouseId(event.target.value); setDirty(true) }}>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
            </Select>
          </>
        )
      }
      case 'document_date': {
        const label = override || tCommon('labels.date')
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            <Input type="date" aria-label={label} value={documentDate} disabled={!editable} onChange={(event) => { setDocumentDate(event.target.value); setDirty(true) }} />
          </>
        )
      }
      case 'memo': {
        const label = override || tCommon('labels.memo')
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            <Input aria-label={label} value={memo} maxLength={2000} disabled={!editable} onChange={(event) => { setMemo(event.target.value); setDirty(true) }} />
          </>
        )
      }
      default:
        return null
    }
  }

  return (
    <TransactionDrawer
      closeHref={data.closeHref}
      beforeClose={confirmDiscard}
      recordId="new"
      showEvidenceTabs={false}
      panelClassName={docTypeMeta('pick_list').surfaceCls}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind="pick_list" />
          <span>{t('create.title', { order: data.salesOrder.number })}</span>
        </span>
      }
      description={data.salesOrder.customerName ?? undefined}
      actions={
        <Button disabled={busy || rows === null} onClick={save}>
          {busy ? tCommon('actions.saving') : tCommon('actions.save')}
        </Button>
      }
    >
      <div className="space-y-6 p-1">
        <ActionAlert error={refusal} fallbackMessage={t('create.failed')} />
        <HeaderFields layout={data.layout} editable={!busy} renderField={renderField} />
        <div className="space-y-2">
          <Label>{tCommon('labels.lines')}</Label>
          {loadError ? (
            <p role="alert" className="py-4 text-sm text-red-700 dark:text-red-300">{loadError}</p>
          ) : rows === null ? (
            <p role="status" className="py-4 text-sm text-slate-600 dark:text-slate-300">{t('create.loading')}</p>
          ) : rows.length === 0 ? (
            <p className="py-4 text-sm text-slate-600 dark:text-slate-300">{t('create.empty')}</p>
          ) : (
            <>
              <LineGrid<PickRow>
                columns={columns}
                rows={rows}
                onRowsChange={(next) => { setRows(next); setDirty(true) }}
                emptyRow={blankRow}
                getRowKey={(row) => row.clientKey}
                cloneRow={(row) => ({ ...row, clientKey: crypto.randomUUID() })}
                readOnly={busy}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('create.hint')}</p>
            </>
          )}
        </div>
      </div>
    </TransactionDrawer>
  )
}

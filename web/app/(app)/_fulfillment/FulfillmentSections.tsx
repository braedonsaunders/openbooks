'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { MoreHorizontal } from 'lucide-react'
import { customFieldDefKey, isCustomFieldKey, type FormLayoutConfig, type HeaderFieldPlacement } from '@openbooks/customization'
import type { FulfillmentDocumentView, FulfillmentLineView } from '@openbooks/engine/src/sales/fulfillment.ts'
import { Badge, Button, ContextMenu, FieldLabel, useContextMenu, type ContextMenuEntry } from '@openbooks/ui'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { CustomFieldInput } from '../../../components/custom-field-input'
import type { CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { FULFILLMENT_STATUS_VARIANT } from './fulfillment-client'

const LINK = 'text-teal-700 hover:underline dark:text-teal-300'
const VALUE = 'text-sm text-slate-900 dark:text-slate-100'

/** Where each related document opens: pick lists and shipments in their own
 *  drawers, the sales order in its drawer, and the sales fulfilment — stock
 *  movement evidence — on the inventory ledger, as the order drawer does. */
export function fulfillmentHref(kind: 'sales_order' | 'pick_list' | 'shipment' | 'sales_fulfillment', id: string): string {
  switch (kind) {
    case 'sales_order':
      return `/sales-orders?order=${encodeURIComponent(id)}`
    case 'pick_list':
      return `/picks?pick=${encodeURIComponent(id)}`
    case 'shipment':
      return `/shipments?shipment=${encodeURIComponent(id)}`
    case 'sales_fulfillment':
      return '/inventory'
  }
}

/**
 * The drawer-title state of a pick list or shipment: a void wins, then a
 * completed stage, then the document status. A released pick list is
 * `approved` in documents; a completed shipment is `approved` with stage done.
 */
export function FulfillmentStateBadge({ document }: { document: Pick<FulfillmentDocumentView, 'kind' | 'status' | 'stage'> }) {
  const t = useTranslations('fulfillment.state')
  const shipment = document.kind === 'shipment'
  const key =
    document.status === 'voided'
      ? 'voided'
      : document.stage === 'done'
        ? shipment ? 'completed' : 'shipped'
        : document.status === 'pending_approval'
          ? 'pendingApproval'
          : document.status === 'approved'
            ? 'released'
            : 'draft'
  const variant = document.stage === 'done' && document.status !== 'voided' ? 'success' : (FULFILLMENT_STATUS_VARIANT[document.status] ?? 'secondary')
  return <Badge variant={variant}>{t(key)}</Badge>
}

function formatShipTo(address: FulfillmentDocumentView['shipToAddress']): string[] {
  if (!address) return []
  return [
    address.label,
    address.line1,
    address.line2,
    [address.city, address.region, address.postalCode].filter(Boolean).join(', '),
    address.country,
  ].filter((part): part is string => Boolean(part && part.trim()))
}

/**
 * The header of a pick list or shipment, laid out by the record type's
 * customization form: moved, hidden and renamed fields and custom fields all
 * follow the layout. Every built-in field is read-only except a draft
 * shipment's carrier, service and tracking number, which the shipment drawer
 * supplies through `editableField` while it is editing. Custom fields are
 * editable while the form is editable and `onCustomChange` is supplied; the
 * server validates them like every document's custom fields.
 */
export function FulfillmentHeader({
  document,
  layout,
  headerDefs,
  custom,
  editable = false,
  editableField,
  onCustomChange,
}: {
  document: FulfillmentDocumentView
  layout: FormLayoutConfig
  headerDefs: CustomFieldDefClient[]
  custom: Record<string, unknown>
  editable?: boolean
  editableField?: (key: string, label: string) => ReactNode | null
  onCustomChange?: (key: string, value: unknown) => void
}) {
  const t = useTranslations('fulfillment.fields')
  const tCommon = useTranslations('common')
  const defByKey = useMemo(() => new Map(headerDefs.map((def) => [def.key, def])), [headerDefs])

  const renderField = (placement: HeaderFieldPlacement, isEditable: boolean): ReactNode => {
    if (isCustomFieldKey(placement.key)) {
      const def = defByKey.get(customFieldDefKey(placement.key))
      if (!def) return null
      const writable = isEditable && onCustomChange !== undefined
      return (
        <CustomFieldInput
          def={{ ...def, label: placement.labelOverride?.trim() || def.label }}
          value={custom[def.key]}
          onChange={(value) => onCustomChange?.(def.key, value)}
          readOnly={!writable}
        />
      )
    }
    const override = placement.labelOverride?.trim()
    const labelled = (fallback: string, value: ReactNode) => {
      const label = override || fallback
      return (
        <>
          <FieldLabel fieldName={label}>{label}</FieldLabel>
          <div className={VALUE}>{value}</div>
        </>
      )
    }
    const editableControl = (key: string, fallback: string) => {
      if (!isEditable || !editableField) return null
      const control = editableField(key, override || fallback)
      return control ?? null
    }
    switch (placement.key) {
      case 'party_id':
        return labelled(tCommon('labels.customer'), document.customer?.name ?? '—')
      case 'sales_order_id':
        return labelled(t('salesOrder'), document.salesOrder
          ? <Link href={fulfillmentHref('sales_order', document.salesOrder.id)} className={`font-mono ${LINK}`}>{document.salesOrder.number}</Link>
          : '—')
      case 'pick_list_id':
        return labelled(t('pickList'), document.pickList
          ? <Link href={fulfillmentHref('pick_list', document.pickList.id)} className={`font-mono ${LINK}`}>{document.pickList.number}</Link>
          : '—')
      case 'warehouse_id':
        return labelled(tCommon('labels.warehouse'), `${document.warehouse.code} · ${document.warehouse.name}`)
      case 'document_date':
        return labelled(tCommon('labels.date'), document.documentDate)
      case 'memo':
        return labelled(tCommon('labels.memo'), document.memo || '—')
      case 'carrier_id':
        return editableControl('carrier_id', t('carrier')) ?? labelled(t('carrier'), document.carrier ? `${document.carrier.name} (${document.carrier.code})` : '—')
      case 'carrier_service':
        return editableControl('carrier_service', t('service')) ?? labelled(t('service'), document.carrierService || '—')
      case 'tracking_number':
        return editableControl('tracking_number', t('trackingNumber')) ?? labelled(t('trackingNumber'), document.trackingNumber
          ? document.trackingUrl
            ? <a href={document.trackingUrl} target="_blank" rel="noopener noreferrer" className={`font-mono ${LINK}`}>{document.trackingNumber}</a>
            : <span className="font-mono">{document.trackingNumber}</span>
          : '—')
      case 'ship_to_address': {
        const lines = formatShipTo(document.shipToAddress)
        return labelled(t('shipTo'), lines.length ? <span className="whitespace-pre-line">{lines.join('\n')}</span> : '—')
      }
      default:
        return null
    }
  }

  return <HeaderFields layout={layout} editable={editable} renderField={renderField} />
}

type LineRow = FulfillmentLineView & Record<string, unknown>

/**
 * The lines of a pick list or shipment in the shared line grid, read-only,
 * with the columns the customization form places. A draft shipment passes
 * `cartonActions` to set or clear each line's carton from a row menu.
 */
export function FulfillmentLines({
  lines,
  layout,
  cartonActions,
}: {
  lines: FulfillmentLineView[]
  layout: FormLayoutConfig
  cartonActions?: { onSet: (line: FulfillmentLineView) => void; onClear: (line: FulfillmentLineView) => void; disabled: boolean }
}) {
  const t = useTranslations('fulfillment')
  const tCommon = useTranslations('common')
  const menu = useContextMenu()
  const [target, setTarget] = useState<FulfillmentLineView | null>(null)
  const rows = useMemo(() => lines.map((line) => ({ ...line }) as LineRow), [lines])

  const columns = useMemo<LineGridColumn<LineRow>[]>(() => {
    const builtIn: Record<string, LineGridColumn<LineRow>> = {
      sales_order_line: {
        key: 'salesOrderLineNumber', label: t('fields.salesOrderLine'), width: '90px', type: 'readonly',
        render: (row) => t('lines.orderLine', { line: row.salesOrderLineNumber }),
      },
      item_id: { key: 'itemLabel', label: tCommon('labels.item'), width: 'minmax(170px,1.6fr)', type: 'readonly' },
      description: {
        key: 'description', label: tCommon('labels.description'), width: 'minmax(150px,1.4fr)', type: 'readonly',
        render: (row) => row.description ?? '',
      },
      bin_id: { key: 'binCode', label: t('fields.bin'), width: '110px', type: 'readonly', render: (row) => <span className="font-mono">{row.binCode}</span> },
      lot_serial: {
        key: 'lotSerial', label: t('fields.lotSerial'), width: '130px', type: 'readonly',
        render: (row) => row.serialNumber
          ? t('lines.serial', { serial: row.serialNumber })
          : row.lotNumber ? t('lines.lot', { lot: row.lotNumber }) : '',
      },
      quantity: { key: 'quantity', label: tCommon('labels.quantity'), width: '110px', type: 'decimal', decimalScale: 8, align: 'right' },
      unit: { key: 'unit', label: tCommon('labels.unit'), width: '80px', type: 'readonly', render: (row) => row.unit ?? '' },
      carton: { key: 'carton', label: t('fields.carton'), width: '110px', type: 'readonly', render: (row) => row.carton ?? '' },
    }
    const placed = layout.lines.columns.flatMap((placement) => {
      if (!placement.visible) return []
      const base = builtIn[placement.key]
      if (!base) return []
      return [{ ...base, width: placement.width ?? base.width, label: placement.labelOverride?.trim() || base.label }]
    })
    if (!cartonActions) return placed
    return [
      ...placed,
      {
        key: '_lineActions', label: tCommon('labels.actions'), width: '64px', type: 'readonly',
        render: (row) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 px-0"
            disabled={cartonActions.disabled}
            aria-label={t('lines.actionsFor', { line: row.lineNumber })}
            onClick={(event) => {
              setTarget(row)
              menu.openBelow(event.currentTarget)
            }}
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </Button>
        ),
      },
    ]
  }, [layout, cartonActions, t, tCommon, menu])

  const items: ContextMenuEntry[] = target && cartonActions
    ? [
        { key: 'set', label: t('cartons.set'), onSelect: () => cartonActions.onSet(target) },
        { key: 'clear', label: t('cartons.clear'), disabled: !target.carton, onSelect: () => cartonActions.onClear(target) },
      ]
    : []

  if (lines.length === 0) {
    return <p className="px-1 py-6 text-sm text-slate-600 dark:text-slate-300">{t('lines.empty')}</p>
  }
  return (
    <div className="p-1">
      <LineGrid<LineRow>
        columns={columns}
        rows={rows}
        onRowsChange={() => undefined}
        emptyRow={() => rows[0]!}
        getRowKey={(row) => row.lineId}
        readOnly
      />
      <ContextMenu open={menu.open} position={menu.position} items={items} onClose={menu.close} />
    </div>
  )
}

/**
 * The Related tab: every document this one belongs to in the order cycle,
 * each opening its own drawer.
 */
export function FulfillmentRelated({ document }: { document: FulfillmentDocumentView }) {
  const t = useTranslations('fulfillment')
  const entries = [
    document.salesOrder ? { key: 'salesOrder', label: t('fields.salesOrder'), ref: document.salesOrder, href: fulfillmentHref('sales_order', document.salesOrder.id) } : null,
    document.kind === 'shipment' && document.pickList ? { key: 'pickList', label: t('fields.pickList'), ref: document.pickList, href: fulfillmentHref('pick_list', document.pickList.id) } : null,
    document.kind === 'pick_list' && document.shipment ? { key: 'shipment', label: t('fields.shipment'), ref: document.shipment, href: fulfillmentHref('shipment', document.shipment.id) } : null,
    document.salesFulfillment ? { key: 'salesFulfillment', label: t('fields.salesFulfillment'), ref: document.salesFulfillment, href: fulfillmentHref('sales_fulfillment', document.salesFulfillment.id) } : null,
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  if (entries.length === 0) {
    return <p className="px-1 py-6 text-sm text-slate-600 dark:text-slate-300">{t('related.empty')}</p>
  }
  return (
    <div className="p-1">
      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {entries.map((entry) => (
          <div key={entry.key} className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="w-36 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">{entry.label}</span>
            <Link href={entry.href} className={`font-mono ${LINK}`}>{entry.ref.number}</Link>
          </div>
        ))}
      </div>
    </div>
  )
}

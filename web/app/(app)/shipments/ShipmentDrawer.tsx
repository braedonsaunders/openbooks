'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import type { FulfillmentLineView } from '@openbooks/engine/src/sales/fulfillment.ts'
import { Button, FieldLabel, Input, SearchSelect, Select } from '@openbooks/ui'
import { useAppAction } from '@/lib/use-app-action'
import { readApiErrorMessage } from '@/lib/api-error'
import type { DrawerMode } from '@/lib/drawer-mode'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import { PdfButton } from '../../../components/pdf-button'
import { promptDialog } from '../../../lib/prompt'
import { confirmDialog } from '../../../lib/confirm'
import { fulfillmentRequest } from '../_fulfillment/fulfillment-client'
import { PackExecutionPanel } from './PackExecutionPanel'
import { ShippingPanel } from './_fulfillment/ShippingPanel'
import {
  FulfillmentHeader,
  FulfillmentLines,
  FulfillmentRelated,
  FulfillmentStateBadge,
  fulfillmentHref,
} from '../_fulfillment/FulfillmentSections'
import type { FulfillmentDrawerData } from '../_fulfillment/types'

interface CompletedShipment {
  shipmentNumber: string
  fulfillmentNumber: string
  replayed: boolean
}

/**
 * A shipment: the picked lines leaving the warehouse. While it is a draft the
 * operator names the carrier, service and tracking number and packs lines
 * into cartons; Complete records the sales fulfilment from the picked bins
 * (it moves stock, so it also needs the posting grant) and ends the pick
 * list's reservation. A completed shipment can email the customer its
 * tracking link. Every refusal shows the server's reason and remedy.
 */
export function ShipmentDrawer({ data, initialMode = 'view' }: { data: FulfillmentDrawerData; initialMode?: DrawerMode }) {
  const t = useTranslations('fulfillment')
  const tPdf = useTranslations('pdfTemplates')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const { busy, refusal, execute, refuse, clearRefusal } = useAppAction()
  const shipment = data.document
  const draft = shipment.status === 'draft' && shipment.stage === 'open'
  const canEdit = draft && data.canManage
  const [mode, setMode] = useState<DrawerMode>(initialMode === 'edit' && canEdit ? 'edit' : 'view')
  const [carrierId, setCarrierId] = useState(shipment.carrier?.id ?? '')
  const [service, setService] = useState(shipment.carrierService ?? '')
  const [tracking, setTracking] = useState(shipment.trackingNumber ?? '')
  const [custom, setCustom] = useState<Record<string, unknown>>(data.custom)
  const base = `/api/shipments/${shipment.id}`

  // The active carriers, plus the shipment's own carrier when it has since
  // been deactivated, so the stored choice still reads by name. Saving an
  // inactive carrier is refused by the server with its remedy.
  const carriers = useMemo(() => {
    const active = data.carriers
    if (!shipment.carrier || active.some((carrier) => carrier.id === shipment.carrier!.id)) return active
    return [...active, { ...shipment.carrier, services: shipment.carrierService ? [shipment.carrierService] : [] }]
  }, [data.carriers, shipment.carrier, shipment.carrierService])
  const services = carriers.find((carrier) => carrier.id === carrierId)?.services ?? []
  const cartonCount = new Set(shipment.lines.map((line) => line.carton?.trim()).filter(Boolean)).size

  function resetCarrier() {
    setCarrierId(shipment.carrier?.id ?? '')
    setService(shipment.carrierService ?? '')
    setTracking(shipment.trackingNumber ?? '')
    setCustom(data.custom)
  }

  async function saveCarrier() {
    const carrierChanged = carrierId !== (shipment.carrier?.id ?? '')
      || service !== (shipment.carrierService ?? '')
      || tracking.trim() !== (shipment.trackingNumber ?? '')
    // Only changed custom values travel; a cleared value is sent as null.
    const customChanges: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(custom), ...Object.keys(data.custom)])) {
      if (JSON.stringify(custom[key] ?? null) !== JSON.stringify(data.custom[key] ?? null)) customChanges[key] = custom[key] ?? null
    }
    const body: Record<string, unknown> = {}
    if (carrierChanged) {
      if (!carrierId) {
        refuse(t('shipment.carrierRequired'), t('actionFailed'))
        return
      }
      if (!service) {
        refuse(t('shipment.serviceRequired'), t('actionFailed'))
        return
      }
      body.carrier = { carrierId, service, trackingNumber: tracking.trim() || null }
    }
    if (Object.keys(customChanges).length > 0) body.custom = customChanges
    if (Object.keys(body).length === 0) {
      setMode('view')
      return
    }
    await execute(
      () => fulfillmentRequest(base, { method: 'PATCH', body }, t('shipment.saveFailed')),
      {
        fallbackMessage: t('shipment.saveFailed'),
        successMessage: t('shipment.saved', { number: shipment.documentNumber }),
        onOk: () => {
          setMode('view')
          router.refresh()
        },
      },
    )
  }

  async function saveCartons(cartons: { lineId: string; carton: string | null }[]) {
    await execute(
      () => fulfillmentRequest(base, { method: 'PATCH', body: { cartons } }, t('cartons.failed')),
      {
        fallbackMessage: t('cartons.failed'),
        successMessage: t('cartons.saved'),
        onOk: () => router.refresh(),
      },
    )
  }

  async function setCarton(line: FulfillmentLineView) {
    const carton = await promptDialog({
      title: t('cartons.setTitle', { line: line.lineNumber }),
      label: t('fields.carton'),
      initialValue: line.carton ?? '',
      placeholder: t('cartons.placeholder'),
      confirmLabel: tCommon('actions.save'),
    })
    if (!carton) return
    await saveCartons([{ lineId: line.lineId, carton }])
  }

  async function packAll() {
    const carton = await promptDialog({
      title: t('cartons.allTitle', { number: shipment.documentNumber }),
      label: t('fields.carton'),
      placeholder: t('cartons.placeholder'),
      confirmLabel: tCommon('actions.save'),
    })
    if (!carton) return
    await saveCartons(shipment.lines.map((line) => ({ lineId: line.lineId, carton })))
  }

  async function complete() {
    const confirmed = await confirmDialog({
      title: t('shipment.completeTitle', { number: shipment.documentNumber }),
      message: t('shipment.completeMessage'),
      confirmLabel: t('shipment.complete'),
    })
    if (!confirmed) return
    await execute(
      () => fulfillmentRequest<CompletedShipment>(`${base}/complete`, { method: 'POST' }, t('shipment.completeFailed')),
      {
        fallbackMessage: t('shipment.completeFailed'),
        onOk: (result) => {
          toast.success(t('shipment.completed', { number: result.shipmentNumber, fulfillment: result.fulfillmentNumber }))
          router.refresh()
        },
      },
    )
  }

  async function voidShipment() {
    const confirmed = await confirmDialog({
      title: t('shipment.voidTitle', { number: shipment.documentNumber }),
      message: t('shipment.voidMessage'),
      confirmLabel: tCommon('actions.void'),
      tone: 'danger',
    })
    if (!confirmed) return
    const reason = await promptDialog({
      title: t('shipment.voidTitle', { number: shipment.documentNumber }),
      label: tCommon('amendment.reason'),
      placeholder: t('voidReasonPlaceholder'),
      confirmLabel: tCommon('actions.void'),
    })
    if (!reason) return
    await execute(
      () => fulfillmentRequest(`${base}/void`, { method: 'POST', body: { reason } }, t('shipment.voidFailed')),
      {
        fallbackMessage: t('shipment.voidFailed'),
        successMessage: t('shipment.voided', { number: shipment.documentNumber }),
        onOk: () => router.refresh(),
      },
    )
  }

  async function sendTracking() {
    clearRefusal()
    // The customer's address on file, read through the record-send route so
    // the prompt starts from the same recipient the server would choose.
    let suggested = ''
    try {
      const res = await fetch(`/api/record-pdf/shipment/${shipment.id}/send`, { cache: 'no-store' })
      if (!res.ok) {
        refuse(await readApiErrorMessage(res, t('tracking.failed')), t('tracking.failed'))
        return
      }
      const info = (await res.json()) as { to?: string | null }
      suggested = typeof info.to === 'string' ? info.to : ''
    } catch {
      refuse(null, t('tracking.failed'))
      return
    }
    const to = await promptDialog({
      title: t('tracking.title', { number: shipment.documentNumber }),
      label: t('tracking.recipient'),
      initialValue: suggested,
      placeholder: t('tracking.recipientPlaceholder'),
      confirmLabel: tCommon('actions.next'),
    })
    if (!to) return
    const message = await promptDialog({
      title: t('tracking.title', { number: shipment.documentNumber }),
      label: t('tracking.message'),
      placeholder: t('tracking.messagePlaceholder'),
      confirmLabel: tCommon('actions.next'),
    })
    const confirmed = await confirmDialog({
      title: t('tracking.title', { number: shipment.documentNumber }),
      message: t('tracking.confirm', { to }),
      confirmLabel: t('tracking.send'),
    })
    if (!confirmed) return
    await execute(
      () => fulfillmentRequest<{ to: string }>(`${base}/send-tracking`, {
        method: 'POST',
        body: message ? { to, message } : { to },
      }, t('tracking.failed')),
      {
        fallbackMessage: t('tracking.failed'),
        onOk: (result) => {
          toast.success(t('tracking.sent', { to: result.to }))
        },
      },
    )
  }

  const editableField = (key: string, label: string) => {
    if (key === 'carrier_id') {
      return (
        <>
          <FieldLabel fieldName={label}>{label}<span className="text-red-500"> *</span></FieldLabel>
          <SearchSelect
            ariaLabel={label}
            options={carriers.map((carrier) => ({ value: carrier.id, label: `${carrier.name} (${carrier.code})` }))}
            value={carrierId}
            onChange={(value) => {
              const next = value ?? ''
              setCarrierId(next)
              const offered = carriers.find((carrier) => carrier.id === next)?.services ?? []
              if (!offered.includes(service)) setService(offered.length === 1 ? offered[0]! : '')
            }}
            placeholder={carriers.length === 0 ? t('shipment.noCarriers') : t('shipment.chooseCarrier')}
          />
        </>
      )
    }
    if (key === 'carrier_service') {
      return (
        <>
          <FieldLabel fieldName={label}>{label}<span className="text-red-500"> *</span></FieldLabel>
          <Select aria-label={label} value={service} onChange={(event) => setService(event.target.value)} disabled={!carrierId}>
            <option value="">{t('shipment.chooseService')}</option>
            {services.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </Select>
        </>
      )
    }
    if (key === 'tracking_number') {
      return (
        <>
          <FieldLabel fieldName={label}>{label}</FieldLabel>
          <Input aria-label={label} value={tracking} maxLength={100} onChange={(event) => setTracking(event.target.value)} />
        </>
      )
    }
    return null
  }

  const actions = mode === 'edit' ? (
    <Button disabled={busy} onClick={saveCarrier}>{busy ? tCommon('actions.saving') : tCommon('actions.save')}</Button>
  ) : (
    <>
      <PdfButton recordType="shipment" recordId={shipment.id} />
      <PdfButton
        recordType="shipment_carton_label"
        recordId={shipment.id}
        label={tPdf('recordTypes.shipment_carton_label')}
        disabled={busy || cartonCount === 0}
      />
      <PdfButton
        recordType="shipment_shipping_label"
        recordId={shipment.id}
        label={tPdf('recordTypes.shipment_shipping_label')}
        disabled={busy || !shipment.trackingNumber}
      />
      {data.canManage && draft ? (
        <>
          <Button
            disabled={busy || !data.canPost}
            title={data.canPost ? undefined : t('shipment.completeNeedsPost')}
            onClick={complete}
          >
            {t('shipment.complete')}
          </Button>
          <Button variant="outline" disabled={busy || shipment.lines.length === 0} onClick={packAll}>{t('cartons.all')}</Button>
          <Button variant="ghost" disabled={busy} onClick={voidShipment} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
            {tCommon('actions.void')}
          </Button>
        </>
      ) : null}
      {data.canManage && shipment.stage === 'done' && shipment.status !== 'voided' ? (
        <Button variant="outline" disabled={busy} onClick={sendTracking}>{t('tracking.action')}</Button>
      ) : null}
      {shipment.pickList ? (
        <Link href={fulfillmentHref('pick_list', shipment.pickList.id)}>
          {t('shipment.openPickList', { number: shipment.pickList.number })}
        </Link>
      ) : null}
    </>
  )

  return (
    <TransactionDrawer
      closeHref={data.closeHref}
      recordId={shipment.id}
      canEditAttachments={data.canManage}
      panelClassName={docTypeMeta('shipment').surfaceCls}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind="shipment" />
          <span className="font-mono">{shipment.documentNumber}</span>
          <FulfillmentStateBadge document={shipment} />
        </span>
      }
      description={mode === 'edit' ? tCommon('feedback.editingHint') : (shipment.customer?.name ?? undefined)}
      primaryAction={
        canEdit ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs"
            disabled={busy}
            onClick={() => {
              if (mode === 'edit') {
                resetCarrier()
                clearRefusal()
                setMode('view')
              } else {
                setMode('edit')
              }
            }}
          >
            {mode === 'edit' ? tCommon('actions.cancel') : tCommon('actions.edit')}
          </Button>
        ) : null
      }
      actions={actions}
      detailTabs={[
        {key:'packing',label:t('packingTab'),content:<PackExecutionPanel shipment={shipment} canManage={canEdit} canMove={canEdit&&data.shippingHubEnabled}/>},
        {
          key: 'lines',
          label: tCommon('labels.lines'),
          content: (
            <FulfillmentLines
              lines={shipment.lines}
              layout={data.layout}
              barcodeScanningEnabled={data.barcodeScanningEnabled}
              customerId={shipment.customer?.id}
              cartonActions={canEdit ? {
                onSet: setCarton,
                onClear: (line) => saveCartons([{ lineId: line.lineId, carton: null }]),
                disabled: busy,
              } : undefined}
            />
          ),
        },
        { key: 'related', label: t('related.tab'), content: <FulfillmentRelated document={shipment} /> },
        ...(data.shippingHubEnabled ? [{
          key: 'shipping',
          label: t('shipping.tab'),
          content: (
            <ShippingPanel
              shipmentId={shipment.id}
              draft={draft}
              canBuy={data.canBuyLabels && draft}
              accounts={data.shippingAccounts}
              presets={data.packagePresets}
            />
          ),
        }] : []),
      ]}
    >
      <div className="space-y-6 p-1">
        <ActionAlert error={refusal} fallbackMessage={t('actionFailed')} />
        <FulfillmentHeader
          document={shipment}
          layout={data.layout}
          headerDefs={data.headerDefs}
          custom={mode === 'edit' ? custom : data.custom}
          editable={mode === 'edit' && !busy}
          editableField={editableField}
          onCustomChange={(key, value) => setCustom((current) => ({ ...current, [key]: value }))}
        />
        {draft && !shipment.carrier ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{t('shipment.carrierHint')}</p>
        ) : null}
      </div>
    </TransactionDrawer>
  )
}

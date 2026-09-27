'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Button } from '@openbooks/ui'
import { useAppAction } from '@/lib/use-app-action'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import { ApprovalActions } from '../../../components/approval-actions'
import { ApprovalHistory } from '../../../components/approval-history'
import { promptDialog } from '../../../lib/prompt'
import { confirmDialog } from '../../../lib/confirm'
import { fulfillmentRequest } from '../_fulfillment/fulfillment-client'
import {
  FulfillmentHeader,
  FulfillmentLines,
  FulfillmentRelated,
  FulfillmentStateBadge,
  fulfillmentHref,
} from '../_fulfillment/FulfillmentSections'
import type { FulfillmentDrawerData } from '../_fulfillment/types'

/**
 * A pick list: the bins an issued sales order's stock lines are picked from.
 * A draft is released through Flows (an approval gate may hold it pending);
 * a released pick list holds its bins until a shipment created from it is
 * completed, or until it is voided with a reason. Every action is refused by
 * the server by name, and the refusal's remedy is shown with it.
 */
export function PickListDrawer({ data }: { data: FulfillmentDrawerData }) {
  const t = useTranslations('fulfillment')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const pick = data.document
  const open = pick.stage === 'open' && pick.status !== 'voided'
  const base = `/api/picks/${pick.id}`

  async function release() {
    await execute(
      () => fulfillmentRequest<{ pickList: { documentNumber: string; status: 'approved' | 'pending_approval' } }>(
        `${base}/release`,
        { method: 'POST' },
        t('pick.releaseFailed'),
      ),
      {
        fallbackMessage: t('pick.releaseFailed'),
        onOk: (result) => {
          toast.success(
            result.pickList.status === 'pending_approval'
              ? t('pick.releasePending', { number: result.pickList.documentNumber })
              : t('pick.released', { number: result.pickList.documentNumber }),
          )
          router.refresh()
        },
      },
    )
  }

  async function createShipment() {
    await execute(
      () => fulfillmentRequest<{ shipment: { id: string; documentNumber: string } }>(
        '/api/shipments',
        { method: 'POST', body: { pickListId: pick.id } },
        t('pick.shipFailed'),
      ),
      {
        fallbackMessage: t('pick.shipFailed'),
        onOk: (result) => {
          toast.success(t('pick.shipmentCreated', { number: result.shipment.documentNumber }))
          router.push(fulfillmentHref('shipment', result.shipment.id))
          router.refresh()
        },
      },
    )
  }

  async function voidPick() {
    const confirmed = await confirmDialog({
      title: t('pick.voidTitle', { number: pick.documentNumber }),
      message: t('pick.voidMessage'),
      confirmLabel: tCommon('actions.void'),
      tone: 'danger',
    })
    if (!confirmed) return
    const reason = await promptDialog({
      title: t('pick.voidTitle', { number: pick.documentNumber }),
      label: tCommon('amendment.reason'),
      placeholder: t('voidReasonPlaceholder'),
      confirmLabel: tCommon('actions.void'),
    })
    if (!reason) return
    await execute(
      () => fulfillmentRequest(`${base}/void`, { method: 'POST', body: { reason } }, t('pick.voidFailed')),
      {
        fallbackMessage: t('pick.voidFailed'),
        successMessage: t('pick.voided', { number: pick.documentNumber }),
        onOk: () => router.refresh(),
      },
    )
  }

  const actions = data.canManage ? (
    <>
      <ApprovalActions subjectKind="pick_list" subjectId={pick.id} />
      {pick.status === 'draft' ? (
        <Button disabled={busy} onClick={release}>{t('pick.release')}</Button>
      ) : null}
      {pick.status === 'approved' && open ? (
        <Button disabled={busy} onClick={createShipment}>{t('pick.createShipment')}</Button>
      ) : null}
      {pick.shipment ? (
        <Link href={fulfillmentHref('shipment', pick.shipment.id)}>
          {t('pick.openShipment', { number: pick.shipment.number })}
        </Link>
      ) : null}
      {open ? (
        <Button variant="ghost" disabled={busy} onClick={voidPick} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
          {tCommon('actions.void')}
        </Button>
      ) : null}
    </>
  ) : null

  return (
    <TransactionDrawer
      closeHref={data.closeHref}
      recordId={pick.id}
      canEditAttachments={data.canManage}
      panelClassName={docTypeMeta('pick_list').surfaceCls}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind="pick_list" />
          <span className="font-mono">{pick.documentNumber}</span>
          <FulfillmentStateBadge document={pick} />
        </span>
      }
      description={pick.customer?.name ?? undefined}
      actions={actions}
      detailTabs={[
        { key: 'lines', label: tCommon('labels.lines'), content: <FulfillmentLines lines={pick.lines} layout={data.layout} /> },
        { key: 'related', label: t('related.tab'), content: <FulfillmentRelated document={pick} /> },
        {
          key: 'approvals',
          label: tCommon('approvalFlow.historyTitle'),
          content: <ApprovalHistory subjectKind="pick_list" subjectId={pick.id} showEmptyState />,
        },
      ]}
    >
      <div className="space-y-6 p-1">
        <ActionAlert error={refusal} fallbackMessage={t('actionFailed')} />
        <FulfillmentHeader document={pick} layout={data.layout} headerDefs={data.headerDefs} custom={data.custom} />
        {pick.status === 'draft' ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{t('pick.draftHint')}</p>
        ) : null}
      </div>
    </TransactionDrawer>
  )
}

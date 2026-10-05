import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, mergeHref, pickString } from '../../../lib/list-params'
import { loadPaymentFlyout, type PaymentFlyout } from '../payments/payment-flyout'

/**
 * Money in — customer receipts applied to open AR items — split into a loader
 * and a spec. The mirror of /payments: same two sections through the same
 * slots, with `kind`/`direction` flipped and its own base path.
 *
 * Its tab strip is NOT the payments one. The two look alike but the receipts
 * variant carries no hover treatment and no transition class, and the harness
 * compares class strings exactly — so they stay two components rather than one
 * with a flag, which is how they were written.
 */

export interface ReceiptsData {
  title: string
  description: string
  newReceiptLabel: string
  newRunLabel: string
  newRunHref: string
  onReceipts: boolean
  onRuns: boolean
  /** Header New button: the receipts tab AND the creation right — the same
   *  canCreate the drawer reads through its slot. */
  showNewReceipt: boolean
  view: 'receipts' | 'runs'
  tabLabels: { receipts: string; collections: string }
  currentParams: Record<string, string | string[] | undefined>
  /** ?payment= flyout payload for the receipt drawer (list-drawer route). */
  drawer: ReceiptDrawerPayload | null
}

/** Receipt drawer payload: the shared flyout plus the list return address. */
export interface ReceiptDrawerPayload {
  flyout: PaymentFlyout
  basePath: '/receipts'
  closeHref: string
  initialMode: 'edit' | 'view'
}

export async function loadReceipts(
  sp: Record<string, string | string[] | undefined>,
): Promise<ReceiptsData> {
  const authz = await requirePermission('ar.pay')
  const t = await getTranslations('receipts')
  const view = pickString(sp.view) === 'runs' ? 'runs' : 'receipts'

  // Only a real receipt id reaches the loader: a malformed ?payment= must
  // never bind to a uuid column and render a 500.
  const rawPayment = typeof sp.payment === 'string' ? sp.payment : undefined
  const paymentId = rawPayment && isUuid(rawPayment) ? rawPayment : undefined
  const flyout = paymentId
    ? await loadPaymentFlyout({
        paymentId,
        creating: false,
        kind: 'customer_payment',
        orgId: authz.user.orgId,
        userId: authz.user.id,
        userRoles: authz.user.roles.map(({ key }) => key),
        authz,
        formId: pickString(sp.form),
      })
    : null
  const drawer: ReceiptDrawerPayload | null =
    flyout && flyout.mode === 'record'
      ? {
          flyout,
          basePath: '/receipts',
          closeHref: mergeHref('/receipts', sp, {
            payment: undefined,
            paymentNew: undefined,
            mode: undefined,
            form: undefined,
          }),
          initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view',
        }
      : null

  return {
    title: t('page.title'),
    description: t('page.description'),
    newReceiptLabel: t('page.newReceipt'),
    newRunLabel: t('page.newCollectionRun'),
    newRunHref: mergeHref('/receipts', sp, { view: 'runs', newRun: '1', run: undefined }),
    onReceipts: view === 'receipts',
    onRuns: view === 'runs',
    showNewReceipt: view === 'receipts' && can(authz, 'ar.pay'),
    view,
    tabLabels: { receipts: t('page.tabs.receipts'), collections: t('page.tabs.collections') },
    currentParams: sp,
    drawer,
  }
}

const f = ref<ReceiptsData>()

export function receiptsSpec(data: ReceiptsData): PageSpec {
  return page({
    route: '/receipts',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [
          widget(
            'new-payment',
            { kind: 'customer_payment', basePath: '/receipts', label: data.newReceiptLabel },
            f('showNewReceipt'),
          ),
          widget('new-payment-run', { href: data.newRunHref, label: data.newRunLabel }, f('onRuns')),
        ],
      }),
      widgetBlock('receipts-view-tabs', { view: data.view, labels: data.tabLabels }),
    ],
    body: [
      {
        ...widgetBlock('payments-section', {
          sp: data.currentParams,
          basePath: '/receipts',
          kind: 'customer_payment',
        }),
        when: f('onReceipts'),
      },
      {
        ...widgetBlock('payment-runs-section', {
          sp: data.currentParams,
          basePath: '/receipts',
          direction: 'inbound',
        }),
        when: f('onRuns'),
      },
    ],
  })
}

import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../lib/authz'
import { mergeHref, pickString } from '../../../lib/list-params'

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
  view: 'receipts' | 'runs'
  tabLabels: { receipts: string; collections: string }
  currentParams: Record<string, string | string[] | undefined>
}

export async function loadReceipts(
  sp: Record<string, string | string[] | undefined>,
): Promise<ReceiptsData> {
  await requirePermission('ar.pay')
  const t = await getTranslations('receipts')
  const view = pickString(sp.view) === 'runs' ? 'runs' : 'receipts'

  return {
    title: t('page.title'),
    description: t('page.description'),
    newReceiptLabel: t('page.newReceipt'),
    newRunLabel: t('page.newCollectionRun'),
    newRunHref: mergeHref('/receipts', sp, { view: 'runs', newRun: '1', run: undefined }),
    onReceipts: view === 'receipts',
    onRuns: view === 'runs',
    view,
    tabLabels: { receipts: t('page.tabs.receipts'), collections: t('page.tabs.collections') },
    currentParams: sp,
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
            f('onReceipts'),
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

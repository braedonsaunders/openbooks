import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../lib/authz'
import { mergeHref, pickString } from '../../../lib/list-params'

/**
 * Money out — vendor payments with open-item application, and EFT payment
 * runs — split into a loader and a spec.
 *
 * The header action is a conditional PAIR: a create-payment button on one tab,
 * a link-styled create-run button on the other. `when` omits a widget; it
 * cannot choose between two, so the loader raises two flags and the spec
 * places both widgets, each gated by its own.
 *
 * Both body sections need an `Authz`, an org id and a user id, so each arrives
 * through a slot that re-derives them from the session. A spec is data, and
 * data that names an org id is a cross-tenant read waiting to happen.
 */

export interface PaymentsData {
  title: string
  description: string
  newPaymentLabel: string
  newRunLabel: string
  newRunHref: string
  onPayments: boolean
  onRuns: boolean
  view: 'payments' | 'runs'
  tabLabels: { payments: string; runs: string }
  currentParams: Record<string, string | string[] | undefined>
}

export async function loadPayments(
  sp: Record<string, string | string[] | undefined>,
): Promise<PaymentsData> {
  await requirePermission('ap.pay')
  const t = await getTranslations('payments')
  const view = pickString(sp.view) === 'runs' ? 'runs' : 'payments'

  return {
    title: t('page.title'),
    description: t('page.description'),
    newPaymentLabel: t('page.newPayment'),
    newRunLabel: t('page.newRun'),
    newRunHref: mergeHref('/payments', sp, { view: 'runs', newRun: '1', run: undefined }),
    onPayments: view === 'payments',
    onRuns: view === 'runs',
    view,
    tabLabels: { payments: t('page.tabs.payments'), runs: t('page.tabs.runs') },
    currentParams: sp,
  }
}

const f = ref<PaymentsData>()

export function paymentsSpec(data: PaymentsData): PageSpec {
  return page({
    route: '/payments',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [
          widget(
            'new-payment',
            { kind: 'vendor_payment', basePath: '/payments', label: data.newPaymentLabel },
            f('onPayments'),
          ),
          widget(
            'new-payment-run',
            { href: data.newRunHref, label: data.newRunLabel },
            f('onRuns'),
          ),
        ],
      }),
      widgetBlock('payments-view-tabs', { view: data.view, labels: data.tabLabels }),
    ],
    body: [
      {
        ...widgetBlock('payments-section', {
          sp: data.currentParams,
          basePath: '/payments',
          kind: 'vendor_payment',
        }),
        when: f('onPayments'),
      },
      {
        ...widgetBlock('payment-runs-section', {
          sp: data.currentParams,
          basePath: '/payments',
          direction: 'outbound',
        }),
        when: f('onRuns'),
      },
    ],
  })
}

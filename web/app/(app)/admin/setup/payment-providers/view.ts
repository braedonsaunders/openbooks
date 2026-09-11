import 'server-only'

import { redirect } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { featureEnabled, resolvedFeatureState } from '../../../../../lib/features'

/**
 * Company Settings → Payment Providers, split into a loader and a spec.
 *
 * The degenerate whole-island case, and the loader is honest about it: the
 * native page is a permission gate, a feature gate, and one client component
 * with no props. `PaymentProvidersClient` fetches its own providers, bank
 * accounts and surcharge rules and owns every form, so there is no server data
 * to bind and the loader resolves nothing.
 *
 * Both gates run here, so a spec render redirects exactly as the native one
 * does. A gate that only guarded the native path would be a hole, not a
 * difference in rendering.
 */

export type PaymentProvidersData = Record<string, never>

export async function loadPaymentProviders(): Promise<PaymentProvidersData> {
  const authz = await requirePermission('admin.setup.manage')
  const features = await resolvedFeatureState(authz.user.orgId)
  if (!featureEnabled(features, 'onlinePayments')) redirect('/admin/setup/features')
  return {}
}

export function paymentProvidersSpec(_data: PaymentProvidersData): PageSpec {
  return page({
    route: '/admin/setup/payment-providers',
    // The setup workspace renders its own shell around every setup page, so a
    // page layout here would nest the chrome — and the island owns whatever
    // container it wants inside that.
    layout: 'bare',
    header: [],
    body: [widgetBlock('payment-providers-workspace')],
  })
}

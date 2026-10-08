import { redirect } from 'next/navigation'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { PAYMENT_SETUP_PAGES, paymentSetupHref } from '../../../../../lib/setup/rail'
import { loadPaymentOperations, paymentOperationsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function PaymentOperationsSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // Each view is its own Setup page; an address without one opens the first.
  if (!PAYMENT_SETUP_PAGES.some((page) => page.view === sp.view)) redirect(paymentSetupHref(PAYMENT_SETUP_PAGES[0].view))
  const data = await loadPaymentOperations(sp)
  return <ModuleView spec={paymentOperationsSpec(data)} data={data} searchParams={sp} trusted />
}

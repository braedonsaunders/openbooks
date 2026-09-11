import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadPaymentOperations, paymentOperationsSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function PaymentOperationsSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPaymentOperations(sp)
  return <ModuleView spec={paymentOperationsSpec(data)} data={data} searchParams={sp} trusted />
}

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { ContractCostError } from '@openbooks/engine/revenue'
import { Button } from '@openbooks/ui'
import { RouteStateView } from '@/components/route-state'
import { ModuleView } from '@/components/viewspec/module-view'
import { loadContractCosts, contractCostsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function ContractCosts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // Only loader work sits inside the try: no JSX is constructed there, so
  // render errors stay with the error boundary. A named expected refusal
  // returns its own message and remedy below; anything else is not a
  // ContractCostError, so redirects, missing records and unexpected
  // failures keep their existing handling — redirects and notFound fly
  // past, and the rest reaches the app error boundary, which never quotes
  // server internals.
  let data: Awaited<ReturnType<typeof loadContractCosts>>
  try {
    data = await loadContractCosts(sp)
  } catch (error) {
    if (!(error instanceof ContractCostError)) throw error
    const t = await getTranslations('shell.routeState')
    return (
      <RouteStateView
        state="error"
        icon={<AlertTriangle />}
        title={error.message}
        description={error.remedy}
        action={
          <Button asChild>
            <Link href="/dashboard">{t('backToDashboard')}</Link>
          </Button>
        }
      />
    )
  }
  return <ModuleView spec={contractCostsSpec(data)} data={data} searchParams={sp} trusted />
}

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { StoredValueError } from '@openbooks/engine/stored-value'
import { Button } from '@openbooks/ui'
import { RouteStateView } from '@/components/route-state'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadStoredValuePage, storedValueSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Customers → Stored value. Gift cards and store credit carried as a
 * liability: KPIs, the masked-code register, and one drawer per account.
 */
export default async function StoredValuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // Only loader work sits inside the try: no JSX is constructed there, so
  // render errors stay with the error boundary. A named expected refusal
  // returns its own message and remedy below; anything else is not a
  // StoredValueError, so redirects, missing records and unexpected failures
  // keep their existing handling.
  let data: Awaited<ReturnType<typeof loadStoredValuePage>>
  try {
    data = await loadStoredValuePage(sp)
  } catch (error) {
    if (!(error instanceof StoredValueError)) throw error
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
  return <ModuleView spec={storedValueSpec(data)} data={data} searchParams={sp} trusted />
}

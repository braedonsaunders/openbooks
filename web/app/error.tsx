'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { RouteStateView } from '@/components/route-state'

/**
 * Root route error boundary — the fail-closed surface for failures ABOVE the
 * authenticated app shell.
 *
 * Next.js never routes a segment's own layout failure to that segment's
 * error.tsx, so a throw in (app)/layout.tsx (F-t05-001: a transient pool
 * timeout behind ten concurrent shell queries) bypassed (app)/error.tsx and
 * the root had no boundary — Next served a raw "Internal Server Error" text
 * page with no shell and no recovery action. This boundary catches those
 * failures and renders the same chrome as (app)/error.tsx; keep the two in
 * sync. It renders inside the root layout, so next-intl and link providers
 * are available. Failures in the root layout itself still go to
 * global-error.tsx.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations('shell.routeState')
  const tCommon = useTranslations('common.actions')

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <RouteStateView
      state="error"
      icon={<AlertTriangle />}
      title={t('errorTitle')}
      description={t('errorDescription')}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={reset}>{tCommon('retry')}</Button>
          <Button variant="outline" asChild>
            <Link href="/dashboard">{t('backToDashboard')}</Link>
          </Button>
        </div>
      }
    />
  )
}

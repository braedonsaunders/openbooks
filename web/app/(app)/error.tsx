'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { RouteStateView } from '@/components/route-state'

export default function AppError({
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

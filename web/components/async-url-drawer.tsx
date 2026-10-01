'use client'

import type { ComponentProps, ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button, EmptyState, Skeleton, UrlDrawer } from '@openbooks/ui'

/** One dialog owns the complete request lifecycle. Only its body changes
 * when data arrives, so focus, scroll lock and the entrance animation persist. */
export function AsyncUrlDrawer({ pending, error, onRetry, children, ...drawer }: Omit<ComponentProps<typeof UrlDrawer>, 'children' | 'openKey'> & {
  /** The requested record's identity; never a loading or error phase. */
  openKey: string
  pending: boolean
  error?: string | null
  onRetry?: () => void
  children: ReactNode
}) {
  const t = useTranslations('common')
  return (
    <UrlDrawer {...drawer}>
      {error ? (
        <EmptyState title={t('feedback.loadFailed')} description={error}
          action={onRetry ? <Button variant="outline" onClick={onRetry}>{t('actions.retry')}</Button> : undefined} />
      ) : pending ? (
        <div aria-busy="true" className="space-y-3">
          {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}
        </div>
      ) : children}
    </UrlDrawer>
  )
}

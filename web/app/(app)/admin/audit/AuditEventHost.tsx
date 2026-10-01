'use client'

import { useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { DrawerNavigateContext } from '@openbooks/ui'
import { isUuid } from '@openbooks/engine/src/platform/uuid.ts'
import { AuditEventDrawer, type AuditEvent } from './AuditEventDrawer'

/** Like the related-party drawer host, the event owns its detail request.
 * Native history keeps the list mounted when only the selected event changes. */
export function AuditEventHost({ event: initialEvent }: { event: AuditEvent | null }) {
  const params = useSearchParams()
  const pathname = usePathname()
  const eventId = params.get('event')
  const t = useTranslations('common.auditTrail')
  const [loaded, setLoaded] = useState(initialEvent)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const closeParams = new URLSearchParams(params.toString())
  closeParams.delete('event')
  const query = closeParams.toString()
  const closeHref = query ? `${pathname}?${query}` : pathname
  const event = loaded?.id === eventId ? loaded : initialEvent?.id === eventId ? initialEvent : null

  useEffect(() => {
    if (!eventId || !isUuid(eventId) || initialEvent?.id === eventId) return
    const controller = new AbortController()
    fetch(`/api/audit/events/${encodeURIComponent(eventId)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null
          throw new Error(body?.error || t('loadFailedDescription'))
        }
        return await response.json() as AuditEvent
      })
      .then((data) => {
        if (controller.signal.aborted) return
        setLoaded(data)
        setFailure(null)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setFailure({ id: eventId, message: error instanceof Error ? error.message : t('loadFailedDescription') })
      })
    return () => controller.abort()
  }, [eventId, initialEvent?.id, retry, t])

  if (!eventId) return null
  const error = failure?.id === eventId ? failure.message : null
  return (
    <DrawerNavigateContext.Provider value={(href) => window.history.pushState(null, '', href)}>
      <AuditEventDrawer key={eventId} event={event} closeHref={closeHref} eventId={eventId}
        error={error || (!isUuid(eventId) ? t('loadFailedDescription') : null)}
        onRetry={() => { setFailure(null); setRetry((n) => n + 1) }} />
    </DrawerNavigateContext.Provider>
  )
}

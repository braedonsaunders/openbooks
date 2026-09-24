'use client'

import { useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import { useViewerFormat } from '@/lib/viewer-format'
import { buildGreeting } from './_greeting'

function subscribe(): () => void {
  return () => {}
}

/**
 * Viewer-local dashboard greeting. The server bakes its best paint (org
 * zone, passed as serverGreeting); the store re-reads the stem in the
 * browser zone after hydration and corrects it when the viewer is away from
 * the org zone. The server snapshot matches the SSR HTML, so there is no
 * hydration mismatch — and no visible change when both zones agree.
 */
export function GreetingText({
  name,
  serverGreeting,
}: {
  name: string | null
  serverGreeting: string
}) {
  const t = useTranslations('dashboard')
  const { locale, timeZone } = useViewerFormat()
  const text = useSyncExternalStore(
    subscribe,
    () =>
      buildGreeting(new Date(), name, {
        morning: t('greeting.morning'),
        afternoon: t('greeting.afternoon'),
        evening: t('greeting.evening'),
      }, timeZone, locale),
    () => serverGreeting,
  )
  return <>{text}</>
}

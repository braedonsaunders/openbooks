'use client'

import { useContext, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { DrawerNavigateContext, Button, EmptyState } from '@openbooks/ui'
import { isUuid } from '@openbooks/engine/src/platform/uuid.ts'
import { listDrawerRoute, isListDrawerHrefChange, type NativeListDrawerData } from '../lib/list/drawer-routes'
import { NativeListDrawer } from './native-list-drawer'
import { useDrawerResource } from './use-drawer-resource'

/** Native record components own their dialog. Mount that dialog once with
 * complete data, as the related-party host does; never add a loading dialog. */
export function ListDrawerHost({ source, initial, initialId, initialForm }: {
  source: string; initial?: NativeListDrawerData | null; initialId?: string; initialForm?: string
}) {
  const params = useSearchParams()
  const pathname = usePathname()
  const route = listDrawerRoute(source)
  const id = route ? params.get(route.param) : null
  const form = params.get('form') ?? undefined
  const t = useTranslations('common')
  const navigate = useContext(DrawerNavigateContext)
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const search = new URLSearchParams()
  if (route && id) search.set(route.param, id)
  if (form) search.set('form', form)
  // A retry has the same server semantics but a new request identity.
  if (retry) search.set('retry', String(retry))
  const url = route && pathname === route.path && id && isUuid(id) ? `/api/lists/${source}/drawer?${search}` : null
  const [seed, setSeed] = useState({ payload: initial, active: true })
  const matchesSelection = id === initialId && form === initialForm
  // Server data seeds one uninterrupted selection. Closing or switching away
  // consumes it; reopening must reauthorize and read the current revision.
  // A genuine server refresh supplies a new seed after a write or navigation.
  if (seed.payload !== initial) setSeed({ payload: initial, active: true })
  else if (seed.active && !matchesSelection) setSeed({ payload: initial, active: false })
  const initialMatches = Boolean(initial && seed.active && matchesSelection)
  const loaded = useDrawerResource<NativeListDrawerData>(initialMatches ? null : url, (error) => {
    if (url) setFailure({ url, message: error.message })
  })
  if (!url) return null
  const data = initialMatches ? initial : loaded
  const error = failure?.url === url && !data ? failure.message : null
  if (error) return <EmptyState title={t('feedback.loadFailed')} description={error}
    action={<Button variant="outline" onClick={() => setRetry((n) => n + 1)}>{t('actions.retry')}</Button>} />
  if (!data) return <span role="status" className="sr-only" aria-live="polite">{t('feedback.loading')}</span>
  const drawer = data.drawer && typeof data.drawer === 'object'
    ? { ...data.drawer, initialMode: params.get('mode') === 'edit' ? 'edit' : 'view' } : data.drawer
  return <DrawerNavigateContext.Provider value={(href) => {
    if (isListDrawerHrefChange(window.location.href, href)) window.history.pushState(null, '', href)
    else if (navigate) navigate(href)
    else window.location.assign(href)
  }}><NativeListDrawer widget={data.widget} drawer={drawer} /></DrawerNavigateContext.Provider>
}

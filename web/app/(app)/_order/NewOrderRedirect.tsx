'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { mergeHref } from '../../../lib/list-params'

/**
 * Handles `?<param>=new` deep links with zero writes: swaps the URL to the
 * unsaved-create drawer (`?<createParam>=1`) so the flyout opens on an
 * editable in-memory draft that is persisted only by its explicit Save.
 * (`apiPath`/`createFailedMessage` stay accepted so existing widget props
 * keep typechecking; nothing here fetches.)
 */
export function NewOrderRedirect({
  base,
  param,
  createParam,
}: {
  apiPath?: string
  base: string
  param: string
  createParam?: string
  createFailedMessage?: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    // A missing createParam is a miswired widget, not a state to navigate
    // through: replacing ?<param>=new with a markerless URL would strand
    // the drawer closed with no error, so refuse to navigate instead.
    if (!createParam) {
      console.error(`NewOrderRedirect: missing createParam for ${base}`)
      return
    }
    const current = Object.fromEntries(searchParams.entries())
    router.replace(mergeHref(base, current, { [param]: undefined, [createParam]: '1' }) as never)
  }, [router, searchParams, base, param, createParam])

  return null
}

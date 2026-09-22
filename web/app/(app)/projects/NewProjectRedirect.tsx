'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { mergeHref } from '../../../lib/list-params'

/**
 * Handles `?project=new` deep links with zero writes: swaps the URL to the
 * unsaved-create drawer (`?projectNew=1`) so the flyout opens on an editable
 * draft that is persisted only by its explicit Save.
 */
export function NewProjectRedirect() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const current = Object.fromEntries(searchParams.entries())
    router.replace(mergeHref('/projects', current, {
      project: undefined,
      projectNew: '1',
    }) as never)
  }, [router, searchParams])

  return null
}

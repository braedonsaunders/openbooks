'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { mergeHref } from '@/lib/list-params'

/**
 * The one unsaved-create button. Opening it writes nothing — it navigates to
 * a URL-controlled unsaved drawer (`?<param>=1`) and the drawer's explicit
 * Save is the first write, so abandoning the drawer leaves no row behind.
 * `clear` names the list-state keys the open drops (the open record, its
 * search and pagination); `extra` carries fixed drawer params (such as a
 * mode or role); `currentParams` overrides the live query string for callers
 * (and tests) that already hold it.
 */
export function UnsavedCreateButton({
  base,
  param,
  clear = [],
  label,
  extra,
  currentParams,
}: {
  base: string
  param: string
  clear?: readonly string[]
  label: string
  extra?: Readonly<Record<string, string>>
  currentParams?: Record<string, string | string[] | undefined>
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function open() {
    const current = currentParams ?? Object.fromEntries(searchParams.entries())
    const overrides: Record<string, string | null> = { [param]: '1', ...(extra ?? {}) }
    for (const key of clear) overrides[key] = null
    router.push(mergeHref(base, current, overrides) as never)
    router.refresh()
  }

  return (
    <Button onClick={open}>
      <Plus size={15} />
      {label}
    </Button>
  )
}

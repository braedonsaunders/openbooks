'use client'

import Link from 'next/link'
import type { ComponentProps } from 'react'
import { isListDrawerHrefChange } from '../lib/list/drawer-routes'

/** Retain normal link behavior for modified clicks, new tabs and full-page
 * records. Only an existing record over the same list uses native history. */
export function ListDrawerLink(props: ComponentProps<typeof Link>) {
  return <Link {...props} prefetch={false} onClick={(event) => {
    props.onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target === '_blank') return
    const href = typeof props.href === 'string' ? props.href : null
    if (!href || !isListDrawerHrefChange(window.location.href, href)) return
    event.preventDefault()
    window.history.pushState(null, '', href)
  }} />
}

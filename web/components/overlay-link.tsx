'use client'

import type { ComponentProps, MouseEvent } from 'react'
import { useReportOverlayOptional } from './navigation-provider'

function isModifiedClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0
}

/**
 * Same-tab overlay chrome. Cmd/ctrl-click keeps the href (full load with
 * the drawer open). Same-tab click replaceStates so a force-dynamic report
 * paper does not re-run.
 */
export function OverlayLink({
  href,
  onClick,
  ...props
}: ComponentProps<'a'> & { href: string }) {
  const overlay = useReportOverlayOptional()
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || isModifiedClick(event)) return
        if (!overlay) return
        event.preventDefault()
        overlay.navigate(href)
      }}
    />
  )
}

import type { KeyboardEvent } from 'react'

/**
 * APG menu keyboard support for the Popover-based list menus (FilterChips,
 * ViewsMenu), mirroring the role="menu"/role="menuitem" semantics of the
 * shared ContextMenu primitive. Attach to the onKeyDown of the element
 * carrying role="menu": ArrowUp/ArrowDown/Home/End move focus among its
 * enabled menuitems. Escape-to-close is already handled by the Popover.
 */
export function menuArrowKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
    ),
  )
  if (items.length === 0) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  let next: number
  if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = items.length - 1
  else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length
  else next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length
  const target = items[next]
  if (target) target.focus()
}

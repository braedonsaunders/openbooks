'use client'

import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { DrawerTabStrip } from '../drawer-tab-strip'
import { SubtabNav } from '@braedonsaunders/appkit-ui'
import { switchView, viewSwitchTypes } from '@openbooks/ui'

/** The house record selector, with keyboard focus and optional panel ownership. */
export function RecordTabs<T extends string>({ label, active, tabs, onChange, children, panelId, className }: {
  label: string
  active: T
  tabs: { key: T; label: ReactNode; count?: number; disabled?: boolean }[]
  onChange: (key: T) => void
  children?: ReactNode
  panelId?: string
  className?: string
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const contentId = panelId ?? (children !== undefined ? `${id}-panel` : undefined)
  // Every selection is a view switch, so the panel change animates like a page change.
  const select = (key: T) => switchView(() => onChange(key), viewSwitchTypes(
    tabs.findIndex((tab) => tab.key === active), tabs.findIndex((tab) => tab.key === key)))
  useLayoutEffect(() => {
    const buttons = root.current?.querySelectorAll<HTMLElement>('button')
    buttons?.forEach((button, index) => {
      const tab = tabs[index]!
      button.id = `${id}-${tab.key}`
      button.tabIndex = contentId ? tab.key === active ? 0 : -1 : 0
      if (contentId) button.setAttribute('aria-controls', contentId)
      else button.removeAttribute('aria-controls')
    })
  }, [tabs, active, id, contentId])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLElement) || event.target.tagName !== 'BUTTON') return
    const focused = event.target
    const available = tabs.filter((tab) => !tab.disabled)
    if (!available.length) return
    const index = available.findIndex((tab) => `${id}-${tab.key}` === focused.id)
    const rtl = root.current && getComputedStyle(root.current).direction === 'rtl'
    let next: number
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = available.length - 1
    else if (event.key === 'ArrowRight') next = (index + (rtl ? -1 : 1) + available.length) % available.length
    else if (event.key === 'ArrowLeft') next = (index + (rtl ? 1 : -1) + available.length) % available.length
    else return
    event.preventDefault()
    const selected = available[next]!
    select(selected.key)
    document.getElementById(`${id}-${selected.key}`)?.focus()
  }

  return <>
    <div ref={root} onKeyDown={onKeyDown} className={className}>
      {contentId ? <SubtabNav tabs={tabs} active={active} onSelect={(key) => select(key as T)} ariaLabel={label} /> : <DrawerTabStrip tabs={tabs} activeKey={active} onSelect={onChange} ariaLabel={label} />}
    </div>
    {children !== undefined ? <div id={contentId} role="tabpanel" aria-labelledby={`${id}-${active}`} tabIndex={0}>{children}</div> : null}
  </>
}

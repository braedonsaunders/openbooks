'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from './utils'
import { useHydrated } from './use-hydrated'

/**
 * Universal context menu — a floating list of actions opened at a point.
 *
 * Two ways to trigger it, both via {@link useContextMenu}:
 *   • right-click:  <tr onContextMenu={menu.onContextMenu}>
 *   • a kebab (⋮) button:  <button onClick={(e) => menu.openBelow(e.currentTarget)}>
 *
 * The panel portals to <body>, clamps itself inside the viewport, and closes on
 * outside-click / Escape / scroll. Items carry an icon, label, and handler;
 * `danger` tints destructive actions, and `{ separator: true }` draws a divider.
 *
 *   const menu = useContextMenu()
 *   <ContextMenu open={menu.open} position={menu.position} onClose={menu.close}
 *     items={[
 *       { key: 'open', label: 'Open', icon: FolderOpen, onSelect: () => … },
 *       { key: 'sep', separator: true },
 *       { key: 'del', label: 'Delete', icon: Trash2, danger: true, onSelect: () => … },
 *     ]} />
 */

export interface ContextMenuItem {
  key: string
  label: string
  icon?: React.ComponentType<{ className?: string }>
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
}

export type ContextMenuEntry = ContextMenuItem | { key: string; separator: true }

export interface ContextMenuController {
  open: boolean
  position: { x: number; y: number } | null
  /** Open at an explicit viewport point. */
  openAt: (x: number, y: number) => void
  /** Right-click handler — prevents the native menu and opens at the cursor. */
  onContextMenu: (e: React.MouseEvent) => void
  /** Open anchored to the bottom-right of a trigger element (a kebab button). */
  openBelow: (el: HTMLElement) => void
  close: () => void
}

export function useContextMenu(): ContextMenuController {
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null)

  const openAt = React.useCallback((x: number, y: number) => setPosition({ x, y }), [])
  const onContextMenu = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setPosition({ x: e.clientX, y: e.clientY })
  }, [])
  const openBelow = React.useCallback((el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setPosition({ x: r.right, y: r.bottom + 4 })
  }, [])
  const close = React.useCallback(() => setPosition(null), [])

  return { open: position != null, position, openAt, onContextMenu, openBelow, close }
}

export function ContextMenu({
  open,
  position,
  items,
  onClose,
  className,
}: {
  open: boolean
  position: { x: number; y: number } | null
  items: ContextMenuEntry[]
  onClose: () => void
  className?: string
}) {
  const panelRef = React.useRef<HTMLDivElement>(null)
  const mounted = useHydrated()
  // Measured panel size, delivered by the observer callback below. The menu
  // position is derived from it during render (see `coords`) instead of being
  // copied into state from an effect.
  const [panelSize, setPanelSize] = React.useState<{ width: number; height: number } | null>(null)

  // Observe the panel once it exists so the menu can clamp inside the
  // viewport. The measurement arrives via the observer callback (an external
  // subscription), and disconnects after the first reading — the position only
  // depends on `open`/`position`, matching the previous update points.
  React.useLayoutEffect(() => {
    if (!open || !position) return
    const panel = panelRef.current
    if (!panel || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setPanelSize({ width: panel.offsetWidth, height: panel.offsetHeight })
      observer.disconnect()
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [open, position])

  const coords = React.useMemo(() => {
    if (!open || !position) return null
    const pw = panelSize?.width ?? 176
    const ph = panelSize?.height ?? 0
    const pad = 8
    let x = position.x
    let y = position.y
    if (typeof window !== 'undefined') {
      if (x + pw + pad > window.innerWidth) x = window.innerWidth - pw - pad
      if (y + ph + pad > window.innerHeight) y = window.innerHeight - ph - pad
    }
    return { x: Math.max(pad, x), y: Math.max(pad, y) }
  }, [open, position, panelSize])

  React.useEffect(() => {
    if (!open) return
    function onDown(e: Event) {
      if (panelRef.current?.contains(e.target as Node)) return
      onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    function onScroll() {
      onClose()
    }
    // Defer so the click/right-click that opened the menu doesn't close it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('contextmenu', onDown)
      document.addEventListener('keydown', onKey)
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', onScroll)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('contextmenu', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, onClose])

  if (!mounted || typeof document === 'undefined') return null

  const at = coords ?? position

  return createPortal(
    <AnimatePresence>
      {open && at ? (
        <motion.div
          ref={panelRef}
          data-ui-overlay
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            'fixed z-[70] min-w-[11rem] max-w-[16rem] overflow-hidden rounded-md border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-800 dark:bg-slate-900',
            className,
          )}
          style={{ left: at.x, top: at.y, transformOrigin: 'top left' }}
          role="menu"
        >
          {items.map((item) =>
            'separator' in item ? (
              <div key={item.key} className="my-1 h-px bg-slate-100 dark:bg-slate-800" />
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return
                  onClose()
                  item.onSelect()
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm transition-colors',
                  item.disabled
                    ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
                    : item.danger
                      ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40'
                      : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
                )}
              >
                {item.icon ? <item.icon className="h-4 w-4 shrink-0 opacity-80" /> : null}
                <span className="flex-1 truncate">{item.label}</span>
              </button>
            ),
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}

'use client'

// Promise-based replacement for the browser's window.confirm(). One
// <ConfirmRoot /> is mounted in the (app) layout beside <Toaster />; client
// components import { confirmDialog } and await it to gate destructive actions:
//
//   if (!(await confirmDialog('Delete this record?'))) return
//
// The store lives at module scope so confirmDialog() is a plain callable (a true
// drop-in for window.confirm) rather than a hook — no context wiring at every
// call site. The rendered modal is animated, dark-mode aware, and portals to
// <body> (PageContainer's transform would otherwise trap position:fixed).

import * as React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, HelpCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'

export type ConfirmTone = 'default' | 'danger'

type ConfirmOptions = {
  /** Heading. Defaults to "Are you sure?" (danger) / "Confirm" (default). */
  title?: string
  /** Body message — the sentence(s) that were passed to window.confirm(). */
  message: React.ReactNode
  /** Primary button label. Defaults to "Confirm". */
  confirmLabel?: string
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string
  /** `danger` = red primary button + warning icon (for destructive actions). */
  tone?: ConfirmTone
}

type Request = ConfirmOptions & { id: number; resolve: (ok: boolean) => void }

let current: Request | null = null
let counter = 0
const listeners = new Set<() => void>()
function emit() {
  for (const l of listeners) l()
}

/**
 * Open an animated confirmation modal and resolve to the user's choice.
 * Accepts a plain string (like window.confirm) or a full options object.
 */
export function confirmDialog(options: string | ConfirmOptions): Promise<boolean> {
  const opts: ConfirmOptions = typeof options === 'string' ? { message: options } : options
  return new Promise<boolean>((resolve) => {
    // If a dialog is somehow already open, dismiss it as cancelled first so we
    // never leave a dangling promise.
    if (current) current.resolve(false)
    current = { ...opts, id: ++counter, resolve }
    emit()
  })
}

function settle(ok: boolean) {
  if (!current) return
  current.resolve(ok)
  current = null
  emit()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Mounted once in the app layout. Renders the active confirm request (if any). */
export function ConfirmRoot() {
  const t = useTranslations('ui.confirm')
  const tConfirm = useTranslations('common.confirm')
  const req = React.useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )

  React.useEffect(() => {
    if (!req) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') settle(false)
      // Let focused buttons handle Enter through their native click. This
      // preserves an explicit Cancel activation instead of settling true from
      // this document-level listener before the button click can run.
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) settle(true)
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [req])

  if (typeof document === 'undefined') return null

  const danger = req?.tone === 'danger'
  const title = req?.title ?? (danger ? tConfirm('title') : t('defaultTitle'))
  const confirmLabel = req?.confirmLabel ?? tConfirm('confirm')
  const cancelLabel = req?.cancelLabel ?? tConfirm('cancel')

  return createPortal(
    <AnimatePresence>
      {req ? (
        <div
          key={req.id}
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
            onClick={() => settle(false)}
            aria-hidden="true"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', damping: 26, stiffness: 340, mass: 0.7 }}
            className="relative w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex items-start gap-4 p-6">
              <div
                className={
                  danger
                    ? 'flex size-10 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400'
                    : 'flex size-10 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-600 dark:bg-sky-950/50 dark:text-sky-400'
                }
              >
                {danger ? <AlertTriangle size={20} /> : <HelpCircle size={20} />}
              </div>
              <div className="min-w-0 space-y-1.5 pt-0.5">
                <h2
                  id="confirm-title"
                  className="text-base font-semibold text-slate-900 dark:text-slate-100"
                >
                  {title}
                </h2>
                <div className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  {req.message}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-slate-800 dark:bg-slate-900/60">
              <Button variant="outline" onClick={() => settle(false)}>
                {cancelLabel}
              </Button>
              <Button
                autoFocus
                variant={danger ? 'destructive' : 'default'}
                onClick={() => settle(true)}
              >
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}

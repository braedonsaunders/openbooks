'use client'

// Promise-based replacement for window.prompt(). One <PromptRoot /> is mounted
// in the app layout beside <ConfirmRoot />; client components import
// { promptDialog } and await a styled, dark-mode-aware text-input modal:
//
//   const name = await promptDialog({ title: 'Rename file', initialValue: file.name })
//   if (name && name !== file.name) { … }
//
// Resolves to the trimmed string on confirm, or null on cancel/empty — mirroring
// the confirmDialog store pattern so there's no context wiring at call sites.

import * as React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { Button, Input, Label } from '@openbooks/ui'

type PromptOptions = {
  title: string
  /** Field label above the input. */
  label?: string
  /** Pre-filled (and pre-selected) value. */
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
}

type Request = PromptOptions & { id: number; resolve: (value: string | null) => void }

let current: Request | null = null
let counter = 0
const listeners = new Set<() => void>()
function emit() {
  for (const l of listeners) l()
}

/** Open a text-input modal and resolve to the trimmed value, or null. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    if (current) current.resolve(null)
    current = { ...options, id: ++counter, resolve }
    emit()
  })
}

function settle(value: string | null) {
  if (!current) return
  current.resolve(value)
  current = null
  emit()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Mounted once in the app layout. Renders the active prompt request (if any). */
export function PromptRoot() {
  const tc = useTranslations('common')
  const req = React.useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
  const [value, setValue] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Reset the field each time a new request opens; focus + select the text.
  React.useEffect(() => {
    if (!req) return
    setValue(req.initialValue ?? '')
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      cancelAnimationFrame(id)
      document.body.style.overflow = prev
    }
  }, [req?.id])

  if (typeof document === 'undefined') return null

  function submit() {
    const trimmed = value.trim()
    settle(trimmed ? trimmed : null)
  }

  return createPortal(
    <AnimatePresence>
      {req ? (
        <div
          key={req.id}
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="prompt-title"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
            onClick={() => settle(null)}
            aria-hidden="true"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', damping: 26, stiffness: 340, mass: 0.7 }}
            className="relative w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          >
            <form
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              <div className="space-y-3 p-6">
                <h2
                  id="prompt-title"
                  className="text-base font-semibold text-slate-900 dark:text-slate-100"
                >
                  {req.title}
                </h2>
                {req.label ? (
                  <Label htmlFor="prompt-input" className="text-xs text-slate-500 dark:text-slate-400">
                    {req.label}
                  </Label>
                ) : null}
                <Input
                  id="prompt-input"
                  ref={inputRef}
                  value={value}
                  placeholder={req.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') settle(null)
                  }}
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-slate-800 dark:bg-slate-900/60">
                <Button type="button" variant="outline" onClick={() => settle(null)}>
                  {req.cancelLabel ?? tc('confirm.cancel')}
                </Button>
                <Button type="submit" disabled={!value.trim()}>
                  {req.confirmLabel ?? tc('actions.save')}
                </Button>
              </div>
            </form>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}

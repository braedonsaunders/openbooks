'use client'

// Global ⌘K / Ctrl+K quick launcher for the assistant, ported from beaconhs.
// Opens a command-style input anywhere in the app; submitting routes to
// /assistant with the prompt (auto-sent there once).

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CornerDownLeft, Sparkles } from 'lucide-react'

export function AssistantLauncher() {
  const t = useTranslations('assistant.launcher')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen(true)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(timer)
    }
  }, [open])

  function submit() {
    const q = text.trim()
    setOpen(false)
    setText('')
    router.push(q ? `/assistant?q=${encodeURIComponent(q)}` : '/assistant')
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-500 shadow-sm transition-colors hover:border-teal-300 hover:text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-teal-800 dark:hover:text-slate-200"
        aria-label={t('open')}
      >
        <Sparkles className="h-4 w-4 text-teal-600 dark:text-teal-400" />
        <span className="hidden lg:inline">{t('label')}</span>
        <kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1 text-[10px] font-medium text-slate-400 lg:inline dark:border-slate-700 dark:bg-slate-800">
          ⌘K
        </kbd>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[60] flex items-start justify-center bg-slate-900/40 px-4 backdrop-blur-[2px]"
          onClick={() => setOpen(false)}
        >
          <div
            className="mt-[15vh] w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 px-4 py-3">
              <Sparkles className="h-5 w-5 shrink-0 text-teal-600 dark:text-teal-400" />
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  }
                }}
                placeholder={t('placeholder')}
                className="flex-1 bg-transparent text-base text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
              />
              <button
                type="button"
                onClick={submit}
                aria-label={t('submit')}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <CornerDownLeft className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              {t('hint')}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

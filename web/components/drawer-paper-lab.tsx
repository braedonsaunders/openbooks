'use client'

// Drawer paper lab — a temporary evaluation control for choosing the drawers'
// paper treatment in the running app. Remove with app/drawer-paper-lab.css
// (imported by the (app) layout) once a treatment is chosen.

import { useEffect, useState, useSyncExternalStore } from 'react'

const LOOKS = [
  { key: 'dog-ear', label: 'Dog-ear', blurb: 'Current: turned-down top corner on a fanned stack of two sheets.' },
  { key: 'ream', label: 'Ream', blurb: 'A squared stack: crisp sheet edges step down the leading side.' },
  { key: 'curl', label: 'Curl', blurb: 'The leading corners lift off the desk; the shadow deepens top and bottom.' },
  { key: 'ledger', label: 'Ledger', blurb: 'Dog-ear sheet ruled as accounting paper: red double margin, gutter rules.' },
  { key: 'binder', label: 'Binder', blurb: 'Punched sheets: holes along the leading edge show the desk through.' },
  { key: 'folder', label: 'Folder', blurb: 'The record rests in a manila folder, its back and index tab showing.' },
  { key: 'plain', label: 'Plain', blurb: 'A clean panel with no paper treatment, for comparison.' },
] as const

const TONES = [
  { key: 'white', label: 'White' },
  { key: 'ivory', label: 'Ivory' },
  { key: 'linen', label: 'Linen' },
] as const

type Settings = { look: string; tone: string; grain: boolean }
const DEFAULTS: Settings = { look: 'dog-ear', tone: 'white', grain: false }
const STORAGE_KEY = 'openbooks.drawer-paper-lab'
const subscribeNothing = () => () => {}
const browserReady = () => true
const serverReady = () => false

function readSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

export function DrawerPaperLab() {
  const mounted = useSyncExternalStore(subscribeNothing, browserReady, serverReady)
  const [settings, setSettings] = useState<Settings>(readSettings)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!mounted) return
    const root = document.documentElement
    root.dataset.drawerLook = settings.look
    root.dataset.drawerTone = settings.tone
    root.dataset.drawerGrain = settings.grain ? 'on' : 'off'
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [mounted, settings])

  if (!mounted) return null
  const update = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch })
  const current = LOOKS.find((look) => look.key === settings.look) ?? LOOKS[0]

  return (
    <div className="fixed bottom-4 left-4 z-[65] text-sm">
      {open ? (
        <div className="w-[21rem] rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-slate-900 dark:text-slate-100">Drawer paper</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">Open any drawer, then switch treatments live.</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
              Hide
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {LOOKS.map((look) => (
              <button
                key={look.key}
                type="button"
                title={look.blurb}
                aria-pressed={settings.look === look.key}
                onClick={() => update({ look: look.key })}
                className={`rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
                  settings.look === look.key
                    ? 'border-teal-600 bg-teal-50 font-medium text-teal-900 dark:border-teal-400 dark:bg-teal-950/50 dark:text-teal-100'
                    : 'border-slate-200 text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300'
                }`}
              >
                {look.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{current.blurb}</p>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-slate-700 dark:text-slate-300">Paper tone</span>
            <div className="flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
              {TONES.map((tone) => (
                <button
                  key={tone.key}
                  type="button"
                  aria-pressed={settings.tone === tone.key}
                  onClick={() => update({ tone: tone.key })}
                  className={`rounded-md px-2.5 py-1 text-xs ${settings.tone === tone.key ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'}`}
                >
                  {tone.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-slate-700 dark:text-slate-300">Paper grain</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.grain}
              onClick={() => update({ grain: !settings.grain })}
              className={`relative h-5 w-9 rounded-full transition-colors ${settings.grain ? 'bg-teal-600' : 'bg-slate-300 dark:bg-slate-600'}`}
            >
              <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${settings.grain ? 'translate-x-4' : ''}`} />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-full border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 shadow-lg hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          Drawer paper · {current.label}
        </button>
      )}
    </div>
  )
}

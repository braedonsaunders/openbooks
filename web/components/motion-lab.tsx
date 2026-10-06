'use client'

// Paper motion lab — a temporary evaluation control for choosing the page
// and tab motion in the running app. Remove with app/motion-lab.css (imported
// by the (app) layout) once a motion is chosen.

import { useEffect, useState } from 'react'

const MOTIONS = [
  { key: 'lay-on', label: 'Lay on', blurb: 'A fresh sheet slides up onto the stack; the old one settles back.' },
  { key: 'shuffle', label: 'Shuffle', blurb: 'The drawer motion: in from the side, askew, squaring up as it lands.' },
  { key: 'turn', label: 'Turn', blurb: 'The top sheet is lifted by its corner and turned aside.' },
  { key: 'tear-off', label: 'Tear off', blurb: 'The top sheet peels up from its bottom edge, off a pad.' },
  { key: 'settle', label: 'Settle', blurb: 'Set down from a hair above the desk; the shadow tightens.' },
  { key: 'current', label: 'Current', blurb: 'What main ships today, for comparison.' },
] as const

const SPEEDS = [
  { t: '1', label: '1×' },
  { t: '2', label: '½×' },
  { t: '5', label: 'Slow-mo' },
] as const

type Settings = { page: string; tab: string; pill: boolean; t: string }
const DEFAULTS: Settings = { page: 'lay-on', tab: 'shuffle', pill: true, t: '1' }
const STORAGE_KEY = 'openbooks.paper-motion-lab'

function readSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

export function MotionLab() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setSettings(readSettings())
  }, [])

  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    root.dataset.paperPage = settings.page
    root.dataset.paperTab = settings.tab
    root.dataset.paperPill = settings.pill ? 'on' : 'off'
    root.style.setProperty('--paper-t', settings.t)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  if (!settings) return null
  const update = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch })

  return (
    <div className="fixed right-4 bottom-4 z-[65] text-sm">
      {open ? (
        <div className="w-[22rem] rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-slate-900 dark:text-slate-100">Paper motion</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">Pick a motion, then move between pages and tabs.</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
              Hide
            </button>
          </div>
          <MotionChoice title="Page change" value={settings.page} onChange={(page) => update({ page })} />
          <MotionChoice title="Tab switch" value={settings.tab} onChange={(tab) => update({ tab })} />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-slate-700 dark:text-slate-300">Tab pill glides</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.pill}
              onClick={() => update({ pill: !settings.pill })}
              className={`relative h-5 w-9 rounded-full transition-colors ${settings.pill ? 'bg-teal-600' : 'bg-slate-300 dark:bg-slate-600'}`}
            >
              <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${settings.pill ? 'translate-x-4' : ''}`} />
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-slate-700 dark:text-slate-300">Speed</span>
            <div className="flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
              {SPEEDS.map((speed) => (
                <button
                  key={speed.t}
                  type="button"
                  aria-pressed={settings.t === speed.t}
                  onClick={() => update({ t: speed.t })}
                  className={`rounded-md px-2.5 py-1 text-xs ${settings.t === speed.t ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'}`}
                >
                  {speed.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-full border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 shadow-lg hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          Paper motion · {MOTIONS.find((motion) => motion.key === settings.page)?.label} / {MOTIONS.find((motion) => motion.key === settings.tab)?.label}
        </button>
      )}
    </div>
  )
}

function MotionChoice({ title, value, onChange }: { title: string; value: string; onChange: (key: string) => void }) {
  return (
    <fieldset className="mb-3">
      <legend className="mb-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{title}</legend>
      <div className="grid grid-cols-2 gap-1.5">
        {MOTIONS.map((motion) => (
          <button
            key={motion.key}
            type="button"
            title={motion.blurb}
            aria-pressed={value === motion.key}
            onClick={() => onChange(motion.key)}
            className={`rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
              value === motion.key
                ? 'border-teal-600 bg-teal-50 font-medium text-teal-900 dark:border-teal-400 dark:bg-teal-950/50 dark:text-teal-100'
                : 'border-slate-200 text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300'
            }`}
          >
            {motion.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{MOTIONS.find((motion) => motion.key === value)?.blurb}</p>
    </fieldset>
  )
}

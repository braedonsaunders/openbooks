'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Settings2 } from 'lucide-react'
import { Panel } from './Panel'

/**
 * Editable analytics thresholds — Gantry's Configuration-tab save flow.
 * Renders the field spec from lib/analytics/config.ts, PUTs overrides to
 * /api/analytics/config/<dashboard>, then refreshes the server-rendered
 * dashboard so every tab recomputes with the new values.
 */
export interface EditorField {
  key: string
  label: string
  help: string
  min: number
  max: number
  step: number
}

export function ConfigEditor({
  dashboard,
  fields,
  values,
  defaults,
}: {
  dashboard: string
  fields: EditorField[]
  values: Record<string, number>
  defaults: Record<string, number>
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, String(values[f.key] ?? defaults[f.key])])))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const dirty = fields.some((f) => Number(draft[f.key]) !== (values[f.key] ?? defaults[f.key]))

  const save = async (payload: Record<string, number>) => {
    setBusy(true)
    setMsg(null)
    const r = await fetch(`/api/analytics/config/${dashboard}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (r.ok) {
      setMsg('Saved — recomputing…')
      router.refresh()
    } else if (r.status === 403) {
      setMsg('Saving requires the Setup permission.')
    } else {
      setMsg(`Save failed (${r.status}).`)
    }
    setBusy(false)
  }

  return (
    <Panel title="Thresholds" icon={Settings2} hint="Per-organization — every tab recomputes on save">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="flex items-baseline justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
              {f.label}
              <span className="font-normal text-slate-400 dark:text-slate-500">default {defaults[f.key]}</span>
            </span>
            <input
              type="number"
              value={draft[f.key]}
              min={f.min}
              max={f.max}
              step={f.step}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm text-slate-700 tabular-nums dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
            />
            <span className="mt-0.5 block text-[11px] leading-snug text-slate-400 dark:text-slate-500">{f.help}</span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => save(Object.fromEntries(fields.map((f) => [f.key, Number(draft[f.key])])))}
          className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 hover:bg-teal-700"
        >
          Save configuration
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setDraft(Object.fromEntries(fields.map((f) => [f.key, String(defaults[f.key])])))
            void save({ ...defaults })
          }}
          className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          Reset to defaults
        </button>
        {msg ? <span className="text-xs text-slate-400 dark:text-slate-500">{msg}</span> : null}
      </div>
    </Panel>
  )
}

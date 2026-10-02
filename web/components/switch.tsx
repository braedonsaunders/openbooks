import type { ReactNode } from 'react'
import { Label, cn } from '@openbooks/ui'

/** A record-level boolean uses the same switch and label as Setup controls. */
export function SwitchField({ label, description, on, disabled = false, onToggle }: {
  label: string; description?: string; on: boolean; disabled?: boolean; onToggle: () => void;
}) {
  return <div className="flex items-center justify-between gap-4">
    <div className="min-w-0"><Label>{label}</Label>{description ? <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p> : null}</div>
    <Switch on={on} disabled={disabled} onToggle={onToggle} label={label} />
  </div>
}

/**
 * Accessible on/off switch (role=switch), teal when on — the Features
 * switchboard control, shared so every Setup toggle renders and behaves
 * identically. Alignment-neutral by default (no top offset); pass a
 * className when the row needs one.
 */
export function Switch({
  on,
  disabled,
  onToggle,
  label,
  className,
}: {
  on: boolean
  disabled: boolean
  onToggle: () => void
  label: string
  className?: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
        on ? 'bg-teal-600 dark:bg-teal-500' : 'bg-slate-200 dark:bg-slate-700',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        className,
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform',
          on ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

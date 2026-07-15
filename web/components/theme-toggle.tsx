'use client'

// Light / dark / system switcher. Expanded: a 3-way segmented control. Collapsed
// (icon-rail sidebar): a single button showing the active mode that cycles
// light → dark → system. Renders an inert placeholder until mounted so the SSR
// markup (which can't know the stored preference) doesn't mismatch on hydration.

import { useTranslations } from 'next-intl'
import { Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { useTheme, type Theme } from './theme-provider'

// Module-level constants can't call hooks — store message keys, translate at render.
const OPTIONS: { value: Theme; icon: typeof Sun; labelKey: 'light' | 'system' | 'dark' }[] = [
  { value: 'light', icon: Sun, labelKey: 'light' },
  { value: 'system', icon: Monitor, labelKey: 'system' },
  { value: 'dark', icon: Moon, labelKey: 'dark' },
]

export function ThemeToggle({ collapsed = false }: { collapsed?: boolean }) {
  const t = useTranslations('shell.themeToggle')
  const { theme, setTheme, mounted } = useTheme()

  if (collapsed) {
    const active = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[1]!
    const Icon = active.icon
    const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'
    return (
      <button
        type="button"
        onClick={() => setTheme(next)}
        title={t('currentHint', { theme: t(`options.${active.labelKey}`) })}
        aria-label={t('current', { theme: t(`options.${active.labelKey}`) })}
        className="grid h-9 w-9 place-items-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        {mounted ? <Icon size={16} /> : <Monitor size={16} className="opacity-0" />}
      </button>
    )
  }

  return (
    <div
      role="radiogroup"
      aria-label={t('label')}
      className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800/60"
    >
      {OPTIONS.map((o) => {
        const Icon = o.icon
        const selected = mounted && theme === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(o.value)}
            title={t(`options.${o.labelKey}`)}
            className={cn(
              'inline-flex h-7 flex-1 items-center justify-center rounded-md transition-colors',
              selected
                ? 'bg-white text-teal-700 shadow-sm dark:bg-slate-700 dark:text-teal-300'
                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
            )}
          >
            <Icon size={15} />
          </button>
        )
      })}
    </div>
  )
}

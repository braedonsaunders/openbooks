'use client'

// Per-user language preference — lives in the account menu next to the theme
// switch. "" (org default) clears users.locale so the tenant default applies;
// picking a locale persists it and re-renders the app in that language.

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { LOCALES, type Locale } from '../i18n/config'

export function LanguageSelect({ preference }: { preference: Locale | null }) {
  const t = useTranslations('shell.language')
  const router = useRouter()
  const [value, setValue] = useState(preference ?? '')
  const [pending, startTransition] = useTransition()

  async function change(next: string) {
    const prev = value
    setValue(next)
    const res = await fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: next || null }),
    })
    if (!res.ok) {
      setValue(prev)
      toast.error(t('saveFailed'))
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <select
      aria-label={t('label')}
      value={value}
      disabled={pending}
      onChange={(e) => change(e.target.value)}
      className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
    >
      <option value="">{t('orgDefault')}</option>
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  )
}

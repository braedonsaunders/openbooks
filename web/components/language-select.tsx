'use client'

// Per-user language preference — lives in the account menu next to the theme
// switch. "" (org default) clears users.locale so the tenant default applies;
// picking a locale persists it and re-renders the app in that language.

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Select } from '@openbooks/ui'
import { LOCALES, type Locale } from '../i18n/config'

export function LanguageSelect({ preference }: { preference: Locale | null }) {
  const t = useTranslations('shell.language')
  const router = useRouter()
  const [value, setValue] = useState(preference ?? '')
  const [pending, startTransition] = useTransition()

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.currentTarget.value
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
    <Select
      aria-label={t('label')}
      value={value}
      disabled={pending}
      onChange={change}
      triggerClassName="h-8 w-full text-sm"
    >
      <option value="">{t('orgDefault')}</option>
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </Select>
  )
}

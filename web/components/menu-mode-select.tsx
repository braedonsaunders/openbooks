'use client'

// Per-user app-menu layout preference — lives in the account menu next to the
// language select. "" (org default) clears users.nav_mode so the tenant
// default applies; picking a mode persists it and re-renders the app shell.

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Select } from '@openbooks/ui'
import { NAV_MODES, type NavMode } from '../lib/nav-mode'

export function MenuModeSelect({ preference }: { preference: NavMode | null }) {
  const t = useTranslations('shell.menuMode')
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
      body: JSON.stringify({ navMode: next || null }),
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
      {NAV_MODES.map((m) => (
        <option key={m} value={m}>
          {t(`options.${m}`)}
        </option>
      ))}
    </Select>
  )
}

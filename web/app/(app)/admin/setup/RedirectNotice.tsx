'use client'

import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { MovedFromSource } from '../../../../lib/moved-redirect'

function isSource(value: string | null): value is MovedFromSource {
  return value === 'settings' || value === 'setup-index' || value === 'payment-providers'
}

/**
 * The alias-redirect notice for the setup workspace (UX-17).
 *
 * /admin/settings, /admin/setup and the payment-providers gate redirect
 * here with `?movedFrom=<source>` (see web/lib/moved-redirect.ts). This
 * tells the reader where they landed and why — a silent redirect reads as
 * a broken bookmark. Renders nothing without a known source, so ordinary
 * navigation is untouched.
 */
export function SetupRedirectNotice() {
  const params = useSearchParams()
  const t = useTranslations('admin.setup.redirectNotice')
  const movedFrom = params.get('movedFrom')
  if (!isSource(movedFrom)) return null
  const body =
    movedFrom === 'settings'
      ? t('settingsBody')
      : movedFrom === 'setup-index'
        ? t('indexBody')
        : t('providersBody')
  return (
    <div
      role="status"
      className="mb-4 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-100"
    >
      <p className="font-semibold">{t('title')}</p>
      <p className="mt-0.5">{body}</p>
    </div>
  )
}

'use client'

import { useTranslations } from 'next-intl'

/**
 * The invalid-spec panel for ModuleView, split out so the title translates.
 * ModuleView itself is a server component; the validator error list below
 * the title stays English by construction (validator diagnostics), but the
 * panel chrome must read the session locale like every other page chrome.
 */
export function SpecValidationError({ errors }: { errors: readonly string[] }) {
  const t = useTranslations('customization.views')
  return (
    <div className="m-4 rounded-md border border-red-300 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-950/40">
      <p className="font-semibold text-red-700 dark:text-red-300">{t('renderFailed')}</p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-red-600 dark:text-red-400">
        {errors.slice(0, 10).map((error, index) => (
          <li key={index}>{error}</li>
        ))}
      </ul>
    </div>
  )
}

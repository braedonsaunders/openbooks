'use client'

import { useTranslations } from 'next-intl'
import { ShieldAlert } from 'lucide-react'

/**
 * The shared missing-grant hint: a small inline line naming the permission
 * a hidden or disabled action needs, so the operator knows what to ask
 * their administrator for instead of staring at a missing button. Used by
 * list pages (whose primary New action hides without the create grant) and
 * by drawers (whose decisive actions disable without the award/approve
 * grant) — one pattern, never per-page copy.
 */
export function PermissionHint({ permission, action }: { permission: string; action: string }) {
  const t = useTranslations('common')
  return (
    <p className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t('permissionHint', { permission, action })}</span>
    </p>
  )
}

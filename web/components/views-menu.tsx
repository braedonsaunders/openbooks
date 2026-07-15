'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ChevronDown, Check } from 'lucide-react'
import { Button, Popover, cn } from '@openbooks/ui'
import { buildHref, pickString } from '../lib/list-params'
import type { ListViewRow } from '../lib/customization/resolve'

/**
 * Saved-list-view picker for a record list page. Lists the views available to
 * the user (org-shared + personal), loads one via ?view=<id>, sets the user's
 * default, and links admins to the view designer.
 */
export function ViewsMenu({
  available,
  currentId,
  currentName,
  recordType,
  basePath,
  currentParams,
  canManage,
}: {
  available: ListViewRow[]
  currentId: string | null
  currentName: string
  recordType: string
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
}) {
  const t = useTranslations('customization.views')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const q = pickString(currentParams.q)

  const setDefault = async (viewId: string | null) => {
    setBusy(true)
    const res = await fetch('/api/customization/list-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordType, viewId }),
    })
    setBusy(false)
    if (res.ok) toast.success(viewId ? t('setDefaultDone') : t('clearDefaultDone'))
    else toast.error((await res.json()).error ?? t('setDefaultFailed'))
    router.refresh()
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      className="w-64"
      trigger={
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <span className="text-xs text-slate-500 dark:text-slate-400">{t('label')}</span>
          <span className="max-w-[12rem] truncate font-medium">{currentName}</span>
          <ChevronDown size={14} className="text-slate-400" />
        </Button>
      }
    >
      <div className="py-1 text-sm">
        {available.length === 0 ? (
          <div className="px-3 py-2 text-slate-500">{t('none')}</div>
        ) : (
          available.map((v) => (
            <Link
              key={v.id}
              href={buildHref(basePath, { view: v.id, q })}
              onClick={() => setOpen(false)}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60',
                v.id === currentId && 'text-teal-700 dark:text-teal-300',
              )}
            >
              <span className="flex-1 truncate">{v.name}</span>
              {v.scope === 'org' ? (
                <span className="text-[10px] uppercase tracking-wide text-slate-400">{t('orgBadge')}</span>
              ) : null}
              {v.isDefault ? (
                <span className="text-[10px] uppercase tracking-wide text-slate-400">{t('defaultBadge')}</span>
              ) : null}
              {v.id === currentId ? <Check size={14} /> : null}
            </Link>
          ))
        )}
        <div className="mt-1 border-t border-slate-100 pt-1 dark:border-slate-800">
          <button
            type="button"
            disabled={busy || !currentId}
            onClick={() => setDefault(currentId)}
            className="w-full px-3 py-1.5 text-left text-slate-600 hover:bg-slate-50 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800/60"
          >
            {t('setDefault')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDefault(null)}
            className="w-full px-3 py-1.5 text-left text-slate-600 hover:bg-slate-50 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800/60"
          >
            {t('useSystemDefault')}
          </button>
          {canManage ? (
            <>
              <Link
                href={`/admin/customization?recordType=${encodeURIComponent(recordType)}&tab=views&view=new`}
                onClick={() => setOpen(false)}
                className="block px-3 py-1.5 text-teal-700 hover:bg-slate-50 dark:text-teal-300 dark:hover:bg-slate-800/60"
              >
                {t('newView')}
              </Link>
              <Link
                href={`/admin/customization?recordType=${encodeURIComponent(recordType)}&tab=views`}
                onClick={() => setOpen(false)}
                className="block px-3 py-1.5 text-teal-700 hover:bg-slate-50 dark:text-teal-300 dark:hover:bg-slate-800/60"
              >
                {t('manage')}
              </Link>
            </>
          ) : null}
        </div>
      </div>
    </Popover>
  )
}

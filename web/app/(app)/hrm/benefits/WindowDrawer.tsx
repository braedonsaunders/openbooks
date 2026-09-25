'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Label, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useDirtyClose } from '../../../../lib/use-dirty-close'
import type { WindowDrawerData } from '../../../../lib/hrm/benefits'

/**
 * Window drawer, opened from a row through the `window=<id>` search param.
 * Loader-resolved progress plus the window's enrolments with their amounts;
 * closing navigates the param away. Closing an open window (with the
 * required reason) and opening a draft ride the window routes inside, and
 * the list refreshes after every transition.
 */
export function WindowDrawer({ drawer, closeHref }: { drawer: WindowDrawerData; closeHref: string }) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const reasonId = useId()
  const router = useRouter()
  const [closing, setClosing] = useState(false)
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState(false)
  const window = drawer.window

  function close() {
    router.push(closeHref as never)
    router.refresh()
  }

  // A typed close reason is unsaved work: drawer-level dismiss (Escape,
  // backdrop, X) asks before abandoning it. The inline Cancel only hides
  // the reason form — the drawer stays open and the text is kept — so it
  // needs no confirmation.
  const reasonClose = useDirtyClose({
    dirty: reason.trim().length > 0,
    busy: working,
    onClose: close,
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('confirm.discardChanges'),
  })

  async function transition(path: 'open' | 'close', body: Record<string, string>) {
    setWorking(true)
    try {
      const res = await fetch(`/api/hrm/enrollment-windows/${window.id}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('benefits.windowFailed')))
        return
      }
      setClosing(false)
      close()
    } catch {
      // Offline or another transport failure rejects instead of resolving:
      // the refusal toast is the only evidence, and working must reset so
      // the drawer controls do not strand disabled.
      toast.error(t('benefits.windowFailed'))
    } finally {
      setWorking(false)
    }
  }

  return (
    <Drawer open onClose={() => void reasonClose.close()} title={window.name} description={window.rangeLabel} size="lg">
      <div className="flex flex-col gap-5 p-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{drawer.progressLabel}</h3>
          {drawer.progress.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('benefits.drawerNoEnrolments')}</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
              {drawer.progress.map((p) => (
                <li key={p.value} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="text-sm text-slate-600 dark:text-slate-300">{p.label}</span>
                  <span className="text-sm tabular-nums text-slate-900 dark:text-slate-100">{p.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('benefits.drawerEnrolments')}</h3>
          {drawer.enrolments.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('benefits.drawerNoEnrolments')}</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
              {drawer.enrolments.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{e.employeeLabel}</span>
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    {e.planCode}
                    {e.coverageLabel ? ` · ${e.coverageLabel}` : ''}
                  </span>
                  <span className="ml-auto text-sm tabular-nums text-slate-600 dark:text-slate-300">
                    {e.employeeAmountPerPeriod ?? '–'} / {e.employerAmountPerPeriod ?? '–'} {e.currency}
                  </span>
                  <span className="basis-full text-xs text-slate-400 dark:text-slate-500">{e.statusLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {window.status === 'draft' ? (
            <Button disabled={working} onClick={() => transition('open', {})}>
              {t('benefits.openAction')}
            </Button>
          ) : null}
          {window.status === 'open' && !closing ? (
            <Button variant="outline" onClick={() => setClosing(true)}>
              {t('benefits.closeAction')}
            </Button>
          ) : null}
        </div>
        {closing ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={reasonId}>{t('benefits.closeReasonPlaceholder')}</Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('benefits.closeReasonPlaceholder')}
              required
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setClosing(false)}>
                {t('benefits.cancel')}
              </Button>
              <Button
                disabled={working || !reason.trim()}
                onClick={() => transition('close', { reason: reason.trim() })}
              >
                {t('benefits.closeAction')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Drawer>
  )
}

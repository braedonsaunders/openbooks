'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Drawer } from '@openbooks/ui'
import { ListOrdered, ArrowUpRight } from 'lucide-react'
import { ConfigEditor } from '../../analytics/_ui/ConfigEditor'
import { Panel } from '../../analytics/_ui/Panel'
import { useDirtyClose } from '../../../../lib/use-dirty-close'

/**
 * AP pay-selection configuration — the rule that decides WHICH bills the
 * pay-run planner recommends each week. This is AP's config: the weekly cap +
 * restrict-to-safe knobs (persisted to the shared cashflow config the engine
 * reads) plus the scheduling model behind the recommendation. The cash-wide
 * forecast model (recurring categories, prediction settings) lives on the
 * Cash cockpit — linked below, not duplicated here.
 *
 * All copy renders from the ap.cockpit.config catalog; the cap label carries
 * the organization's base-currency code from the MoneyProvider (via the
 * cockpit), never a hardcoded currency symbol.
 */
export function ApSelectionConfigDrawer({
  onClose,
  title,
  description,
  weeklyCap,
  restrictToSafe,
  dpo,
  currencyCode,
  canEdit,
}: {
  onClose: () => void
  title: string
  description: string
  weeklyCap: string
  restrictToSafe: boolean
  dpo: number
  currencyCode: string
  /** Setup permission with unrestricted scope — the drawer only opens behind
   * the gated gear, and the editor must never assume it. */
  canEdit: boolean
}) {
  const t = useTranslations('ap.cockpit.config')
  const tc = useTranslations('common')
  // The editor's draft is local state that unmounts with the drawer:
  // guard dismissal with the shared dirty-close flow so unsaved edits
  // ask before they are discarded.
  const [editorDirty, setEditorDirty] = useState(false)
  const closeGuard = useDirtyClose({
    dirty: editorDirty,
    onClose,
    message: tc('feedback.unsavedChanges'),
    confirmLabel: tc('confirm.discardChanges'),
  })
  const items: { label: string; value: string; note: string }[] = [
    { label: t('orderLabel'), value: t('orderValue'), note: t('orderNote') },
    { label: t('predictionLabel'), value: t('predictionValue'), note: t('predictionNote') },
    { label: t('overdueLabel'), value: t('overdueValue'), note: t('overdueNote') },
    { label: t('snapLabel'), value: t('snapValue'), note: t('snapNote') },
    { label: t('dpoLabel'), value: t('dpoValue', { dpo }), note: t('dpoNote') },
  ]

  return (
    <Drawer open onClose={() => void closeGuard.close()} size="lg" title={title} description={description} bodyClassName="overflow-y-auto">
      <div className="space-y-5">
        <ConfigEditor
          dashboard="cashflow"
          canEdit={canEdit}
          onDirtyChange={setEditorDirty}
          fields={[
            { key: 'weeklyApCap', label: t('weeklyCapLabel', { currency: currencyCode }), help: t('weeklyCapHelp'), min: 0, max: 100_000_000, step: 1000 },
            { key: 'restrictToSafe', label: t('restrictLabel'), help: t('restrictHelp'), min: 0, max: 1, step: 1 },
          ]}
          values={{ weeklyApCap: weeklyCap, restrictToSafe: restrictToSafe ? 1 : 0 }}
          defaults={{ weeklyApCap: '0.0000', restrictToSafe: 0 }}
        />

        <Panel title={t('scheduleTitle')} icon={ListOrdered} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {items.map((i) => (
              <li key={i.label} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{i.label}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{i.note}</p>
                </div>
                <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-right text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">{i.value}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <p className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          {t('footerPre')}
          <Link href={('/banking/cash')} className="inline-flex items-center gap-0.5 font-medium text-teal-600 hover:underline dark:text-teal-400">
            {t('footerLink')} <ArrowUpRight size={12} />
          </Link>
        </p>
      </div>
    </Drawer>
  )
}

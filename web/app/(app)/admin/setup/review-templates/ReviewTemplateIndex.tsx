'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ClipboardList, Plus } from 'lucide-react'
import { Badge, Button, EmptyState } from '@openbooks/ui'
import { promptDialog } from '../../../../../lib/prompt'
import { createSetupRow } from '../../../../../lib/setup/builder-client'

export interface ReviewTemplateCard {
  id: string
  name: string
  isActive: boolean
  scaleMin: string
  scaleMax: string
  sectionCount: number
  questionCount: number
  cycleCount: number
}

/**
 * Review templates: the entry point to the builder. Each card opens the
 * template's own builder page; New creates the template with the default
 * 1–5 scale through the shared Setup API and opens it.
 */
export function ReviewTemplateIndex({ templates }: { templates: ReviewTemplateCard[] }) {
  const t = useTranslations('admin.setup.reviewBuilder')
  const tb = useTranslations('admin.setup.builder')
  const tc = useTranslations('common')
  const router = useRouter()

  async function create() {
    const name = await promptDialog({ title: t('newTemplate'), label: t('fields.name'), confirmLabel: tc('actions.create') })
    if (!name) return
    const result = await createSetupRow('hrm-review-templates', {
      name, ratingScaleMin: 1, ratingScaleMax: 5, ratingScaleLabels: [], isActive: true,
    }, {
      fallback: tc('feedback.createFailed'),
      duplicate: t('errors.duplicateName'),
      inUse: tb('errors.inUse'),
      stale: tb('errors.stale'),
      network: tb('errors.network'),
    })
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    router.push(`/admin/setup/review-templates/${String(result.body.id)}`)
  }

  const newButton = (
    <Button type="button" onClick={() => void create()}>
      <Plus size={15} /> {t('newTemplate')}
    </Button>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
        </div>
        {templates.length > 0 ? newButton : null}
      </div>
      {templates.length === 0 ? (
        <EmptyState icon={<ClipboardList />} title={t('emptyTitle')} description={t('emptyDescription')} action={newButton} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {templates.map((template) => (
            <li key={template.id}>
              <Link
                href={`/admin/setup/review-templates/${template.id}`}
                className="block h-full rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-600"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300">
                      <ClipboardList size={16} />
                    </span>
                    <span className="truncate font-semibold text-slate-900 dark:text-slate-100">{template.name}</span>
                  </span>
                  {template.isActive ? null : <Badge variant="secondary">{tb('inactive')}</Badge>}
                </div>
                <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                  {t('cardSummary', { sections: template.sectionCount, questions: template.questionCount })}
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {t('scaleSummary', { min: template.scaleMin, max: template.scaleMax })}
                  {template.cycleCount > 0 ? ` · ${t('cycleCount', { count: template.cycleCount })}` : ''}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

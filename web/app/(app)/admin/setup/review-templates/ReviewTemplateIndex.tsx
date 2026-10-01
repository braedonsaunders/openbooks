'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ClipboardList, Plus } from 'lucide-react'
import { Badge, Button, EmptyState, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../../components/page-layout'
import { ReviewTemplateCreateForm } from './ReviewTemplateCreateForm'

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

/** One native form catalog and builder, reachable from Setup and Performance. */
export function ReviewTemplateIndex({ templates, basePath = '/admin/setup/review-templates', creating = false }: { templates: ReviewTemplateCard[]; basePath?: string; creating?: boolean }) {
  const t = useTranslations('admin.setup.reviewBuilder')
  const tb = useTranslations('admin.setup.builder')
  const th = useTranslations('hrm')
  const inPerformance = basePath === '/hrm/performance/templates'

  const newButton = (
    <Button asChild><Link href={`${basePath}?template=new`}><Plus size={15} /> {inPerformance ? th('performance.workspace.newReviewForm') : t('newTemplate')}</Link></Button>
  )

  const header = <PageHeader title={inPerformance ? th('performance.workspace.reviewFormsTab') : t('title')} description={t('description')} actions={newButton} />
  const content = (
    <div className="space-y-5">
      {creating ? <ReviewTemplateCreateForm basePath={basePath} /> : null}
      {templates.length === 0 ? (
        <EmptyState icon={<ClipboardList />} title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {templates.map((template) => (
            <li key={template.id}>
              <Link
                href={`${basePath}/${template.id}`}
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
  return inPerformance ? <ListPageLayout header={header}>{content}</ListPageLayout> : <div className="space-y-5">{header}{content}</div>
}

'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ChevronRight, Plus, Workflow } from 'lucide-react'
import { Badge, Button, EmptyState, cn } from '@openbooks/ui'
import { promptDialog } from '../../../../../lib/prompt'
import { createSetupRow } from '../../../../../lib/setup/builder-client'
import type { PipelineStageKind } from '../../../../../lib/setup/hrm-builder-outline'
import { STAGE_ICON, STAGE_TONE } from './PipelineBuilder'

export interface PipelineCard {
  id: string
  name: string
  isDefault: boolean
  isActive: boolean
  requisitionCount: number
  stages: { id: string; name: string; kind: PipelineStageKind }[]
}

/**
 * Hiring pipelines: the entry point to the builder. Each card shows the
 * funnel as a stage strip and opens the pipeline's own builder page; New
 * creates an empty pipeline through the shared Setup API and opens it.
 */
export function PipelineIndex({ pipelines }: { pipelines: PipelineCard[] }) {
  const t = useTranslations('admin.setup.pipelineBuilder')
  const tb = useTranslations('admin.setup.builder')
  const tc = useTranslations('common')
  const router = useRouter()

  async function create() {
    const name = await promptDialog({ title: t('newPipeline'), label: t('fields.pipelineName'), confirmLabel: tc('actions.create') })
    if (!name) return
    const result = await createSetupRow('hrm-pipeline-templates', { name, isDefault: false, isActive: true }, {
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
    router.push(`/admin/setup/hiring-pipelines/${String(result.body.id)}`)
  }

  const newButton = (
    <Button type="button" onClick={() => void create()}>
      <Plus size={15} /> {t('newPipeline')}
    </Button>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
        </div>
        {pipelines.length > 0 ? newButton : null}
      </div>
      {pipelines.length === 0 ? (
        <EmptyState icon={<Workflow />} title={t('emptyTitle')} description={t('emptyDescription')} action={newButton} />
      ) : (
        <ul className="space-y-3">
          {pipelines.map((pipeline) => (
            <li key={pipeline.id}>
              <Link
                href={`/admin/setup/hiring-pipelines/${pipeline.id}`}
                className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-600"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300">
                      <Workflow size={16} />
                    </span>
                    <span className="truncate font-semibold text-slate-900 dark:text-slate-100">{pipeline.name}</span>
                    {pipeline.isDefault ? <Badge variant="success">{t('default')}</Badge> : null}
                    {pipeline.isActive ? null : <Badge variant="secondary">{tb('inactive')}</Badge>}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {t('stageCount', { count: pipeline.stages.length })} · {t('requisitionCount', { count: pipeline.requisitionCount })}
                  </span>
                </div>
                {pipeline.stages.length > 0 ? (
                  <ol className="mt-3 flex flex-wrap items-center gap-1">
                    {pipeline.stages.map((stage, index) => {
                      const Icon = STAGE_ICON[stage.kind]
                      return (
                        <li key={stage.id} className="flex items-center gap-1">
                          {index > 0 ? <ChevronRight size={12} className="text-slate-300 dark:text-slate-600" aria-hidden /> : null}
                          <span className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', STAGE_TONE[stage.kind])}>
                            <Icon size={11} /> {stage.name}
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                ) : (
                  <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{t('issues.noStages')}</p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

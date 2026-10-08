import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { listDecisionsPage } from '@openbooks/engine/src/hrm/ai/governance.ts'
import { AI_CAPABILITIES } from '@openbooks/engine/src/hrm/ai/registry.ts'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { loadAiLedger } from '../../../../../lib/hrm/ai-rails'
import { parseListParams, pickString } from '../../../../../lib/list-params'
import { ModuleHomeTabs } from '../../../../../components/module-home/tabs'
import { ServerPagedTable } from '../../../../../components/server-paged-table'
import { ListFilterSelect } from '../../../../../components/list-filter-select'
import { AiGovernanceSection } from '../../ai/AiGovernanceSection'

export const dynamic = 'force-dynamic'
const BASE = '/admin/setup/ai-capabilities'

/** Advanced action limits and their activity replace one active Setup body. */
export default async function AssistantActionSetup({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.setup.manage')
  await requireFeatureEnabled(authz.user.orgId, 'aiGovernanceLedger')
  const sp = await searchParams
  const t = await getTranslations('admin.aiLedger')
  const activity = pickString(sp.tab) === 'activity'
  const content = activity ? await activityBody() : <AiGovernanceSection ledger={await loadAiLedger(authz)} />

  async function activityBody() {
    const params = parseListParams(sp, { sort: 'recorded', allowedSorts: ['recorded'] as const, perPage: 25 })
    const capabilityKey = pickString(sp.capabilityKey)
    const outcome = pickString(sp.outcome)
    const result = await listDecisionsPage(db, {
      orgId: authz.user.orgId, actorId: authz.user.id, capabilityKey, outcome,
      limit: params.perPage, offset: (params.page - 1) * params.perPage,
    })
    const exportParams = new URLSearchParams({ format: 'csv', page: String(params.page), perPage: String(params.perPage) })
    if (capabilityKey) exportParams.set('capabilityKey', capabilityKey)
    if (outcome) exportParams.set('outcome', outcome)
    return <ServerPagedTable source="assistant_activity" rows={result.decisions} rowKey={(row) => row.id}
      basePath={BASE} currentParams={{ ...sp, tab: 'activity' }} total={result.total} page={params.page} perPage={params.perPage}
      empty={t('activityEmpty')}
      toolbar={<>
        <ListFilterSelect basePath={BASE} currentParams={{ ...sp, tab: 'activity' }} paramKey="capabilityKey"
          label={t('columns.capability')} allLabel={t('all')}
          options={[...AI_CAPABILITIES.values()].map((cap) => ({ value: cap.key, label: cap.name }))} />
        <ListFilterSelect basePath={BASE} currentParams={{ ...sp, tab: 'activity' }} paramKey="outcome"
          label={t('columns.outcome')} allLabel={t('all')}
          options={['shown', 'accepted', 'edited', 'rejected', 'expired'].map((value) => ({ value, label: t(`outcomes.${value}`) }))} />
        <a href={`/api/admin/ai-decisions?${exportParams}`} className="text-sm font-medium text-teal-700 dark:text-teal-300">{t('exportPage')}</a>
      </>}
      columns={[
        { key: 'when', header: t('columns.when'), cell: (row) => row.recordedAt.slice(0, 16).replace('T', ' ') },
        { key: 'capability', header: t('columns.capability'), cell: (row) => AI_CAPABILITIES.get(row.capabilityKey)?.name ?? row.capabilityKey },
        { key: 'summary', header: t('columns.summary'), cell: (row) => row.outputSummary },
        { key: 'outcome', header: t('columns.outcome'), cell: (row) => ['shown', 'accepted', 'edited', 'rejected', 'expired'].includes(row.outcome) ? t(`outcomes.${row.outcome}`) : row.outcome },
        { key: 'reviewer', header: t('columns.reviewer'), cell: (row) => row.humanReviewer ?? '—' },
      ]} />
  }

  return <div className="space-y-4">
    <PageHeader title={t('title')} description={activity ? t('activityDescription') : t('description')} />
    <ModuleHomeTabs placement="local" tabs={[
      { href: BASE, label: t('capabilitiesTitle'), active: !activity },
      { href: `${BASE}?tab=activity`, label: t('decisionsTitle'), active: activity },
    ]} />
    <p className="text-sm text-slate-500 dark:text-slate-400">{t('authorityHelp')} <Link href="/admin/setup/features" className="text-teal-700 hover:underline dark:text-teal-300">{t('featuresLink')}</Link></p>
    {content}
  </div>
}

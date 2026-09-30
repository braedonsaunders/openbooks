import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { provisionEditorOptions, readProvisionObligation, ProvisionError } from '@openbooks/engine/provisions'
import { PageHeader, UrlDrawer } from '@openbooks/ui'
import { EntityListView } from '@/components/entity-list-view'
import { ListPageLayout } from '@/components/page-layout'
import { ModuleHomeTabs } from '@/components/module-home/ui'
import { groupTabs } from '@/components/module-home/group-tabs'
import { requirePermission, can } from '@/lib/authz'
import { isUuid, pickString, mergeHref } from '@/lib/list-params'
import { ChangeEvidence } from '../changes/ChangeEvidence'
import { ProvisionAssessmentButton, ProvisionAssessmentHistory } from './ProvisionAssessmentButton'

export const dynamic = 'force-dynamic'
export default async function ProvisionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requirePermission('gl.read'), sp = await searchParams, t = await getTranslations('accounting.provisions')
  const canManage = can(auth, 'gl.manage'), selected = pickString(sp.provision)
  if (selected && !isUuid(selected)) notFound()
  const [tabs, editor, detail] = await Promise.all([
    groupTabs('accounting', '/accounting/provisions', { orgId: auth.user.orgId }),
    canManage ? provisionEditorOptions(auth.user.orgId, auth.user.id).then(options => ({ options, error: null })).catch(error => {
      if (error instanceof ProvisionError) return { options: null, error: error.message }
      throw error
    }) : null,
    selected ? readProvisionObligation(auth.user.orgId, auth.user.id, selected).catch(error => {
      if (error instanceof Error && 'status' in error && error.status === 404) notFound()
      throw error
    }) : null,
  ])
  const options = editor?.options
  return <ListPageLayout header={<PageHeader title={t('title')} description={t('description')}
    actions={<>{options ? <ProvisionAssessmentButton options={options} /> : null}<ModuleHomeTabs tabs={tabs} /></>} />}>
    {editor?.error ? <p role="alert" className="text-sm text-red-600">{editor.error}</p> : null}
    <EntityListView recordType="provision_obligation" orgId={auth.user.orgId} userId={auth.user.id}
      canManage={false} sp={sp} emptyTitle={t('empty')} drawer={detail ? <UrlDrawer open title={detail.identity.name}
        closeHref={mergeHref('/accounting/provisions', sp, { provision: undefined, drawerReturn: undefined })} size="2xl">
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">{t('reviewHint')}</p>
          {options ? <ProvisionAssessmentButton options={options} identity={detail.identity} /> : null}
          <ChangeEvidence value={detail.identity} />
          <ProvisionAssessmentHistory assessments={detail.assessments} />
        </div>
      </UrlDrawer> : undefined} />
  </ListPageLayout>
}

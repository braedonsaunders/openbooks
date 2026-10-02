import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getChecklistDesigner } from '@openbooks/engine/hrm/processes'
import { Button, PageHeader } from '@openbooks/ui'
import { Plus } from 'lucide-react'
import { ListPageLayout } from '../../../../../components/page-layout'
import { EntityListView } from '../../../../../components/entity-list-view'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { isUuid, pickString, mergeHref } from '../../../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { loadRefOptions, loadEntityOptions } from '../../../../../lib/setup/ref-options'
import { ProcessTemplateDrawer } from './ProcessTemplateDrawer'

export const dynamic = 'force-dynamic'

export default async function ProcessTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const authz = await requirePermission('hrm.process.manage')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  const [t, templateRefs, stepRefs, employments] = await Promise.all([
    getTranslations('hrm.processes.templates'),
    loadRefOptions(SETUP_ENTITY_BY_KEY.get('hrm-process-templates')!, authz.user.orgId, authz.allowedSubsidiaryIds),
    loadRefOptions(SETUP_ENTITY_BY_KEY.get('hrm-process-template-steps')!, authz.user.orgId, authz.allowedSubsidiaryIds),
    loadEntityOptions('worker-employments',authz.user.orgId,authz.allowedSubsidiaryIds),
  ])
  const selected = pickString(sp.template)
  const creating = selected === 'new'
  if (selected && !creating && !isUuid(selected)) notFound()
  const detail = selected && !creating
    ? await getChecklistDesigner({ orgId: authz.user.orgId, actorId: authz.user.id, templateId: selected })
    : null

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={
            <>
              <Button asChild><Link href={mergeHref('/hrm/processes/templates', sp, { template: 'new' }) as never}><Plus size={15} /> {t('newTemplate')}</Link></Button>
            </>
          }
        />
      }
    >
      <EntityListView
        recordType="hrm_process_template"
        orgId={authz.user.orgId} userId={authz.user.id} canManage sp={sp}
        emptyTitle={t('empty')}
        formatValue={(_row, key, value) => key === 'kind' ? t(`kinds.${String(value)}`)
          : key === 'status' ? t(`statuses.${String(value)}`) : key === 'scope' ? t(value === 'limited' ? 'limitedScope' : 'allEmployees') : undefined}
      />
      {selected ? (
        <ProcessTemplateDrawer
          key={selected}
          creating={creating}
          template={detail}
          closeHref={mergeHref('/hrm/processes/templates', sp, { template: undefined })}
          subsidiaries={templateRefs.subsidiaries ?? []}
          departments={templateRefs.departments ?? []}
          employees={stepRefs.employees ?? []}
          employments={employments}
        />
      ) : null}
    </ListPageLayout>
  )
}

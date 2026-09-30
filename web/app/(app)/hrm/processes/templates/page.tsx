import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getProcessTemplate } from '@openbooks/engine/src/hrm/processes.ts'
import { Button, PageHeader } from '@openbooks/ui'
import { Plus } from 'lucide-react'
import { ListPageLayout } from '../../../../../components/page-layout'
import { ModuleHomeTabs } from '../../../../../components/module-home/ui'
import { EntityListView } from '../../../../../components/entity-list-view'
import { hrmGroupTabs } from '../../../../../components/module-home/group-tabs'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { isUuid, pickString } from '../../../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { loadRefOptions } from '../../../../../lib/setup/ref-options'
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
  const [t, tabs, templateRefs, stepRefs] = await Promise.all([
    getTranslations('hrm.processes.templates'),
    hrmGroupTabs(authz, '/hrm/processes'),
    loadRefOptions(SETUP_ENTITY_BY_KEY.get('hrm-process-templates')!, authz.user.orgId, authz.allowedSubsidiaryIds),
    loadRefOptions(SETUP_ENTITY_BY_KEY.get('hrm-process-template-steps')!, authz.user.orgId, authz.allowedSubsidiaryIds),
  ])
  const selected = pickString(sp.template)
  const creating = selected === 'new'
  if (selected && !creating && !isUuid(selected)) notFound()
  const detail = selected && !creating
    ? await getProcessTemplate({ orgId: authz.user.orgId, actorId: authz.user.id, templateId: selected })
    : null

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={
            <>
              <Button asChild><Link href="/hrm/processes/templates?template=new"><Plus size={15} /> {t('newTemplate')}</Link></Button>
              <ModuleHomeTabs tabs={tabs} />
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
          : key === 'scope' ? t(value === 'limited' ? 'limitedScope' : 'allEmployees') : undefined}
      />
      <div><Button asChild variant="outline"><Link href="/hrm/processes">{t('backToChecklists')}</Link></Button></div>
      {selected ? (
        <ProcessTemplateDrawer
          key={selected}
          creating={creating}
          template={detail}
          closeHref="/hrm/processes/templates"
          subsidiaries={templateRefs.subsidiaries ?? []}
          departments={templateRefs.departments ?? []}
          employees={stepRefs.employees ?? []}
        />
      ) : null}
    </ListPageLayout>
  )
}

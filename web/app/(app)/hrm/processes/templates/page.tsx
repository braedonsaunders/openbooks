import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getProcessTemplate, listProcessTemplates } from '@openbooks/engine/src/hrm/processes.ts'
import { Badge, Button, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { Plus } from 'lucide-react'
import { ListPageLayout } from '../../../../../components/page-layout'
import { ModuleHomeTabs } from '../../../../../components/module-home/ui'
import { SearchInput } from '../../../../../components/search-input'
import { hrmGroupTabs } from '../../../../../components/module-home/group-tabs'
import { hrmPeopleViewTabs } from '../../../../../lib/hrm/workspace-tabs'
import { requirePermission } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'
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
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  const [t, tc, templates, tabs, peopleTabs, templateRefs, stepRefs] = await Promise.all([
    getTranslations('hrm.processes.templates'),
    getTranslations('common'),
    listProcessTemplates({ orgId: authz.user.orgId, actorId: authz.user.id }),
    hrmGroupTabs(authz, '/hrm/processes'),
    hrmPeopleViewTabs(authz, '/hrm/processes/templates'),
    loadRefOptions(SETUP_ENTITY_BY_KEY.get('hrm-process-templates')!, authz.user.orgId, authz.allowedSubsidiaryIds),
    loadRefOptions(SETUP_ENTITY_BY_KEY.get('hrm-process-template-steps')!, authz.user.orgId, authz.allowedSubsidiaryIds),
  ])
  const query = (pickString(sp.q) ?? '').trim().toLowerCase()
  const rows = query
    ? templates.filter((template) => `${template.name} ${template.kind}`.toLowerCase().includes(query))
    : templates
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
      <div className="flex h-full min-h-0 flex-col gap-4">
        <ModuleHomeTabs tabs={peopleTabs} />
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput placeholder={t('search')} />
          <Button asChild variant="outline"><Link href="/hrm/processes">{t('backToChecklists')}</Link></Button>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('name')}</TableHead>
                <TableHead>{t('kind')}</TableHead>
                <TableHead>{t('scope')}</TableHead>
                <TableHead className="text-right">{t('steps')}</TableHead>
                <TableHead>{t('status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-slate-500 dark:text-slate-400">{t('empty')}</TableCell></TableRow>
              ) : null}
              {rows.map((template) => (
                <TableRow key={template.id}>
                  <TableCell>
                    <Link href={`/hrm/processes/templates?template=${template.id}`} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                      {template.name}
                    </Link>
                  </TableCell>
                  <TableCell>{t(`kinds.${template.kind}`)}</TableCell>
                  <TableCell>{template.appliesTo.departmentId || template.appliesTo.employerSubsidiaryId ? t('limitedScope') : t('allEmployees')}</TableCell>
                  <TableCell className="text-right tabular-nums">{template.stepCount}</TableCell>
                  <TableCell><Badge variant={template.isActive ? 'success' : 'outline'}>{template.isActive ? t('active') : t('retired')}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
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

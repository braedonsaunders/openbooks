import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import Link from 'next/link'
import { PageHeader } from '@openbooks/ui'
import { requireProjectsFeature } from '../../../lib/projects-gate'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, pickString } from '../../../lib/list-params'
import { subsidiaryUiOptions } from '../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { loadProject } from '../../api/projects/_lib'
import { loadProjectCockpit } from './_cockpit-data'
import { NewProjectButton } from './NewProjectButton'
import { NewProjectRedirect } from './NewProjectRedirect'
import { ProjectDrawer } from './ProjectDrawer'

export const dynamic = 'force-dynamic'

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('projects')

  const authz = await requirePermission('projects.read')
  const canManage = can(authz, 'projects.manage')
  const orgId = authz.user.orgId
  await requireProjectsFeature(orgId)
  const canViewApplications = can(authz, 'ar.read')

  const sp = await searchParams
  const projectId = typeof sp.project === 'string' ? sp.project : undefined

  const openProject =
    projectId && projectId !== 'new' && isUuid(projectId) ? await loadProject(projectId, orgId) : null

  // party pickers + resolved form layout + cockpit data for the flyout
  // (only when a project is open).
  const [parties, subsidiaries, cockpit, projectTypesRes] = openProject
    ? await Promise.all([
        db.execute(sql`
          select id, display_name from parties
           where org_id = ${orgId} and is_active
           order by display_name limit 2000`) as any,
        subsidiaryUiOptions(orgId),
        loadProjectCockpit(orgId, openProject.project.id as string),
        db.execute(sql`
          select id, name, billing_method as "billingMethod",
                 coalesce(invoicing_profile->>'billingProcedure', 'standard') as "billingProcedure"
            from project_types where org_id = ${orgId} and is_active order by sort_order, name`) as any,
      ])
    : [null, [], null, null]
  const projectTypes = (projectTypesRes?.rows ?? []) as { id: string; name: string; billingMethod: string | null; billingProcedure: string }[]

  const resolvedForm = openProject
    ? await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: 'project',
        userRoles: [authz.user.role],
        headerDefs: await loadFieldDefs('projects'),
        lineDefs: [],
        explicitLayoutId: pickString(sp.form),
      })
    : null

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('list.title')}
          description={t('list.description')}
          actions={
            <div className="flex items-center gap-2">
              {canViewApplications && (
                <Link
                  href={(openProject ? `/construction?projectId=${openProject.project.id}` : '/construction') as never}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Applications for Payment
                </Link>
              )}
              {canManage ? <NewProjectButton /> : null}
            </div>
          }
        />
      }
    >
      <EntityListView
        recordType="project"
        orgId={orgId}
        userId={authz.user.id}
        canManage={canManage}
        sp={sp}
        emptyAction={canManage ? <NewProjectButton /> : undefined}
        drawer={
          <>
            {projectId === 'new' && canManage ? <NewProjectRedirect /> : null}
            {openProject && parties && cockpit ? (
              <ProjectDrawer
                key={String(openProject.project.id)}
                payload={openProject as any}
                parties={parties.rows}
                subsidiaries={subsidiaries}
                canManage={canManage}
                layout={resolvedForm?.layout}
                cockpit={cockpit}
                projectTypes={projectTypes}
              />
            ) : null}
          </>
        }
      />
    </ListPageLayout>
  )
}

import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { requireProjectsFeature } from '../../../lib/projects-gate'
import { isFeatureEnabled } from '../../../lib/features'
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
import { RelatedTransactionDrawer } from '../../../components/related-transaction-drawer'

export const dynamic = 'force-dynamic'

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('projects')

  const authz = await requirePermission('projects.read')
  const canManage = can(authz, 'projects.manage')
  const canViewGl = can(authz, 'gl.read')
  const orgId = authz.user.orgId
  await requireProjectsFeature(orgId)
  const applicationPermissions = {
    canRead: can(authz, 'ar.read'),
    canCreate: can(authz, 'ar.create'),
    canApprove: can(authz, 'ar.approve'),
    canInvoice: can(authz, 'ar.post'),
  }

  const sp = await searchParams
  const projectId = typeof sp.project === 'string' ? sp.project : undefined
  const projectTransactionId = pickString(sp.projectTxn)
  const projectTransactionKind = pickString(sp.projectTxnKind)

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
        loadProjectCockpit(orgId, openProject.project.id as string, {
          includeApplicationBilling: applicationPermissions.canRead,
        }),
        db.execute(sql`
          select id, name, billing_method as "billingMethod",
                 invoicing_profile->>'billingProcedure' as "billingProcedure"
            from project_types where org_id = ${orgId} and is_active order by sort_order, name`) as any,
      ])
    : [null, [], null, null]
  const projectTypes = (projectTypesRes?.rows ?? []) as { id: string; name: string; billingMethod: string | null; billingProcedure: string }[]

  // The Schedule tab is a Projects sub-capability: resolved on the server so a
  // client-side layout choice can never surface a gated feature.
  const [schedulingEnabled, locale] = await Promise.all([
    isFeatureEnabled(orgId, 'projectScheduling'),
    getLocale(),
  ])

  const resolvedForm = openProject
    ? await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: 'project',
        userRoles: (authz.user as any).roles?.map(({ key }: { key: string }) => key) ?? [authz.user.role],
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
          actions={canManage ? <NewProjectButton /> : null}
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
                canViewGl={canViewGl}
                layout={resolvedForm?.layout}
                cockpit={cockpit}
                projectTypes={projectTypes}
                schedulingEnabled={schedulingEnabled}
                locale={locale}
                initialTab={pickString(sp.projectTab) ?? 'overview'}
                applicationPermissions={applicationPermissions}
              />
            ) : null}
            {openProject && projectTransactionId && isUuid(projectTransactionId) && projectTransactionKind ? (
              <RelatedTransactionDrawer
                id={projectTransactionId}
                kind={projectTransactionKind}
                projectId={String(openProject.project.id)}
                authz={authz}
                formLayoutId={pickString(sp.form)}
              />
            ) : null}
          </>
        }
      />
    </ListPageLayout>
  )
}

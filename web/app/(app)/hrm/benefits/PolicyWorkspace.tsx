import 'server-only'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { NavigationPicker } from '../../../../components/module-home/navigation-picker'
import { NewSetupButton } from '../../admin/setup/[entity]/SetupDrawer'
import { getTranslations } from 'next-intl/server'
import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'
import { SETUP_ENTITY_BY_KEY } from '../../../../lib/setup/registry'
import { requirePermission, can } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { notFound } from 'next/navigation'

const policies = { entitlements: 'entitlement-plans', vacation: 'payroll-vacation-terms', service: 'payroll-service-credits' } as const

/** Benefits owns policy configuration; payroll consumes these same native effective records. */
export async function PolicyWorkspace({ sp }: { sp: Record<string, string | undefined> }) {
  const authz = await requirePermission('hrm.benefits.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  await requireFeatureEnabled(authz.user.orgId, 'payroll')
  const policy = sp.policy ?? 'entitlements'
  if (!Object.hasOwn(policies, policy)) notFound()
  if (sp.employment && !isUuid(sp.employment)) notFound()
  const entity = SETUP_ENTITY_BY_KEY.get(policies[policy as keyof typeof policies])!
  const t = await getTranslations('hrm.benefitPolicies')
  const admin = await getTranslations('admin.setup')
  return <ListPageLayout header={<PageHeader title={t(policy)} description={t('description')} actions={can(authz, 'hrm.benefits.manage') ? <NewSetupButton entityKey={entity.key} label={admin('new')} basePath="/hrm/benefits" /> : undefined} />}>
    <div className="space-y-4">
      <NavigationPicker label={t('title')} value={policy} options={Object.keys(policies).map(key => ({ key, label: t(key), href: `/hrm/benefits?view=policies&policy=${key}${sp.employment ? `&employment=${encodeURIComponent(sp.employment)}` : ''}` }))} />
      <SetupEntitySection entity={entity} orgId={authz.user.orgId} actorId={authz.user.id} searchParams={sp} basePath="/hrm/benefits" hideHeader
        canManage={can(authz, 'hrm.benefits.manage')} allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
        mutationBasePath="/api/hrm/benefit-plan-configuration"
        fixedFilter={policy !== 'entitlements' && sp.employment ? { fieldKey: 'employmentId', value: sp.employment } : undefined}
      />
    </div>
  </ListPageLayout>
}

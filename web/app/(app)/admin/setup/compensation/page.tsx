import { getTranslations } from 'next-intl/server'
import { field, frame, grid, page, pageHeader, widgetBlock } from '@braedonsaunders/appkit-viewspec'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { loadCompensationSettingsBlock } from '../../../../../lib/hrm/compensation'

export const dynamic = 'force-dynamic'

/** Company-wide compensation policy has one editable home in Company Setup.
 * The existing domain command owns validation, authorization and audit history. */
export default async function CompensationSetupPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('hrm.compensation.manage')
  await requireFeatureEnabled(authz.user.orgId, 'hrmCompensation')
  const t = await getTranslations('hrm')
  const settings = await loadCompensationSettingsBlock(
    authz.user.orgId, authz.allowedSubsidiaryIds === null, t,
  )
  const data = {
    title: t('compensation.settings.title'),
    description: t('compensation.workspace.settingsDescription'),
    settings,
    refusal: settings?.refusal ?? (!settings ? t('compensation.workspace.unrestrictedSettingsRequired') : null),
  }
  const spec = page({
    route: '/admin/setup/compensation', layout: 'bare',
    body: [grid('space-y-6', [
      pageHeader({ title: field('title'), description: field('description') }),
      widgetBlock('empty-state', { title: field('title'), description: field('refusal') }, field('refusal')),
      ...(settings ? [frame('card', [grid('p-6', [widgetBlock('hrm-comp-settings', { settings: field('settings') })])])] : []),
    ])],
  })
  return <ModuleView spec={spec} data={data} searchParams={await searchParams} trusted />
}

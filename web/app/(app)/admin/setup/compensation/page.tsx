import { getTranslations } from 'next-intl/server'
import { Card, CardContent, EmptyState, PageHeader } from '@openbooks/ui'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { loadCompensationSettingsBlock } from '../../../../../lib/hrm/compensation'
import { CompensationSettingsForm } from '../../../hrm/compensation/islands'

export const dynamic = 'force-dynamic'

/** Company-wide compensation policy has one editable home in Company Setup.
 * The existing domain command owns validation, authorization and audit history. */
export default async function CompensationSetupPage() {
  const authz = await requirePermission('hrm.compensation.manage')
  await requireFeatureEnabled(authz.user.orgId, 'hrmCompensation')
  const t = await getTranslations('hrm')
  const settings = await loadCompensationSettingsBlock(
    authz.user.orgId, authz.allowedSubsidiaryIds === null, t,
  )
  return (
    <div className="space-y-6">
      <PageHeader title={t('compensation.settings.title')}
        description={t('compensation.workspace.settingsDescription')} />
      {!settings ? <EmptyState title={t('compensation.settings.title')}
        description={t('compensation.workspace.unrestrictedSettingsRequired')} /> : (
        <>
          {settings.refusal ? <EmptyState title={settings.title} description={settings.refusal} /> : null}
          <Card><CardContent className="pt-6">
            <CompensationSettingsForm
              labels={{ failed: settings.failed, submit: settings.submit, cancel: settings.cancel }}
              initial={settings.initial}
              attributeLabel={settings.attributeLabel}
              attributeOptions={settings.attributeOptions}
              thresholdLabel={settings.thresholdLabel}
              responseDaysLabel={settings.responseDaysLabel}
              roundingLabel={settings.roundingLabel}
              roundingOptions={settings.roundingOptions}
              burdenLabel={settings.burdenLabel}
            />
          </CardContent></Card>
        </>
      )}
    </div>
  )
}

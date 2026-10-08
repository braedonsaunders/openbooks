import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { SetupEntitySection } from '../[entity]/SetupEntitySection'
import { can, requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { suggestInternalBillingAccounts } from '../../../../../lib/internal-billing'
import { pickString } from '../../../../../lib/list-params'
import { INTERNAL_BILLING_RULES_ENTITY, internalBillingCreateChooser } from '../../../../../lib/setup/entities/internal-billing'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.setup.entities.internal-billing')
  return { title: t('title') }
}

/**
 * Company Settings → Internal billing. The shared setup list and drawer over
 * the rule versions; creating one starts on three plain-language cards that
 * pre-select the organization's suggested accounts, with accounts, dates and
 * the billable default under Advanced.
 */
export default async function InternalBillingSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'internalBilling')
  const creating = pickString(sp.row) === 'new'
  const entity = {
    ...INTERNAL_BILLING_RULES_ENTITY,
    // Activity is a property of a saved version; a new one starts active.
    fields: creating ? INTERNAL_BILLING_RULES_ENTITY.fields.filter((field) => field.key !== 'isActive') : INTERNAL_BILLING_RULES_ENTITY.fields,
    createChooser: creating
      ? internalBillingCreateChooser(await businessToday(orgId), await suggestInternalBillingAccounts(orgId))
      : undefined,
  }
  return (
    <SetupEntitySection
      entity={entity}
      orgId={orgId}
      actorId={authz.user.id}
      searchParams={sp}
      basePath="/admin/setup/internal-billing"
      canManage={can(authz, 'admin.setup.manage')}
      allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
    />
  )
}

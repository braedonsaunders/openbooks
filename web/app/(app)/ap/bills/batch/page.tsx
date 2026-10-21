import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { can, requirePermission } from '../../../../../lib/authz'
import { orgInfo } from '../../../../../lib/data'
import { DOC_KINDS, createPermission, postPermission } from '../../../../../lib/document-kinds'
import { accountOptions, isDocKindEnabled, partyOptions, taxCodeOptions, taxGroupOptions } from '../../../../../lib/documents'
import { currencyMinorUnits } from '../../../../../lib/iso-currencies'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../../../lib/subsidiaries'
import { BatchBillEntry, type BatchTaxProfile } from './BatchBillEntry'

export const dynamic = 'force-dynamic'

const BATCH_BILL_KIND = 'vendor_bill'

export async function generateMetadata() {
  const t = await getTranslations('batchEntry')
  return { title: t('title') }
}

/**
 * Batch bill entry: many vendor bills keyed on one grid. The page needs the
 * same create permission as a single bill; posting needs the post permission,
 * and both are enforced again by the endpoints each row saves through. The
 * pickers are the bill drawer's own, scoped to the caller's subsidiaries.
 */
export default async function BatchBillEntryPage() {
  const authz = await requirePermission(createPermission(BATCH_BILL_KIND))
  const orgId = authz.user.orgId
  if (!(await isDocKindEnabled(orgId, BATCH_BILL_KIND))) notFound()
  const scope = authz.allowedSubsidiaryIds
  const [org, today, vendors, accounts, taxCodes, taxGroups, multiSubsidiary] = await Promise.all([
    orgInfo(orgId),
    businessToday(orgId),
    partyOptions('vendor', orgId, scope),
    accountOptions(DOC_KINDS[BATCH_BILL_KIND]!, orgId, scope),
    taxCodeOptions(orgId),
    taxGroupOptions(orgId),
    isMultiSubsidiary(orgId),
  ])
  if (!org?.base_currency) throw new Error('Organization base currency is not configured')
  const subsidiaries = multiSubsidiary
    ? (await subsidiaryOptions(false, false, orgId))
        .filter((option) => !scope || scope.has(option.id))
        .map((option) => ({ id: option.id, name: option.name }))
    : null
  const taxProfiles: BatchTaxProfile[] = [
    ...taxCodes.map((code) => ({ value: `code:${code.id}`, label: code.code ?? code.name ?? '', components: code.tax_components ?? [] })),
    ...taxGroups.map((group) => ({ value: `group:${group.id}`, label: group.code ?? group.name ?? '', components: group.tax_components ?? [] })),
  ]
  return (
    <BatchBillEntry
      orgId={orgId}
      userId={authz.user.id}
      today={today}
      minorUnits={currencyMinorUnits(org.base_currency)}
      vendors={vendors.map((vendor) => ({ id: vendor.id, display_name: vendor.display_name ?? '', short_code: vendor.short_code ?? null }))}
      accounts={accounts.map((account) => ({ id: account.id, number: account.number ?? null, name: account.name ?? '' }))}
      taxProfiles={taxProfiles}
      subsidiaries={subsidiaries && subsidiaries.length > 0 ? subsidiaries : null}
      defaultSubsidiaryId={subsidiaries?.[0]?.id ?? null}
      canPost={can(authz, postPermission(BATCH_BILL_KIND))}
      canCreateVendor={can(authz, 'parties.manage')}
      helpHref="/docs/batch-bill-entry"
    />
  )
}

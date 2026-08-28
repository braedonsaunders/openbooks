import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { NewDocumentButton } from '../../../components/new-document-button'
import { requirePermission, can } from '../../../lib/authz'
import { analyticsConfig } from '../../../lib/analytics/config'
import { normalizeMoneyValue, withoutWeekEntries } from '../../../lib/cash/core'
import { arPosition } from '../../../lib/cash/ar-position'
import { ArCockpit } from './cockpit/ArCockpit'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ar')
  return { title: t('cockpit.title') }
}

/**
 * Accounts Receivable — the receivables control center (vitals + collections
 * worklist + aging), the AP page's mirror. The invoice list is its own
 * first-class route at /ar/invoices.
 */
export default async function AR() {
  const authz = await requirePermission('ar.read')
  const canCreate = can(authz, 'ar.create')
  const t = await getTranslations('ar')
  const tCommon = await getTranslations('common')

  const newButton = canCreate ? (
    <NewDocumentButton
      items={[
        { kind: 'customer_invoice', label: t('actions.newInvoice') },
        { kind: 'customer_credit', label: t('actions.newCredit') },
      ]}
      basePath="/ar/invoices"
      triggerLabel={t('actions.new')}
      creatingLabel={tCommon('actions.creating')}
      failedLabel={t('toasts.createDraftFailed')}
    />
  ) : undefined

  const tabs = <ModuleHomeTabs tabs={await groupTabs('customers', '/ar', { orgId: authz.user.orgId })} />

  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: normalizeMoneyValue(String(cfg.weeklyApCap ?? 0)), restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  const position = await arPosition(authz.user.orgId, 4, apSettings)
  // The schedule bars need each week's label and amount; the week drill
  // fetches the week a reader actually opens from /api/cash/week-entries.
  // Shipping every week's transactions as well repeated the whole open-item
  // book across the horizon.
  const data = {
    ...position,
    weeks: position.weeks.map((w) => ({ ...w, entries: [] })),
    timeline: withoutWeekEntries(position.timeline),
    // Project to the columns the worklist renders. The cockpit is a client
    // component, so mapping there still sent every field across the wire —
    // including five the list never shows.
    worklist: position.worklist.map((e) => ({
      id: e.id,
      docId: e.docId,
      docKind: e.docKind,
      partyName: e.partyName,
      amount: e.amount,
      dueDate: e.dueDate,
      predictedDate: e.predictedDate,
      daysOverdue: e.daysOverdue,
      method: e.method,
    })),
  }

  return (
    <ListPageLayout
      className="flex h-full min-h-0 flex-col"
      header={
        <PageHeader
          title={t('cockpit.title')}
          description={t('cockpit.description')}
          actions={<div className="flex items-center gap-3">{newButton}{tabs}</div>}
        />
      }
    >
      <ArCockpit data={data} canCollect={can(authz, 'ar.pay')} />
    </ListPageLayout>
  )
}

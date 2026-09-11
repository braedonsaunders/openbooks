import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadArInvoices, arInvoicesSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ar')
  return { title: t('list.title') }
}

/**
 * Customer invoices + credits — the AR document list, a first-class route
 * beside the /ar cockpit (both are one tab-click apart). The list is the
 * universal RecordListView; this page owns the header, the New button, and
 * the ?doc= flyout with its form-layout resolution.
 */
export default async function ArInvoices({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadArInvoices(sp)
  return <ModuleView spec={arInvoicesSpec(data)} data={data} searchParams={sp} trusted />
}

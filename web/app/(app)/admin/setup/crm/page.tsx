import { redirect } from "next/navigation"
import { ModuleView } from "../../../../../components/viewspec/module-view"
import { CRM_SETUP_PAGES, crmSetupHref } from "../../../../../lib/setup/rail"
import { crmSetupSpec, loadCrmSetup } from "./view"

export const dynamic = "force-dynamic";


export default async function CrmSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams
  const salesTab=Array.isArray(sp.tab)?sp.tab[0]:sp.tab
  if (salesTab&&['teams','quotas','territories'].includes(salesTab)) redirect(`/crm/sales/${salesTab}`)
  // Each CRM list is its own Setup page; an address without one opens the first.
  if (!CRM_SETUP_PAGES.some((page) => page.tab === salesTab)) redirect(crmSetupHref(CRM_SETUP_PAGES[0].tab))
  const data = await loadCrmSetup(sp)
  return <ModuleView spec={crmSetupSpec(data)} data={data} searchParams={sp} trusted />
}

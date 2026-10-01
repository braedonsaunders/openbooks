import { redirect } from "next/navigation"
import { ModuleView } from "../../../../../components/viewspec/module-view"
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
  const data = await loadCrmSetup(sp)
  return <ModuleView spec={crmSetupSpec(data)} data={data} searchParams={sp} trusted />
}

import { ModuleView } from "../../../../../components/viewspec/module-view"
import { crmSetupSpec, loadCrmSetup } from "./view"

export const dynamic = "force-dynamic";


export default async function CrmSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams
  const data = await loadCrmSetup(sp)
  return <ModuleView spec={crmSetupSpec(data)} data={data} searchParams={sp} trusted />
}

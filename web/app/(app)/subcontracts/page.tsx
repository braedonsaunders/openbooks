import { ModuleView } from "../../../components/viewspec/module-view"
import { loadSubcontracts, subcontractsSpec } from "./view"

export const dynamic = "force-dynamic";

export default async function SubcontractsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams
  const data = await loadSubcontracts(sp)
  return <ModuleView spec={subcontractsSpec(data)} data={data} searchParams={sp} trusted />
}

import { ModuleView } from "../../../components/viewspec/module-view"
import { loadPropertyManagement, propertyManagementSpec } from "./view"

export const dynamic = "force-dynamic";

export default async function PropertyManagementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams
  const data = await loadPropertyManagement(sp)
  return <ModuleView spec={propertyManagementSpec(data)} data={data} searchParams={sp} trusted />
}

import { ModuleView } from "../../../../components/viewspec/module-view"
import { loadSecurity, securitySpec } from "./view"

export const dynamic = "force-dynamic";

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams
  const data = await loadSecurity(sp)
  return <ModuleView spec={securitySpec(data)} data={data} searchParams={sp} trusted />
}

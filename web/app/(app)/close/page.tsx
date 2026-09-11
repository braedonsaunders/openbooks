import { ModuleView } from "../../../components/viewspec/module-view"
import { loadClose, closeSpec } from "./view"

export const dynamic = "force-dynamic";


export default async function PeriodClose({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams
  const data = await loadClose(sp)
  return <ModuleView spec={closeSpec(data)} data={data} searchParams={sp} trusted />
}

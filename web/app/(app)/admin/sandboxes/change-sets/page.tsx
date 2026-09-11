import { ModuleView } from "../../../../../components/viewspec/module-view"
import { changeSetsSpec, loadChangeSets } from "./view"

export const dynamic = "force-dynamic";
export default async function ChangeSetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const data = await loadChangeSets(sp);
  return <ModuleView spec={changeSetsSpec(data)} data={data} searchParams={sp} trusted />;
}

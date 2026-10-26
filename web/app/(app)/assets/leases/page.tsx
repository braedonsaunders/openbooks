import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadLeasesPage, leasesSpec } from "./view";

export const dynamic = "force-dynamic";

export default async function LeasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadLeasesPage(sp);
  return <ModuleView spec={leasesSpec(data)} data={data} searchParams={sp} trusted />;
}

import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadNonprofitSetup, nonprofitSetupSpec } from "./view";

export const dynamic = "force-dynamic";

export default async function NonprofitSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadNonprofitSetup(sp);
  return <ModuleView spec={nonprofitSetupSpec(data)} data={data} searchParams={sp} trusted />;
}

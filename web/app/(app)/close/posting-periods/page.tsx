import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadPostingPeriods, postingPeriodsSpec } from "./view";

export const dynamic = "force-dynamic";

export default async function PostingPeriodsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadPostingPeriods(sp);
  return <ModuleView spec={postingPeriodsSpec(data)} data={data} searchParams={sp} trusted />;
}

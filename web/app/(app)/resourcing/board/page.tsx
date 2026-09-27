import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadResourcingBoardPage, resourcingBoardSpec } from "./view";

export const dynamic = "force-dynamic";

export default async function ResourcingBoard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadResourcingBoardPage(sp);
  return <ModuleView spec={resourcingBoardSpec(data)} data={data} searchParams={sp} trusted />;
}

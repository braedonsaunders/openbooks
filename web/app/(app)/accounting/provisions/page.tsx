import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadProvisions, provisionsSpec } from "./view";

export const dynamic = "force-dynamic";

export default async function ProvisionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadProvisions(sp);
  return <ModuleView spec={provisionsSpec(data)} data={data} searchParams={sp} trusted />;
}

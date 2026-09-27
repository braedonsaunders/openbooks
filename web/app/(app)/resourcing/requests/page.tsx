import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadResourceRequestsPage, resourceRequestsSpec } from "./view";

export const dynamic = "force-dynamic";

export default async function ResourceRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadResourceRequestsPage(sp);
  return <ModuleView spec={resourceRequestsSpec(data)} data={data} searchParams={sp} trusted />;
}

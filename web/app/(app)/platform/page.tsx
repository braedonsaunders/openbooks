import { ModuleView } from "../../../components/viewspec/module-view"
import { loadPlatformHub, platformHubSpec } from "./view"

export const dynamic = "force-dynamic";


export default async function PlatformPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const sp = (await searchParams) ?? {};
  const data = await loadPlatformHub();
  return <ModuleView spec={platformHubSpec(data)} data={data} searchParams={sp} trusted />;
}

import { ModuleView } from "../../../components/viewspec/module-view";
import { loadChannelsHome, channelsHomeSpec } from "./view";

export const dynamic = "force-dynamic";

/**
 * Channels home — the storefront-connections cockpit. Channel cards, stat
 * tiles and the needs-attention queue are loaded in the tenant-scoped server
 * view, with subsidiary restrictions applied before each figure is rendered.
 */
export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadChannelsHome();
  return <ModuleView spec={channelsHomeSpec(data)} data={data} searchParams={sp} trusted />;
}

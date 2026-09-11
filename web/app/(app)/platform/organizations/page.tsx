import { ModuleView } from "../../../../components/viewspec/module-view"
import { loadPlatformOrganizations, platformOrganizationsSpec } from "./view"

export const dynamic = "force-dynamic";


export default async function PlatformOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadPlatformOrganizations(sp);
  return <ModuleView spec={platformOrganizationsSpec(data)} data={data} searchParams={sp} trusted />;
}

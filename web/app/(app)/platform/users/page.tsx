import { ModuleView } from "../../../../components/viewspec/module-view"
import { loadPlatformUsers, platformUsersSpec } from "./view"

export const dynamic = "force-dynamic";



export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadPlatformUsers(sp);
  return <ModuleView spec={platformUsersSpec(data)} data={data} searchParams={sp} trusted />;
}

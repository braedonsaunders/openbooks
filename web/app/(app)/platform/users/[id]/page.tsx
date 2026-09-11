import { ModuleView } from "../../../../../components/viewspec/module-view"
import { loadPlatformUser, platformUserSpec } from "./view"

export const dynamic = "force-dynamic";


export default async function PlatformUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const data = await loadPlatformUser(id);
  return <ModuleView spec={platformUserSpec(data)} data={data} searchParams={sp} trusted />;
}

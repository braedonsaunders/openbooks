import { ModuleView } from "../../../../components/viewspec/module-view"
import { loadAdminBackups, adminBackupsSpec } from "./view"

export const dynamic = "force-dynamic";


export default async function BackupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadAdminBackups();
  return <ModuleView spec={adminBackupsSpec(data)} data={data} searchParams={sp} trusted />;
}

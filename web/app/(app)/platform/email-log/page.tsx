import { ModuleView } from "../../../../components/viewspec/module-view"
import { loadEmailLog, emailLogSpec } from "./view"

export const dynamic = "force-dynamic";




export default async function PlatformEmailLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadEmailLog(sp);
  return <ModuleView spec={emailLogSpec(data)} data={data} searchParams={sp} trusted />;
}

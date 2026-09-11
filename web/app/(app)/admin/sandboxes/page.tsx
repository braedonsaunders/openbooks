import { ModuleView } from "../../../../components/viewspec/module-view"
import { loadSandboxes, sandboxesSpec } from "./view"

export const dynamic = "force-dynamic";

export default async function SandboxesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams
  const data = await loadSandboxes()
  return <ModuleView spec={sandboxesSpec(data)} data={data} searchParams={sp} trusted />
}

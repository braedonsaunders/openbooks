import { getTranslations } from "next-intl/server"
import { redirect } from 'next/navigation'
import { ModuleView } from "../../../components/viewspec/module-view"
import { loadCollections, collectionsSpec } from "./view"

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("nav");
  return { title: t("modules.collections") };
}

/** Operational collections and billing, with reporting owned by /reports. */
export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  if (sp.view === 'reports') redirect('/reports')
  const data = await loadCollections()
  return <ModuleView spec={collectionsSpec(data)} data={data} searchParams={sp} trusted />
}

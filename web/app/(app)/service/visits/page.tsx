import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadServiceVisits, serviceVisitsSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: (await getTranslations("service"))("pages.visits.title") };
}

/** Service visits — gated on Service dispatch and the service grants. */
export default async function ServiceVisitsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadServiceVisits(sp);
  return <ModuleView spec={serviceVisitsSpec(data)} data={data} searchParams={sp} trusted />;
}

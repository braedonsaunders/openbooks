import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadMyVisits, myVisitsSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: (await getTranslations("service"))("pages.myVisits.title") };
}

/** My visits — a technician's own service visits, built for a phone. */
export default async function MyVisitsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadMyVisits();
  return <ModuleView spec={myVisitsSpec(data)} data={data} searchParams={sp} trusted />;
}

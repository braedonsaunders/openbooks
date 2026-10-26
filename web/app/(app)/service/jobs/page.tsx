import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadServiceJobs, serviceJobsSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: (await getTranslations("service"))("pages.jobs.title") };
}

/** Service jobs — gated on Service dispatch and the service grants. */
export default async function ServiceJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadServiceJobs(sp);
  return <ModuleView spec={serviceJobsSpec(data)} data={data} searchParams={sp} trusted />;
}

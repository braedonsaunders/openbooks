import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadServiceRequests, serviceRequestsSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: (await getTranslations("service"))("pages.requests.title") };
}

/** Service requests — gated on Service dispatch and the service grants. */
export default async function ServiceRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadServiceRequests(sp);
  return <ModuleView spec={serviceRequestsSpec(data)} data={data} searchParams={sp} trusted />;
}

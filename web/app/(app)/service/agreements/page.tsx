import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadServiceAgreements, serviceAgreementsSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: (await getTranslations("service"))("pages.agreements.title") };
}

/** Service agreements — gated on Service dispatch and the service grants. */
export default async function ServiceAgreementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadServiceAgreements(sp);
  return <ModuleView spec={serviceAgreementsSpec(data)} data={data} searchParams={sp} trusted />;
}

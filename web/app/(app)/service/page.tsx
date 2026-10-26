import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../components/viewspec/module-view";
import { loadServiceHome, serviceHomeSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: (await getTranslations("service"))("pages.home.title") };
}

/** Service home — Service dispatch's landing in Operations. */
export default async function ServiceHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadServiceHome(sp);
  return <ModuleView spec={serviceHomeSpec(data)} data={data} searchParams={sp} trusted />;
}

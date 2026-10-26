import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadInformationReturns, informationReturnsSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("compliance");
  return { title: t("informationReturns.title") };
}

/** Information-return filings and readiness, selected as URL-addressed views. */
export default async function InformationReturnsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const data = await loadInformationReturns(sp);
  return <ModuleView spec={informationReturnsSpec(data)} data={data} searchParams={sp} trusted />;
}

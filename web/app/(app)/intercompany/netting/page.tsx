import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadNettingPage, nettingSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("intercompany");
  return { title: t("netting.title") };
}

/**
 * Intercompany netting and settlement runs — gated by Company Settings →
 * Features → Intercompany netting under Multi-subsidiary.
 */
export default async function IntercompanyNettingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadNettingPage(sp);
  return <ModuleView spec={nettingSpec(data)} data={data} searchParams={sp} trusted />;
}

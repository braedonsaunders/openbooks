import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadNecPreparation, necPreparationSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("reports");
  return { title: t("hub.cards.necPreparationTitle") };
}

/**
 * 1099-NEC preparation: the accountant's cash-basis worksheet beside the
 * compliance filing workspace. Reports read + AP read, no feature switch.
 */
export default async function NecPreparation({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadNecPreparation(sp);
  return <ModuleView spec={necPreparationSpec(data)} data={data} searchParams={sp} trusted />;
}

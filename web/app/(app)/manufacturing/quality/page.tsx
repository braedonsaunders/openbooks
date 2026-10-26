import { getTranslations } from "next-intl/server";
import { ModuleView } from "@/components/viewspec/module-view";
import { loadManufacturingQuality, manufacturingQualitySpec } from "./view";
import { InspectionHost } from "./InspectionHost";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("manufacturing.quality");
  return { title: t("title") };
}

export default async function Quality({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadManufacturingQuality(sp);

  return (
    <>
      <ModuleView spec={manufacturingQualitySpec(data)} data={data} searchParams={sp} trusted />
      <InspectionHost
        recordId={data.selectedInspectionId}
        closeHref={data.closeHref}
        canInspect={data.canInspect}
        canPost={data.canPost}
        scrapReasons={data.scrapReasons}
      />
    </>
  );
}

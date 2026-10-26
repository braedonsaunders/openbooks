import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../../components/viewspec/module-view";
import { loadSegmentDependencyExceptions, segmentDependencyExceptionsSpec } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("admin");
  return { title: t("setup.segmentDependencies.title") };
}

/** Open documents whose lines break a segment value dependency rule. */
export default async function SegmentDependencyExceptions({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadSegmentDependencyExceptions();
  return (
    <ModuleView
      spec={segmentDependencyExceptionsSpec(data)}
      data={data}
      searchParams={sp}
      trusted
    />
  );
}

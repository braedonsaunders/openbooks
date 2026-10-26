import { PageHeader } from "@openbooks/ui";
import { ListPageLayout } from "@/components/page-layout";
import { ModuleHomeTabs } from "@/components/module-home/ui";
import { ModuleView } from "@/components/viewspec/module-view";
import { loadManufacturingGenealogy, genealogySpec } from "./view";
import { GenealogySeedPicker } from "./GenealogySeedPicker";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const data = await loadManufacturingGenealogy(raw);

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={data.title}
          description={data.traceDescription}
          actions={<ModuleHomeTabs tabs={data.tabs} />}
        />
      }
      className="space-y-4"
    >
      <GenealogySeedPicker
        kind={data.kind}
        id={data.id}
        direction={data.direction}
        maxDepth={data.maxDepth}
        initialSeeds={data.initialSeeds}
      />
      {data.trace ? (
        <>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {data.associationLabel}
            {data.trace.visibility === "authorized_entities" ? ` ${data.scopedLabel}` : ""}
          </p>
          {data.trace.truncated ? (
            <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
              {data.truncatedLabel}
            </p>
          ) : null}
        </>
      ) : null}
      <ModuleView spec={genealogySpec(data)} data={data} searchParams={raw} trusted />
    </ListPageLayout>
  );
}

import { ModuleView } from "@/components/viewspec/module-view";
import { RebateDrawer } from "./RebateDrawer";
import { loadRebates, rebatesSpec } from "./view";

export const dynamic = "force-dynamic";

export default async function RebatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadRebates(sp);
  return (
    <>
      <ModuleView spec={rebatesSpec(data)} data={data} searchParams={sp} trusted />
      {data.selected ? (
        <RebateDrawer
          key={data.selected.claim?.id ?? data.selected.agreement.id}
          data={data.selected}
        />
      ) : null}
    </>
  );
}

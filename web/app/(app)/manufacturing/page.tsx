import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ModuleView } from "@/components/viewspec/module-view";
import { PageHeader, Button } from "@openbooks/ui";
import { ListPageLayout } from "@/components/page-layout";
import { ModuleHomeTabs } from "@/components/module-home/ui";
import { loadManufacturingHome, manufacturingHomeSpec } from "./view";
import { WorkflowStart } from "./WorkflowStart";
import { ManufacturingSetupJourney } from "./SetupJourney";
import { ManufacturingRecordHost } from "./RecordHost";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("manufacturing");
  return { title: t("title") };
}

export default async function ManufacturingHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadManufacturingHome(sp);
  const host = data.recordHost;

  if (data.legacyMode) {
    return (
      <ListPageLayout
        header={
          <PageHeader
            title={data.title}
            description={data.description}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <ModuleHomeTabs tabs={data.legacyTabs} />
                {host.canManage ? (
                  <Button asChild>
                    <Link href={data.newWorkOrderHref as never}>{data.labels.newWorkOrder}</Link>
                  </Button>
                ) : null}
              </div>
            }
          />
        }
      >
        <div className="space-y-5">
          {data.legacyMode === "setup" ? (
            <ManufacturingSetupJourney />
          ) : (
            <>
              {data.canSetup ? (
                <p className="text-sm text-slate-500">
                  {data.legacyText.firstTime}{" "}
                  <Link
                    className="font-medium text-teal-700 hover:underline"
                    href="/admin/setup/manufacturing"
                  >
                    {data.legacyText.setup}
                  </Link>
                </p>
              ) : null}
              <WorkflowStart choices={host.operatingChoices} />
              <p className="max-w-3xl text-sm text-slate-500">{data.legacyText.projectNote}</p>
            </>
          )}
        </div>
        <ManufacturingRecordHost
          view="work-orders"
          recordId={data.selectedRecordId}
          closeHref={data.closeHref}
          options={host.options}
          canManage={host.canManage}
          canPost={host.canPost}
          canBuy={host.canBuy}
          canSubcontract={host.canSubcontract}
          canReadQuality={host.canReadQuality}
          canReadJournal={host.canReadJournal}
          canGovernRevisions={host.canGovernRevisions}
        />
      </ListPageLayout>
    );
  }

  return (
    <>
      <ModuleView spec={manufacturingHomeSpec(data)} data={data} searchParams={sp} trusted />
      <ManufacturingRecordHost
        view="work-orders"
        recordId={data.selectedRecordId}
        closeHref={data.closeHref}
        options={host.options}
        canManage={host.canManage}
        canPost={host.canPost}
        canBuy={host.canBuy}
        canSubcontract={host.canSubcontract}
        canReadQuality={host.canReadQuality}
        canReadJournal={host.canReadJournal}
        canGovernRevisions={host.canGovernRevisions}
      />
    </>
  );
}

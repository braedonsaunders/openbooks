import "server-only";

import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { requireServiceArea } from "../../../../lib/service/pages";
import { serviceWorkspaceTabs } from "../../../../lib/service/workspace-tabs";

/**
 * Service jobs: the universal entity list for `service_job` with the
 * service record host as its drawer. The host reads `?job=` (and the other
 * service record parameters) and loads the record client-side, so opening a
 * row keeps the list mounted.
 */
export interface ServiceJobsData {
  title: string;
  description: string;
  currentParams: Record<string, string | string[] | undefined>;
  canCreate: boolean;
  newLabel: string;
  tabs: ReturnType<typeof serviceWorkspaceTabs>;
}

export async function loadServiceJobs(
  sp: Record<string, string | string[] | undefined>,
): Promise<ServiceJobsData> {
  const { capabilities } = await requireServiceArea();
  const t = await getTranslations("service");
  return {
    title: t("pages.jobs.title"),
    description: t("pages.jobs.description"),
    currentParams: sp,
    canCreate: capabilities.manage,
    newLabel: t("pages.jobs.new"),
    tabs: serviceWorkspaceTabs("jobs", {
      overview: t("tabs.overview"),
      requests: t("tabs.requests"),
      jobs: t("tabs.jobs"),
      visits: t("tabs.visits"),
      agreements: t("tabs.agreements"),
    }),
  };
}

const f = ref<ServiceJobsData>();

export function serviceJobsSpec(data: ServiceJobsData): PageSpec {
  return page({
    route: "/service/jobs",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget("service-new-button", { kind: "job", label: data.newLabel }, f("canCreate")),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock("entity-list-view", {
        recordType: "service_job",
        sp: data.currentParams,
        drawer: { widget: "service-record-host", props: {} },
      }),
    ],
  });
}

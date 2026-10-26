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
 * Service requests: the universal entity list for `service_request` with the
 * service record host as its drawer. The host reads `?request=` (and the other
 * service record parameters) and loads the record client-side, so opening a
 * row keeps the list mounted.
 */
export interface ServiceRequestsData {
  title: string;
  description: string;
  currentParams: Record<string, string | string[] | undefined>;
  canCreate: boolean;
  newLabel: string;
  tabs: ReturnType<typeof serviceWorkspaceTabs>;
}

export async function loadServiceRequests(
  sp: Record<string, string | string[] | undefined>,
): Promise<ServiceRequestsData> {
  const { capabilities } = await requireServiceArea();
  const t = await getTranslations("service");
  return {
    title: t("pages.requests.title"),
    description: t("pages.requests.description"),
    currentParams: sp,
    canCreate: capabilities.manage,
    newLabel: t("pages.requests.new"),
    tabs: serviceWorkspaceTabs("requests", {
      overview: t("tabs.overview"),
      requests: t("tabs.requests"),
      jobs: t("tabs.jobs"),
      visits: t("tabs.visits"),
      agreements: t("tabs.agreements"),
    }),
  };
}

const f = ref<ServiceRequestsData>();

export function serviceRequestsSpec(data: ServiceRequestsData): PageSpec {
  return page({
    route: "/service/requests",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget("service-new-button", { kind: "request", label: data.newLabel }, f("canCreate")),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock("entity-list-view", {
        recordType: "service_request",
        sp: data.currentParams,
        drawer: { widget: "service-record-host", props: {} },
      }),
    ],
  });
}

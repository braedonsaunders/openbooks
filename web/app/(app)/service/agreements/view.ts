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
 * Service agreements: the universal entity list for `service_agreement` with the
 * service record host as its drawer. The host reads `?agreement=` (and the other
 * service record parameters) and loads the record client-side, so opening a
 * row keeps the list mounted.
 */
export interface ServiceAgreementsData {
  title: string;
  description: string;
  currentParams: Record<string, string | string[] | undefined>;
  canCreate: boolean;
  newLabel: string;
  tabs: ReturnType<typeof serviceWorkspaceTabs>;
}

export async function loadServiceAgreements(
  sp: Record<string, string | string[] | undefined>,
): Promise<ServiceAgreementsData> {
  const { capabilities } = await requireServiceArea();
  const t = await getTranslations("service");
  return {
    title: t("pages.agreements.title"),
    description: t("pages.agreements.description"),
    currentParams: sp,
    canCreate: capabilities.manage,
    newLabel: t("pages.agreements.new"),
    tabs: serviceWorkspaceTabs("agreements", {
      overview: t("tabs.overview"),
      requests: t("tabs.requests"),
      jobs: t("tabs.jobs"),
      visits: t("tabs.visits"),
      agreements: t("tabs.agreements"),
    }),
  };
}

const f = ref<ServiceAgreementsData>();

export function serviceAgreementsSpec(data: ServiceAgreementsData): PageSpec {
  return page({
    route: "/service/agreements",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget("service-new-button", { kind: "agreement", label: data.newLabel }, f("canCreate")),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock("entity-list-view", {
        recordType: "service_agreement",
        sp: data.currentParams,
        drawer: { widget: "service-record-host", props: {} },
      }),
    ],
  });
}

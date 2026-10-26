import "server-only";
import { getTranslations } from "next-intl/server";
import type { ModuleHomeTab } from "../../../components/module-home/ui";

/**
 * The Compliance workspace's route-tab strip, defined once so every page in the
 * module renders the identical strip (the /ap idiom). Lien waivers need a
 * project, so that tab appears only when the Projects gate is on — the tab
 * disappearing and the route 404ing are the same condition, read from the same
 * place. The overview/vendors tabs need subcontractor compliance and the
 * information-returns tab needs the informationReturns tax switch, for the
 * same reason: a tab never leads somewhere the feature-required page would
 * refuse.
 */
export async function complianceTabs(
  activeHref: string,
  opts: {
    projectsEnabled: boolean;
    complianceEnabled?: boolean;
    informationReturnsEnabled?: boolean;
  },
): Promise<ModuleHomeTab[]> {
  const t = await getTranslations("compliance");
  const complianceOn = opts.complianceEnabled ?? true;
  const returnsOn = opts.informationReturnsEnabled ?? true;
  const tabs = [
    ...(complianceOn ? [{ href: "/compliance", key: "tabs.overview" }] : []),
    ...(complianceOn ? [{ href: "/compliance/vendors", key: "tabs.vendors" }] : []),
    ...(opts.projectsEnabled && complianceOn
      ? [{ href: "/compliance/lien-waivers", key: "tabs.lienWaivers" }]
      : []),
    ...(returnsOn
      ? [{ href: "/compliance/information-returns", key: "tabs.informationReturns" }]
      : []),
  ];
  return tabs.map((tab) => ({
    href: tab.href,
    label: t(tab.key),
    active: activeHref === tab.href,
  }));
}

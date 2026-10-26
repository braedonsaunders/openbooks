import type { ModuleHomeTab } from "../../components/module-home/tab-types";

export type ServiceWorkspaceSection = "overview" | "requests" | "jobs" | "visits" | "agreements";

const ROUTES: Record<ServiceWorkspaceSection, string> = {
  overview: "/service",
  requests: "/service/requests",
  jobs: "/service/jobs",
  visits: "/service/visits",
  agreements: "/service/agreements",
};

export function serviceWorkspaceTabs(
  active: ServiceWorkspaceSection,
  labels: Record<ServiceWorkspaceSection, string>,
): ModuleHomeTab[] {
  return (Object.keys(ROUTES) as ServiceWorkspaceSection[]).map((section) => ({
    href: ROUTES[section],
    label: labels[section],
    active: section === active,
  }));
}

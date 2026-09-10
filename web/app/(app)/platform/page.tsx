import { PageHeader } from "@openbooks/ui";
import { PageContainer } from "../../../components/page-layout";
import { ModuleView } from "../../../components/viewspec/module-view";
import { platformSummary } from "../../../lib/platform-admin";
import { PlatformNotice, PlatformTile, type PlatformTileIconKey } from "./sections";
import { loadPlatformHub, platformHubSpec } from "./view";

export const dynamic = "force-dynamic";

const tiles: {
  href: string;
  iconKey: PlatformTileIconKey;
  title: string;
  description: string;
  stat: (summary: Awaited<ReturnType<typeof platformSummary>>) => number;
  detail: (summary: Awaited<ReturnType<typeof platformSummary>>) => string;
}[] = [
  {
    href: "/platform/organizations",
    iconKey: "building-2",
    title: "Organizations",
    description: "Every production company, sandbox, and preview environment",
    stat: (summary) => summary.organizations,
    detail: (summary) =>
      `${summary.productionOrganizations} production · ${summary.environments} non-production`,
  },
  {
    href: "/platform/users",
    iconKey: "users",
    title: "Users",
    description: "Global operator view of production identities and privileges",
    stat: (summary) => summary.activeUsers,
    detail: (summary) =>
      `${summary.superAdmins} super administrator${summary.superAdmins === 1 ? "" : "s"}`,
  },
  {
    href: "/platform/access",
    iconKey: "key-round",
    title: "Cross-org access",
    description:
      "Controlled mappings between login identities and organizations",
    stat: (summary) => summary.activeGrants,
    detail: () => "Active explicit grants",
  },
  {
    href: "/platform/email-log",
    iconKey: "mail",
    title: "Email log",
    description: "Delivery evidence across every organization",
    stat: (summary) => summary.failedEmails,
    detail: () => "Failed deliveries requiring attention",
  },
];

export default async function PlatformPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const sp = (await searchParams) ?? {};
  if (sp.__viewspec === "1") {
    const data = await loadPlatformHub();
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={platformHubSpec(data)} data={data} searchParams={sp} trusted />
      </>
    );
  }
  const summary = await platformSummary();
  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Super Admin"
          description="Platform-wide operations, identities, access controls, and delivery evidence."
        />

        <PlatformNotice />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <PlatformTile
              key={tile.href}
              href={tile.href}
              iconKey={tile.iconKey}
              title={tile.title}
              description={tile.description}
              stat={tile.stat(summary).toLocaleString()}
              detail={tile.detail(summary)}
            />
          ))}
        </div>
      </div>
    </PageContainer>
  );
}

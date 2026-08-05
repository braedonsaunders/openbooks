import Link from "next/link";
import { Building2, KeyRound, Mail, ShieldCheck, Users } from "lucide-react";
import { Card, CardContent, PageHeader } from "@openbooks/ui";
import { PageContainer } from "../../../components/page-layout";
import { platformSummary } from "../../../lib/platform-admin";

export const dynamic = "force-dynamic";

const tiles = [
  {
    href: "/platform/organizations",
    title: "Organizations",
    description: "Every production company, sandbox, and preview environment",
    icon: Building2,
    stat: (summary: Awaited<ReturnType<typeof platformSummary>>) =>
      summary.organizations,
    detail: (summary: Awaited<ReturnType<typeof platformSummary>>) =>
      `${summary.productionOrganizations} production · ${summary.environments} non-production`,
  },
  {
    href: "/platform/users",
    title: "Users",
    description: "Global operator view of production identities and privileges",
    icon: Users,
    stat: (summary: Awaited<ReturnType<typeof platformSummary>>) =>
      summary.activeUsers,
    detail: (summary: Awaited<ReturnType<typeof platformSummary>>) =>
      `${summary.superAdmins} super administrator${summary.superAdmins === 1 ? "" : "s"}`,
  },
  {
    href: "/platform/access",
    title: "Cross-org access",
    description:
      "Controlled mappings between login identities and organizations",
    icon: KeyRound,
    stat: (summary: Awaited<ReturnType<typeof platformSummary>>) =>
      summary.activeGrants,
    detail: () => "Active explicit grants",
  },
  {
    href: "/platform/email-log",
    title: "Email log",
    description: "Delivery evidence across every organization",
    icon: Mail,
    stat: (summary: Awaited<ReturnType<typeof platformSummary>>) =>
      summary.failedEmails,
    detail: () => "Failed deliveries requiring attention",
  },
] as const;

export default async function PlatformPage() {
  const summary = await platformSummary();
  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Super Admin"
          description="Platform-wide operations, identities, access controls, and delivery evidence."
        />

        <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/60 dark:bg-amber-950/25">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800">
              <ShieldCheck size={20} />
            </span>
            <div>
              <p className="text-sm font-semibold text-amber-950 dark:text-amber-100">
                Platform workspace
              </p>
              <p className="mt-0.5 text-sm text-amber-800 dark:text-amber-300">
                This workspace bypasses organization boundaries for authorized
                operators. Every access-control mutation is validated and
                written to the immutable audit trail.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => {
            const Icon = tile.icon;
            return (
              <Link key={tile.href} href={tile.href as never} className="group">
                <Card
                  interactive
                  className="h-full hover:border-amber-300 dark:hover:border-amber-800"
                >
                  <CardContent className="flex h-full flex-col p-4">
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-lg bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800/60">
                        <Icon size={19} />
                      </span>
                      <span className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {tile.stat(summary).toLocaleString()}
                      </span>
                    </div>
                    <h2 className="mt-4 text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tile.title}
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                      {tile.description}
                    </p>
                    <p className="mt-auto pt-4 text-xs font-medium text-amber-700 dark:text-amber-300">
                      {tile.detail(summary)}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>
    </PageContainer>
  );
}

import { notFound } from "next/navigation";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DetailHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { DetailPageLayout } from "../../../../../components/page-layout";
import { isUuid } from "../../../../../lib/list-params";
import {
  platformGrantOptions,
  platformUser,
} from "../../../../../lib/platform-admin";
import { requireSuperAdmin } from "../../../../../lib/super-admin";
import { revokeAccessAction, setSuperAdminAction } from "../../actions";
import { GrantAccessForm } from "../../_components/GrantAccessForm";
import {
  PlatformUserHeader,
  GrantActingCell,
  GrantControlCell,
  NoGrantsBody,
  IdentityRecordCard,
} from "./sections";
import { ModuleView } from "../../../../../components/viewspec/module-view";
import { loadPlatformUser, platformUserSpec } from "./view";
import { PlatformMutationButton } from "../../_components/PlatformMutationButton";

export const dynamic = "force-dynamic";

function formatDate(value: string | Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default async function PlatformUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  if (sp.__viewspec === "1") {
    const data = await loadPlatformUser(id);
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={platformUserSpec(data)} data={data} searchParams={sp} trusted />
      </>
    );
  }
  if (!isUuid(id)) notFound();
  const authz = await requireSuperAdmin();
  const [record, options] = await Promise.all([
    platformUser(id),
    platformGrantOptions(),
  ]);
  if (!record) notFound();
  const { user, grants } = record;
  const isSelf = user.id === authz.user.homeUserId;

  return (
    <DetailPageLayout
      header={
        <PlatformUserHeader
          userId={user.id}
          name={user.name}
          subtitle={`${user.email} · ${user.orgName}`}
          isActive={user.isActive}
          isSuperAdmin={user.isSuperAdmin}
          isSelf={isSelf}
          backHref="/platform/users"
          backLabel="Users"
        />
      }
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="space-y-5">
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Cross-organization access
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Explicit production-organization mappings for this login
                identity. Super admins do not require grants.
              </p>
            </div>
            <GrantAccessForm
              members={options.members}
              organizations={options.organizations.filter(
                (organization) => organization.id !== user.orgId,
              )}
              actingUsers={options.actingUsers}
              defaultMemberUserId={user.id}
            />
            <Card>
              {grants.length === 0 ? (
                <NoGrantsBody />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Organization</TableHead>
                      <TableHead>Acts as</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Control</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grants.map((grant) => (
                      <TableRow key={grant.id}>
                        <TableCell className="font-medium">
                          {grant.orgName}
                        </TableCell>
                        <TableCell>
                          <GrantActingCell name={grant.actingName} email={grant.actingEmail} />
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={grant.isActive ? "success" : "secondary"}
                          >
                            {grant.isActive ? "active" : "revoked"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <GrantControlCell grantId={grant.id} isActive={grant.isActive} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
          </section>
        </div>

        <IdentityRecordCard
          title="Identity record"
          facts={[
            { label: "User ID", value: user.id, mono: true },
            { label: "Home organization", value: user.orgName },
            { label: "Organization roles", value: user.roles.join(", ") },
            { label: "Last login", value: formatDate(user.lastLoginAt) },
            { label: "Created", value: formatDate(user.createdAt) },
          ]}
        />
      </div>
    </DetailPageLayout>
  );
}

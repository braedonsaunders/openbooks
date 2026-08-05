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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
        <DetailHeader
          back={{ href: "/platform/users", label: "Users" }}
          title={user.name}
          subtitle={`${user.email} · ${user.orgName}`}
          badge={
            <div className="flex items-center gap-2">
              <Badge variant={user.isActive ? "success" : "secondary"}>
                {user.isActive ? "active" : "inactive"}
              </Badge>
              {user.isSuperAdmin ? (
                <Badge variant="warning">super admin</Badge>
              ) : null}
            </div>
          }
          actions={
            <PlatformMutationButton
              action={setSuperAdminAction.bind(
                null,
                user.id,
                !user.isSuperAdmin,
              )}
              success={
                user.isSuperAdmin
                  ? "Super-admin access revoked"
                  : "Super-admin access granted"
              }
              variant={user.isSuperAdmin ? "destructive" : "outline"}
              disabled={isSelf && user.isSuperAdmin}
            >
              {user.isSuperAdmin
                ? isSelf
                  ? "Current operator"
                  : "Revoke super admin"
                : "Make super admin"}
            </PlatformMutationButton>
          }
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
                <CardContent className="p-5 text-sm text-slate-500 dark:text-slate-400">
                  No explicit cross-organization grants.
                </CardContent>
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
                          <div>{grant.actingName}</div>
                          <div className="text-xs text-slate-500">
                            {grant.actingEmail}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={grant.isActive ? "success" : "secondary"}
                          >
                            {grant.isActive ? "active" : "revoked"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {grant.isActive ? (
                            <PlatformMutationButton
                              action={revokeAccessAction.bind(null, grant.id)}
                              success="Cross-organization access revoked"
                              size="sm"
                              variant="ghost"
                            >
                              Revoke
                            </PlatformMutationButton>
                          ) : (
                            <span className="text-xs text-slate-400">
                              Preserved
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
          </section>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Identity record</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <Fact label="User ID" value={user.id} mono />
            <Fact label="Home organization" value={user.orgName} />
            <Fact label="Organization roles" value={user.roles.join(', ')} />
            <Fact label="Last login" value={formatDate(user.lastLoginAt)} />
            <Fact label="Created" value={formatDate(user.createdAt)} />
          </CardContent>
        </Card>
      </div>
    </DetailPageLayout>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div
        className={
          mono
            ? "mt-1 break-all font-mono text-xs text-slate-700 dark:text-slate-200"
            : "mt-1 text-slate-800 dark:text-slate-200"
        }
      >
        {value}
      </div>
    </div>
  );
}

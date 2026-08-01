import Link from "next/link";
import { ShieldAlert, Users } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { FilterChips } from "../../../../components/filter-bar";
import { Pagination } from "../../../../components/pagination";
import { ListPageLayout } from "../../../../components/page-layout";
import { SearchInput } from "../../../../components/search-input";
import { SortableTh } from "../../../../components/sortable-th";
import { parseListParams, pickString } from "../../../../lib/list-params";
import { platformUsers } from "../../../../lib/platform-admin";

export const dynamic = "force-dynamic";

const BASE = "/platform/users";
const SORTS = [
  "name",
  "email",
  "organization",
  "role",
  "lastLogin",
  "grants",
] as const;

function formatDate(value: string | Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const statusParam = pickString(sp.status);
  const status =
    statusParam === "active" ||
    statusParam === "inactive" ||
    statusParam === "super"
      ? statusParam
      : undefined;
  const params = parseListParams(sp, {
    sort: "name",
    dir: "asc",
    perPage: 25,
    allowedSorts: SORTS,
  });
  const result = await platformUsers({ ...params, status });

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: "/platform", label: "Super Admin" }}
            title="Users"
            description="Production login identities, organization roles, and platform privileges."
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search user, email, organization, or role…" />
            <FilterChips
              basePath={BASE}
              currentParams={sp}
              paramKey="status"
              label="Status"
              options={[
                {
                  value: "active",
                  label: "Active",
                  count: result.statusCounts.active ?? 0,
                },
                {
                  value: "inactive",
                  label: "Inactive",
                  count: result.statusCounts.inactive ?? 0,
                },
                {
                  value: "super",
                  label: "Super admin",
                  count: result.statusCounts.super ?? 0,
                },
              ]}
            />
          </div>
        </>
      }
    >
      {result.rows.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No users found"
          description="Try broadening the search or status filter."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="name"
                  active={params.sort === "name"}
                  dir={params.dir}
                >
                  User
                </SortableTh>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="organization"
                  active={params.sort === "organization"}
                  dir={params.dir}
                >
                  Home organization
                </SortableTh>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="role"
                  active={params.sort === "role"}
                  dir={params.dir}
                >
                  Role
                </SortableTh>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="grants"
                  active={params.sort === "grants"}
                  dir={params.dir}
                >
                  Access
                </SortableTh>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="lastLogin"
                  active={params.sort === "lastLogin"}
                  dir={params.dir}
                >
                  Last login
                </SortableTh>
                <TableHead className="text-right">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/platform/users/${user.id}` as never}
                        className="font-medium text-slate-900 hover:text-teal-700 dark:text-slate-100 dark:hover:text-teal-300"
                      >
                        {user.name}
                      </Link>
                      {user.isSuperAdmin ? (
                        <Badge variant="warning" className="gap-1">
                          <ShieldAlert size={11} /> super admin
                        </Badge>
                      ) : null}
                      {!user.isActive ? (
                        <Badge variant="secondary">inactive</Badge>
                      ) : null}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {user.email}
                    </div>
                  </TableCell>
                  <TableCell>{user.orgName}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {user.roles.map((role) => <Badge key={role} variant="outline">{role}</Badge>)}
                    </div>
                  </TableCell>
                  <TableCell>
                    {user.grantCount > 0 ? (
                      <span className="font-medium tabular-nums">
                        {user.grantCount} explicit
                      </span>
                    ) : (
                      <span className="text-slate-500">Home only</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-slate-600 dark:text-slate-300">
                    {formatDate(user.lastLoginAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/platform/users/${user.id}` as never}>
                        Manage
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination
            basePath={BASE}
            currentParams={sp}
            total={result.total}
            page={params.page}
            perPage={params.perPage}
          />
        </div>
      )}
    </ListPageLayout>
  );
}

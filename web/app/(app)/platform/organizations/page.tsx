import { Building2, ExternalLink } from "lucide-react";
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
import { platformOrganizations } from "../../../../lib/platform-admin";
import { enterOrganizationAction } from "../actions";

export const dynamic = "force-dynamic";

const BASE = "/platform/organizations";
const SORTS = ["name", "environment", "users", "sandboxes", "created"] as const;

export default async function PlatformOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const environmentParam = pickString(sp.environment);
  const environment =
    environmentParam === "production" ||
    environmentParam === "sandbox" ||
    environmentParam === "preview"
      ? environmentParam
      : undefined;
  const params = parseListParams(sp, {
    sort: "name",
    dir: "asc",
    perPage: 25,
    allowedSorts: SORTS,
  });
  const result = await platformOrganizations({ ...params, environment });

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: "/platform", label: "Super Admin" }}
            title="Organizations"
            description="Production companies and their isolated non-production environments."
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search name, legal name, country, or currency…" />
            <FilterChips
              basePath={BASE}
              currentParams={sp}
              paramKey="environment"
              label="Environment"
              options={[
                {
                  value: "production",
                  label: "Production",
                  count: result.environmentCounts.production ?? 0,
                },
                {
                  value: "sandbox",
                  label: "Sandbox",
                  count: result.environmentCounts.sandbox ?? 0,
                },
                {
                  value: "preview",
                  label: "Preview",
                  count: result.environmentCounts.preview ?? 0,
                },
              ]}
            />
          </div>
        </>
      }
    >
      {result.rows.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title="No organizations found"
          description="Try broadening the search or environment filter."
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
                  Organization
                </SortableTh>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="environment"
                  active={params.sort === "environment"}
                  dir={params.dir}
                >
                  Environment
                </SortableTh>
                <TableHead>Country / currency</TableHead>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="users"
                  active={params.sort === "users"}
                  dir={params.dir}
                >
                  Users
                </SortableTh>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="sandboxes"
                  active={params.sort === "sandboxes"}
                  dir={params.dir}
                >
                  Sandboxes
                </SortableTh>
                <TableHead className="text-right">Workspace</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((org) => (
                <TableRow key={org.id}>
                  <TableCell>
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {org.name}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {org.legalName || org.id}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        org.envKind === "production"
                          ? "success"
                          : org.envKind === "sandbox"
                            ? "warning"
                            : "secondary"
                      }
                    >
                      {org.envKind}
                    </Badge>
                    {org.parentName ? (
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        of {org.parentName}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div>{org.country}</div>
                    <div className="text-xs text-slate-500">
                      {org.baseCurrency}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium tabular-nums">
                      {org.activeUserCount}
                    </span>
                    <span className="text-slate-400"> / {org.userCount}</span>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {org.sandboxCount}
                  </TableCell>
                  <TableCell className="text-right">
                    <form action={enterOrganizationAction}>
                      <input type="hidden" name="orgId" value={org.id} />
                      <Button type="submit" size="sm" variant="outline">
                        Open <ExternalLink size={14} />
                      </Button>
                    </form>
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

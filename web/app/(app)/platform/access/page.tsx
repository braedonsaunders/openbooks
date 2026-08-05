import { KeyRound } from "lucide-react";
import {
  Badge,
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
import {
  platformGrantOptions,
  platformGrants,
} from "../../../../lib/platform-admin";
import { revokeAccessAction } from "../actions";
import { GrantAccessForm } from "../_components/GrantAccessForm";
import { PlatformMutationButton } from "../_components/PlatformMutationButton";

export const dynamic = "force-dynamic";

const BASE = "/platform/access";
const SORTS = ["member", "organization", "actingUser", "updated"] as const;

function formatDate(value: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default async function PlatformAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const statusParam = pickString(sp.status);
  const status =
    statusParam === "active" || statusParam === "inactive"
      ? statusParam
      : undefined;
  const params = parseListParams(sp, {
    sort: "updated",
    dir: "desc",
    perPage: 25,
    allowedSorts: SORTS,
  });
  const [result, options] = await Promise.all([
    platformGrants({ ...params, status }),
    platformGrantOptions(),
  ]);

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: "/platform", label: "Super Admin" }}
            title="Cross-org access"
            description="Explicit, auditable access mappings between production organizations."
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search member, organization, or acting user…" />
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
                  label: "Revoked",
                  count: result.statusCounts.inactive ?? 0,
                },
              ]}
            />
          </div>
        </>
      }
      className="space-y-5"
    >
      <GrantAccessForm {...options} />
      {result.rows.length === 0 ? (
        <EmptyState
          icon={<KeyRound />}
          title="No access grants found"
          description="Create an explicit mapping above, or broaden the search and status filter."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="member"
                  active={params.sort === "member"}
                  dir={params.dir}
                >
                  Member identity
                </SortableTh>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="organization"
                  active={params.sort === "organization"}
                  dir={params.dir}
                >
                  Target organization
                </SortableTh>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="actingUser"
                  active={params.sort === "actingUser"}
                  dir={params.dir}
                >
                  Acts as
                </SortableTh>
                <TableHead>Status</TableHead>
                <SortableTh
                  basePath={BASE}
                  currentParams={sp}
                  column="updated"
                  active={params.sort === "updated"}
                  dir={params.dir}
                >
                  Last changed
                </SortableTh>
                <TableHead className="text-right">Control</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((grant) => (
                <TableRow key={grant.id}>
                  <TableCell>
                    <div className="font-medium">{grant.memberName}</div>
                    <div className="text-xs text-slate-500">
                      {grant.memberEmail} · {grant.memberOrgName}
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">{grant.orgName}</TableCell>
                  <TableCell>
                    <div>{grant.actingName}</div>
                    <div className="text-xs text-slate-500">
                      {grant.actingEmail}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={grant.isActive ? "success" : "secondary"}>
                      {grant.isActive ? "active" : "revoked"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-slate-600 dark:text-slate-300">
                    {formatDate(grant.updatedAt)}
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
                        History preserved
                      </span>
                    )}
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

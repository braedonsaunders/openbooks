import { PagedTable } from "../../../../components/paged-table";
import { Badge, Button, PageHeader } from "@openbooks/ui";
import { ListPageLayout } from "../../../../components/page-layout";
import { SearchInput } from "../../../../components/search-input";
import { FilterChips } from "../../../../components/filter-bar";
import { asDate } from "../../../../lib/platform-console";
import type {
  PlatformGrant,
  PlatformOrganization,
  PlatformUser,
} from "../../../../lib/platform-admin";
import { revokeAccessAction } from "../actions";
import { GrantAccessForm } from "../_components/GrantAccessForm";
import { PlatformMutationButton } from "../_components/PlatformMutationButton";
import { ViewerDateTime } from "../../../../components/viewer-format";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { platformDrawerHref } from "../../../../lib/platform-console";
import { useTranslations } from "next-intl";

/**
 * Two composite cells in the cross-org access list.
 *
 * The control cell is the notable one: it binds a SERVER ACTION to a specific
 * grant id. A bound function is exactly what a spec must never carry — it is
 * not serializable and it is authority, not presentation — so the spec passes
 * the id and the binding happens here.
 */

/** Name over a muted "email · organization" line. */
export function IdentityCell({ name, detail }: { name: string; detail: string }) {
  return (
    <>
      <div className="font-medium">{name}</div>
      <div className="text-xs text-slate-500">{detail}</div>
    </>
  );
}

/** Plain name over a muted email. */
export function ActingCell({ name, email }: { name: string; email: string }) {
  return (
    <>
      <div>{name}</div>
      <div className="text-xs text-slate-500">{email}</div>
    </>
  );
}

/** Revoke button while the grant is live; a history note once it is not. */
export function AccessControlCell({
  grantId,
  isActive,
  labels,
}: {
  grantId: string;
  isActive: boolean;
  labels?: {
    preserved: string;
    revoked: string;
    requestFailed?: string;
    working?: string;
    revoke?: string;
  };
}) {
  const t = useTranslations("platform.access");
  if (!isActive)
    return (
      <span className="text-xs text-slate-400">{labels?.preserved ?? t("historyPreserved")}</span>
    );
  return (
    <PlatformMutationButton
      action={revokeAccessAction.bind(null, grantId)}
      success={labels?.revoked ?? t("mutation.revoked")}
      fallbackError={labels?.requestFailed ?? t("mutation.requestFailed")}
      pendingLabel={labels?.working ?? t("mutation.working")}
      size="sm"
      variant="ghost"
    >
      {labels?.revoke ?? t("revoke")}
    </PlatformMutationButton>
  );
}

/**
 * The cross-org access list on the house list composition (toolbar + sortable
 * table + pager), driven server-side by platformGrants.
 *
 * It replaces the AppKit RecordList wrapper, which paged only by swapping
 * the fetched page under a client-side table: search, sort and the grant
 * form all read a single page as the control plane. Sort, search, status
 * and page size now travel on the URL and narrow in SQL; the grant form and
 * the revoke control are unchanged client islands. The row cells stay the
 * shared cells above that the viewspec platform widgets also render.
 */
export async function AccessList({
  grants,
  total,
  page,
  perPage,
  sort,
  dir,
  status,
  statusCounts,
  basePath,
  currentParams,
  members,
  organizations,
  actingUsers,
}: {
  grants: PlatformGrant[];
  total: number;
  page: number;
  perPage: number;
  sort: "member" | "organization" | "actingUser" | "updated";
  dir: "asc" | "desc";
  status: "active" | "inactive" | undefined;
  statusCounts: Record<string, number>;
  basePath: string;
  currentParams: Record<string, string | string[] | undefined>;
  members: Pick<PlatformUser, "id" | "name" | "email" | "orgName" | "orgId">[];
  organizations: Pick<PlatformOrganization, "id" | "name">[];
  actingUsers: Pick<PlatformUser, "id" | "name" | "email" | "orgName" | "orgId">[];
}) {
  const t = await getTranslations("platform.access");
  const filtered = currentParams.q !== undefined || status !== undefined;
  const drawerOpen =
    (Array.isArray(currentParams.grant) ? currentParams.grant[0] : currentParams.grant) === "new";
  const drawerCloseHref = platformDrawerHref(basePath, currentParams, "grant");
  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("title")}
          description={t("description")}
          back={{ href: "/platform", label: t("backToPlatform") }}
          actions={
            <Button asChild>
              <Link href={platformDrawerHref(basePath, currentParams, "grant", "new") as never}>
                {t("grantAccess")}
              </Link>
            </Button>
          }
        />
      }
    >
      <div className="space-y-5">
        {drawerOpen ? (
          <GrantAccessForm
            open
            closeHref={drawerCloseHref}
            members={members}
            organizations={organizations}
            actingUsers={actingUsers}
          />
        ) : null}
        <PagedTable
          rows={grants}
          rowKey={(row) => row.id}
          serverWindow={{ total, page, perPage }}
          basePath={basePath}
          currentParams={currentParams}
          sort={sort}
          dir={dir}
          empty={filtered ? t("emptyFiltered") : t("empty")}
          toolbarAfter={
            <>
              <SearchInput placeholder={t("searchPlaceholder")} />
              <FilterChips
                basePath={basePath}
                currentParams={currentParams}
                paramKey="status"
                label={t("status")}
                options={[
                  {
                    value: "active",
                    label: t("statuses.active"),
                    count: Number(statusCounts.active ?? 0),
                  },
                  {
                    value: "inactive",
                    label: t("statuses.revoked"),
                    count: Number(statusCounts.inactive ?? 0),
                  },
                ]}
              />
            </>
          }
          columns={[
            {
              key: "member",
              header: t("columns.member"),
              sortKey: "member",
              cell: (grant) => (
                <IdentityCell
                  name={grant.memberName}
                  detail={`${grant.memberEmail} · ${grant.memberOrgName}`}
                />
              ),
            },
            {
              key: "organization",
              header: t("columns.organization"),
              sortKey: "organization",
              cell: (grant) => grant.orgName,
            },
            {
              key: "actingUser",
              header: t("columns.actingUser"),
              sortKey: "actingUser",
              cell: (grant) => <ActingCell name={grant.actingName} email={grant.actingEmail} />,
            },
            {
              key: "status",
              header: t("status"),
              cell: (grant) => (
                <Badge variant={grant.isActive ? "success" : "secondary"}>
                  {grant.isActive ? t("statuses.active") : t("statuses.revoked")}
                </Badge>
              ),
            },
            {
              key: "updated",
              header: t("columns.lastChanged"),
              sortKey: "updated",
              cell: (grant) =>
                asDate(grant.updatedAt) ? <ViewerDateTime value={asDate(grant.updatedAt)!} /> : "—",
            },
            {
              key: "revoke",
              header: <span className="sr-only">{t("revoke")}</span>,
              className: "w-px whitespace-nowrap px-2 text-center",
              style: { width: 64 },
              cell: (grant) => (
                <AccessControlCell
                  grantId={grant.id}
                  isActive={grant.isActive}
                  labels={{
                    preserved: t("historyPreserved"),
                    revoked: t("mutation.revoked"),
                    requestFailed: t("mutation.requestFailed"),
                    working: t("mutation.working"),
                    revoke: t("revoke"),
                  }}
                />
              ),
            },
          ]}
        />
      </div>
    </ListPageLayout>
  );
}

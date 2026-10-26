"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, UrlDrawer } from "@openbooks/ui";
import { DrawerTabStrip } from "../../../../components/drawer-tab-strip";
import { PagedTable } from "../../../../components/paged-table";
import type { PlatformGrant, PlatformUser } from "../../../../lib/platform-admin";
import { asDate } from "../../../../lib/platform-console";
import { useViewerFormat } from "@/lib/viewer-format";
import { PlatformMutationButton } from "./PlatformMutationButton";
import { setSuperAdminAction } from "../actions";
import { GrantActingCell, GrantControlCell } from "../users/[id]/sections";

type UserDetail = {
  user: PlatformUser;
  grants: PlatformGrant[];
  totalGrants: number;
  grantsPage: number;
  grantsPerPage: number;
  isSelf: boolean;
};

export function PlatformUserDetailClient({
  detail,
  closeHref,
  listParams,
}: {
  detail: UserDetail;
  closeHref: string;
  listParams: Record<string, string | string[] | undefined>;
}) {
  const t = useTranslations("platform.users");
  const tAccess = useTranslations("platform.access");
  const { dateTime } = useViewerFormat();
  const [tab, setTab] = useState<"overview" | "grants">("overview");
  const { user, grants, totalGrants, grantsPage, grantsPerPage, isSelf } = detail;
  const grantsParams = {
    ...listParams,
    grantPage: String(grantsPage),
    grantPerPage: String(grantsPerPage),
  };

  return (
    <UrlDrawer
      open
      openKey={user.id}
      closeHref={closeHref}
      size="xl"
      title={user.name}
      description={t("drawerDescription", { email: user.email, organization: user.orgName })}
      headerActions={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={user.isActive ? "success" : "secondary"}>
            {user.isActive ? t("statuses.active") : t("statuses.inactive")}
          </Badge>
          {user.isSuperAdmin ? <Badge variant="warning">{t("statuses.superAdmin")}</Badge> : null}
          <PlatformMutationButton
            action={setSuperAdminAction.bind(null, user.id, !user.isSuperAdmin)}
            success={
              user.isSuperAdmin ? t("mutation.superAdminRevoked") : t("mutation.superAdminGranted")
            }
            fallbackError={t("mutation.requestFailed")}
            pendingLabel={t("mutation.working")}
            variant={user.isSuperAdmin ? "destructive" : "outline"}
            disabled={isSelf && user.isSuperAdmin}
          >
            {user.isSuperAdmin
              ? isSelf
                ? t("currentOperator")
                : t("revokeSuperAdmin")
              : t("makeSuperAdmin")}
          </PlatformMutationButton>
        </div>
      }
      subtabs={
        <DrawerTabStrip
          ariaLabel={t("drawerTabsLabel")}
          activeKey={tab}
          onSelect={setTab}
          tabs={[
            { key: "overview", label: t("tabs.overview") },
            { key: "grants", label: t("tabs.grants"), count: totalGrants },
          ]}
        />
      }
    >
      {tab === "overview" ? (
        <dl className="grid gap-x-6 gap-y-4 rounded-xl border border-slate-200 p-4 sm:grid-cols-2 dark:border-slate-800">
          <Fact label={t("facts.email")} value={user.email} />
          <Fact label={t("facts.homeOrganization")} value={user.orgName} />
          <Fact label={t("facts.roles")} value={user.roles.length ? user.roles.join(", ") : "—"} />
          <Fact
            label={t("facts.lastLogin")}
            value={asDate(user.lastLoginAt) ? dateTime(asDate(user.lastLoginAt)!) : t("never")}
          />
          <Fact
            label={t("facts.created")}
            value={asDate(user.createdAt) ? dateTime(asDate(user.createdAt)!) : "—"}
          />
          <Fact label={t("facts.accountId")} value={user.id} mono />
        </dl>
      ) : (
        <PagedTable
          rows={grants}
          rowKey={(grant) => grant.id}
          serverWindow={{ total: totalGrants, page: grantsPage, perPage: grantsPerPage }}
          pageParamKey="grantPage"
          perPageParamKey="grantPerPage"
          basePath="/platform/users"
          currentParams={grantsParams}
          empty={t("noGrants")}
          columns={[
            {
              key: "organization",
              header: tAccess("columns.organization"),
              cell: (grant) => grant.orgName,
            },
            {
              key: "actingUser",
              header: tAccess("columns.actingUser"),
              cell: (grant) => (
                <GrantActingCell name={grant.actingName} email={grant.actingEmail} />
              ),
            },
            {
              key: "status",
              header: tAccess("status"),
              cell: (grant) => (
                <Badge variant={grant.isActive ? "success" : "secondary"}>
                  {grant.isActive ? tAccess("statuses.active") : tAccess("statuses.revoked")}
                </Badge>
              ),
            },
            {
              key: "revoke",
              header: <span className="sr-only">{tAccess("revoke")}</span>,
              className: "w-px whitespace-nowrap px-2 text-center",
              style: { width: 64 },
              cell: (grant) => (
                <GrantControlCell
                  grantId={grant.id}
                  isActive={grant.isActive}
                  labels={{
                    preserved: tAccess("historyPreserved"),
                    revoked: tAccess("mutation.revoked"),
                    requestFailed: tAccess("mutation.requestFailed"),
                    working: tAccess("mutation.working"),
                    revoke: tAccess("revoke"),
                  }}
                />
              ),
            },
          ]}
        />
      )}
    </UrlDrawer>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={mono ? "mt-1 break-all font-mono text-xs" : "mt-1 text-sm font-medium"}>
        {value}
      </dd>
    </div>
  );
}

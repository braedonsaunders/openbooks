import { platformListSources } from "../../../../lib/list/platform-sources";
import { clamp, isUuid, pickString } from "../../../../lib/list-params";
import { platformUser } from "../../../../lib/platform-admin";
import type { PlatformGrant, PlatformUser } from "../../../../lib/platform-admin";
import { requireSuperAdmin } from "../../../../lib/super-admin";
import { UsersList } from "./sections";

export const dynamic = "force-dynamic";

export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const source = platformListSources.users;
  const { params, filter: status, result } = await source.read(sp);
  const selectedUserId = pickString(sp.user);
  let detail: {
    user: PlatformUser;
    grants: PlatformGrant[];
    totalGrants: number;
    grantsPage: number;
    grantsPerPage: number;
    isSelf: boolean;
  } | null = null;
  if (selectedUserId && isUuid(selectedUserId)) {
    const grantsPage = clamp(Number(pickString(sp.grantPage) ?? "1"), 1, 10_000);
    const grantsPerPage = clamp(Number(pickString(sp.grantPerPage) ?? "25"), 5, 100);
    const [record, authz] = await Promise.all([
      platformUser(selectedUserId, { page: grantsPage, perPage: grantsPerPage }),
      requireSuperAdmin(),
    ]);
    if (record) {
      detail = {
        user: record.user,
        grants: record.grants,
        totalGrants: record.totalGrants,
        grantsPage,
        grantsPerPage,
        isSelf: record.user.id === authz.user.homeUserId,
      };
    }
  }
  return (
    <UsersList
      rows={result.rows}
      total={result.total}
      page={params.page}
      perPage={params.perPage}
      sort={params.sort}
      dir={params.dir}
      status={status}
      statusCounts={result.statusCounts}
      basePath={source.basePath}
      currentParams={sp}
      detail={detail}
    />
  );
}

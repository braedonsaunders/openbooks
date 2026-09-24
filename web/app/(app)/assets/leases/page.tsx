import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { Button, PageHeader } from "@openbooks/ui";
import Link from "next/link";
import { ListPageLayout } from "@/components/page-layout";
import { ModuleHomeTabs } from "@/components/module-home/ui";
import { groupTabs } from "@/components/module-home/group-tabs";
import { EntityListView } from "@/components/entity-list-view";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import {
  allowedSubsidiaryIds,
  subsidiaryVisibleFilter,
} from "@/lib/subsidiaries";
import { isUuid } from "@/lib/list-params";
import { loadLease } from "./_lib";
import { LeaseDrawer, NewLeaseButton } from "./LeaseDrawer";
export const dynamic = "force-dynamic";
export default async function LeasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requirePermission("assets.read");
  await requireFeatureEnabled(auth.user.orgId, "fixedAssets");
  const sp = await searchParams,
    orgId = auth.user.orgId;
  const allowed = await allowedSubsidiaryIds(auth.user.id, orgId);
  const [accounts, subsidiaries, payload] = await Promise.all([
    db.execute<{ value: string; label: string }>(
      sql`select id as value,number||' · '||name as label from accounts where org_id=${orgId} and is_active and not is_summary order by number`,
    ),
    db.execute<{ value: string; label: string }>(
      sql`select id as value,name as label from subsidiaries s where org_id=${orgId} and is_active and not is_elimination ${subsidiaryVisibleFilter(sql`s.id`, allowed)} order by name`,
    ),
    typeof sp.lease === "string" && isUuid(sp.lease)
      ? loadLease(orgId, sp.lease, allowed)
      : Promise.resolve(null),
  ]);
  const canManage = can(auth, "assets.manage");
  const t = await getTranslations("assets");
  const tabs = await groupTabs("accounting", "/assets/leases", { orgId });
  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("leases.pageTitle")}
          description={t("leases.pageDescription")}
          actions={
            <>
              {canManage ? (
                <NewLeaseButton
                  accounts={accounts.rows}
                  subsidiaries={subsidiaries.rows}
                />
              ) : null}
              <Button asChild variant="outline">
                <Link href="/accounting/changes">{t("leases.eventsTitle")}</Link>
              </Button>
              <ModuleHomeTabs tabs={tabs} />
            </>
          }
        />
      }
    >
      <EntityListView
        recordType="lease_agreement"
        orgId={orgId}
        userId={auth.user.id}
        canManage={canManage}
        sp={sp}
        drawer={
          payload ? (
            // Keyed by lease: the drawer holds useState-from-props (the
            // change/terminate form, its idempotency key), so switching
            // leases without a remount would pre-fill B with A's terms.
            <LeaseDrawer
              key={payload.lease.id}
              payload={payload}
              canManage={canManage}
              accounts={accounts.rows}
              subsidiaries={subsidiaries.rows}
            />
          ) : undefined
        }
      />
    </ListPageLayout>
  );
}

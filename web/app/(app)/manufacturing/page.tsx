import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { withScopeSnapshot } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import {
  listManufacturingRecords,
  type ManufacturingView,
} from "@openbooks/engine/src/manufacturing/workspace.ts";
import { manufacturingFeatureEnabled } from "@openbooks/engine/src/manufacturing/gate.ts";
import { requirePermission, can } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { PageHeader, Button, Card, CardContent } from "@openbooks/ui";
import { ListPageLayout } from "@/components/page-layout";
import { LiveDirectory } from "@/components/module-home/ui";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const t = await getTranslations("manufacturing");
  return { title: t("title") };
}
export default async function ManufacturingHome() {
  const authz = await requirePermission("manufacturing.read");
  await requireFeatureEnabled(authz.user.orgId, "manufacturing");
  const t = await getTranslations("manufacturing");
  const items = await withScopeSnapshot(authz.user.orgId, async () => {
    const views: ManufacturingView[] = [
      "work-orders",
      "work-centers",
      "routings",
    ];
    if (
      await manufacturingFeatureEnabled(
        authz.user.orgId,
        "manufacturingMrp",
        db,
      )
    )
      views.push("mrp");
    const result = [];
    for (const view of views) {
      const page = await listManufacturingRecords(
        db,
        authz.user.orgId,
        authz.allowedSubsidiaryIds,
        view,
      );
      result.push({
        href: "/manufacturing/" + view,
        label: t("titles." + view),
        iconKey:
          view === "mrp"
            ? "calendar-days"
            : view === "routings"
              ? "workflow"
              : view === "work-centers"
                ? "settings"
                : "package",
        badge: { value: String(page.total), hint: t("descriptions." + view) },
      });
    }
    return result;
  });
  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("title")}
          description={t("description")}
          actions={
            can(authz, "manufacturing.manage") ? (
              <Button asChild>
                <Link href="/manufacturing/work-orders?record=new">
                  {t("new.work-orders")}
                </Link>
              </Button>
            ) : undefined
          }
        />
      }
    >
      <Card>
        <CardContent className="space-y-4 pt-5">
          <h2 className="text-lg font-semibold">{t("homeTitle")}</h2>
          <p className="max-w-3xl text-sm text-slate-500">{t("homeNote")}</p>
          <LiveDirectory items={items} />
          {can(authz, "admin.setup.manage") &&
          authz.allowedSubsidiaryIds === null ? (
            <Button variant="outline" asChild>
              <Link href="/admin/setup/manufacturing">{t("setup")}</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </ListPageLayout>
  );
}

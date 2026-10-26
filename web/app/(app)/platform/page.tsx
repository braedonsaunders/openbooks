import { PlatformHub } from "@braedonsaunders/appkit-superadmin/react";
import { ShieldCheck } from "lucide-react";
import { platformSummary } from "../../../lib/platform-admin";
import { getFormatter, getTranslations } from "next-intl/server";
import { createOpenBooksPlatformNav } from "../../../lib/platform-console";

export const dynamic = "force-dynamic";

export default async function PlatformPage() {
  const format = await getFormatter();
  const t = await getTranslations("platform");
  const summary = await platformSummary();
  const tiles = createOpenBooksPlatformNav(t).tiles.map((tile) => {
    if (tile.id === "tenants") {
      return {
        ...tile,
        stat: format.number(summary.organizations),
        detail: t("hub.organizationsDetail", {
          production: format.number(summary.productionOrganizations),
          nonProduction: format.number(summary.environments),
        }),
      };
    }
    if (tile.id === "users") {
      return {
        ...tile,
        stat: format.number(summary.activeUsers),
        detail: t("hub.superAdminsDetail", { count: summary.superAdmins }),
      };
    }
    if (tile.id === "access") {
      return {
        ...tile,
        stat: format.number(summary.activeGrants),
        detail: t("hub.activeGrantsDetail"),
      };
    }
    if (tile.id === "emailLog") {
      return {
        ...tile,
        stat: format.number(summary.failedEmails),
        detail: t("hub.failedDeliveriesDetail"),
      };
    }
    return tile;
  });

  return (
    <PlatformHub
      title={t("hub.title")}
      description={t("hub.description")}
      tiles={tiles}
      notice={
        <div className="rounded-xl border border-warning/30 bg-warning-subtle/70 p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-warning-subtle text-warning ring-1 ring-warning/20">
              <ShieldCheck size={20} />
            </span>
            <div>
              <p className="text-sm font-semibold text-fg">{t("notice.title")}</p>
              <p className="mt-0.5 text-sm text-fg-muted">{t("notice.description")}</p>
            </div>
          </div>
        </div>
      }
    />
  );
}

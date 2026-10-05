import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can, getAuthz } from "../../../../lib/authz";
import { CommerceError } from "@openbooks/engine/src/commerce/errors.ts";
import { getChannel } from "@openbooks/engine/src/commerce/channels.ts";
import { listInboundEvents } from "@openbooks/engine/src/commerce/inbound.ts";
import { workspaceTabsFor } from "@openbooks/engine/src/commerce/adapters.ts";
import { SETUP_ENTITY_BY_KEY } from "../../../../lib/setup/registry";
import { DetailPageLayout } from "../../../../components/page-layout";
import { Badge } from "@openbooks/ui";
import { DetailHeader } from "@openbooks/ui";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { ChannelActions } from "./ChannelActions";
import { ChannelActivity } from "./ChannelActivity";
import { ProductsTab } from "./ProductsTab";
import { LocationsTab } from "./LocationsTab";
import { SettingsTab } from "./SettingsTab";
import { SetupEntitySection } from "../../admin/setup/[entity]/SetupEntitySection";

const STATUS_VARIANT: Record<string, "success" | "secondary" | "outline" | "destructive" | "warning"> = {
  active: "success",
  paused: "outline",
  error: "destructive",
};

async function loadChannel(orgId: string, channelId: string) {
  try {
    return await getChannel(orgId, channelId);
  } catch (error) {
    if (error instanceof CommerceError && error.code === "channel_not_found") notFound();
    throw error;
  }
}

/**
 * One storefront's workspace. Overview and Settings render on the server;
 * Activity, Products and Locations are client tables over the channel
 * endpoints. Adapter packs contribute further tabs through
 * `workspaceTabs()`; with no connector installed the core three stand
 * alone.
 */
export async function ChannelWorkspace({
  channelId,
  tab,
  sp,
}: {
  channelId: string;
  tab: string;
  sp: Record<string, string | string[] | undefined>;
}) {
  const authz = await getAuthz();
  if (!authz) notFound();
  if (!can(authz, "channels.read")) notFound();
  const t = await getTranslations("channels");
  const channel = await loadChannel(authz.user.orgId, channelId);
  const canManage = can(authz, "channels.manage");
  // Connector-contributed tabs arrive through the channel adapter's
  // `workspaceTabs()`; a kind with no adapter contributes none, so the
  // built-in tabs stand alone instead of refusing. An adapter key the
  // channel's own adapter did not contribute falls back to overview.
  const adapterTabs = workspaceTabsFor(channel.kind);
  const adapterKeys = new Set(adapterTabs.map((adapterTab) => `adapter:${adapterTab.key}`));
  const activeTab = tab === "activity" || tab === "settings" || adapterKeys.has(tab) ? tab : "overview";
  const statusLabel = t.has(`status.${channel.status}`) ? t(`status.${channel.status}`) : channel.status;

  return (
    <DetailPageLayout
      header={
        <DetailHeader
          back={{ href: "/channels", label: t("workspace.back") }}
          title={channel.name}
          subtitle={`${channel.kind} · ${channel.externalAccount} · ${channel.currency}`}
          badge={<Badge variant={STATUS_VARIANT[channel.status] ?? "secondary"}>{statusLabel}</Badge>}
          actions={
            <ChannelActions
              channelId={channel.id}
              channelName={channel.name}
              status={channel.status}
              canManage={canManage}
            />
          }
        />
      }
      subtabs={
        <WorkspaceTabs
          basePath={`/channels/${channel.id}`}
          activeTab={activeTab}
          tabs={[
            { key: "overview", label: t("workspace.tabs.overview") },
            { key: "activity", label: t("workspace.tabs.activity") },
            { key: "settings", label: t("workspace.tabs.settings") },
            ...adapterTabs.map((adapterTab) => ({
              key: `adapter:${adapterTab.key}` as const,
              label: t.has(adapterTab.labelKey) ? t(adapterTab.labelKey) : adapterTab.labelKey,
            })),
          ]}
        />
      }
    >
      {activeTab === "overview" ? (
        <WorkspaceOverview channelId={channel.id} />
      ) : activeTab === "activity" ? (
        <ChannelActivity channelId={channel.id} canManage={canManage} />
      ) : activeTab === "adapter:products" ? (
        <ProductsTab channelId={channel.id} currency={channel.currency} canManage={canManage} />
      ) : activeTab === "adapter:locations" ? (
        <LocationsTab channelId={channel.id} canManage={canManage} />
      ) : (
        <WorkspaceSettings channelId={channel.id} canManage={canManage} sp={sp} />
      )}
    </DetailPageLayout>
  );
}

async function WorkspaceOverview({ channelId }: { channelId: string }) {
  const authz = await getAuthz();
  if (!authz) notFound();
  const t = await getTranslations("channels");
  const channel = await loadChannel(authz.user.orgId, channelId);
  const events = await listInboundEvents(authz.user.orgId, channelId, 5);
  const healthEntries = Object.entries(channel.health ?? {});
  const outstanding = events.filter((event) => event.status === "failed" || event.status === "dead").length;
  return (
    <div className="space-y-5">
      {channel.status === "connecting" ? (
        <p className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
          {t("workspace.reviewBanner")}{" "}
          <a className="font-medium underline" href={`/channels/connect?channel=${channel.id}`}>
            {t("workspace.reviewCta")}
          </a>
        </p>
      ) : null}
      {outstanding > 0 ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {t("workspace.attentionBanner", { count: outstanding })}
        </p>
      ) : null}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-medium">{t("workspace.healthTitle")}</h2>
        {healthEntries.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">{t("workspace.healthEmpty")}</p>
        ) : (
          <dl className="mt-2 divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {healthEntries.map(([stream, state]) => (
              <div key={stream} className="flex items-center justify-between gap-3 py-1.5">
                <dt className="text-slate-500">{stream}</dt>
                <dd className="font-medium">{String(state)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-medium">{t("workspace.recentTitle")}</h2>
        {events.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">{t("workspace.recentEmpty")}</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {events.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate">
                  {event.topic} <span className="text-slate-400">{event.providerEventId}</span>
                </span>
                <Badge variant={STATUS_VARIANT[event.status] ?? "secondary"}>
                  {t.has(`activity.status.${event.status}`) ? t(`activity.status.${event.status}`) : event.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function WorkspaceSettings({
  channelId,
  canManage,
  sp,
}: {
  channelId: string;
  canManage: boolean;
  sp: Record<string, string | string[] | undefined>;
}) {
  const authz = await getAuthz();
  if (!authz) notFound();
  const t = await getTranslations("channels");
  const maps = SETUP_ENTITY_BY_KEY.get("channel-account-maps");
  const locations = SETUP_ENTITY_BY_KEY.get("channel-locations");
  if (!maps || !locations) notFound();
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">{t("workspace.settingsHint")}</p>
      <SetupEntitySection
        entity={maps}
        orgId={authz.user.orgId}
        actorId={authz.user.id}
        searchParams={sp}
        basePath={`/channels/${channelId}`}
        canManage={canManage}
        allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
        rowParam="mapRow"
        paramPrefix="map"
        fixedFilter={{ fieldKey: "channelId", value: channelId }}
        hideHeader={false}
      />
      <SetupEntitySection
        entity={locations}
        orgId={authz.user.orgId}
        actorId={authz.user.id}
        searchParams={sp}
        basePath={`/channels/${channelId}`}
        canManage={canManage}
        allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
        rowParam="locationRow"
        paramPrefix="location"
        fixedFilter={{ fieldKey: "channelId", value: channelId }}
        hideHeader={false}
      />
      <SettingsTab channelId={channelId} />
    </div>
  );
}

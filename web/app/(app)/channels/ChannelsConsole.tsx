'use client'

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useViewerFormat } from "@/lib/viewer-format";
import { createMoneyFormatter, minorToMajorText } from "@/lib/money-format";
import { toast } from "sonner";
import Link from "next/link";
import { Layers, Pause, Play, Plug, Unplug } from "lucide-react";
import {
  Badge,
  Button,
  DisclosureSection,
  Drawer,
  EmptyState,
  Input,
  Label,
  PageHeader,
} from "@openbooks/ui";
import { ListPageLayout } from "../../../components/page-layout";
import { CockpitPanel, StatTile } from "../../../components/cockpit/ui";
import { CommerceCloseTile } from "./CommerceCloseTile";
import { NewMenuButton } from "../../../components/new-menu-button";
import { readApiErrorMessage } from "../../../lib/api-error";
import { confirmDialog } from "@/lib/confirm";
import { promptDialog } from "@/lib/prompt";
import { channelCards, type Channel, type MarginChannel } from "./channel-cards";

interface Payload {
  channels: Channel[];
  kinds: string[];
}

const STATUS_VARIANT: Record<string, "success" | "secondary" | "outline" | "destructive" | "warning"> = {
  active: "success",
  paused: "outline",
  error: "destructive",
  dead: "destructive",
  failed: "warning",
};

export function ChannelsConsole() {
  const router = useRouter();
  const locale = useLocale();
  const { dateTime } = useViewerFormat();
  const fmt = (ts: string | null) => (ts ? dateTime(new Date(ts)) : "—");
  const t = useTranslations("channels");
  const tCommon = useTranslations("common");
  const [data, setData] = useState<Payload | null>(null);
  const [margin, setMargin] = useState<MarginChannel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [connectKind, setConnectKind] = useState<string | null>(null);

  const load = useCallback(() => {
    return fetch("/api/channels")
      .then(async (res) => {
        // The status is checked before the body is parsed: a 403 names its
        // grant and lands in the error panel below, never in the empty state.
        if (!res.ok) {
          setLoadError(await readApiErrorMessage(res, t("home.toast.loadFailed", { status: res.status })));
          setLoading(false);
          return;
        }
        const payload = (await res.json()) as Payload;
        setData(payload);
        setLoadError(null);
        setLoading(false);
      })
      .catch(() => {
        setLoadError(t("home.toast.loadFailed", { status: "network" }));
        setLoading(false);
      });
  }, [t]);

  // Trailing order margin loads beside the channels: a margin failure hides
  // the panel, never the console.
  useEffect(() => {
    fetch("/api/channels/economics/summary?days=30")
      .then(async (res) => {
        if (!res.ok) return;
        const payload = (await res.json()) as { channels: MarginChannel[] };
        setMargin(payload.channels);
      })
      .catch(() => {});
  }, []);

  // Kinds with a guided connect flow leave the generic drawer for
  // their wizard: OAuth and the match review cannot run inside a
  // name-and-secret form.
  function connect(kind: string) {
    if (kind === "shopify") {
      router.push("/channels/connect");
      return;
    }
    setConnectKind(kind);
  }

  function retryLoad() {
    setLoadError(null);
    setLoading(true);
    void load();
  }

  useEffect(() => {
    void load();
  }, [load]);

  async function lifecycle(channel: Channel, action: "pause" | "resume" | "disconnect") {
    const reason = await promptDialog({
      title: t(`home.${action}Title`, { name: channel.name }),
      message: t(`home.${action}Body`),
      label: t("home.reasonLabel"),
      confirmLabel: t(`home.${action}Confirm`),
    });
    if (!reason) return;
    if (action === "disconnect" && !(await confirmDialog(t("home.disconnectVerify", { name: channel.name })))) return;
    setBusy(`${channel.id}:${action}`);
    try {
      const res = await fetch(`/api/channels/${channel.id}/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t("home.toast.actionFailed", { status: res.status })));
        return;
      }
      toast.success(t(`home.toast.${action}d`));
      await load();
    } catch {
      toast.error(t("home.toast.actionFailed", { status: "network" }));
    } finally {
      setBusy(null);
    }
  }

  const channels = data?.channels ?? [];
  const kinds = data?.kinds ?? [];
  const active = channels.filter((c) => c.status === "active").length;
  // One parent collection: every channel once, attention and margins inline.
  const cards = channelCards(channels, margin);
  const attentionCount = cards.reduce((sum, card) => sum + card.outstanding, 0);
  const lastDelivery = channels
    .map((c) => c.attention.lastReceivedAt)
    .filter((ts): ts is string => ts != null)
    .sort()
    .at(-1) ?? null;
  const statusLabel = (s: string) => (t.has(`status.${s}`) ? t(`status.${s}`) : s);

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("home.title")}
          description={t("home.description")}
          actions={
            kinds.length > 0 ? (
              <NewMenuButton
                label={t("home.connect")}
                busyLabel={tCommon("actions.loading")}
                items={kinds.map((kind) => ({ key: kind, label: kind }))}
                onSelect={(key) => connect(key)}
              />
            ) : null
          }
        />
      }
    >
      {loading ? (
        <p className="text-sm text-slate-500">{tCommon("actions.loading")}</p>
      ) : loadError ? (
        <EmptyState
          title={t("home.loadFailedTitle")}
          description={loadError}
          action={<Button onClick={retryLoad}>{tCommon("actions.retry")}</Button>}
        />
      ) : channels.length === 0 ? (
        <EmptyState
          icon={<Layers size={20} />}
          title={t("home.emptyTitle")}
          description={t("home.emptyBody")}
          action={
            kinds.length > 0 ? (
              <NewMenuButton
                label={t("home.connect")}
                busyLabel={tCommon("actions.loading")}
                items={kinds.map((kind) => ({ key: kind, label: kind }))}
                onSelect={(key) => connect(key)}
              />
            ) : (
              <Button asChild>
                <Link href="/admin/setup/features">{t("home.emptyFeaturesAction")}</Link>
              </Button>
            )
          }
        />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label={t("home.tiles.active")} value={String(active)} icon={Plug} />
            <StatTile
              label={t("home.tiles.attention")}
              value={String(attentionCount)}
              sub={attentionCount > 0 ? t("home.tiles.attentionSub") : t("home.tiles.attentionClear")}
              icon={Layers}
              tone={attentionCount > 0 ? "warning" : "positive"}
            />
            <StatTile
              label={t("home.tiles.ordersToday")}
              value="0"
              sub={t("home.tiles.ordersTodaySub")}
              icon={Layers}
            />
            <StatTile label={t("home.tiles.lastDelivery")} value={fmt(lastDelivery)} icon={Layers} />
          </div>
          <CommerceCloseTile />
          <CockpitPanel
            title={t("home.channelsTitle")}
            hint={t("home.channelsHint")}
            actions={
              <Button size="sm" variant="outline" asChild>
                <Link href="/reports">{t("home.marginReport")}</Link>
              </Button>
            }
          >
            <ul className="grid gap-3 md:grid-cols-2">
              {cards.map(({ channel, outstanding, marginRows }) => {
                return (
                  <li
                    key={channel.id}
                    className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          <Link href={`/channels/${channel.id}`} className="hover:underline">
                            {channel.name}
                          </Link>
                        </p>
                        <p className="truncate text-sm text-slate-500">
                          {channel.kind} · {channel.externalAccount} · {channel.currency}
                        </p>
                      </div>
                      <Badge variant={STATUS_VARIANT[channel.status] ?? "secondary"}>
                        {statusLabel(channel.status)}
                      </Badge>
                    </div>
                    {outstanding > 0 ? (
                      <p className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-200">
                        {t("home.attentionReason", {
                          failed: channel.attention.failed,
                          dead: channel.attention.dead,
                        })}{" "}
                        <Link
                          href={`/channels/${channel.id}?tab=activity`}
                          className="font-normal text-teal-700 hover:underline dark:text-teal-300"
                        >
                          {t("home.review")}
                        </Link>
                      </p>
                    ) : (
                      <p className="mt-2 text-sm text-slate-500">
                        {t("home.cardClear", { delivery: fmt(channel.attention.lastReceivedAt) })}
                      </p>
                    )}
                    {marginRows.map((row) => {
                      const money = createMoneyFormatter(locale, row.currency);
                      const formatted = (minor: string) =>
                        money.money(minorToMajorText(minor), { currency: row.currency });
                      const revenue = BigInt(row.revenueMinor);
                      const cm2 = BigInt(row.cm2Minor);
                      const pct = revenue > 0n ? Number((cm2 * 10000n) / revenue) / 100 : null;
                      return (
                        <p key={`${row.channelId}|${row.currency}`} className="mt-1 text-sm text-slate-500">
                          {t("home.marginMeta", {
                            orders: row.orders,
                            revenue: formatted(row.revenueMinor),
                            adSpend: formatted(row.adSpendMinor),
                          })}{" "}
                          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {formatted(row.cm2Minor)}
                          </span>
                          {pct != null ? (
                            <Badge variant="secondary">{t("home.marginPct", { pct: pct.toFixed(2) })}</Badge>
                          ) : null}
                          {row.estimatedOrders > 0 ? (
                            <Badge variant="warning">
                              {t("home.marginEstimated", { count: row.estimatedOrders })}
                            </Badge>
                          ) : null}
                        </p>
                      );
                    })}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/channels/${channel.id}`}>{t("home.open")}</Link>
                      </Button>
                      {channel.status === "active" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy != null}
                          onClick={() => void lifecycle(channel, "pause")}
                        >
                          <Pause size={14} /> {t("home.pause")}
                        </Button>
                      ) : null}
                      {channel.status === "paused" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy != null}
                          onClick={() => void lifecycle(channel, "resume")}
                        >
                          <Play size={14} /> {t("home.resume")}
                        </Button>
                      ) : null}
                      {channel.status !== "disconnected" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy != null}
                          onClick={() => void lifecycle(channel, "disconnect")}
                        >
                          <Unplug size={14} /> {t("home.disconnect")}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </CockpitPanel>
          <DisclosureSection title={t("home.advancedTitle")} summary={t("home.advancedSummary")}>
            <p className="text-sm text-slate-500">{t("home.advancedBody")}</p>
          </DisclosureSection>
        </div>
      )}
      {connectKind ? (
        <ConnectDrawer kind={connectKind} onClose={() => setConnectKind(null)} onConnected={() => void load()} />
      ) : null}
    </ListPageLayout>
  );
}

function ConnectDrawer({ kind, onClose, onConnected }: {
  kind: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const t = useTranslations("channels");
  const tCommon = useTranslations("common");
  const [name, setName] = useState("");
  const [externalAccount, setExternalAccount] = useState("");
  const [currency, setCurrency] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, name, externalAccount, currency, settings: {} }),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("home.toast.createFailed", { status: res.status })));
        return;
      }
      const payload = (await res.json()) as { webhookSecret: string | null };
      // The signing secret is shown once: the operator registers it with the
      // storefront now, then it seals and never reads back.
      setSecret(payload.webhookSecret);
      toast.success(t("home.toast.connected"));
      onConnected();
    } catch {
      setError(t("home.toast.createFailed", { status: "network" }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={t("home.connectTitle", { kind })}
      description={t("home.connectBody")}
      footer={
        secret ? (
          <Button onClick={onClose}>{tCommon("actions.done")}</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {tCommon("actions.cancel")}
            </Button>
            <Button onClick={() => void connect()} disabled={busy || !name.trim() || !externalAccount.trim()}>
              {t("home.connectConfirm")}
            </Button>
          </>
        )
      }
    >
      {secret ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-500">{t("home.secretBody")}</p>
          <p className="break-all rounded-lg bg-slate-100 p-3 font-mono text-sm dark:bg-slate-800">{secret}</p>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("home.connectNameLabel")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("home.connectNamePlaceholder")} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("home.connectAccountLabel")}</Label>
            <Input
              value={externalAccount}
              onChange={(e) => setExternalAccount(e.target.value)}
              placeholder={t("home.connectAccountPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("home.connectCurrencyLabel")}</Label>
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="USD" maxLength={3} />
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
      )}
    </Drawer>
  );
}

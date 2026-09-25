"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useViewerFormat } from "@/lib/viewer-format";
import { promptDialog } from "../../../../lib/prompt";
import { confirmDialog } from "../../../../lib/confirm";
import { Badge, Button, Card, Input, Label, Select } from "@openbooks/ui";
import {
  createSandboxAction,
  deleteSandboxAction,
  promoteSandboxAction,
  refreshSandboxAction,
  resetSandboxAction,
  setScheduleAction,
} from "./actions";
import { enterOrg } from "../../../../lib/sandbox-session";

export type PeriodOption = {
  id: string;
  name: string;
  endsOn: string;
  calendarName: string;
};

export interface SandboxRow {
  id: string;
  orgId: string;
  name: string;
  tier: string;
  masked: boolean;
  status: string;
  lastError: string | null;
  lastRefreshAt: string | null;
  refreshSchedule: string | null;
  storageRows: number;
  createdAt: string;
}

const STATUS_VARIANT: Record<string, "default" | "warning" | "destructive" | "success" | "secondary"> = {
  ready: "success",
  provisioning: "warning",
  refreshing: "warning",
  deleting: "warning",
  failed: "destructive",
};

export function SandboxManager({
  sandboxes,
  periods,
}: {
  sandboxes: SandboxRow[];
  periods: PeriodOption[];
}) {
  const { dateTime, number } = useViewerFormat();
  const t = useTranslations("admin.sandboxManager");
  const [name, setName] = useState("");
  const [tier, setTier] = useState("masked");
  const [asOfPeriodId, setAsOfPeriodId] = useState("");
  const [pending, start] = useTransition();
  // One idempotency key per create-form instance, rotated after success: a
  // double-click or retried submit reuses the key and dedupes in BullMQ,
  // while the next intentional create mints a new one.
  const createKey = useRef(crypto.randomUUID());
  // Same per sandbox row for refresh/reset/delete.
  const opKeys = useRef<Record<string, string>>({});
  const opKeyFor = (sandboxId: string): string => {
    const existing = opKeys.current[sandboxId];
    if (existing) return existing;
    const minted = crypto.randomUUID();
    opKeys.current[sandboxId] = minted;
    return minted;
  };
  const rotateOpKey = (sandboxId: string): void => {
    opKeys.current[sandboxId] = crypto.randomUUID();
  };
  // An as-of clone needs a period cutoff; block create until one is chosen.
  const needsPeriod = tier === "as_of" && !asOfPeriodId;

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("newEnvironment")}</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t("description")}
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="grow">
            <Label htmlFor="sbx-name">{t("name")}</Label>
            <Input
              id="sbx-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
            />
          </div>
          <div>
            <Label htmlFor="sbx-tier">{t("tier")}</Label>
            <Select id="sbx-tier" value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="masked">{t("tiers.masked")}</option>
              <option value="full">{t("tiers.full")}</option>
              <option value="dev">{t("tiers.dev")}</option>
              <option value="as_of">{t("tiers.asOf")}</option>
            </Select>
          </div>
          {tier === "as_of" && (
            <div>
              <Label htmlFor="sbx-period">{t("asOfPeriod")}</Label>
              <Select
                id="sbx-period"
                value={asOfPeriodId}
                onChange={(e) => setAsOfPeriodId(e.target.value)}
              >
                <option value="">{t("choosePeriod")}</option>
                {periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t("periodOption", { name: p.name, endsOn: p.endsOn, calendar: p.calendarName })}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {t("periodCount", { count: periods.length })}
              </p>
            </div>
          )}
          <Button
            disabled={pending || needsPeriod}
            onClick={() =>
              start(async () => {
                await createSandboxAction({
                  name,
                  tier: tier as unknown as "masked" | "as_of" | "dev" | "full",
                  asOfPeriodId: tier === "as_of" ? asOfPeriodId : null,
                  clientOpKey: createKey.current,
                });
                setName("");
                setAsOfPeriodId("");
                createKey.current = crypto.randomUUID();
              })
            }
          >
            {t("create")}
          </Button>
        </div>
        {tier === "as_of" && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {t("cutoffDescription")}
          </p>
        )}
      </Card>

      <div className="space-y-3">
        <Button asChild variant="outline"><Link href="/admin/sandboxes/change-sets">{t("reviewChanges")}</Link></Button>
        {sandboxes.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t("none")}</p>
        )}
        {sandboxes.map((s) => (
          <Card key={s.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">{s.name}</span>
                  <Badge variant={STATUS_VARIANT[s.status] ?? "secondary"}>{t.has(`statuses.${s.status}`) ? t(`statuses.${s.status}`) : t("statuses.unknown")}</Badge>
                  <Badge variant="outline">{t.has(`tiers.${s.tier}`) ? t(`tiers.${s.tier}`) : t("tiers.unknown")}</Badge>
                  {s.masked && <Badge variant="secondary">{t("masked")}</Badge>}
                </div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {t("storageSummary", {
                    records: number(s.storageRows),
                    refreshed: s.lastRefreshAt ? t("refreshed", { when: dateTime(new Date(s.lastRefreshAt)) }) : t("neverRefreshed"),
                    schedule: s.refreshSchedule ? t.has(`schedule.${s.refreshSchedule}`) ? t(`schedule.${s.refreshSchedule}`) : t("schedule.unknown") : "none",
                  })}
                </div>
                {s.lastError && (
                  <div className="mt-1 text-xs text-red-600 dark:text-red-400">{s.lastError}</div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  disabled={s.status !== "ready"}
                  onClick={() => start(async () => void (await enterOrg(s.orgId)))}
                >
                  {t("enter")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || s.status !== "ready"}
                  onClick={() =>
                    start(async () => {
                      await refreshSandboxAction(s.id, true, opKeyFor(s.id));
                      rotateOpKey(s.id);
                    })
                  }
                  title={t("refreshTitle")}
                >
                  {t("refresh")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || s.status !== "ready"}
                  onClick={() =>
                    start(async () => {
                      if (await confirmDialog(t("resetConfirm"))) {
                        await resetSandboxAction(s.id, opKeyFor(s.id));
                        rotateOpKey(s.id);
                      }
                    })
                  }
                >
                  {t("reset")}
                </Button>
                <PromoteButton sandboxId={s.id} disabled={pending || s.status !== "ready"} />
                <Select
                  aria-label={t("autoRefresh")}
                  className="h-8 w-28"
                  value={s.refreshSchedule ?? ""}
                  onChange={(e) => start(async () => void (await setScheduleAction(s.id, e.target.value || null)))}
                >
                  <option value="">{t("schedule.manual")}</option>
                  <option value="hourly">{t("schedule.hourly")}</option>
                  <option value="daily">{t("schedule.daily")}</option>
                  <option value="weekly">{t("schedule.weekly")}</option>
                </Select>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      if (await confirmDialog(t("deleteConfirm", { name: s.name }))) {
                        await deleteSandboxAction(s.id, opKeyFor(s.id));
                        rotateOpKey(s.id);
                      }
                    })
                  }
                >
                  {t("delete")}
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function PromoteButton({ sandboxId, disabled }: { sandboxId: string; disabled: boolean }) {
  const t = useTranslations("admin.sandboxManager");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return <div className="space-y-1">
    <Button variant="secondary" size="sm" disabled={disabled || pending} onClick={() => start(async () => {
      const name = await promptDialog({ title: t("changeSetName"), initialValue: t("changeSetDefaultName"), confirmLabel: t("captureChanges") });
      if (!name) return;
      setError(null);
      try {
        const result = await promoteSandboxAction(sandboxId, name);
        router.push(`/admin/sandboxes/change-sets?changeSet=${encodeURIComponent(result.changeSetId)}`);
      } catch { setError(t("captureFailed")); }
    })} title={t("captureTitle")}>{t("captureChanges")}</Button>
    {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
  </div>;
}

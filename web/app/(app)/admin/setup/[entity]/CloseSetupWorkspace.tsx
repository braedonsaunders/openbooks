"use client";

import { ModuleHomeTabs } from "@/components/module-home/tabs";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@openbooks/ui";
import { mergeHref, pickString } from "../../../../../lib/list-params";
import { BASE, TABS, type Tab } from "./close-setup-shared";
import type { Props } from "./close-setup-types";
import { CalendarsTab } from "./close-setup-calendars";
import { PeriodsTab } from "./close-setup-periods";
import { BlueprintsTab } from "./close-setup-blueprints";
import { AutomationTab, PoliciesTab } from "./close-setup-policies";
import { PackagesTab } from "./close-setup-packages";

export type {
  AutomationDraft,
  AutomationRow,
  BankingReconAccount,
  BlueprintBaseRow,
  BlueprintDraft,
  BlueprintRow,
  BlueprintStepDraft,
  BlueprintStepRow,
  CalendarDraft,
  CalendarOptionRow,
  CalendarRow,
  CloseSetupBookRow,
  PackageDraft,
  PackageRow,
  PeriodLockState,
  PeriodRow,
  PolicyDraft,
  PolicyRow,
  ReopenRow,
  ReportDefEntry,
  SetupRoleRow,
  SetupUserRow,
} from "./close-setup-types";

export function CloseSetupWorkspace(props: Props) {
  const t = useTranslations("close.setup");
  const visibleTabs: readonly Tab[] = props.advancedClose ? TABS : ["calendars", "periods"];
  const rawTab = pickString(props.currentParams.tab);
  const tab: Tab = visibleTabs.includes(rawTab as Tab) ? (rawTab as Tab) : "calendars";
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t("title")}</h2>
        <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">{t("description")}</p>
      </div>
      {!props.advancedClose ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50/70 p-4 text-sm text-teal-900 dark:border-teal-900 dark:bg-teal-950/30 dark:text-teal-200">
          <span>{t("simpleMode")}</span>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/setup/features">{t("enableAdvanced")}</Link>
          </Button>
        </div>
      ) : null}
      <ModuleHomeTabs
        tabs={visibleTabs.map((key) => ({
          href: mergeHref(BASE, props.currentParams, { tab: key }),
          label: t(`tabs.${key}`),
          active: tab === key,
        }))}
      />
      {tab === "calendars" ? <CalendarsTab {...props} /> : null}
      {tab === "periods" ? <PeriodsTab {...props} /> : null}
      {tab === "blueprints" ? <BlueprintsTab {...props} /> : null}
      {tab === "policies" ? <PoliciesTab {...props} /> : null}
      {tab === "automation" ? <AutomationTab {...props} /> : null}
      {tab === "packages" ? <PackagesTab {...props} /> : null}
    </div>
  );
}

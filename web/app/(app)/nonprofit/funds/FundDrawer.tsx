"use client";

import { useMoney } from "@/components/money-provider";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  UrlDrawer,
} from "@openbooks/ui";
import { DrawerTabStrip } from "@/components/drawer-tab-strip";
import { useAppAction } from "@/lib/use-app-action";
import type { FundDrawerData, FundCreateDrawerData } from "./view";

type FundTab = "details" | "pairs" | "releases";
const FUND_KINDS = ["operating", "restricted", "endowment", "plant", "board_designated"] as const;
const BUDGETARY_CONTROL_MODES = ["off", "advisory", "hard"] as const;

const RELEASE_STATUS_VARIANT: Record<string, "success" | "secondary" | "warning" | "outline"> = {
  draft: "outline",
  pending_approval: "warning",
  posted: "success",
  void: "secondary",
};

/**
 * Fund record drawer — classification, interfund pairs, and recent releases.
 * Read-only by design: funds change through the fund commands, and releases
 * move through their approval lifecycle, so the drawer links onward instead
 * of editing in place.
 */
export function FundDrawer({ drawer }: { drawer: FundDrawerData | FundCreateDrawerData }) {
  const { money } = useMoney();
  const t = useTranslations("nonprofit");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const action = useAppAction();
  const [tab, setTab] = useState<FundTab>("details");
  const [form, setForm] = useState({
    code: "",
    name: "",
    kind: "operating",
    restrictionClass: "",
    budgetaryControl: "off",
  });

  if (drawer.mode === "create") {
    async function createFund() {
      await action.execute(
        () =>
          fetchAction<{ fund: { id: string } }>("/api/funds/commands", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "create", ...form }),
          }),
        {
          fallbackMessage: tCommon("feedback.createFailed"),
          successMessage: tCommon("feedback.saved"),
          onOk: ({ fund }) => {
            router.push(`/nonprofit/funds?fund=${fund.id}`);
            router.refresh();
          },
        },
      );
    }

    return (
      <UrlDrawer
        open
        closeHref={drawer.closeHref}
        size="2xl"
        title={tCommon("actions.newRecord")}
        description={t("funds.details")}
      >
        <ActionAlert error={action.refusal} fallbackMessage={tCommon("feedback.createFailed")} />
        <div className="grid gap-4 p-1 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="fund-code">{t("funds.code")}</Label>
            <Input
              id="fund-code"
              value={form.code}
              onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fund-name">{tCommon("labels.name")}</Label>
            <Input
              id="fund-name"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fund-kind">{t("funds.kind")}</Label>
            <Select
              id="fund-kind"
              value={form.kind}
              onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value }))}
            >
              {FUND_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`funds.kinds.${kind}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fund-restriction-class">{t("funds.restrictionClass")}</Label>
            <Input
              id="fund-restriction-class"
              value={form.restrictionClass}
              onChange={(event) =>
                setForm((current) => ({ ...current, restrictionClass: event.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fund-budgetary-control">{t("funds.budgetaryControl")}</Label>
            <Select
              id="fund-budgetary-control"
              value={form.budgetaryControl}
              onChange={(event) =>
                setForm((current) => ({ ...current, budgetaryControl: event.target.value }))
              }
            >
              {BUDGETARY_CONTROL_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`funds.controlModes.${mode}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <Button
            variant="outline"
            disabled={action.busy}
            onClick={() => router.push(drawer.closeHref)}
          >
            {tCommon("actions.cancel")}
          </Button>
          <Button
            disabled={
              action.busy || !form.code.trim() || !form.name.trim() || !form.restrictionClass.trim()
            }
            onClick={() => void createFund()}
          >
            {tCommon("actions.create")}
          </Button>
        </div>
      </UrlDrawer>
    );
  }

  const fund = drawer.fund;

  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">{fund.code}</span>
          <span>{fund.name}</span>
          <Badge variant={fund.isActive ? "success" : "outline"}>
            {fund.isActive ? t("funds.active") : t("funds.archived")}
          </Badge>
        </span>
      }
      description={t("funds.details")}
      subtabs={
        <DrawerTabStrip
          ariaLabel={t("funds.tabsAria")}
          activeKey={tab}
          onSelect={setTab}
          tabs={(
            [
              { key: "details", label: tCommon("auditTrail.tabs.details") },
              { key: "pairs", label: t("funds.pairs") },
              { key: "releases", label: t("funds.recentReleases") },
            ] as const
          ).map((item) => ({ key: item.key, label: item.label }))}
        />
      }
      headerActions={
        drawer.canCustomize ? (
          <div className="flex items-center gap-1.5">
            <Button asChild variant="outline" size="sm" className="h-8 px-2.5 text-xs">
              <Link href="/admin/customization?recordType=fund&tab=forms">
                {tCommon("actions.customize")}
              </Link>
            </Button>
          </div>
        ) : undefined
      }
    >
      {tab === "details" ? (
        <div className="grid gap-4 p-1 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t("funds.code")}
            </p>
            <p className="font-mono text-sm">{fund.code}</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t("funds.kind")}
            </p>
            <p className="text-sm">{fund.kind}</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t("funds.restrictionClass")}
            </p>
            <p className="text-sm">{fund.restrictionClass}</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t("funds.budgetaryControl")}
            </p>
            <p className="text-sm">{fund.budgetaryControl}</p>
          </div>
        </div>
      ) : null}
      {tab === "pairs" ? (
        <div className="space-y-3 p-1">
          {drawer.pairs.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("funds.pairsEmpty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("funds.pair")}</TableHead>
                  <TableHead>{t("funds.settlementAccounts")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drawer.pairs.map((pair) => (
                  <TableRow key={pair.id}>
                    <TableCell className="font-mono text-[13px]">
                      {pair.fromCode} → {pair.toCode}
                    </TableCell>
                    <TableCell className="font-mono text-[13px]">
                      {pair.dueFromNumber ?? "—"} / {pair.dueToNumber ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      ) : null}
      {tab === "releases" ? (
        <div className="space-y-3 p-1">
          {drawer.releases.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("funds.releasesEmpty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("releases.title")}</TableHead>
                  <TableHead>{t("releases.releaseDate")}</TableHead>
                  <TableHead className="text-right">{t("releases.amount")}</TableHead>
                  <TableHead>{t("releases.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drawer.releases.map((release) => (
                  <TableRow key={release.id}>
                    <TableCell>
                      <Link
                        href={`/nonprofit/releases?release=${release.id}`}
                        className="font-mono text-[13px] text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {release.number}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-[13px]">{release.releaseDate}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(release.amount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={RELEASE_STATUS_VARIANT[release.status] ?? "secondary"}>
                        {release.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      ) : null}
    </UrlDrawer>
  );
}
